'use strict';

/**
 * promise-score-v1 — how Nick kept his word THIS London week (21 Oct 2026).
 * READ-ONLY: nothing here writes, anywhere.
 *
 * For every promise whose due point falls in the week it says ONE thing:
 *   kept-on-time  ticked on or before its due day, or a governed send read back
 *                 in Sent Items before its due point;
 *   late          ticked after its due day, delivered after the due point, or
 *                 the point has passed while it is still open;
 *   unverified    delivered with Sent Items evidence that cannot place it
 *                 either side of the due point;
 *   pending       still open and its due point has not come yet;
 *   dropped       Nick abandoned it — listed, never counted as kept or broken.
 * And, separately, how many promises were RE-DATED during the week (a date move,
 * or a re-commit Nick made on purpose — the two are told apart).
 *
 * ── A tick IS delivery (Nick, 26 Oct 2026) ────────────────────────────────────
 * "If I tick a task off, it's done, and the promise is delivered." A ticked
 * record counts as kept; its completion DAY decides on time vs late. The score
 * is measured whenever the task list can be read — it no longer waits for a
 * governed send to exist. (Until 26 Oct a tick was scored `unverified` and the
 * score stayed "Not measured" until a delivery email was sent through NEURO —
 * a rule Nick never asked for.)
 *
 * ── Sent Items evidence, when there is one ──────────────────────────────────
 * A GOVERNED send that names the promise (prepared_actions, its evidence
 * carrying `promiseKey` and move `deliver-email`) whose action is `verified`
 * AND whose latest verification record is `verified` — i.e. the exact message
 * was read back in Sent Items (action-executor.judgeSentItem). It outranks a
 * tick when both exist. Never evidence:
 *   - progress-evidence's `likely_fulfilled` is an INFERENCE, never proof;
 *   - a chase is progress, not delivery;
 *   - 'executed' (provider said 202) is transport, not delivery.
 * The send time is bracketed: the attempt asked for the send at `sentNotBefore`
 * and Sent Items had it by `provenBy` (the verification). Kept-on-time needs
 * `provenBy` before the due point; late needs `sentNotBefore` after it; a
 * bracket that straddles the point is UNVERIFIED for timing, and says so.
 *
 * Those sends are prepared by services/promise-delivery. `proofSource` still
 * reports whether that path is connected, but the score no longer depends on it.
 *
 * ── Due point ───────────────────────────────────────────────────────────────
 * The date stated in the promise's own wording, else the task's due date when
 * NEURO knows it was SET or STATED (wm_commitments.due_basis). The 10-day
 * placeholder (`default`) is not a promise of a date: such promises are
 * `undated` and never counted as due. The point is the END of that London
 * day — delivered before 00:00 London the next day is on time, across BST/GMT.
 *
 * ── The Monday report is NOT a promise ──────────────────────────────────────
 * The Weekly Risk report owed to Chris by midday on the week's first working
 * day has its own status (`mondayReport`) and never enters the counts.
 *
 * ⚠ An employment matter is counted and NEVER described: its entry carries the
 *   key, task ids, outcome and a rule category only (promise-observe's rule).
 */

const CONTRACT = 'promise-score-v1';
const TZ = 'Europe/London';
const PROOF_RULE = 'governed-send-verified-in-sent-items';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ── London time (PURE) ───────────────────────────────────────────────────────

const msOf = (now) => (typeof now === 'number' ? now : Date.parse(now));

/** PURE. 'YYYY-MM-DD HH:MM' London wall clock for an instant. */
function londonWall(ms) {
  const s = new Date(Math.floor(ms / 1000) * 1000).toLocaleString('sv-SE', { timeZone: TZ });
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

/** PURE. London minus UTC, in minutes, at an instant (60 in BST, 0 in GMT). */
function londonOffsetMin(ms) {
  const whole = Math.floor(ms / 1000) * 1000;
  const wall = new Date(whole).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T') + 'Z';
  return Math.round((Date.parse(wall) - whole) / 60000);
}

/** PURE. The instant of a London wall-clock time. UK changes clocks at 01:00 UTC, so midnight is never ambiguous. */
function londonInstant(dateKey, hhmm = '00:00') {
  const guess = Date.parse(`${dateKey}T${hhmm}:00Z`);
  if (!Number.isFinite(guess)) return NaN;
  let ms = guess - londonOffsetMin(guess) * 60000;
  const off = londonOffsetMin(ms);
  if (guess - off * 60000 !== ms) ms = guess - off * 60000;
  return ms;
}

/** PURE. Calendar arithmetic on a YYYY-MM-DD key. */
function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const weekdayOf = (dateKey) => new Date(`${dateKey}T12:00:00Z`).getUTCDay();

/** PURE. The London Monday–Sunday week containing `now`, with exact instant bounds [startMs, endMs). */
function londonWeek(now) {
  const today = londonWall(msOf(now)).date;
  const start = addDays(today, -((weekdayOf(today) + 6) % 7));
  const end = addDays(start, 6);
  return { start, end, startMs: londonInstant(start), endMs: londonInstant(addDays(start, 7)) };
}

/** PURE. "Tuesday 21 October 2026, 15:30 (London)". */
function londonLabel(ms) {
  const w = londonWall(ms);
  const d = new Date(`${w.date}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${w.time} (London)`;
}

/** PURE. "Tuesday 21 October". */
function dayLabel(dateKey) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** PURE. A SQLite/ledger UTC stamp ('YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM:SS', no zone) → ms. */
function utcStampMs(s) {
  if (!s) return NaN;
  const t = String(s).trim().replace(' ', 'T');
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
}

// ── The due point (PURE) ─────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * PURE. Where a promise's due point is, and on what basis — or why it has none.
 * `dueBasis` is wm_commitments.due_basis for the lead task (stated | set | default | none), or null if unknown.
 */
function duePoint(promise, dueBasis = null) {
  const stated = promise.statedDate && DATE_ONLY.test(promise.statedDate.date) ? promise.statedDate.date : null;
  if (stated) return { date: stated, basis: 'stated-in-wording', endsMs: londonInstant(addDays(stated, 1)) };
  const due = promise.due && DATE_ONLY.test(String(promise.due).slice(0, 10)) ? String(promise.due).slice(0, 10) : null;
  if (!due) return { date: null, basis: null, undatedWhy: 'no date stated or set' };
  if (dueBasis === 'default') return { date: null, basis: 'default', undatedWhy: 'only the 10-day placeholder date — no date was promised' };
  return { date: due, basis: dueBasis === 'stated' || dueBasis === 'set' ? dueBasis : 'task-due-date', endsMs: londonInstant(addDays(due, 1)) };
}

// ── Classification (PURE) ────────────────────────────────────────────────────

/** PURE. How a closed promise closed: 'done' if any record was ticked, else 'dropped'. */
function closedAs(promise) {
  const recs = promise.records || [];
  if (recs.some((r) => r.status === 'done')) return 'done';
  if (recs.length && recs.every((r) => r.status === 'dropped')) return 'dropped';
  return (promise.tickedWithoutEvidence || []).length ? 'done' : 'dropped';
}

/**
 * PURE. The outcome of one dated promise. `proof` is the verified delivery
 * (see the header) or null.
 */
function classify(promise, due, proof, nowMs) {
  const ends = due.endsMs;
  if (proof) {
    const proven = { kind: 'verified-send', rule: PROOF_RULE, actionId: proof.actionId, messageRef: proof.messageRef || null,
      sentNotBefore: proof.sentNotBefore || null, provenBy: proof.provenBy };
    const by = Date.parse(proof.provenBy);
    const from = proof.sentNotBefore ? Date.parse(proof.sentNotBefore) : NaN;
    if (Number.isFinite(by) && by < ends) {
      return { outcome: 'kept-on-time', rule: 'delivery read back in Sent Items before the due point', evidence: [proven] };
    }
    if (Number.isFinite(from) && from >= ends) {
      return { outcome: 'late', rule: 'delivery read back in Sent Items, sent after the due point', evidence: [proven] };
    }
    return { outcome: 'unverified', rule: 'delivery proven, but the proof cannot place it before the due point', evidence: [proven] };
  }
  if (promise.open) {
    if (nowMs >= ends) return { outcome: 'late', rule: 'its due point has passed with no delivery evidence', evidence: [] };
    return { outcome: 'pending', rule: 'its due point has not come yet', evidence: [] };
  }
  if (closedAs(promise) === 'dropped') return { outcome: 'dropped', rule: 'you dropped it', evidence: [] };
  // A tick is delivery (Nick, 26 Oct 2026). completedAt is a London day; the
  // latest tick across the promise's records is when it was done.
  const ticked = (promise.records || []).filter((r) => r.status === 'done');
  const evidence = ticked.map((r) => ({ kind: 'ticked', taskId: r.taskId, at: r.completedAt || null }));
  const days = ticked.map((r) => r.completedAt).filter(Boolean).sort();
  const doneDay = days.length ? days[days.length - 1] : null;
  if (doneDay && due.date && doneDay > due.date) return { outcome: 'late', rule: 'ticked after its due day', evidence };
  return { outcome: 'kept-on-time', rule: doneDay ? 'ticked on or before its due day' : 'ticked (the day was not recorded)', evidence };
}

/** PURE. The category of an employment matter — never its words (promise-observe's rule). */
function sensitiveCategory(s) {
  try { return require('./promise-observe').sensitiveRule(s); } catch { return 'hr-other'; }
}

/** PURE. A promise as the score shows it: identity and evidence, or — for an employment matter — the key and a category only. */
function entryFor(promise, due, verdict) {
  const sensitive = Boolean(promise.sensitivity && promise.sensitivity.sensitive);
  const base = { key: promise.key, taskIds: promise.taskIds, outcome: verdict.outcome, rule: verdict.rule };
  if (sensitive) return { ...base, sensitive: true, sensitiveRule: sensitiveCategory(promise.sensitivity), text: null, due: null, owedTo: null, evidence: verdict.evidence.map((e) => ({ kind: e.kind })) };
  return {
    ...base, sensitive: false, text: promise.text,
    due: due.date ? { date: due.date, basis: due.basis, endsAt: new Date(due.endsMs).toISOString() } : null,
    owedTo: promise.owedTo ? promise.owedTo.resolved || null : null,
    source: promise.source ? { title: promise.source.title || null, path: promise.source.path || null } : null,
    evidence: verdict.evidence,
  };
}

/** PURE. Re-dates inside [startMs, endMs): date moves and deliberate re-commits, told apart. */
function reDatesIn(promise, week) {
  const inWeek = (s) => { const t = utcStampMs(s); return Number.isFinite(t) && t >= week.startMs && t < week.endMs; };
  const slips = promise.slips || {};
  return { moved: (slips.dueMovesAt || []).filter(inWeek).length, recommitted: (slips.recommitsAt || []).filter(inWeek).length };
}

/**
 * PURE. The week's score.
 *   promises    promise-ledger-v1 promises
 *   proofs      Map promiseKey → proof (see readProofs)
 *   dueBases    Map promiseKey → due_basis | null
 *   proofSource { status: 'connected' | 'not-connected' | 'unreadable', why }
 */
function scoreWeek({ promises = [], proofs = new Map(), dueBases = new Map(), proofSource = { status: 'not-connected' }, week, now, gaps = [] }) {
  const nowMs = msOf(now);
  const wk = week || londonWeek(nowMs);
  const counts = { due: 0, keptOnTime: 0, late: 0, unverified: 0, pending: 0, dropped: 0, reDated: 0, undated: 0, beforeProofSource: 0 };
  const reDated = { moved: 0, recommitted: 0 };
  const entries = [];
  const reDatedEntries = [];
  const undated = [];
  for (const p of promises) {
    const rd = reDatesIn(p, wk);
    if (rd.moved || rd.recommitted) {
      counts.reDated += 1; reDated.moved += rd.moved; reDated.recommitted += rd.recommitted;
      const sensitive = Boolean(p.sensitivity && p.sensitivity.sensitive);
      reDatedEntries.push({ key: p.key, taskIds: p.taskIds, moved: rd.moved, recommitted: rd.recommitted,
        rule: rd.recommitted && !rd.moved ? 're-committed by you to a date you chose' : 'its due date was moved this week',
        ...(sensitive ? { sensitive: true, sensitiveRule: sensitiveCategory(p.sensitivity), text: null } : { sensitive: false, text: p.text }) });
    }
    const due = duePoint(p, dueBases.get(p.key) || null);
    if (!due.date) {
      if (p.open && due.basis === 'default') { counts.undated += 1; undated.push({ key: p.key, why: due.undatedWhy }); }
      continue;
    }
    if (due.date < wk.start || due.date > wk.end) continue;
    const verdict = classify(p, due, proofs.get(p.key) || null, nowMs);
    entries.push(entryFor(p, due, verdict));
    if (verdict.outcome === 'dropped') { counts.dropped += 1; continue; }
    counts.due += 1;
    if (verdict.outcome === 'kept-on-time') counts.keptOnTime += 1;
    else if (verdict.outcome === 'late') counts.late += 1;
    else if (verdict.outcome === 'unverified') counts.unverified += 1;
    else counts.pending += 1;
  }
  entries.sort((a, b) => String((a.due || {}).date || '').localeCompare(String((b.due || {}).date || '')) || a.taskIds[0] - b.taskIds[0]);
  const settled = counts.due - counts.pending;
  const readable = !gaps.some((g) => g.input === 'tasks');
  const measured = readable;
  return {
    contract: CONTRACT,
    week: { start: wk.start, end: wk.end, startsAt: new Date(wk.startMs).toISOString(), endsAt: new Date(wk.endMs).toISOString(), label: `Week of ${dayLabel(wk.start)}` },
    generatedAt: new Date(nowMs).toISOString(),
    counts,
    reDated,
    // NULL, never a number, only when the task list could not be read.
    ratio: measured ? { kept: counts.keptOnTime, of: settled } : null,
    measured,
    proofSource: { rule: PROOF_RULE, ...proofSource },
    why: !readable ? 'NEURO couldn’t read the task list, so nothing is counted as kept.' : null,
    entries,
    reDatedEntries,
    undated,
    gaps,
  };
}

// ── The Monday report (PURE) ─────────────────────────────────────────────────

/**
 * PURE. The status of the Weekly Risk report for the week — kept apart from
 * ordinary promises. `sent` is weekly-risk.sentRecord(week); `sendProof` is
 * the governed action's verification ({ verified, provenBy }) when the send
 * went through NEURO; `published` is weekly-risk.publishedAt(week).
 */
function mondayReport({ week, dueDay = null, published = null, sent = null, sendProof = null, now, known = true }) {
  const nowMs = msOf(now);
  const day = dueDay || week;
  const dueMs = londonInstant(day, '12:00');
  const base = { week, dueAt: new Date(dueMs).toISOString(), dueLabel: londonLabel(dueMs) };
  if (!known) return { ...base, state: 'unknown', rule: 'NEURO couldn’t read the report’s records', evidence: [] };
  if (sent && sent.sentAt) {
    const at = Date.parse(sent.sentAt);
    if (sent.actionId && sendProof && sendProof.verified) {
      const by = Date.parse(sendProof.provenBy);
      const onTime = Number.isFinite(by) && by <= dueMs;
      return { ...base, state: onTime ? 'sent-verified-on-time' : 'sent-verified-late',
        rule: onTime ? 'sent through NEURO and read back in Sent Items by the deadline' : 'sent through NEURO and read back in Sent Items after the deadline',
        evidence: [{ kind: 'verified-send', actionId: sent.actionId, provenBy: sendProof.provenBy }] };
    }
    return { ...base, state: 'sent-unverified',
      rule: sent.reportedByNick ? 'you recorded sending it yourself — your word, not a read-back' : 'a send is recorded, but it was not read back in Sent Items',
      evidence: [{ kind: sent.reportedByNick ? 'reported-by-nick' : 'send-record', at: Number.isFinite(at) ? new Date(at).toISOString() : null }] };
  }
  if (published) return { ...base, state: 'written-no-send-record', rule: 'written, but no send is recorded — not the same as not sent', evidence: [{ kind: 'published' }] };
  return nowMs < dueMs
    ? { ...base, state: 'due', rule: 'not yet due', evidence: [] }
    : { ...base, state: 'late', rule: 'its deadline has passed with nothing written or sent', evidence: [] };
}

// ── Readers ──────────────────────────────────────────────────────────────────

const _db = () => require('../db/database');
const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };

/**
 * The verified deliveries that name a promise. Reads prepared_actions,
 * action_attempts and action_verifications only.
 */
function _executionOn() {
  try { return require('./feature-flags').isEnabled('governed_execution') === true; } catch { return false; }
}

/**
 * The source is CONNECTED only when both are true — otherwise the score stays
 * unmeasured (fail closed):
 *   - at least one promise-linked deliver-email has been prepared through the
 *     governed path (promise-delivery) — the score measures from then on
 *     (`connectedSince`); and
 *   - "Send approved emails" (governed_execution) is on, so a delivery CAN be
 *     sent and read back.
 */
function readProofs(db = _db(), { executionOn = _executionOn } = {}) {
  const proofs = new Map();
  let rows;
  try {
    rows = db.all(`SELECT action_id, status, evidence_json, verified_at, created_at FROM prepared_actions WHERE evidence_json LIKE '%promiseKey%'`);
  } catch (e) {
    return { proofs, source: { status: 'unreadable', why: e.message } };
  }
  const linked = rows.map((r) => ({ ...r, ev: parse(r.evidence_json) || {} })).filter((r) => r.ev.promiseKey && r.ev.move === 'deliver-email');
  for (const r of linked) {
    if (r.status !== 'verified' || r.ev.move !== 'deliver-email') continue;
    let v; let att;
    try {
      v = db.get(`SELECT checked_at, outcome, proof_json, attempt_id FROM action_verifications WHERE action_id = ? ORDER BY id DESC LIMIT 1`, [r.action_id]);
      att = v ? db.get(`SELECT started_at, send_requested_at, send_outcome FROM action_attempts WHERE attempt_id = ?`, [v.attempt_id]) : null;
    } catch { continue; }
    if (!v || v.outcome !== 'verified') continue;
    const proof = { actionId: r.action_id, provenBy: v.checked_at, sentNotBefore: att ? att.send_requested_at || att.started_at || null : null,
      messageRef: (parse(v.proof_json) || {}).messageRef || null };
    const prev = proofs.get(r.ev.promiseKey);
    if (!prev || Date.parse(proof.provenBy) < Date.parse(prev.provenBy)) proofs.set(r.ev.promiseKey, proof);
  }
  if (!linked.length) return { proofs, source: { status: 'not-connected', why: 'no promise delivery has been prepared yet, so the score starts with the first one' } };
  const on = typeof executionOn === 'function' ? executionOn() : Boolean(executionOn);
  if (!on) return { proofs: new Map(), source: { status: 'not-connected', why: '“Send approved emails” is off, so no promise delivery can be read back', linkedActions: linked.length } };
  const connectedSince = linked.map((r) => r.created_at).filter(Boolean).sort()[0] || null;
  return { proofs, source: { status: 'connected', connectedSince, linkedActions: linked.length, verifiedDeliveries: proofs.size } };
}

/** due_basis for each promise's lead task, from the world model (commitment:task:<id>). */
function readDueBases(promises, db = _db()) {
  const out = new Map();
  for (const p of promises) {
    try {
      const r = db.get(`SELECT due_basis FROM wm_commitments WHERE commitment_id = ?`, [`commitment:task:${p.leadTaskId || p.taskIds[0]}`]);
      out.set(p.key, r ? r.due_basis || null : null);
    } catch { out.set(p.key, null); }
  }
  return out;
}

function _mondayReportNow(nowMs, week) {
  try {
    const wr = require('./weekly-risk');
    let dueDay = week.start;
    try {
      const wd = require('./working-days');
      for (let i = 0; i < 5; i++) { const d = addDays(week.start, i); if (wd.isWorkingDay(new Date(`${d}T12:00:00`))) { dueDay = d; break; } }
    } catch { /* Monday */ }
    const sent = wr.sentRecord(week.start);
    let sendProof = null;
    if (sent && sent.actionId) {
      const v = _db().get(`SELECT checked_at, outcome FROM action_verifications WHERE action_id = ? ORDER BY id DESC LIMIT 1`, [sent.actionId]);
      sendProof = v ? { verified: v.outcome === 'verified', provenBy: v.checked_at } : { verified: false };
    }
    const out = mondayReport({ week: week.start, dueDay, published: wr.publishedAt(week.start), sent, sendProof, now: nowMs });
    // The saved report, so the card can show what was actually sent (22 Oct 2026):
    // subject, time, recipient NAMES (never addresses) and the opening lines.
    if (sent && sent.sentAt) {
      const body = String(sent.body || '').replace(/<[^>]+>/g, ' ').replace(/[#*_`>|]/g, ' ').replace(/\s+/g, ' ').trim();
      out.report = {
        subject: sent.subject || null, sentAt: sent.sentAt,
        recipients: (Array.isArray(sent.recipients) ? sent.recipients : []).map((r) => (typeof r === 'string' ? (r.includes('@') ? null : r) : (r && r.name) || null)).filter(Boolean),
        excerpt: body ? (body.length > 420 ? `${body.slice(0, 420).replace(/\s+\S*$/, '')}…` : body) : null,
        reportedByNick: Boolean(sent.reportedByNick),
      };
    }
    return out;
  } catch (e) {
    return mondayReport({ week: week.start, now: nowMs, known: false });
  }
}

/** The score for the London week containing `now`, the week before, and the Monday report. Reads only. */
function read({ now = Date.now(), ledger = null } = {}) {
  const nowMs = msOf(now);
  const facts = ledger || require('./promise-ledger').read({ now: nowMs });
  const { proofs, source } = readProofs();
  const dueBases = readDueBases(facts.promises);
  const week = londonWeek(nowMs);
  const prevWeek = londonWeek(week.startMs - 1);
  const current = scoreWeek({ promises: facts.promises, proofs, dueBases, proofSource: source, week, now: nowMs, gaps: facts.gaps });
  const previous = scoreWeek({ promises: facts.promises, proofs, dueBases, proofSource: source, week: prevWeek, now: nowMs, gaps: facts.gaps });
  return { ...current, previous: { week: previous.week, counts: previous.counts, ratio: previous.ratio }, mondayReport: _mondayReportNow(nowMs, week) };
}

module.exports = {
  CONTRACT, PROOF_RULE,
  londonWall, londonOffsetMin, londonInstant, londonWeek, londonLabel, dayLabel, addDays, utcStampMs,
  duePoint, classify, closedAs, reDatesIn, scoreWeek, mondayReport,
  readProofs, readDueBases, read,
};
