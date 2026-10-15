'use strict';

const express = require('express');
const LINKS = require('../../shared/neuro-links.cjs');
const links = require('../services/neuro-links');

const router = express.Router();

// GET /api/links/resolve — open an exact-item deep link (neuro:?item=<kind>:<id>) for a task, approval/action, email, hazard or meeting prep: resolve link, deep link, open item, canonical link. Answers open (200) with the one record, or explicitly invalid (400) / missing (404) / stale (410, with the current record when known) / unreadable (503). Never falls back to a page or list. Read-only. ?item=<kind>:<id>
router.get('/resolve', (req, res) => {
  const item = typeof req.query.item === 'string' ? req.query.item : '';
  const out = links.resolve(item);
  const code = LINKS.STATUS_HTTP[out.status] || 500;
  res.status(code).json({ ok: out.status === 'open', ...out });
});

module.exports = router;
