'use strict';

/**
 * SAiM's judgement over promises Nick made in meetings — OWNED BY SAiM (18 Oct 2026).
 *
 * Three pure parts, all over NEURO's promise ledger (promise-ledger-v1):
 *   1. DISCOVERY — the pattern-derived proposal "Promises made in meetings close
 *      within 7 days", raised only when the evidence threshold is met.
 *   2. JUDGEMENT — for one promise: its state and the moves SAiM may prepare.
 *   3. BUDGET — when SAiM may raise a proposal or prompt about a promise.
 *
 * PURE: facts in, judgement out. No I/O, no clock (`now` is passed), nothing
 * required from backend/.
 */

const crypto = require('crypto');

const POLICY_VERSION = '2026-10-18.1';
const PROPOSAL_FINGERPRINT = 'pattern:meeting-promises-close-7d';
const PROPOSAL_CLASS = 'pattern';

/** Pattern threshold (operating model §Goal Discovery, class 2). */
const MIN_OCCURRENCES = 3;
const MIN_SPAN_DAYS = 14;
const RECENT_DAYS = 28;

const DAY = 86400000;
// Europe/London calendar day (the Pi may run UTC; a 00:30 BST read is today, not yesterday).
const ymd = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** PURE. Did this promise slip, as an observed fact? */
function slipped(p) {
  return p.slips.dueMoves >= 2 || p.slips.lapsedBlocks >= 1 || p.slips.statedDatePassed;
}

// ── 1. Discovery ─────────────────────────────────────────────────────────────

/**
 * Evaluate the pattern threshold. Returns { qualifies, verdicts, occurrences, proposal|null }.
 * Every verdict is stated, so a "no" says which test failed.
 */
function discover(ledger, { now }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const since = ymd(nowMs - RECENT_DAYS * DAY);
  const all = (ledger && ledger.promises) || [];
  const occ = all.filter((p) => slipped(p) && p.slips.lastSlipAt && p.slips.lastSlipAt >= since);
  const named = occ.filter((p) => p.owedTo.people.length || (p.owedTo.fromNote && p.owedTo.fromNote.people.length) || p.owedTo.ambiguous.length);
  const firstSeen = occ.map((p) => p.firstSeen).sort()[0] || null;
  const span = firstSeen ? daysBetween(firstSeen, ymd(nowMs)) : 0;
  const verdicts = [
    { test: 'recurrence', pass: occ.length >= MIN_OCCURRENCES && span >= MIN_SPAN_DAYS,
      why: `${occ.length} promises from meetings slipped in the last ${RECENT_DAYS} days, over ${span} days (need ≥${MIN_OCCURRENCES} over ≥${MIN_SPAN_DAYS})` },
    { test: 'consequence', pass: named.length >= 1, why: `${named.length} of them are owed to a named person` },
    { test: 'intervention', pass: occ.length >= 1, why: 'each one can be delivered, re-committed to a date you set, or dropped — your call, weekly' },
    { test: 'measurable', pass: true, why: 'NEURO can read whether each promise was delivered, re-committed or slipped' },
    { test: 'readable', pass: !(ledger.gaps || []).some((g) => g.input === 'tasks' || g.input === 'activity'),
      why: (ledger.gaps || []).length ? `gaps: ${(ledger.gaps || []).map((g) => g.input).join(', ')}` : 'every source read' },
  ];
  const qualifies = verdicts.every((v) => v.pass);
  return { qualifies, verdicts, occurrences: occ.map((p) => p.key), proposal: qualifies ? proposalFor(ledger, occ, named, { nowMs, firstSeen }) : null };
}

/** The proposal itself — observed facts kept apart from SAiM's interpretation. */
function proposalFor(ledger, occ, named, { nowMs, firstSeen }) {
  const moves = occ.reduce((n, p) => n + p.slips.dueMoves, 0);
  const lapsed = occ.reduce((n, p) => n + p.slips.lapsedBlocks, 0);
  const examples = occ.slice(0, 3).map((p) => ({
    key: p.key, text: p.text, slips: p.slips.dueMoves + p.slips.lapsedBlocks, firstSeen: p.firstSeen,
  }));
  const observedAt = ledger.readAt;
  const evidence = [
    { kind: 'observed', fact: `${occ.length} promises made in meetings slipped in the last 4 weeks: their dates were moved ${moves} times and ${lapsed} focus blocks for them lapsed.`, source: 'tasks, activity log, task blocks', observedAt },
    { kind: 'observed', fact: `${named.length} of them are owed to a named person.`, source: 'meeting notes, People notes', observedAt },
    { kind: 'observed', fact: `The oldest still open first surfaced on ${firstSeen}.`, source: 'tasks', observedAt },
    { kind: 'interpretation', fact: 'Booking a block has been standing in for keeping the promise: the date moves with each booking, so nothing ever says it is late.' },
  ];
  const snapshot = { occurrences: occ.map((p) => ({ key: p.key, dueMoves: p.slips.dueMoves, lapsedBlocks: p.slips.lapsedBlocks, statedDatePassed: p.slips.statedDatePassed })), readAt: observedAt };
  return {
    fingerprint: PROPOSAL_FINGERPRINT,
    class: PROPOSAL_CLASS,
    policyVersion: POLICY_VERSION,
    title: 'Promises made in meetings close within 7 days',
    whyNow: `${occ.length} promises from your meetings slipped in the last four weeks — ${moves} date moves and ${lapsed} lapsed blocks.`,
    evidence,
    examples,
    confidence: occ.length >= 5 && named.length >= 2 ? 'high' : 'moderate',
    benefit: 'Fewer broken promises to your team, and slippage made visible the week it happens instead of never.',
    cost: 'About 20 minutes a week deciding deliver, re-commit or drop — and some honest "not this week"s to people.',
    definitionOfDone: 'Four consecutive weeks in which no promise to a named person passes its date without delivery evidence or a re-commit you made.',
    firstStep: `A list of the ${occ.length} slipped promises, each with the sentence it came from and how often it slipped, ready for deliver / re-commit / drop. Prepared only — nothing is sent or changed.`,
    responses: ['accept', 'change', 'defer', 'never'],
    evidenceHash: hashOf(snapshot),
    evidenceSnapshot: snapshot,
  };
}

const hashOf = (x) => crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 16);

/**
 * "Materially new evidence" for a deferred or rejected proposal: a promise that
 * was not in the snapshot slipped. More of the same promises slipping again is
 * not new.
 */
function materiallyNew(prevSnapshot, nextSnapshot) {
  const before = new Set(((prevSnapshot && prevSnapshot.occurrences) || []).map((o) => o.key));
  return ((nextSnapshot && nextSnapshot.occurrences) || []).some((o) => !before.has(o.key));
}

// ── 2. Judgement per promise ─────────────────────────────────────────────────

/**
 * State and allowed moves for one promise.
 * `closed` comes from the loop's own record (delivery evidence or Nick's word).
 */
function judge(p, { now, closed = null, recommits = [] } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const today = ymd(nowMs);
  if (closed) return { key: p.key, state: 'closed', closedBy: closed.kind, moves: [], routing: null };
  if (!p.open && !closed) {
    // Ticked with no delivery evidence: a tick is not delivery (task 149).
    return { key: p.key, state: 'ticked-no-evidence', moves: ['delivered', 'reopen'], routing: null };
  }
  const lastRecommit = recommits.slice().sort((a, b) => a.at.localeCompare(b.at)).pop() || null;
  const date = lastRecommit ? lastRecommit.to : (p.statedDate && p.statedDate.date) || p.due;
  const late = Boolean(date && date < today);
  const state = late ? 'late' : slipped(p) ? 'slipped' : 'open';
  const moves = [];
  const recipient = p.owedTo.resolved || null;
  // Delivering is the promise itself; a chase is only for a dependency the wording names.
  moves.push('deliver-email');
  if (/\b(once|when|after)\b.*\b(provided|confirmed|sent|agreed|available|ready)\b/i.test(p.text)) moves.push('chase-email');
  if (p.nextMeeting) moves.push('meeting-line');
  moves.push('re-commit', 'delivered', 'drop');
  return {
    key: p.key, state, date, recipient,
    recipientNeeded: !recipient, // an ambiguous or unnamed recipient is CHOSEN by Nick, never guessed
    moves, routing: null,
  };
}

// ── 3. Budget ────────────────────────────────────────────────────────────────

const WINDOWS = Object.freeze(['07:30', '12:30', '17:30']);
const WINDOW_MINUTES = 20;
const BEFORE_MEETING_MINUTES = 30;
const MAX_PROMISE_PROMPTS_PER_DAY = 3;
const PROPOSAL_PAUSE_DAYS = 14;

const hhmm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const localParts = (ms, tz) => {
  const s = new Date(ms).toLocaleString('sv-SE', { timeZone: tz }); // "YYYY-MM-DD HH:MM:SS"
  return { date: s.slice(0, 10), minutes: hhmm(s.slice(11, 16)), weekday: new Date(`${s.slice(0, 10)}T12:00:00Z`).getUTCDay() };
};
const isoWeek = (date) => {
  const d = new Date(`${date}T12:00:00Z`); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4)); return `${y}-W${String(1 + Math.round(((d - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
};

/** Shared vetoes: SAiM never interrupts these. */
function vetoed(ctx) {
  if (ctx.inMeeting) return 'in a meeting';
  if (ctx.inFocus) return 'in a focus session';
  if (ctx.quietHours) return 'quiet hours';
  return null;
}

/**
 * May SAiM raise a goal proposal now? One open at a time; one new per ISO week;
 * Monday 07:30 window only (a work/process proposal); never on a day with a
 * critical item; two non-accepts in a row pause proposals for two weeks.
 */
function mayRaiseProposal({ now, tz = 'Europe/London', ctx = {}, history = [] }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const v = vetoed(ctx); if (v) return { ok: false, why: v };
  if (ctx.criticalToday) return { ok: false, why: 'something critical is in play today — proposals wait' };
  if (history.some((h) => h.status === 'open')) return { ok: false, why: 'a proposal is already waiting for you' };
  const t = localParts(nowMs, tz);
  if (history.some((h) => h.raisedAt && isoWeek(h.raisedAt.slice(0, 10)) === isoWeek(t.date))) return { ok: false, why: 'one new proposal a week' };
  const decided = history.filter((h) => h.decidedAt).sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  const lastTwo = decided.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((h) => h.status !== 'accepted')) {
    const until = Date.parse(lastTwo[1].decidedAt) + PROPOSAL_PAUSE_DAYS * DAY;
    if (nowMs < until) return { ok: false, why: `paused until ${ymd(until)} after two declines` };
  }
  if (t.weekday !== 1 || Math.abs(t.minutes - hhmm('07:30')) > WINDOW_MINUTES) return { ok: false, why: 'work proposals are raised in the Monday 07:30 moment only' };
  return { ok: true, why: 'Monday 07:30, nothing open, nothing critical' };
}

/**
 * May SAiM prompt about this promise now? In a bundled window (07:30 / 12:30 /
 * 17:30) or within 30 minutes before a meeting with the person it is owed to;
 * never in a meeting, focus or quiet hours; once per person per meeting; at most
 * three promise prompts a day.
 */
function mayPromptPromise({ now, tz = 'Europe/London', ctx = {}, promise, prompted = [] }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const v = vetoed(ctx); if (v) return { ok: false, why: v };
  const t = localParts(nowMs, tz);
  const today = prompted.filter((x) => localDateOf(x.at, tz) === t.date);
  if (today.length >= MAX_PROMISE_PROMPTS_PER_DAY) return { ok: false, why: `${MAX_PROMISE_PROMPTS_PER_DAY} promise prompts already today` };
  // ONCE per promise per London day, whatever moment it was offered at — a
  // bundle, a pre-meeting window, or a meeting that has since moved or been
  // renamed. Checked BEFORE the meeting branch: a meeting is a reason to offer
  // a promise, never a licence to offer it twice in a day.
  if (promise && today.some((x) => x.key === promise.key)) return { ok: false, why: ALREADY_OFFERED, alreadyOffered: true };
  const meet = promise && promise.nextMeeting;
  if (meet) {
    const startMs = Date.parse(`${meet.start}:00${offsetFor(meet.start, tz)}`);
    const mins = (startMs - nowMs) / 60000;
    if (mins > 0 && mins <= BEFORE_MEETING_MINUTES) {
      const key = `${promise.owedTo.resolved || promise.key}@${meet.start}`;
      if (prompted.some((x) => x.meetingKey === key)) return { ok: false, why: 'already raised for this meeting' };
      return { ok: true, why: `${Math.round(mins)} minutes before ${meet.title}`, meetingKey: key };
    }
  }
  const inWindow = WINDOWS.some((w) => Math.abs(t.minutes - hhmm(w)) <= WINDOW_MINUTES);
  if (!inWindow) return { ok: false, why: 'outside the 07:30 / 12:30 / 17:30 moments' };
  return { ok: true, why: 'a bundled moment' };
}

const ALREADY_OFFERED = 'already offered earlier today';

/**
 * PURE. The London calendar date a prompt-history stamp belongs to. An instant
 * (a trailing Z or offset) is converted — 00:30 BST is the NEXT day, though its
 * UTC stamp still reads the day before; a wall-clock stamp with no zone is
 * already local and is read as written.
 */
function localDateOf(at, tz = 'Europe/London') {
  const s = String(at || '');
  if (/(?:Z|[+-]\d\d:?\d\d)$/.test(s)) { const ms = Date.parse(s); return Number.isFinite(ms) ? localParts(ms, tz).date : null; }
  return /^\d{4}-\d\d-\d\d/.test(s) ? s.slice(0, 10) : null;
}

/** PURE. Which bundled moment (0, 1, 2) `now` falls in, or null. */
function windowIndex(now, tz = 'Europe/London') {
  const t = localParts(typeof now === 'number' ? now : Date.parse(now), tz);
  const i = WINDOWS.findIndex((w) => Math.abs(t.minutes - hhmm(w)) <= WINDOW_MINUTES);
  return i < 0 ? null : i;
}

/** The UTC offset of a wall-clock time in `tz` ("+01:00"). */
function offsetFor(localYmdHm, tz) {
  const guess = Date.parse(`${localYmdHm}:00Z`);
  const shown = new Date(guess).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);
  const diff = Math.round((Date.parse(`${shown}:00Z`) - guess) / 60000);
  const sign = diff >= 0 ? '+' : '-'; const a = Math.abs(diff);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// ── 4. The prompt gate (what a briefing could carry; the shadow logs its verdict) ──

// Never beside an urgent, blind or meeting lead, nor inside a protected block or chosen focus.
const NO_SPONSORSHIP = new Set(['S1 blind', 'S2 critical risk', 'S2u unclassified potential risk', 'S3 meeting',
  'S3a imminent meeting transition', 'S4 deadline inside the block', 'S4r short ritual due now', 'S5 protected block', 'S5f chosen focus']);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => { const x = new Date(`${d}T12:00:00Z`); return Number.isFinite(x.getTime()) ? `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}` : null; };
const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
// "Nick to send…" / "Nick Ward will send…" → "send…": the promise is already his.
const ownerless = (t) => String(t || '').replace(/^\s*Nick(\s+Ward)?\s*(:|to\b|will\b|should\b)\s*/i, '');

/**
 * PURE. The gate's inputs, read from SAiM's own canonical decision and NEURO's
 * candidates. Quiet is NOT read here: main's attention policy has no such
 * field, so quiet reaches the gate only through the context (promise-observe's
 * promiseFeedContext — the attention payload's own `quiet` plus quiet hours).
 */
function gateInputs(decision, candidates) {
  if (!decision || decision.refused || !decision.lead) return { rule: null, offDay: false, decided: false };
  const ww = candidates && candidates.constraints && candidates.constraints.workingWindow;
  return { rule: decision.lead.rule, offDay: Boolean(ww && ww.todayIsWorking === false), decided: true };
}

/**
 * PURE. THE prompt gate: may a briefing carry the goal proposal and/or one
 * promise now, and why (not). `feed` comes from promise-observe.feedFor, which
 * has already applied the interruption budget and the context.
 */
function sponsorshipGate({ rule = null, offDay = false, decided = true, feed = null } = {}) {
  const no = (reason) => ({ shown: false, reason, rule, sponsorship: null });
  if (!decided) return no('no SAiM decision — staying quiet');
  if (NO_SPONSORSHIP.has(rule)) return no(`the lead is "${rule}" — nothing else is shared beside it`);
  if (offDay) return no('not a working day');
  if (!feed) return no('nothing to carry');
  const sponsorship = _sponsorship(feed);
  if (!sponsorship) return no(feed.why ? `nothing to carry: ${feed.why}` : 'nothing to carry');
  return { shown: true, reason: sponsorship.promise ? `shown: ${feed.promiseWhy || 'a promise prompt'}` : 'shown: the goal proposal', rule, sponsorship };
}

/** The words. */
function _sponsorship(feed) {
  const proposal = feed.proposal && feed.proposal.status === 'open' ? {
    id: feed.proposal.id,
    say: `A goal I’d like to propose: ${clip(feed.proposal.title, 90)}.`,
    why: clip(feed.proposal.whyNow, 200),
    responses: ['accept', 'change', 'defer', 'never'],
  } : null;
  const p = feed.promise;
  let promise = null;
  if (p && p.text && Array.isArray(p.moves)) {
    const who = p.owedTo || 'someone in a meeting';
    const when = p.date ? dayLabel(p.date) : null;
    const tail = p.state === 'late' && when ? ` It was due ${when}.` : p.state === 'ticked-no-evidence' ? ' It was ticked, but nothing shows it was delivered.' : ' Its date keeps moving.';
    promise = { key: p.key, say: `You told ${who} you would ${lowerFirst(clip(ownerless(p.text), 140))}.${tail}`, state: p.state, moves: p.moves.slice() };
  }
  return proposal || promise ? { proposal, promise } : null;
}

module.exports = {
  POLICY_VERSION, PROPOSAL_FINGERPRINT, PROPOSAL_CLASS, MIN_OCCURRENCES, MIN_SPAN_DAYS, RECENT_DAYS,
  WINDOWS, BEFORE_MEETING_MINUTES, MAX_PROMISE_PROMPTS_PER_DAY, ALREADY_OFFERED, localDateOf,
  slipped, discover, materiallyNew, judge, mayRaiseProposal, mayPromptPromise, isoWeek, sponsorshipGate, gateInputs, NO_SPONSORSHIP, windowIndex,
};
