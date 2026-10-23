'use strict';

/**
 * The fixes log (services/report-fixes.js) — one vault note per fix under
 * Projects/Fixes Log/, read by the SOAP and Weekly Risk reports.
 *
 * POST /api/report-fixes is the door a Claude Code session uses at deploy: it
 * PROPOSES. Everything that decides — include, dismiss, restore, edit, and the
 * manual entry (which is included at once) — is Nick's: refused to machine
 * clients in the authority matrix and here, interactive in the MCP gateway.
 */

const express = require('express');
const fixes = require('../services/report-fixes');

const router = express.Router();

const fail = (res, e) => res.status(e.status || 500).json({ ok: false, error: e.message });
const machineRefused = (req, res) => {
  if (!req.apiClient) return false;
  res.status(403).json({ ok: false, error: "Including a fix in a report is Nick's decision. He does it in NEURO → Reports → Fixes log, or in the note in Projects/Fixes Log/." });
  return true;
};

// GET /api/report-fixes — fixes for the SOAP and Weekly Risk reports (report fixes, fixed bugs, data corrections), newest deploy first. Query: status=proposed|included|dismissed.
router.get('/', (req, res) => {
  try {
    res.json({ ok: true, ...fixes.list({ status: req.query.status || null }), systems: fixes.SYSTEMS, impacts: fixes.IMPACTS });
  } catch (e) { fail(res, e); }
});

// POST /api/report-fixes — propose a report fix (bug fixed, data correction) after deploying it. Body: { system: nova|vantage|neuro|n8n|other, title, problem, impact: [figures|team|customers], affects: [{ measure, from, to }] (with figures), fixedIn, deployedOn: YYYY-MM-DD }. Arrives proposed; Nick includes it.
router.post('/', (req, res) => {
  const { system, title, problem, impact, affects, fixedIn, deployedOn } = req.body || {};
  try {
    const r = fixes.post({ system, title, problem, impact, affects, fixedIn, deployedOn }, { manual: false, postedBy: req.apiClient ? `machine:${req.apiClient}` : 'nick' });
    res.status(r.created ? 201 : 200).json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});

// POST /api/report-fixes/manual — Nick enters a fix himself; it is included in the reports at once. Same body as POST /api/report-fixes. Nick only.
router.post('/manual', (req, res) => {
  if (machineRefused(req, res)) return;
  const { system, title, problem, impact, affects, fixedIn, deployedOn } = req.body || {};
  try {
    const r = fixes.post({ system, title, problem, impact, affects, fixedIn, deployedOn }, { manual: true, postedBy: 'nick' });
    res.status(r.created ? 201 : 200).json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});

// POST /api/report-fixes/:id/decide — include a proposed fix in the reports, leave it out, or put it back to proposed. Body: { decision: include|dismiss|restore }. Nick only.
router.post('/:id/decide', (req, res) => {
  if (machineRefused(req, res)) return;
  const { decision } = req.body || {};
  try { res.json({ ok: true, fix: fixes.decide(req.params.id, decision) }); } catch (e) { fail(res, e); }
});

// POST /api/report-fixes/:id/edit — Nick corrects a fix's wording, figures or dates. Body: any of { system, title, problem, impact, affects, fixedIn, deployedOn }; omitted fields are kept. Nick only.
router.post('/:id/edit', (req, res) => {
  if (machineRefused(req, res)) return;
  const { system, title, problem, impact, affects, fixedIn, deployedOn } = req.body || {};
  try { res.json({ ok: true, fix: fixes.edit(req.params.id, { system, title, problem, impact, affects, fixedIn, deployedOn }) }); } catch (e) { fail(res, e); }
});

module.exports = router;
