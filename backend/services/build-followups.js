'use strict';

/**
 * Build 23AH — the open user-action ledger.
 *
 * From Build 23 on, anything a build leaves for Nick to do becomes (or
 * updates) a REAL NEURO task. A follow-up written only in a build note, a gap
 * analysis or a handoff is one nobody does — Build 21's "ten minutes" list sat
 * in a vault note for a day while its owner forgot it existed.
 *
 * Rules:
 *   • A follow-up has a stable `key`; the ledger (agent_state) maps key → task.
 *   • Before creating, match against existing tasks: an OPEN one is reused, a
 *     DONE/DROPPED one means it is already resolved and is never recreated.
 *   • A created task records its source build (source 'build-followup', the
 *     build and key in its notes and origin detail).
 *   • `verify` is the acceptance check: a follow-up with no task fails.
 */

const LEDGER_KEY = 'build_followups';
const OPEN = new Set(['open', 'in-progress']);

function _db() { return require('../db/database'); }
function _ledger() { try { return JSON.parse(_db().getState(LEDGER_KEY) || '{}') || {}; } catch { return {}; } }
function _setLedger(l) { _db().setState(LEDGER_KEY, JSON.stringify(l)); }

function validate(f) {
  if (!f || typeof f !== 'object') return 'a follow-up must be an object';
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(String(f.key || ''))) return 'a follow-up needs a key (lowercase, hyphens)';
  if (!(typeof f.title === 'string' && f.title.trim().length >= 5)) return `follow-up ${f.key}: a title is needed`;
  if (!/^Build \d+/.test(String(f.build || ''))) return `follow-up ${f.key}: the source build is needed ("Build 23")`;
  return null;
}

/** Best existing match for a follow-up's wording (and any alternative wordings). */
function _match(f, rows) {
  const dedupe = require('./task-dedupe');
  const texts = [f.title, ...(f.alsoMatches || [])];
  let best = null;
  for (const t of texts) {
    const hit = dedupe.findEquivalent(t, rows.map((r) => r.text), { minScore: dedupe.INTERNAL_MIN_SCORE });
    if (hit && (!best || hit.score > best.score)) best = { row: rows[hit.index], score: hit.score };
  }
  return best;
}

/**
 * Reconcile a build's follow-ups into tasks. `apply:false` (the default)
 * reports what WOULD happen and writes nothing.
 * Outcome per follow-up: exists | reused | resolved | created | would-create | invalid.
 */
function reconcile(followups = [], { apply = false, now = Date.now() } = {}) {
  const db = _db();
  const store = require('./task-store');
  const ledger = _ledger();
  const all = db.listTaskRows({ status: 'all' });
  const open = all.filter((r) => OPEN.has(r.status));
  const closed = all.filter((r) => !OPEN.has(r.status));
  const out = [];
  for (const f of followups) {
    const bad = validate(f);
    if (bad) { out.push({ key: f && f.key, outcome: 'invalid', why: bad }); continue; }
    const held = ledger[f.key] ? db.getTaskRow(ledger[f.key].taskId) : null;
    if (held) {
      out.push({ key: f.key, outcome: OPEN.has(held.status) ? 'exists' : 'resolved', taskId: held.id, status: held.status, text: held.text });
      continue;
    }
    const o = _match(f, open);
    if (o) {
      if (apply) ledger[f.key] = { taskId: o.row.id, build: f.build, linkedAt: new Date(now).toISOString(), how: 'reused' };
      out.push({ key: f.key, outcome: 'reused', taskId: o.row.id, text: o.row.text, score: Math.round(o.score * 100) / 100 });
      continue;
    }
    const c = _match(f, closed);
    if (c) {
      if (apply) ledger[f.key] = { taskId: c.row.id, build: f.build, linkedAt: new Date(now).toISOString(), how: 'already-resolved' };
      out.push({ key: f.key, outcome: 'resolved', taskId: c.row.id, status: c.row.status, text: c.row.text });
      continue;
    }
    if (!apply) { out.push({ key: f.key, outcome: 'would-create', text: f.title }); continue; }
    const r = store.createTask({
      text: f.title.trim(), source: 'build-followup', domain: f.domain || 'personal', due_date: f.dueDate || null,
      notes: [f.why || null, `From ${f.build} (follow-up: ${f.key}).`].filter(Boolean).join('\n\n'),
      originDetail: { build: f.build, followup: f.key }, skipExport: false,
    });
    ledger[f.key] = { taskId: r.id, build: f.build, linkedAt: new Date(now).toISOString(), how: r.created ? 'created' : 'folded' };
    out.push({ key: f.key, outcome: r.created ? 'created' : 'reused', taskId: r.id, text: r.task && r.task.text });
  }
  if (apply) _setLedger(ledger);
  return { ok: true, applied: !!apply, results: out };
}

/** Acceptance: every follow-up must have a task (open, or resolved). */
function verify(followups = []) {
  const ledger = _ledger();
  const db = _db();
  const missing = followups.filter((f) => !(ledger[f.key] && db.getTaskRow(ledger[f.key].taskId))).map((f) => f.key);
  return { ok: missing.length === 0, missing };
}

/**
 * Nick-owned follow-ups known at the end of Build 23. Wording is what Nick
 * would see on his task list; `alsoMatches` catches tasks he already wrote in
 * his own words.
 */
const BUILD_23 = Object.freeze([
  { key: 'reconnect-nick-natwest', build: 'Build 23', title: 'Reconnect my NatWest bank feed in Tally (TrueLayer)',
    why: 'Both NatWest connections stopped refreshing on 27 Jun 2026. Finance in NEURO shows "reconnect required" until the feed is re-approved at NatWest. Tally backfills from each account\'s newest transaction.',
    alsoMatches: ['Reconnect TrueLayer in Tally', 'Reconnect NatWest'] },
  { key: 'helen-reconnect-natwest', build: 'Build 23', title: 'Ask Helen to reconnect her NatWest account in Tally when convenient',
    why: 'Helen\'s account needs her own approval. Until then household finance stays partial.' },
  { key: 'create-personal-admin-list', build: 'Build 23', title: 'Create a "Personal Admin" list in Apple Reminders, then classify and track it in NEURO',
    why: 'NEURO cannot create Apple lists. Then: open NEURO/SAiM on the phone, set the list as Admin and Track it in Life → Reminder lists.',
    alsoMatches: ['Create Personal Admin list'] },
  { key: 'captur-registration', build: 'Build 23', title: 'Add the Captur registration in NEURO (Life → Vehicle)',
    why: 'From the V5C. Unlocks the official MOT/tax checks.', alsoMatches: ['Add Captur registration'] },
  { key: 'captur-mileage', build: 'Build 23', title: 'Add a Captur odometer reading in NEURO (Life → Vehicle)', alsoMatches: ['Add Captur mileage'] },
  { key: 'captur-dates', build: 'Build 23', title: 'Add the Captur MOT, tax and insurance dates in NEURO (Life → Vehicle)', alsoMatches: ['Add MOT tax insurance dates'] },
  { key: 'link-mot-task-captur', build: 'Build 23', title: 'Link the MOT booking task to the Captur in NEURO',
    why: 'Life → Vehicle → link "Book my car in for its MOT" as the MOT\'s action.' },
  { key: 'build18-native-proof', build: 'Build 23', title: 'Finish the Build 18 native proof on the Mac (docs/build-18-mac-runbook.md)',
    why: 'Rebuild NEURO iOS from a clean tree, confirm /api/setup/native, then read the CLMonitor assertion before re-enabling geofences.',
    alsoMatches: ['Build 18 native proof', 'Complete remaining Build 18 native proof'] },
]);

module.exports = { LEDGER_KEY, BUILD_23, validate, reconcile, verify };
