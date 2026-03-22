'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// POST /api/health/ingest — receive Apple Health data from iOS Shortcut
// Secured with a simple token (INGEST_SECRET env var, same as used elsewhere)
router.post('/ingest', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const expected = process.env.INGEST_SECRET || '';

  if (expected && token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }

    const todayKey = new Date().toISOString().split('T')[0];

    // Store each metric separately so individual fields can be queried
    // Also store the full payload for reference
    const entry = {
      date: payload.date || todayKey,
      hrv: payload.hrv || null,                          // ms — HRV SDNN
      rhr: payload.rhr || null,                          // bpm — resting heart rate
      sleepDuration: payload.sleepDuration || null,      // hours
      sleepDeep: payload.sleepDeep || null,              // hours
      sleepRem: payload.sleepRem || null,                // hours
      sleepAwake: payload.sleepAwake || null,            // hours
      sleepEfficiency: payload.sleepEfficiency || null,  // 0-100%
      steps: payload.steps || null,                      // count
      activeEnergy: payload.activeEnergy || null,        // kcal
      vo2max: payload.vo2max || null,                    // mL/kg/min
      respiratoryRate: payload.respiratoryRate || null,  // breaths/min
      bodyWeight: payload.bodyWeight || null,            // kg
      timestamp: new Date().toISOString()
    };

    // Store keyed by date so today's data overwrites stale data
    const stateKey = `health_data_${entry.date}`;
    db.setState(stateKey, JSON.stringify(entry));

    // Also store as 'health_latest' for quick access without knowing the date
    db.setState('health_latest', JSON.stringify(entry));

    console.log(`[Health] Ingested data for ${entry.date}:`,
      `HRV=${entry.hrv}ms RHR=${entry.rhr}bpm sleep=${entry.sleepDuration}h steps=${entry.steps}`
    );

    res.json({ success: true, date: entry.date, received: Object.keys(entry).filter(k => entry[k] !== null).length + ' fields' });
  } catch (e) {
    console.error('[Health] Ingest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/today — retrieve today's health data
router.get('/today', (req, res) => {
  try {
    const todayKey = new Date().toISOString().split('T')[0];
    const raw = db.getState(`health_data_${todayKey}`) || db.getState('health_latest');
    if (!raw) return res.json({ data: null, date: todayKey });
    const data = JSON.parse(raw);
    // Only return today's data — don't surface stale yesterday data as "today"
    if (data.date !== todayKey) return res.json({ data: null, date: todayKey, note: 'No data yet today' });
    res.json({ data, date: todayKey });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/history?days=7 — last N days of health data
router.get('/history', (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const results = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().split('T')[0];
      const raw = db.getState(`health_data_${dateKey}`);
      if (raw) {
        try { results.push(JSON.parse(raw)); } catch {}
      }
    }
    res.json({ history: results, days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/status — is health data available and fresh?
router.get('/status', (req, res) => {
  try {
    const todayKey = new Date().toISOString().split('T')[0];
    const raw = db.getState(`health_data_${todayKey}`);
    const latestRaw = db.getState('health_latest');
    const latest = latestRaw ? JSON.parse(latestRaw) : null;
    res.json({
      hasToday: !!raw,
      latestDate: latest?.date || null,
      latestTimestamp: latest?.timestamp || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
