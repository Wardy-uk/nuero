'use strict';

/**
 * Commitment at risk — the second SEMANTIC evaluator (Build 4D, 3 Oct 2026).
 *
 * Not "you have overdue tasks" (every list already says that, and a list that
 * says it about 30 things is a list nobody reads). The question is narrower:
 * which PROMISES — made by Nick to someone, or to Nick by someone — are about
 * to matter, and still look unresolved on the evidence NEURO actually holds?
 *
 *   "Tech Leadership is Monday at 09:00. You took on "send the support
 *    figures" at the last one (28 Sep); it is still open and nothing newer
 *    says it is done."
 *
 * ── Shadow only. There is no live path. ────────────────────────────────────
 *
 * Findings go to commitment_risk_findings. At the recommended moment the
 * evaluator asks the EXISTING attention policy (ambient-push.worthInterrupting,
 * same moment read, every universal veto) what it WOULD do, records that, and
 * stops. It never sends, never queues, never returns a winner to deliver().
 * COMMITMENT_RISK_MODE is `shadow` (default) or `off`; `live` reads as shadow.
 *
 * ── Triggers (prefer false negatives) ──────────────────────────────────────
 *
 * Only COMMITMENTS are evaluated — a task nobody is waiting on is not at risk
 * of breaking a promise. Only OPEN ones. And only with one of:
 *
 *   deadline-near   a deadline someone STATED or SET falls today or tomorrow
 *   overdue         a stated/set deadline passed 1–14 days ago (older than
 *                   that is history, not risk: it is not raised at all)
 *   meeting-near    the commitment came out of the MOST RECENT written-up
 *                   occurrence of a meeting whose next occurrence (a real
 *                   meeting, other people in it, not declined) starts within
 *                   24h — and, for something somebody else owes, that person
 *                   is in the next one
 *
 * Never on its own: age, the mere existence of an item, a meeting coming up,
 * an urgent email, or NEURO's 10-day placeholder due date (`default`).
 *
 * Held back (recorded as "not raised", with why): a closed record with the
 * same wording (possible completion — not confirmed, not refuted), a waiting-on
 * Nick snoozed, a commitment Nick deferred "not today" in the lane, a stale
 * calendar under a meeting trigger.
 *
 * ── Dedupe ─────────────────────────────────────────────────────────────────
 *
 * One finding per (commitment, episode). An unchanged risk re-evaluated every
 * pass is the SAME finding (novelty `repeated`, nothing re-asked). A higher
 * level escalates it (novelty `escalated`, the attention verdict is asked
 * again). Completion, cancellation or the trigger lapsing RESOLVES it; a risk
 * that comes back later is a NEW episode.
 */

const crypto = require('crypto');
const db = require('../db/database');

const OVERDUE_HORIZON_DAYS = 14;
const MEETING_WINDOW_MIN = 24 * 60;
const MEETING_HIGH_MIN = 120;
const PREP_LEAD_MIN = 60;
const LEVELS = ['elevated', 'high'];
const SELF = 'person:nick-ward';

function mode() {
  const m = String(process.env.COMMITMENT_RISK_MODE || 'shadow').toLowerCase();
  return m === 'off' ? 'off' : 'shadow';
}

const collapse = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function _wm() { return require('./world-model'); }

function dayDiff(a, b) {
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(b) - t(a)) / 86400000);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Monday 5 Oct" from a wall-clock string — sliced, never re-zoned. */
function dayLabel(local) {
  const d = new Date(Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10)));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function shortDate(day) {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// ── evidence readers (real stores; injectable for tests) ────────────────────

function _nextOccurrence(c, nowLocal) {
  const wm = _wm();
  const occ = c.meeting && c.meeting.occurrence;
  if (!occ) return null;
  let series = null;
  const own = db.get('SELECT series_id FROM wm_meetings WHERE meeting_id = ?', [occ.meetingId]);
  if (own && own.series_id) series = own.series_id;
  const row = series
    ? db.get(`SELECT * FROM wm_meetings WHERE series_id = ? AND status = 'scheduled' AND start_local > ?
               ORDER BY start_local LIMIT 1`, [series, nowLocal])
    : db.get(`SELECT * FROM wm_meetings WHERE lower(title) = ? AND status = 'scheduled' AND start_local > ?
               ORDER BY start_local LIMIT 1`, [collapse(c.meetingSeriesKey), nowLocal]);
  return row ? wm.shapeMeeting(row) : null;
}

const DEFAULT_DEPS = {
  commitments: () => require('./world-obligations').listCommitments({ status: 'open', limit: 2000 }),
  task: (id) => require('./world-obligations').getTask(id),
  previousOccurrence: (seriesKey, beforeLocal) => require('./world-obligations').fromPreviousOccurrence(seriesKey, { beforeLocal }),
  nextOccurrence: _nextOccurrence,
  calendarFreshness: (nowMs) => {
    try { return require('./source-health').getSource('microsoft.calendar', { now: nowMs }).freshness; } catch { return 'unknown'; }
  },
  projection: () => {
    const st = require('./event-bus').getStatus().consumers.find((x) => x.name === 'world-model');
    return { lag: st ? st.lag : null, retrying: st ? st.retrying : null };
  },
  waitingSnoozedUntil: (sourceRef) => {
    if (!String(sourceRef).startsWith('waiting-on:')) return null;
    const r = db.get('SELECT snoozed_until FROM waiting_on WHERE key = ?', [sourceRef.slice('waiting-on:'.length)]);
    return r ? r.snoozed_until : null;
  },
  laneDeferral: (title) => {
    try {
      const lc = require('./attention-lifecycle');
      return lc.deferredKeys().get(lc.dedupeKeyFor({ type: 'todo', title })) || null;
    } catch { return undefined; }
  },
  plannedBlocks: (neuroTaskId) => db.all(`SELECT b.date_key, b.start_time, b.status FROM task_blocks b
      JOIN task_block_items i ON i.block_id = b.id WHERE i.task_id = ? AND b.status IN ('scheduled', 'awaiting-writeup')`, [neuroTaskId]),
  readMoment: (nowMs) => require('./ambient-push').readMoment({ now: new Date(nowMs) }),
  // Build 5D. Progress is read per commitment from the projection; the scan
  // that feeds it runs at the head of each pass, throttled.
  progress: (commitmentId) => require('./progress-evidence').progressFor(commitmentId),
  refreshProgress: (nowMs) => require('./progress-evidence').refresh({ now: nowMs }),
  // Build 5F: after the findings are written, prepare (never execute) the next
  // step for the strongest of them.
  prepareActions: (nowMs) => require('./prepared-actions').prepareFromRisk({ now: nowMs }),
  // Build 5A: a meeting-only risk is surfaced on the meeting's own finding.
  meetingFindingFor: (meetingId, startLocal) => require('./meeting-intelligence').activeFindingFor(meetingId, startLocal),
};

// ── the judgement ───────────────────────────────────────────────────────────

/**
 * Gather bounded evidence for one commitment and decide. Returns
 * { finding: false, why } or { finding: true, level, triggers, ... }.
 * A reader that fails is UNAVAILABLE evidence with a reason, never "nothing".
 */
function assess(c, { nowLocal, nowMs, deps }) {
  const today = nowLocal.slice(0, 10);
  const checked = [];
  const unavailable = [];
  const evidence = { commitment: c.provenance.evidence, task: null, progress: [] };
  const triggers = [];

  if (c.status !== 'open') return { finding: false, why: `not open (${c.status})` };

  // The task that realises it, when there is one — its sources are the facts.
  let task = null;
  if (c.relatedTaskId) {
    try { task = deps.task(c.relatedTaskId); checked.push('task'); } catch (e) { unavailable.push({ input: 'task', why: `unreadable: ${e.message}` }); }
    if (task) {
      evidence.task = { taskId: task.taskId, status: task.status, rawStatus: task.rawStatus, sources: task.sources.map((s) => `${s.system}:${s.status}`) };
      if (task.possibleCompletion) {
        return { finding: false, why: 'a record with the same wording is closed — a possible completion, not raised until it is confirmed or refuted', held: true };
      }
      if (task.rawStatus === 'in-progress') evidence.progress.push({ kind: 'marked-in-progress', at: task.updatedAt });
    }
  }

  // Nick's own "not now" decisions are honoured, never re-litigated here.
  const snoozed = deps.waitingSnoozedUntil(c.source.ref);
  checked.push('snooze');
  if (snoozed && Date.parse(snoozed) > nowMs) return { finding: false, why: `snoozed until ${snoozed.slice(0, 10)}`, held: true };
  const deferral = deps.laneDeferral(c.description);
  if (deferral === undefined) unavailable.push({ input: 'lane-deferrals', why: 'attention lifecycle unreadable' });
  else {
    checked.push('lane-deferral');
    if (deferral) return { finding: false, why: `deferred by Nick (${deferral.reason})${deferral.until ? ` until ${String(deferral.until).slice(0, 16)}` : ''}`, held: true };
  }

  // ── deadline triggers: only a deadline someone stated or set ─────────────
  let dueContext = null;
  if (c.due && (c.due.basis === 'stated' || c.due.basis === 'set')) {
    const days = dayDiff(today, c.due.date);
    if (days === 0) { triggers.push({ kind: 'deadline-near', level: 'high', detail: 'due today' }); dueContext = `due today (${c.due.date}, ${c.due.basis})`; }
    else if (days === 1) { triggers.push({ kind: 'deadline-near', level: 'elevated', detail: 'due tomorrow' }); dueContext = `due tomorrow (${c.due.date}, ${c.due.basis})`; }
    // ⚠ OVERDUE needs a deadline the commitment itself STATED. A date set
    // later is a plan, and missing one's own plan is not breaking a promise to
    // someone. Measured on the live store (3 Oct): 9 of the 10 overdue
    // findings a `set` date produced were dates re-set in bulk by a session
    // write (four tasks within three seconds at 11:30:00), not deadlines
    // anyone had been promised.
    else if (days < 0 && -days <= OVERDUE_HORIZON_DAYS && c.due.basis === 'stated') {
      triggers.push({ kind: 'overdue', level: 'high', detail: `${-days} day${-days === 1 ? '' : 's'} overdue` });
      dueContext = `due ${c.due.date} (${c.due.basis}), ${-days} day${-days === 1 ? '' : 's'} ago`;
    } else if (days < 0 && c.due.basis !== 'stated') dueContext = `a date set for ${c.due.date} has passed — a plan, not a stated deadline, so not raised`;
    else if (days < 0) dueContext = `due ${c.due.date}, ${-days} days ago — past the ${OVERDUE_HORIZON_DAYS}-day horizon, not raised`;
    else dueContext = `due ${c.due.date} (${c.due.basis})`;
  } else if (c.due) dueContext = `due ${c.due.date} — NEURO's ${c.due.basis} placeholder, not a stated deadline`;

  // ── the meeting trigger ───────────────────────────────────────────────────
  let relatedMeeting = null;
  if (c.meeting && c.meeting.occurrence) {
    let fresh = 'unknown';
    try { fresh = deps.calendarFreshness(nowMs); } catch { fresh = 'unknown'; }
    checked.push('calendar');
    let next = null;
    try { next = deps.nextOccurrence(c, nowLocal); } catch (e) { unavailable.push({ input: 'next-occurrence', why: `unreadable: ${e.message}` }); }
    if (next) {
      const mins = _wm().minutesBetween(nowLocal, next.start);
      relatedMeeting = { meetingId: next.meetingId, title: next.title, start: next.start, minutesAway: mins, kind: next.kind,
        responseStatus: next.responseStatus, previous: c.meeting.occurrence, notePath: c.meeting.notePath };
      const isMeeting = next.kind === 'meeting' && next.responseStatus !== 'declined';
      if (mins > 0 && mins <= MEETING_WINDOW_MIN && isMeeting) {
        if (fresh !== 'fresh') unavailable.push({ input: 'calendar', why: `calendar is ${fresh} — a next meeting read from it is not a fact, so the meeting trigger is not used` });
        else {
          // Only from the MOST RECENT written-up occurrence before the next one —
          // a commitment from three meetings ago is history, not tomorrow's agenda.
          let prev = null;
          try { prev = deps.previousOccurrence(c.meetingSeriesKey, next.start); } catch { prev = null; }
          const fromLatest = prev && prev.occurrence && prev.occurrence.meetingId === c.meetingId;
          let promisorThere = true;
          if (c.direction !== 'by-nick') {
            promisorThere = !!c.promisor.personId && next.participants.some((p) => p.personId === c.promisor.personId);
          }
          if (!fromLatest) relatedMeeting.why = 'from an older occurrence, not the last one written up';
          else if (!promisorThere) relatedMeeting.why = c.promisor.personId ? 'the person who owes it is not in the next one' : 'who owes it is unresolved, so it cannot be tied to the next meeting';
          else triggers.push({ kind: 'meeting-near', level: mins <= MEETING_HIGH_MIN ? 'high' : 'elevated', detail: `${next.title} in ${mins} min` });
        }
      }
    }
  }

  if (!triggers.length) return { finding: false, why: dueContext ? `no trigger (${dueContext})` : 'no stated deadline and no imminent related meeting' };

  // ── Build 5D: what NEURO has seen since it was made ───────────────────────
  // A likely fulfilment HOLDS the finding (recorded, with its reasons) — it
  // never completes the commitment. A contradiction (inferred done, then an
  // authoritative reopen) does not hold: the authority says it is open.
  let prog = null;
  try { prog = deps.progress ? deps.progress(c.commitmentId) : null; checked.push('progress-evidence'); } catch (e) {
    unavailable.push({ input: 'progress-evidence', why: `unreadable: ${e.message}` });
  }
  if (prog) {
    evidence.progressState = { state: prog.state, basis: prog.basis, reasons: prog.reasons, evidenceIds: prog.evidenceIds || [] };
    if (prog.state === 'likely_fulfilled') {
      return { finding: false, held: true, progress: prog,
        why: `likely already done (${prog.reasons.join('; ')}) — an inference, so not raised and NOT marked complete` };
    }
    if (prog.state === 'unknown') unavailable.push({ input: 'progress-evidence', why: prog.reasons.join('; ') });
  }

  // ── bounded progress evidence ─────────────────────────────────────────────
  if (task && task.sources.some((s) => s.system === 'neuro')) {
    const nid = task.sources.find((s) => s.system === 'neuro').recordId;
    try {
      const blocks = deps.plannedBlocks(Number(nid));
      checked.push('task-blocks');
      for (const b of blocks) evidence.progress.push({ kind: 'time-booked', at: `${b.date_key}T${b.start_time}`, status: b.status });
    } catch (e) { unavailable.push({ input: 'task-blocks', why: `unreadable: ${e.message}` }); }
  }
  if (c.lastProgressAt) evidence.progress.push({ kind: c.direction === 'by-nick' ? 'last-touched' : 'chased', at: c.lastProgressAt });

  const proj = deps.projection();
  checked.push('projection');
  if (proj.lag === null) unavailable.push({ input: 'projection', why: 'world-model consumer status unreadable' });
  else if (proj.lag > 0 || proj.retrying > 0) unavailable.push({ input: 'projection', why: `world model is ${proj.lag} event(s) behind — a later completion may not be applied yet` });

  // A booked block before the deadline is a plan: it holds the level at
  // elevated rather than high for a deadline trigger. A meeting trigger is not
  // softened — time booked is not the thing done.
  let level = triggers.map((t) => t.level).sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a))[0];
  const booked = evidence.progress.some((p) => p.kind === 'time-booked' && (!c.due || p.at.slice(0, 10) <= c.due.date));
  if (booked && level === 'high' && triggers.every((t) => t.kind !== 'meeting-near')) level = 'elevated';

  const base = c.direction === 'by-nick' ? 0.75 : 0.65;
  const confidence = Math.max(0.3, Math.min(0.9, base + 0.05 * (triggers.length - 1)
    + (c.promisor.personId ? 0 : -0.1) - 0.05 * unavailable.length - (booked ? 0.05 : 0)));
  return {
    finding: true, level, triggers, dueContext, relatedMeeting, evidence, unavailable, checked,
    confidence: Math.round(confidence * 100) / 100,
    lastProgress: evidence.progress.length ? evidence.progress[evidence.progress.length - 1] : null,
  };
}

// Strip a leading "Nick to " / "Nick Ward: " / "Hope Goodall - " so the quote is
// the action. Word-bounded: "Monitor Heidi's…" once lost its "Monito" to a
// pattern that read "Moni" + "to" as a name followed by "to" (caught on the
// live dry run).
function _q(s) { return `"${String(s).replace(/^[A-Z][a-z]+(?: [A-Z][a-z]+)?(?:\s+to\b|\s*[:\-–—])\s*/, '').slice(0, 120)}"`; }

/** One or two sentences, deterministic, no model. States evidence; draws no conclusion. */
function summarise(c, a) {
  const who = c.promisor.displayName || c.promisor.raw || 'Someone';
  const what = _q(c.description);
  const meet = a.triggers.find((t) => t.kind === 'meeting-near') ? a.relatedMeeting : null;
  const prevDay = c.meeting && c.meeting.occurrence ? shortDate(c.meeting.occurrence.start.slice(0, 10)) : null;
  const parts = [];
  if (meet) {
    parts.push(`${meet.title} is ${dayLabel(meet.start)} at ${meet.start.slice(11, 16)}.`);
    parts.push(c.direction === 'by-nick'
      ? `You took on ${what} at the last one${prevDay ? ` (${prevDay})` : ''}; it is still open and nothing newer says it is done.`
      : `${who} took on ${what} at the last one${prevDay ? ` (${prevDay})` : ''}; it is still open.`);
  } else if (c.direction === 'by-nick') {
    parts.push(`You committed to ${what}${c.meeting && prevDay ? ` (from the ${prevDay} meeting)` : ''}, ${a.dueContext}; it is still open.`);
  } else {
    parts.push(`${who} committed to ${what}, ${a.dueContext}; it is still open.`);
  }
  if (a.evidence.progress.some((p) => p.kind === 'time-booked')) parts.push('Time is booked for it.');
  return parts.join(' ');
}

function _fp(x) { return crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24); }

function _active(commitmentId) {
  return db.get(`SELECT * FROM commitment_risk_findings WHERE commitment_id = ? AND status = 'active'`, [commitmentId]);
}

/**
 * One pass, from the durable runtime. Returns counts plus `skipped` reasons.
 */
async function evaluate({ now = Date.now(), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const nowMs = now instanceof Date ? now.getTime() : now;
  const nowLocal = _wm().localMinute(nowMs);
  const iso = new Date(nowMs).toISOString();
  const out = { mode: mode(), considered: 0, created: 0, escalated: 0, updated: 0, resolved: 0, decided: 0, held: 0, skipped: [] };
  if (out.mode === 'off') return out;

  // Build 5D: gather what NEURO can see before judging. Never fails the pass.
  if (d.refreshProgress) {
    try { out.progressScan = await d.refreshProgress(nowMs); } catch (e) { out.progressScan = { error: e.message }; }
  }

  const open = d.commitments();
  const openIds = new Set(open.map((c) => c.commitmentId));

  // Anything with an active finding that is no longer open: resolved by its own state.
  for (const f of db.all(`SELECT * FROM commitment_risk_findings WHERE status = 'active'`)) {
    if (openIds.has(f.commitment_id)) continue;
    let status = 'gone';
    try { const c = require('./world-obligations').getCommitment(f.commitment_id); status = c ? c.status : 'gone'; } catch { /* keep gone */ }
    db.run(`UPDATE commitment_risk_findings SET status = 'resolved', resolution = ?, resolved_at = ?, updated_at = ? WHERE finding_id = ?`,
      [status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : `no-longer-open:${status}`, iso, iso, f.finding_id]);
    out.resolved += 1;
  }

  for (const c of open) {
    out.considered += 1;
    const a = assess(c, { nowLocal, nowMs, deps: d });
    const existing = _active(c.commitmentId);
    if (!a.finding) {
      if (a.held) out.held += 1;
      if (out.skipped.length < 50 && (a.held || existing)) out.skipped.push({ commitmentId: c.commitmentId, why: a.why });
      if (existing) {
        db.run(`UPDATE commitment_risk_findings SET status = 'resolved', resolution = ?, resolved_at = ?, updated_at = ? WHERE finding_id = ?`,
          [a.held ? `held: ${a.why}` : `lapsed: ${a.why}`, iso, iso, existing.finding_id]);
        out.resolved += 1;
      }
      continue;
    }
    const summary = summarise(c, a);
    const recommended = (() => {
      // A deadline trigger is about NOW; only a meeting-only finding waits for
      // the hour before the meeting.
      const m = a.triggers.every((t) => t.kind === 'meeting-near') ? a.relatedMeeting : null;
      if (!m) return nowLocal;
      const lead = require('./meeting-context').shiftLocal(m.start, -PREP_LEAD_MIN);
      return lead < nowLocal ? nowLocal : lead;
    })();
    const why = a.triggers.map((t) => `${t.kind}: ${t.detail}`).join('; ');
    const evidenceJson = JSON.stringify({ ...a.evidence, commitment: { id: c.commitmentId, source: c.source, meetingId: c.meetingId },
      promisor: c.promisor, beneficiary: c.beneficiary, direction: c.direction });
    const fp = _fp([a.triggers.map((t) => t.kind), a.level, a.evidence.progress, a.unavailable.map((u) => u.input)]);
    const meetingJson = a.relatedMeeting ? JSON.stringify(a.relatedMeeting) : null;

    if (!existing) {
      const prior = db.get('SELECT MAX(episode) e FROM commitment_risk_findings WHERE commitment_id = ?', [c.commitmentId]);
      const episode = (prior && prior.e ? prior.e : 0) + 1;
      db.run(`INSERT INTO commitment_risk_findings (finding_id, commitment_id, episode, status, level, triggers_json, summary, why,
                evidence_json, unavailable_json, checked_json, confidence, due_context, related_meeting_json, recommended_at,
                evidence_fingerprint, novelty, first_created_at, updated_at, decisions)
              VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, 0)`,
      [`commitment-risk:${c.commitmentId}:${episode}`, c.commitmentId, episode, a.level, JSON.stringify(a.triggers), summary, why,
        evidenceJson, JSON.stringify(a.unavailable), JSON.stringify(a.checked), a.confidence, a.dueContext, meetingJson,
        recommended, fp, iso, iso]);
      out.created += 1;
      console.log(`[CommitmentRisk] (shadow) ${a.level}: ${summary}`);
    } else if (LEVELS.indexOf(a.level) > LEVELS.indexOf(existing.level)) {
      // Escalated: same episode, higher level — and the attention verdict is
      // asked again, because "elevated yesterday" is not "high now".
      db.run(`UPDATE commitment_risk_findings SET level = ?, triggers_json = ?, summary = ?, why = ?, evidence_json = ?,
                unavailable_json = ?, checked_json = ?, confidence = ?, due_context = ?, related_meeting_json = ?, recommended_at = ?,
                evidence_fingerprint = ?, novelty = 'escalated', updated_at = ?, attention_decided_at = NULL WHERE finding_id = ?`,
      [a.level, JSON.stringify(a.triggers), summary, why, evidenceJson, JSON.stringify(a.unavailable), JSON.stringify(a.checked),
        a.confidence, a.dueContext, meetingJson, recommended, fp, iso, existing.finding_id]);
      out.escalated += 1;
    } else if (existing.evidence_fingerprint !== fp) {
      // Evidence moved but the risk did not rise: refreshed in place, not re-asked.
      db.run(`UPDATE commitment_risk_findings SET triggers_json = ?, summary = ?, why = ?, evidence_json = ?, unavailable_json = ?,
                checked_json = ?, confidence = ?, due_context = ?, related_meeting_json = ?, evidence_fingerprint = ?,
                novelty = CASE WHEN novelty = 'new' THEN 'repeated' ELSE novelty END, updated_at = ? WHERE finding_id = ?`,
      [JSON.stringify(a.triggers), summary, why, evidenceJson, JSON.stringify(a.unavailable), JSON.stringify(a.checked),
        a.confidence, a.dueContext, meetingJson, fp, iso, existing.finding_id]);
      out.updated += 1;
    }
    // Unchanged: nothing written. The same risk does not become a new finding.
  }

  // Build 5E: PREPARE (never execute) the next step for the strongest
  // findings, before attention is asked, so a finding and its draft are judged
  // together. A failure here costs the draft, never the finding.
  if (d.prepareActions) {
    try { out.prepared = await d.prepareActions(nowMs); } catch (e) { out.prepared = { error: e.message }; }
  }

  // What the EXISTING attention policy would do — once per finding per level,
  // at the recommended moment. Shadow: recorded, never sent.
  const due = db.all(`SELECT * FROM commitment_risk_findings WHERE status = 'active' AND attention_decided_at IS NULL
                       AND recommended_at <= ?`, [nowLocal]);
  let moment = null; let momentErr = null;
  if (due.length) { try { ({ moment } = await d.readMoment(nowMs)); } catch (e) { momentErr = e.message; } }
  for (const f of due) {
    let decision;
    let triggers = [];
    try { triggers = JSON.parse(f.triggers_json) || []; } catch { triggers = []; }
    const meetingOnly = triggers.length > 0 && triggers.every((t) => t.kind === 'meeting-near');
    let prepared = null;
    try { prepared = d.preparedFor ? d.preparedFor(f.finding_id) : require('./prepared-actions').forFinding(f.finding_id); } catch { prepared = null; }
    if (meetingOnly) {
      // ⚠ Build 5A: a risk that matters BECAUSE a meeting is coming is surfaced
      // once, on that meeting's finding (which carries this one as a linked
      // section). Asking here as well would be two interruptions about one
      // meeting. The meeting pipeline asks the attention question.
      let rm = null;
      try { rm = JSON.parse(f.related_meeting_json); } catch { rm = null; }
      let mf = null;
      try { mf = rm && d.meetingFindingFor ? d.meetingFindingFor(rm.meetingId, rm.start) : null; } catch { mf = null; }
      decision = { push: false, deferredTo: 'meeting-intelligence', meetingId: rm ? rm.meetingId : null,
        meetingFindingId: mf ? mf.findingId : null,
        why: 'a meeting-only risk is surfaced once, on the meeting\'s own finding — not asked here' };
    } else if (!moment) decision = { push: false, why: `could not read the moment: ${momentErr}` };
    else {
      const ap = require('./ambient-push');
      const v = ap.worthInterrupting({ kind: 'commitment-risk', text: f.summary, level: f.level, findingId: f.finding_id,
        preparedActionId: prepared ? prepared.actionId : null }, moment);
      decision = { push: !!v.push, why: v.why || null, urgency: v.urgency || null, wouldSay: v.push ? v.message : null };
    }
    if (prepared) decision.preparedAction = { actionId: prepared.actionId, type: prepared.actionType, status: prepared.status };
    db.run(`UPDATE commitment_risk_findings SET attention_decided_at = ?, attention_json = ?, attention_mode = 'shadow',
              attention_level = level, decisions = decisions + 1, updated_at = ? WHERE finding_id = ?`,
    [iso, JSON.stringify({ ...decision, shadow: true, sent: false }), iso, f.finding_id]);
    out.decided += 1;
  }
  return out;
}

function findings({ status = null, limit = 50 } = {}) {
  const rows = status
    ? db.all('SELECT * FROM commitment_risk_findings WHERE status = ? ORDER BY updated_at DESC LIMIT ?', [status, limit])
    : db.all('SELECT * FROM commitment_risk_findings ORDER BY updated_at DESC LIMIT ?', [limit]);
  const j = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return rows.map((r) => ({
    findingId: r.finding_id, commitmentId: r.commitment_id, episode: r.episode, status: r.status, level: r.level,
    novelty: r.novelty, summary: r.summary, why: r.why, triggers: j(r.triggers_json), dueContext: r.due_context,
    relatedMeeting: j(r.related_meeting_json), evidence: j(r.evidence_json), unavailable: j(r.unavailable_json),
    checked: j(r.checked_json), confidence: r.confidence, recommendedAt: r.recommended_at,
    attention: r.attention_json ? { mode: r.attention_mode, decidedAt: r.attention_decided_at, level: r.attention_level, ...j(r.attention_json) } : null,
    firstCreatedAt: r.first_created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at, resolution: r.resolution,
  }));
}

module.exports = { mode, assess, summarise, evaluate, findings, dayLabel, OVERDUE_HORIZON_DAYS, MEETING_WINDOW_MIN, SELF };
