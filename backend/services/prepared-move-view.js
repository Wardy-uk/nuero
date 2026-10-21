'use strict';

/**
 * What SAiM's approval surface shows about a prepared move (19 Oct 2026) —
 * READ-ONLY. `GET /api/prepared-moves/current` answers from here.
 *
 * It prepares the packet IN MEMORY from the same read-only sources /request
 * uses and re-runs the same fresh checks (diary, leave, the commitment, the
 * note path) — and then STORES NOTHING and MINTS NOTHING. Storing a version and
 * minting a confirmation stay /request's job, behind Nick's explicit click.
 *
 * The rules the screen relies on:
 *   - `move: null` whenever there is no trustworthy move — nothing selected,
 *     an out-of-scope write set, an employment or stale screen. Withheld items
 *     are COUNTED, never named: an employment matter is routing-only, and its
 *     wording is not for this screen.
 *   - a time is offered ONLY if it passes the fresh diary and leave checks NOW.
 *     A time that cannot be confirmed free is listed as withheld with its
 *     reason, never offered "probably free".
 *   - every sentence is composed from the packet's own fields; nothing here
 *     knows about T1.
 */

const exec = require('./prepared-move-exec');

const CONTRACT = 'prepared-move-view-v1';
/** The read must answer within this, or offer nothing. */
const BUDGET_MS = 1500;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLong = (d) => { const x = new Date(`${d}T12:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** The same words /request uses for its question — pinned equal by a test. */
function questionFor(slot) {
  return `Reserve ${toMin(slot.end) - toMin(slot.start)} minutes on ${dayLong(slot.date)} (${slot.start}–${slot.end}) and save the draft?`;
}

/**
 * PURE. What the work IS, in plain words, from the packet's register row —
 * never its internal id. "Publish triage and escalation acceptance criteria for
 * every team, …" → "triage and escalation acceptance criteria". A register
 * action is imperative by convention; if it does not start with a known verb,
 * the draft's own heading is used with any register id ("T1 — ") removed.
 */
const ACTION_VERBS = new Set(['publish', 'write', 'draft', 'agree', 'define', 'create', 'produce', 'document', 'build', 'deliver', 'prepare', 'review', 'update', 'finalise', 'finalize', 'complete', 'establish', 'share', 'confirm', 'propose', 'design']);
const REGISTER_ID = /^[A-Z]{1,5}\d+[a-z]?\s*[—–-]\s*/;
function humanTitle(subject, draftTitle) {
  const action = String((subject && subject.action) || '').trim();
  const m = /^([A-Za-z]+)\s+(.+)$/.exec(action);
  if (m && ACTION_VERBS.has(m[1].toLowerCase())) {
    const t = m[2].split(/\s+(?:for|with|so that|to|by|across|within)\s+|[,;:(—–]/)[0].trim();
    if (t.length >= 3) return t;
  }
  return String(draftTitle || '').replace(REGISTER_ID, '').trim() || 'a draft';
}

/** PURE. What the draft itself leaves open: rows to agree, open questions, things not found. */
function unresolvedFrom(markdown) {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let section = null;
  const toAgree = [];
  const questions = [];
  const notFound = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (/^##\s+/.test(l)) { section = l.replace(/^##\s+/, ''); continue; }
    const row = /^\|\s*([^|]+?)\s*\|(.*)\|\s*$/.exec(l);
    if (row && /_to agree_/.test(row[2]) && !/^[-\s|]+$/.test(row[1])) toAgree.push(row[1]);
    if (/^-\s+/.test(l) && /open questions/i.test(section || '') && !/_\(none found/.test(l)) questions.push(l.replace(/^-\s+/, '').replace(/\s*_from [^_]+_\s*$/, '').trim());
    if (/_\(not found in the notes|_\(teams not found/.test(l)) notFound.push(section || 'part of the draft');
  }
  if (toAgree.length) out.push({ what: `What each team accepts is not agreed yet for ${toAgree.length === 1 ? toAgree[0] : `${toAgree.length} teams`}.`, detail: toAgree });
  for (const q of questions) out.push({ what: q, detail: [] });
  for (const s of notFound) out.push({ what: `Your notes don’t say: ${s.toLowerCase()}.`, detail: [] });
  return out;
}

const { artefactFrom, momentFor } = require('./prepared-move-artefact');

function _authority(now) {
  try { return require('./authority-budget').brief({ now }); } catch { return { canAct: false, stopped: false, deviceOpen: false, granted: false, summary: 'SAiM couldn’t read its allowance.', boundary: { gate: 'unreadable', say: 'I couldn’t check what I’m allowed to do, so I won’t do anything yet.' } }; }
}

function _execution() {
  try {
    const f = require('./feature-flags').list().find((x) => x.key === exec.FLAG) || {};
    return { enabled: Boolean(f.enabled), lockedByEnv: Boolean(f.lockedByEnv), envVar: f.envVar || null, flag: exec.FLAG };
  } catch {
    return { enabled: false, lockedByEnv: false, envVar: null, flag: exec.FLAG };
  }
}

/** Swappable in tests only: the packet source and the fresh-check readers. */
const _deps = { prepare: null, checks: null };
function _setDeps(over = {}) { const was = { ..._deps }; Object.assign(_deps, over); return () => Object.assign(_deps, was); }

/**
 * The view. `deps` (tests only): prepare, checks — default to the executor's own.
 */
/**
 * The whole read runs as a READ-ONLY pass: any write or off-machine request
 * anywhere beneath it is refused and counted (services/read-only-scope).
 */
async function currentView(opts = {}) {
  const p = await require('./read-only-scope').run(() => _currentView(opts));
  return { ...p.result, readOnlyPass: { writesRefused: p.writesRefused, refused: p.refused } };
}

/** The defer and decline choices, as the store accepts them — one list, not a copy. */
function _respondChoices() {
  const st = require('./prepared-move-store');
  const DEFER = { 1: 'Until tomorrow', 3: 'For 3 days', 7: 'For a week' };
  const REASONS = { 'not-now': 'Not now', 'waiting-on-someone': 'Waiting on someone', 'need-more-info': 'Need more information', other: 'Another reason', 'not-mine': 'Not mine to do', 'already-done': 'Already done', 'not-useful': 'Not useful' };
  return {
    defer: { days: st.DEFER_DAYS.map((d) => ({ days: d, label: DEFER[d] })), reasons: st.DEFER_REASONS.map((r) => ({ id: r, label: REASONS[r] })) },
    decline: { reasons: st.DECLINE_REASONS.map((r) => ({ id: r, label: REASONS[r] })), say: 'SAiM won’t offer this one again.' },
  };
}

const KIND_DETAIL = {
  'email-reply': 'The reply goes to Actions, where it waits for your approval code. Nothing is sent from here.',
  'meeting-prep': 'Arranged from what your notes already hold about the people in it. Nothing in it is agreed.',
  'project-note': 'Arranged from what your notes already say. Nothing in it is agreed.',
};

/**
 * The view of a STORED v2 proposal (21 Oct 2026). READ-ONLY. Every word is
 * the stored packet's; an option is offered only if it passes the fresh checks
 * NOW; off duty it is held (nothing to press); a question is shown as one.
 */
async function v2View(record, { now = Date.now(), duty = null, checks = null } = {}) {
  const pkt = record.packet; const s = pkt.selected;
  const cand = await require('./prepared-move-planner').recheck(pkt);
  if (!cand.ok) return { move: null, why: cand.why };
  const evidence = (s.observed || []).map((o) => ({ fact: o.fact, kind: (o.source || {}).kind || null, observedAt: (o.source || {}).observedAt || null }));
  const freshness = (s.freshness || []).map((r) => ({ ref: r.ref, ageHours: r.ageHours, maxHours: r.maxHours, stale: r.stale }));
  const common = {
    version: 2, recordId: record.id, recordVersion: record.version, kind: s.kind, plan: s.plan, title: s.title,
    prepared: { headline: s.headline, detail: s.plan === 'ask' ? (s.ask.questions[0] || {}).why || null : KIND_DETAIL[s.kind] },
    outcome: s.outcome || null,
    why: { because: [s.why].filter(Boolean), goal: (s.outcome || {}).goal || null, doneWhen: (s.outcome || {}).doneWhen || null, willNot: (s.authority || {}).mustNot || [] },
    evidence, freshness, deliverable: s.deliverable || null, ask: s.ask || null, do: s.do || null,
    origin: pkt.origin || null, forum: s.forum || null,
    respond: _respondChoices(), decidedAt: (pkt.decision || {}).decidedAt || null, evidenceExpiresAt: record.evidenceExpiresAt,
    checkedAt: record.checkedAt || record.createdAt,
  };
  const d = duty || { onDuty: false, why: 'unknown' };
  if (d.onDuty !== true) return { held: { reason: d.why, say: require('./prepared-move').HELD_SAY }, move: { ...common, held: true, options: [], prepared: { headline: require('./prepared-move').HELD_SAY, detail: s.headline } } };
  if (s.plan === 'ask') return { move: { ...common, options: [], moment: { headline: s.headline } } };
  const offered = []; const notOffered = [];
  const ck = checks || exec.defaultChecks({ adapters: { vault: exec.readOnlyVault() }, now });
  for (const slot of (s.decision || {}).slots || []) {
    const w = exec.writesFor(pkt, slot.id);
    if (!w.ok || !record.options[slot.id]) continue;
    const r = await exec.freshChecks({ record, w, checks: ck, now });
    const label = slot.date ? `${dayLong(slot.date)} ${slot.start}–${slot.end}` : 'As drafted';
    if (r.ok) offered.push({ id: slot.id, ...(slot.date ? { date: slot.date, start: slot.start, end: slot.end } : {}), label, question: w.confirmation.question, writes: w.confirmation.writes });
    else notOffered.push({ id: slot.id, label, why: r.reasons.join(' ') });
  }
  const first = offered.length ? exec.writesFor(pkt, offered[0].id) : null;
  return {
    move: {
      ...common, options: offered, notOffered,
      contacts: first ? first.confirmation.contacts : null,
      nothingElse: 'Nothing else changes: nothing is sent, nobody is invited, and no task, board card, goal or notification is created.',
      moment: { headline: s.headline },
    },
  };
}

/** PURE-ish (reads suppression). The one Now item SAiM could make ready, or null. */
function makeReadyFrom(packet, now) {
  const planner = require('./prepared-move-planner');
  const st = require('./prepared-move-store');
  if (!packet || !packet.duty || packet.duty.onDuty !== true) return null;
  for (const c of packet.candidates || []) {
    if (packet.selected && packet.selected.ref === c.ref) continue;
    const q = planner.quickEligible(c.item);
    if (!q) continue;
    // A todo's source key needs the task id; an email/meeting's is on the item.
    const m = (c.item && c.item.meta) || {};
    const key = q.kind === 'email-reply' ? `email:${m.emailId}` : q.kind === 'meeting-prep' ? `meeting:${String(c.item.id).replace(/^cal-/, '')}@${String(m.start || '').slice(0, 16)}` : null;
    if (key && st.suppression(planner.moveKeyFor(q.kind, key), now)) continue;
    return { ref: c.ref, title: c.item.title || c.title, kind: q.kind, label: q.label };
  }
  return null;
}

async function _currentView({ now = Date.now(), deps = {}, budgetMs = BUDGET_MS, clock = Date.now } = {}) {
  deps = { ..._deps, ...Object.fromEntries(Object.entries(deps).filter(([, v]) => v)) };
  const started = clock();
  const execution = _execution();
  const base = { ok: true, contract: CONTRACT, generatedAt: new Date(now).toISOString(), execution, authority: _authority(now), budgetMs };
  // A STORED v2 proposal (the scan's, or one Nick asked for) is shown first —
  // one prepared move at a time.
  if (!deps.prepare) {
    let active = [];
    try { active = require('./prepared-move-store').activeV2({ now }); } catch { active = []; }
    for (const rec of active) {
      const duty = await (deps.readDuty || ((t) => require('./prepared-move').readDuty(t)))(now);
      const v = await v2View(rec, { now, duty, checks: deps.checks ? deps.checks({ now }) : null });
      if (v.move) return { ...base, elapsedMs: clock() - started, withheldCount: 0, ...(v.held ? { held: v.held } : {}), move: v.move };
    }
  }
  // ⚠ `pending` is NOT "no move": the check did not finish in time (a cold
  // start, a busy moment), so the answer is unknown — the client may ask again.
  // `nothing-prepared` is a real answer and is never retried.
  const none = (reason, say, extra = {}) => ({ ...base, move: null, pending: reason === 'not-ready-in-time', unavailable: { reason, say }, elapsedMs: clock() - started, ...extra });
  const prepare = deps.prepare || ((o) => require('./prepared-move').prepare(o));
  let packet;
  try {
    packet = await prepare({ now, budgetBy: started + budgetMs });
  } catch (e) {
    if (e instanceof require('./prepared-move').BudgetExceeded) return none('not-ready-in-time', `SAiM couldn’t check everything within ${budgetMs} ms, so nothing is offered.`);
    throw e;
  }
  // A packet that arrived late is not offered either: never stale or partial.
  if (clock() - started > budgetMs) return none('not-ready-in-time', `SAiM couldn’t check everything within ${budgetMs} ms, so nothing is offered.`);
  const withheldCount = (packet && Array.isArray(packet.withheld)) ? packet.withheld.length : 0;
  const s = packet && packet.selected;
  // Nothing prepared: offer to make the first eligible Now item ready (one action).
  let makeReady = null;
  try { makeReady = makeReadyFrom(packet, now); } catch { makeReady = null; }
  if (!s) return none('nothing-prepared', 'Nothing passed every check, so there is nothing to offer.', { withheldCount, makeReady });

  const slots = ((s.decision || {}).slots) || [];
  const first = slots.length ? exec.writesFor(packet, slots[0].id) : null;
  // An out-of-scope or sensitive move is not a move this screen can show.
  if (!first || !first.ok) return none('nothing-prepared', 'Nothing passed every check, so there is nothing to offer.', { withheldCount: withheldCount + 1 });

  const decidedMs = Date.parse((packet.decision || {}).decidedAt);
  if (!Number.isFinite(decidedMs)) return none('nothing-prepared', 'Nothing passed every check, so there is nothing to offer.', { withheldCount: withheldCount + 1 });
  const expiresAt = new Date(decidedMs + require('./prepared-move-store').EVIDENCE_LIFETIME_MS).toISOString();

  const prep = s.preparation || [];
  const draftMd = (prep.find((p) => p.draft) || {}).draft || '';
  const draftTitle = ((/^#\s+(.+)$/m.exec(draftMd) || [])[1] || s.title).replace(/\s*\(DRAFT prepared by SAiM\)\s*$/i, '').trim();
  const notePath = first.steps[1].path;
  const folded = {
    artefact: artefactFrom(draftMd),
    draft: { title: draftTitle, path: notePath, markdown: draftMd },
    evidence: (s.observed || []).map((o) => ({ fact: o.fact, kind: (o.source || {}).kind || null, observedAt: (o.source || {}).observedAt || null, caveat: o.caveat || null })),
    why: {
      because: (s.judgement || {}).because || [],
      goal: (s.outcome || {}).goal || null,
      doneWhen: (s.outcome || {}).doneWhen || null,
      willNot: (s.authority || {}).mustNot || [],
    },
  };

  // Off duty or on leave (or unknown — fails closed): HELD. The draft and its
  // evidence may be looked at; no time, question, write list or confirmation
  // is offered, and no fresh check runs. The next working window prepares the
  // move afresh and re-checks it before anything becomes actionable.
  const duty = packet.duty || { onDuty: false, why: 'unknown' };
  if (duty.onDuty !== true) {
    return {
      ...base,
      elapsedMs: clock() - started,
      withheldCount,
      held: { reason: duty.why, say: require('./prepared-move').HELD_SAY },
      move: {
        title: s.title,
        held: true,
        prepared: { headline: require('./prepared-move').HELD_SAY, detail: null },
        whyItMatters: (s.judgement || {}).summary || null,
        unresolved: unresolvedFrom(draftMd),
        options: [],
        ...folded,
        decidedAt: new Date(decidedMs).toISOString(),
      },
    };
  }

  // A pseudo-record, held in memory only, so the SAME fresh checks run.
  const options = {};
  const writesByOption = {};
  for (const slot of slots) {
    const w = exec.writesFor(packet, slot.id);
    if (w.ok) { options[slot.id] = { writeHash: w.writeHash, slot }; writesByOption[slot.id] = w; }
  }
  const record = { id: null, packet, options, evidenceExpiresAt: expiresAt };
  const checks = deps.checks ? deps.checks({ now }) : exec.defaultChecks({ adapters: { vault: exec.readOnlyVault() }, now });

  const offered = [];
  const notOffered = [];
  for (const slot of slots) {
    const w = writesByOption[slot.id];
    if (!w) continue;
    const r = await exec.freshChecks({ record, w, checks, now });
    if (r.ok) {
      offered.push({ id: slot.id, date: slot.date, start: slot.start, end: slot.end, label: `${dayLong(slot.date)} ${slot.start}–${slot.end}`, question: questionFor(slot), writes: w.confirmation.writes });
    } else {
      notOffered.push({ id: slot.id, label: `${dayLong(slot.date)} ${slot.start}–${slot.end}`, why: r.reasons.join(' ') });
    }
  }

  const title = humanTitle(s.subject, draftTitle);
  const forum = (s.decision || {}).forum || null;
  const citedLines = (s.observed || []).filter((o) => String(o.id || '').startsWith('line:')).length;

  // The fresh checks count against the same budget.
  if (clock() - started > budgetMs) return none('not-ready-in-time', `SAiM couldn’t check everything within ${budgetMs} ms, so nothing is offered.`);
  return {
    ...base,
    elapsedMs: clock() - started,
    withheldCount,
    move: {
      title: s.title,
      prepared: {
        headline: `I’ve drafted ${title}${forum ? ` for ${forum.title} on ${dayLong(forum.start.slice(0, 10))}` : ''}.`,
        detail: citedLines
          ? `It is arranged from ${citedLines} line${citedLines === 1 ? '' : 's'} already in your notes, each one cited. Nothing in it has been agreed yet.`
          : 'Nothing in it has been agreed yet.',
      },
      whyItMatters: (s.judgement || {}).summary || null,
      confidence: (s.judgement || {}).confidence || null,
      unresolved: unresolvedFrom(draftMd),
      options: offered,
      notOffered,
      contacts: first.confirmation.contacts,
      nothingElse: 'Nothing else changes: no email, invite, task, board card, goal or notification.',
      ...folded,
      forum,
      // The Surface's state for an actionable move (never used when held).
      moment: momentFor(forum),
      decidedAt: new Date(decidedMs).toISOString(),
      evidenceExpiresAt: expiresAt,
    },
  };
}

module.exports = { CONTRACT, BUDGET_MS, currentView, v2View, makeReadyFrom, humanTitle, questionFor, unresolvedFrom, artefactFrom, _setDeps };
