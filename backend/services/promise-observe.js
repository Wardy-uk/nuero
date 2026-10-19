'use strict';

/**
 * Meeting promises — the READ-ONLY observation layer for the shadow (18 Oct 2026).
 *
 * Judges the promises NEURO holds (promise-ledger + saim/policy/promises.cjs)
 * and builds the prompt feed through the interruption budget. It writes nothing
 * and requires nothing that can: no task store, no prepared actions, no goals,
 * no proposals, no senders (pinned by a source scan in promise-shadow.test.js).
 *
 * ⚠ An employment matter leaves this module as a task id and a rule CATEGORY
 *   only (`sensitiveRule`): never its wording, the matched words, the meeting
 *   title, or the names of the people involved.
 */

const policy = require('../../saim/policy/promises.cjs');

const msOf = (now) => (typeof now === 'number' ? now : Date.parse(now));

/** PURE. The category of an employment-matter classification — never the pattern or the words. */
function sensitiveRule(sensitivity) {
  if (!sensitivity || !sensitivity.sensitive) return null;
  if (sensitivity.where === 'wording') return 'hr-wording';
  if (sensitivity.where === 'source-note') return 'hr-meeting-title';
  if (sensitivity.rule === 'employee-title') return 'employee-cases-meeting';
  if (sensitivity.rule === 'person-context') return 'person-context';
  return 'hr-other';
}

/**
 * Every promise NEURO holds, judged. Reads only. An employment matter keeps
 * its key, task ids, state and moves (the routing note) — nothing else.
 */
function snapshot({ now = Date.now(), ledger = null } = {}) {
  const nowMs = msOf(now);
  const facts = ledger || require('./promise-ledger').read({ now: nowMs });
  const promises = facts.promises.map((p) => {
    const judgement = policy.judge(p, { now: nowMs });
    const sensitive = Boolean(p.sensitivity && p.sensitivity.sensitive);
    if (sensitive) {
      return {
        key: p.key, taskIds: p.taskIds, sensitive: true, sensitiveRule: sensitiveRule(p.sensitivity),
        open: p.open, closed: null, text: null, owedTo: { resolved: null, people: [], ambiguous: [] }, source: null,
        firstSeen: p.firstSeen, slips: { dueMoves: p.slips.dueMoves, lapsedBlocks: p.slips.lapsedBlocks, statedDatePassed: p.slips.statedDatePassed },
        nextMeeting: null, judgement: { state: judgement.state, moves: judgement.moves, date: null },
      };
    }
    return {
      key: p.key, taskIds: p.taskIds, sensitive: false, sensitiveRule: null,
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
 * the next 30 minutes first; otherwise ONE per bundled moment, rotating, so each
 * promise is offered at most once a day and at most three a day.
 */
function selectPrompt({ promises, ctx, now, prompted = [] }) {
  const candidates = promises
    .filter((p) => !p.closed && !p.sensitive && ['late', 'slipped', 'ticked-no-evidence'].includes(p.judgement.state))
    .sort((a, b) => (a.judgement.state === 'late' ? 0 : 1) - (b.judgement.state === 'late' ? 0 : 1) || String(a.firstSeen).localeCompare(String(b.firstSeen)));
  const passing = [];
  let why = null;
  for (const p of candidates) {
    const gate = policy.mayPromptPromise({ now, ctx, promise: p, prompted });
    if (gate.ok) passing.push({ p, gate }); else if (!why) why = gate.why;
  }
  const meeting = passing.find((x) => x.gate.meetingKey);
  const w = policy.windowIndex(now);
  const pick = meeting || (w !== null && passing.filter((x) => !x.gate.meetingKey)[w]) || null;
  const rotatedOut = !pick && w !== null && passing.length > 0;
  return {
    pick,
    why: pick ? null : rotatedOut ? `each promise once a day — ${passing.length} eligible, already offered at an earlier moment today`
      : why || (candidates.length ? 'nothing passes the budget now' : 'no promise needs a prompt'),
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
    out.promise = { key: p.key, text: p.text, sensitive: p.sensitive, state: p.judgement.state, date: p.judgement.date || null,
      owedTo: p.owedTo.resolved, moves: p.judgement.moves, why: sel.pick.gate.why };
    out.promiseWhy = sel.pick.gate.why;
    out.meetingKey = sel.pick.gate.meetingKey || null;
  }
  return out;
}

module.exports = { sensitiveRule, snapshot, promiseFeedContext, selectPrompt, feedFor };
