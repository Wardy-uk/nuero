'use strict';

/**
 * Meeting promises — the READ-ONLY observation layer for the shadow (18 Oct 2026).
 *
 * Judges the promises NEURO holds (promise-ledger + saim/policy/promises.cjs)
 * and builds the prompt feed through the interruption budget. It writes nothing
 * and requires nothing that can: no task store, no prepared actions, no goals,
 * no proposals, no senders (pinned by a source scan in promise-shadow.test.js).
 */

const policy = require('../../saim/policy/promises.cjs');

const msOf = (now) => (typeof now === 'number' ? now : Date.parse(now));

/** Every promise NEURO holds, judged. Reads only. */
function snapshot({ now = Date.now(), ledger = null } = {}) {
  const nowMs = msOf(now);
  const facts = ledger || require('./promise-ledger').read({ now: nowMs });
  const promises = facts.promises.map((p) => {
    const judgement = policy.judge(p, { now: nowMs });
    return {
      key: p.key, taskIds: p.taskIds,
      open: p.open, closed: null, text: p.text, tickedWithoutEvidence: p.tickedWithoutEvidence,
      firstSeen: p.firstSeen, due: p.due, statedDate: p.statedDate,
      owedTo: { resolved: p.owedTo.resolved, people: p.owedTo.people.map((x) => x.name), ambiguous: p.owedTo.ambiguous },
      source: { title: p.source.title, path: p.source.path, line: p.source.line },
      slips: { dueMoves: p.slips.dueMoves, lapsedBlocks: p.slips.lapsedBlocks, statedDatePassed: p.slips.statedDatePassed },
      nextMeeting: p.nextMeeting || null,
      judgement,
    };
  });
  return { promises, gaps: facts.gaps, readAt: facts.readAt, ledger: facts };
}

/**
 * The interruption context, from the canonical Now payload: the attention
 * activity, the attention payload's own `quiet`, and the configured quiet
 * hours (attention-settings — the same window the push governor honours).
 * Unknown activity → null, and null means stay quiet.
 */
function promiseFeedContext(payload, { now = Date.now() } = {}) {
  const act = payload && payload.context && payload.context.activity;
  if (!act || act === 'unknown') return null;
  let quietHours = false;
  try {
    const settings = require('./attention-settings');
    quietHours = settings.isQuietAt(settings.read(), new Date(msOf(now)));
  } catch { quietHours = false; }
  return {
    inMeeting: act === 'in-meeting',
    inFocus: act === 'in-focus-session',
    quietHours: Boolean(payload.quiet) || quietHours,
    criticalToday: act === 'firefighting',
  };
}

/**
 * PURE. Which promise (if any) is prompted now. A meeting with its person in
 * the next 30 minutes first; otherwise the first eligible promise. `prompted`
 * is the day's history — the policy refuses a promise already offered today
 * (any moment) and caps the day at three, so each bundle takes the next one
 * not yet offered. (Until 19 Oct the bundle ROTATED by window index to fake
 * that without history; with history the rotation skipped promises nobody had
 * seen — A at 07:30, C at 12:30, nothing at 17:30.)
 */
function selectPrompt({ promises, ctx, now, prompted = [] }) {
  const candidates = promises
    .filter((p) => !p.closed && ['late', 'slipped', 'ticked-no-evidence'].includes(p.judgement.state))
    .sort((a, b) => (a.judgement.state === 'late' ? 0 : 1) - (b.judgement.state === 'late' ? 0 : 1) || String(a.firstSeen).localeCompare(String(b.firstSeen)));
  const passing = [];
  let why = null;
  for (const p of candidates) {
    const gate = policy.mayPromptPromise({ now, ctx, promise: p, prompted });
    if (gate.ok) passing.push({ p, gate }); else if (!why) why = gate.why;
  }
  const pick = passing.find((x) => x.gate.meetingKey) || passing[0] || null;
  return {
    pick,
    why: pick ? null : why || (candidates.length ? 'nothing passes the budget now' : 'no promise needs a prompt'),
    candidates: candidates.length,
  };
}

/**
 * PURE. The feed a briefing would be handed: the open proposal (if any) and at
 * most one promise, through the budget.
 */
function feedFor({ ctx = null, promises = [], now, prompted = [], proposal = null, goalAccepted = false } = {}) {
  const out = { proposal: proposal || null, promise: null, why: null, promiseWhy: null, meetingKey: null };
  if (!goalAccepted) { out.why = 'no accepted promises goal'; return out; }
  if (!ctx) { out.why = 'context unknown — staying quiet'; return out; }
  const sel = selectPrompt({ promises, ctx, now, prompted });
  out.why = sel.why;
  if (sel.pick) {
    const p = sel.pick.p;
    out.promise = { key: p.key, text: p.text, state: p.judgement.state, date: p.judgement.date || null,
      owedTo: p.owedTo.resolved, moves: p.judgement.moves, why: sel.pick.gate.why };
    out.promiseWhy = sel.pick.gate.why;
    out.meetingKey = sel.pick.gate.meetingKey || null;
  }
  return out;
}

module.exports = { snapshot, promiseFeedContext, selectPrompt, feedFor };
