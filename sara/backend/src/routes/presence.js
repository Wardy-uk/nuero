// GET /api/presence — compact "are you here?" signal for the SARA auto-lock.
//
// The SARA frontend lock logic polls this (small payload) rather than the full
// /api/state, so the wall display can cheaply ask "should I lock?" on a tight interval.
//
// Source priority:
//   1. Watch BLE presence service — the on-Pi watch-presence service writes a JSON
//      status file (present/away via the Apple Watch IRK + RSSI). This is the primary,
//      desk-level signal. Used when the file is present and FRESH.
//   2. Home Assistant proximity — fallback when the watch service isn't reporting
//      (file missing/stale), preserving the original HA-proximity behaviour.
//
// `away` is the single boolean the client acts on:
//   true  -> SARA may auto-lock (you appear to have left)
//   false -> you're present (and the client may auto-unlock)
//   null  -> unknown (no source available). The client MUST NOT auto-lock on null —
//            only the idle-timeout safety net should fire — so a blind signal can never
//            lock you out.
const fs = require('fs');
const express = require('express');
const ha = require('../telemetry/homeAssistant');

const router = express.Router();

const WATCH_FILE = process.env.WATCH_STATUS_FILE || '/home/nickw/watch-irk/presence.json';
// A watch report older than this is stale -> fall back to HA rather than trust it.
const WATCH_STALE_MS = Number(process.env.WATCH_STALE_MS) || 30000;

function readWatch() {
  try {
    const raw = fs.readFileSync(WATCH_FILE, 'utf8');
    const d = JSON.parse(raw);
    const ageMs = d.updated ? Date.now() - Date.parse(d.updated) : Infinity;
    if (ageMs > WATCH_STALE_MS) return null; // stale -> not trustworthy
    if (d.status !== 'present' && d.status !== 'away') return null;
    return {
      away: d.status === 'away',
      present: d.status === 'present',
      rssi: typeof d.rssi === 'number' ? d.rssi : null,
      source: 'watch-ble',
      ageMs,
    };
  } catch {
    return null; // file missing/unreadable -> fall back
  }
}

router.get('/', (_req, res) => {
  const watch = readWatch();
  if (watch) {
    return res.json({
      source: 'watch-ble',
      available: true,
      reason: null,
      away: watch.away,
      present: watch.present,
      rssi: watch.rssi,
      ageMs: watch.ageMs,
      checkedAt: new Date().toISOString(),
    });
  }

  // Fallback: Home Assistant proximity (original behaviour).
  const t = ha.getTelemetry();
  const prox = t.available ? t.signals.proximity : null;
  res.json({
    source: t.source,
    available: t.available,
    reason: t.reason || 'watch-unavailable',
    away: prox ? prox.away : null,
    present: prox ? prox.present : null,
    proximity: prox || null,
    polledAt: t.polledAt || null,
    checkedAt: new Date().toISOString(),
  });
});

module.exports = router;
