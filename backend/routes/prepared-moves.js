'use strict';

/**
 * SAiM's prepared move (19 Oct 2026; MVP 21 Oct 2026). /request and /confirm
 * are human-only and interactive (authority-matrix: saim.prepared-move,
 * machine: refuse). /current, /prepare, /respond and /answer read or write
 * only NEURO's own proposal rows (saim.prepared-move.propose) and are open to
 * desktop chats over MCP:
 *
 *   GET  /current — what SAiM has prepared, read only: stores nothing and
 *                   mints nothing (prepared-move-view). ?recordId= shows that one.
 *   GET  /promises — Keep my word promises and what SAiM needs to know (read).
 *   POST /prepare — plan one Now item and store the proposal (no external write).
 *   POST /respond — defer (1/3/7 days, with a reason), decline, or restore.
 *   POST /answer  — answer SAiM's question; the move is planned again.
 *   POST /request — prepare the move from live data (or take a STORED v2
 *                   proposal by recordId), store it as an immutable
 *                   version, re-check it, and mint a one-use 60-second
 *                   confirmation. Shows exactly what a yes would write.
 *   POST /confirm — spend that confirmation and make exactly those writes.
 *
 * ⚠ NOT A GENERIC ACTION DOOR. Neither route accepts a date, time, note path,
 * event title, body, recipient or write type: a body carrying any field other
 * than the few named below is REFUSED, never ignored. What is written comes
 * only from the stored packet; the request picks one of the options it offered.
 * The switch (saim_prepared_move_execution, default off) is enforced inside
 * prepared-move-exec, not here.
 */

const express = require('express');
const router = express.Router();

const exec = () => require('../services/prepared-move-exec');
const view = () => require('../services/prepared-move-view');
const HUMAN_ONLY = 'Only Nick, in NEURO, can confirm a prepared move — a machine client cannot.';
const OPTION_RE = /^(approve|unfinished|slot-[1-9])$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Refuse any field the route does not name — a date or a path sent here is an attempt, not a typo. */
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  return extra.length ? `this route takes only ${allowed.join(', ')} — refused: ${extra.join(', ')}` : null;
}
const caller = (req) => require('../services/intent-grants').callerOf(req);
const send = (res, r) => {
  if (r.ok) return res.json(r);
  const { code, ...rest } = r;
  return res.status(code || 409).json({ ...rest, error: (r.reasons || [r.error]).filter(Boolean).join(' ') });
};

const RECORD_RE = /^pm_[0-9a-f]{20}$/;
const REF_RE = /^(item|held|promise):[A-Za-z0-9_:.@-]{1,200}$/;
/** A promise's Keep my word card must re-read what just changed. */
const freshKmw = () => { try { require('../services/canonical-read').invalidateKeepMyWord(); } catch { /* expires within the minute */ } };
const by = (req) => { const m = caller(req).machine || (req.apiClient ? String(req.apiClient) : null); return m ? `machine:${m}` : 'nick'; };
const planner = () => require('../services/prepared-move-planner');
const pstore = () => require('../services/prepared-move-store');
/** The stored proposal as /current would show it, for a reply. */
/** The view of a stored record, or why it cannot be shown. */
async function shownWhy(record) {
  const duty = await require('../services/prepared-move').readDuty(Date.now());
  const v = await view().v2View(record, { duty });
  return { move: v.move || null, why: v.why || null };
}
/**
 * The answer for a record a press or an answer produced (26 Oct 2026). ⚠ NEVER
 * success with nothing to show: a stored record the view refuses is a 409 that
 * says why, or the card renders a no-op sentence over nothing prepared. A
 * promise's move also carries `promiseMove` — the ONE object the promise card
 * renders, the same one canonical Now gives it.
 */
async function recordAnswer(res, r, extra = {}) {
  const sh = await shownWhy(r.record);
  if (!sh.move) return res.status(409).json({ ok: false, ...extra, error: `SAiM couldn’t show what it prepared${sh.why ? ` (${sh.why})` : ''}. Nothing was saved, booked or sent.` });
  const promiseMove = require('../services/promise-moves').fromRecord(r.record);
  return res.json({ ok: true, ...extra, outcome: r.outcome, move: sh.move, ...(promiseMove ? { promiseMove } : {}), confirmWhere: 'Only Nick can confirm it, on his SAiM screen.' });
}

// GET /api/prepared-moves/current — prepared move, read only (make ready, SAiM proposal, drafted reply, meeting prep): what SAiM has prepared now — the draft, evidence and freshness, exact writes, any question she needs answered, and `makeReady` when nothing is prepared. Stores and mints nothing. Machines may read; only Nick confirms.
router.get('/current', async (req, res) => {
  const { recordId = null } = req.query || {};
  if (recordId !== null && (typeof recordId !== 'string' || !RECORD_RE.test(recordId))) return res.status(400).json({ ok: false, error: 'recordId must be a prepared move id' });
  try {
    res.json(await view().currentView(recordId ? { recordId } : {}));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/prepared-moves/eligible — which Now items SAiM can make ready (make this ready, draft the reply, meeting prep): each with its exact ref for /prepare and the Now row ids it is drawn as. Held, personal, employment and ineligible items are left out. Read only.
router.get('/eligible', async (req, res) => {
  try {
    const p = await require('../services/read-only-scope').run(() => planner().eligibleNow());
    res.json({ ok: true, ...p.result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/prepared-moves/promises — held promises SAiM needs an answer on (keep my word, who is it owed to, waiting for you): each Keep my word promise at risk, what is missing (the exact question), its ref for /prepare, and its prepared move (recordId, version, question) if one exists. Answer with /prepare then /answer. Read only.
router.get('/promises', async (req, res) => {
  try {
    res.json({ ok: true, ...(await require('../services/promise-moves').list()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-moves/prepare — make ready (make this ready, draft the reply, meeting prep, draft note, private working draft): take ONE Now item or held promise (its ref) to the furthest safe point — the real draft, a solo block only if your time is needed, or a question for Nick. Stores a PROPOSAL only; nothing is saved, booked or sent until Nick confirms. withdraw: "owed" first removes an earlier answer to who a promise is owed to (kept for the record, no longer used). Body: { ref, withdraw? }
router.post('/prepare', async (req, res) => {
  const bad = strict(req.body, ['ref', 'withdraw']);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const { ref, withdraw = null } = req.body || {};
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return res.status(400).json({ ok: false, error: 'ref is required — a Now item reference (item:…, held:… or promise:…)' });
  if (withdraw !== null && (withdraw !== 'owed' || !ref.startsWith('promise:'))) return res.status(400).json({ ok: false, error: 'withdraw may only be "owed", on a promise ref' });
  try {
    let withdrawn = null;
    if (withdraw) {
      const key = ref.slice('promise:'.length);
      let p = null;
      try { p = planner().DEFAULT_DEPS.promise(key, Date.now()); } catch (e) { return res.status(409).json({ ok: false, error: `NEURO couldn’t read your promises (${e.message}), so nothing was changed.` }); }
      const lead = p && (p.leadTaskId || (p.taskIds || [])[0]);
      if (!lead) return res.status(409).json({ ok: false, error: 'That promise is no longer in what NEURO holds — nothing was changed.' });
      withdrawn = pstore().withdrawAnswer({ moveKey: planner().moveKeyFor('project-note', `task:${lead}`), questionId: 'owed', by: by(req) });
      if (!withdrawn.ok) return res.status(withdrawn.code || 409).json({ ok: false, error: withdrawn.why });
      freshKmw();
    }
    const r = await planner().planAndStore({ ref, origin: req.apiClient || caller(req).machine ? 'mcp' : 'manual' });
    if (withdrawn && !r.ok) return res.json({ ok: true, outcome: 'withdrawn', withdrawn: withdrawn.withdrawn || null, say: `Your earlier answer was removed. ${r.why || ''}`.trim(), move: null });
    if (!r.ok) return res.status(409).json({ ok: false, error: r.why, reason: r.reason || null, withheld: r.withheld });
    if (ref.startsWith('promise:')) freshKmw();
    if (r.outcome === 'handoff') return res.json({ ok: true, outcome: 'handoff', say: r.why, handoff: r.handoff, move: null, withdrawn: withdrawn && withdrawn.withdrawn });
    if (!r.record) return res.json({ ok: true, outcome: r.outcome, say: r.why || null, move: null, withdrawn: withdrawn && withdrawn.withdrawn });
    return recordAnswer(res, r, withdrawn ? { withdrawn: withdrawn.withdrawn || null } : {});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-moves/respond — defer, decline or restore a prepared move (not now, put off, say no, undo): defer hides it for 1, 3 or 7 days with a reason; decline means SAiM never offers it for that email, task or meeting again; restore undoes either. Changes nothing outside NEURO. Body: { recordId, version, response, reason?, days? }
router.post('/respond', (req, res) => {
  const bad = strict(req.body, ['recordId', 'version', 'response', 'reason', 'days']);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const { recordId, version, response, reason = null, days = null } = req.body || {};
  if (typeof recordId !== 'string' || !RECORD_RE.test(recordId)) return res.status(400).json({ ok: false, error: 'recordId is required' });
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ ok: false, error: 'version is required' });
  try {
    const r = pstore().respond({ recordId, version, response, reason, days, by: by(req) });
    if (!r.ok) return res.status(r.code || 409).json({ ok: false, error: r.why });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-moves/answer — answer SAiM's question about a prepared move (what she needs, more info, which folder, what it should cover, the private draft interview's next question): your answer is kept as your own words, a source fact, and the move is planned again as a NEW version. park: true instead parks the private draft's question (not now — kept as unresolved). Body: { recordId, version, questionId, text | park: true }
router.post('/answer', async (req, res) => {
  const bad = strict(req.body, ['recordId', 'version', 'questionId', 'text', 'park']);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const { recordId, version, questionId, text, park = false } = req.body || {};
  if (typeof recordId !== 'string' || !RECORD_RE.test(recordId)) return res.status(400).json({ ok: false, error: 'recordId is required' });
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ ok: false, error: 'version is required' });
  if (typeof questionId !== 'string' || !/^[a-z]{1,20}$/.test(questionId)) return res.status(400).json({ ok: false, error: 'questionId is required' });
  if (park !== false && park !== true) return res.status(400).json({ ok: false, error: 'park must be true or left out' });
  if (park && text !== undefined) return res.status(400).json({ ok: false, error: 'park a question OR answer it — not both' });
  if (!park && typeof text !== 'string') return res.status(400).json({ ok: false, error: 'text is required' });
  try {
    const a = park ? pstore().parkQuestion({ recordId, version, questionId, by: by(req) }) : pstore().addAnswer({ recordId, version, questionId, text, by: by(req) });
    if (!a.ok) return res.status(a.code || 409).json({ ok: false, error: a.why });
    const s = a.record.packet.selected;
    const r = await planner().planAndStore({ source: { kind: s.kind, sourceKey: s.sourceKey, source: s.source, ref: s.ref, title: s.title }, origin: 'answer', firstOrigin: a.record.packet.firstOrigin || a.record.packet.origin || null });
    if ((s.source || {}).promiseKey) freshKmw();
    if (r.ok && r.outcome === 'handoff') return res.json({ ok: true, answered: true, outcome: 'handoff', say: r.why, handoff: r.handoff, move: null });
    if (!r.ok) return res.status(409).json({ ok: false, error: r.why, answered: true });
    if (!r.record) return res.json({ ok: true, answered: true, outcome: r.outcome, say: r.why || null, move: null });
    return recordAnswer(res, r, { answered: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-moves/request — prepared move, step 1 (human only, interactive): show exactly what confirming SAiM's prepared move would write (the note, the reply draft, a solo block) and mint a one-use 60-second confirmation for that stored version. Refuses machine clients. Body: { option, surface, sessionId, recordId? }
router.post('/request', async (req, res) => {
  if (req.apiClient || caller(req).machine) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  const bad = strict(req.body, ['option', 'surface', 'sessionId', 'recordId']);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const { option = 'approve', surface = 'neuro-web', sessionId, recordId = null } = req.body || {};
  if (typeof option !== 'string' || !OPTION_RE.test(option)) return res.status(400).json({ ok: false, error: 'option must be one of the times the move offered (approve, slot-1, …)' });
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return res.status(400).json({ ok: false, error: 'sessionId is required' });
  if (recordId !== null && (typeof recordId !== 'string' || !RECORD_RE.test(recordId))) return res.status(400).json({ ok: false, error: 'recordId must be a prepared move id' });
  try {
    send(res, await exec().requestForMove({ option, recordId, surface, sessionId, caller: caller(req) }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-moves/confirm — prepared move, step 2 (human only, interactive): spend the one-use confirmation and make exactly the stored writes, read each back and return a receipt. Refused, with nothing read or written, while saim_prepared_move_execution is off. Refuses machine clients. Body: { recordId, version, option, grantId }
router.post('/confirm', async (req, res) => {
  if (req.apiClient || caller(req).machine) return res.status(403).json({ ok: false, error: HUMAN_ONLY, executed: false });
  const bad = strict(req.body, ['recordId', 'version', 'option', 'grantId']);
  if (bad) return res.status(400).json({ ok: false, error: bad, executed: false });
  const { recordId, version, option, grantId } = req.body || {};
  if (typeof recordId !== 'string' || !/^pm_[0-9a-f]{20}$/.test(recordId)) return res.status(400).json({ ok: false, error: 'recordId is required', executed: false });
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ ok: false, error: 'version is required', executed: false });
  if (typeof option !== 'string' || !OPTION_RE.test(option)) return res.status(400).json({ ok: false, error: 'option must be one the move offered', executed: false });
  if (typeof grantId !== 'string' || !/^ig_[0-9a-f]{32}$/.test(grantId)) return res.status(400).json({ ok: false, error: 'grantId is required', executed: false });
  try {
    send(res, await exec().confirmMove({ recordId, version, option, grantId, caller: caller(req) }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, executed: false });
  }
});

module.exports = router;
