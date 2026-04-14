'use strict';

/**
 * 1:1 routes — prep generation + meeting note CRUD.
 *   POST /api/1to1/prep          { person, date?, force? }
 *   POST /api/1to1/notes         { action, title, date?, type?, people?, body?, section?, content? }
 */

const express = require('express');
const router = express.Router();

const prep = require('../services/one-to-one-prep');
const meetingNote = require('../services/meeting-note');

router.post('/prep', async (req, res) => {
  try {
    const { person, date, force } = req.body || {};
    if (!person) return res.status(400).json({ ok: false, error: 'person is required' });
    const result = await prep.generatePrep({ person, date, force: !!force });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[1to1/prep]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/notes', (req, res) => {
  try {
    const { action, title, date, type, people, body, section, content } = req.body || {};
    if (!action) return res.status(400).json({ ok: false, error: 'action is required' });
    const result = meetingNote.manageMeetingNote({ action, title, date, type, people, body, section, content });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[1to1/notes]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
