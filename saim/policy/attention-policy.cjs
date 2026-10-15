'use strict';

/**
 * SAiM Attention Policy — `saim-attention-v1`. OWNED BY SAiM (15 Oct 2026).
 * Contract: docs/saim-attention-policy-contract.md (approved in principle 14 Oct,
 * §3 scope amendment 15 Oct).
 *
 * NEURO owns facts (`neuro-candidates-v1`); SAiM owns attention judgement: what
 * she leads with, what she asks Nick to do now, what she protects, and how that
 * shows on each surface. This file is that judgement. NEURO's backend EXECUTES
 * it so every surface receives one answer, but nothing here is a NEURO fact and
 * NEURO never reads it back as one. It writes nothing.
 *
 * PURE: candidates in, decision out. No I/O, no clock (`now` is passed), no
 * require of anything in backend/.
 *
 * ORDER OF WORK
 *   1. SCOPE filters the candidates (work / home / all) — before any choice.
 *   2. The RULES (S1–S11) pick the lead from what is left.
 *   3. MANIFESTATION shapes the output for the surface — never the lead.
 */

const CONTRACT = 'saim-attention-v1';
const POLICY_VERSION = '2026-10-15.4';

/** How long before a block's end an approval deadline must fall to interrupt it. */
const BLOCK_END_MARGIN_MINUTES = 15;

/**
 * How close a meeting with other people must be before it becomes the lead
 * (S3a) — including over a running task block. Matches the window in which
 * NEURO itself calls a meeting imminent (decision-engine, ≤ 10 min).
 */
const MEETING_TRANSITION_MINUTES = 10;

const SURFACES = Object.freeze({
  'work-desktop': { scope: 'work', manifestation: { held: 'list', actions: 'all', deskLaunch: true, speech: false } },
  'work-tablet': { scope: 'work', manifestation: { held: 'list', actions: 'all', deskLaunch: false, speech: false } },
  'home-pi': { scope: 'home', manifestation: { held: 'count', actions: 'none', deskLaunch: false, speech: true } },
  'bedside-phone': { scope: 'home', manifestation: { held: 'count', actions: 'none', deskLaunch: false, speech: true } },
  phone: { scope: 'all', manifestation: { held: 'count', actions: 'limited', maxActions: 2, deskLaunch: false, speech: true } },
});

// ── Scope ────────────────────────────────────────────────────────────────────

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const isRunning = (c) => (c.kind === 'block' && (c.facts.state === 'running' || c.facts.state === 'interrupted'))
  || ((c.kind === 'meeting' || c.kind === 'protected-time') && c.facts.running === true);

/**
 * Personal / home / family context a WORK surface still shows: something that is
 * happening now or timed today, due or overdue, rated critical, or needing Nick.
 */
function relevantToWork(c) {
  if (isRunning(c)) return true;
  if (c.kind === 'block' || c.kind === 'meeting' || c.kind === 'protected-time') return true; // today's diary by construction
  if (c.kind === 'commitment') return c.facts.daysLate >= 0;
  if (c.facts && c.facts.risk === 'critical') return true; // classified or not — a work surface never hides it
  if (c.kind === 'attention-item') return Boolean(c.facts.urgency);
  return c.facts && c.facts.needsNow === true;
}

function inScope(c, scope) {
  const s = (c.sphere && c.sphere.value) || 'unknown';
  if (scope === 'all') return true;
  if (scope === 'home') return s === 'home' || s === 'family';
  // work
  if (s === 'work' || s === 'unknown') return true;
  return relevantToWork(c);
}

// ── Wording SAiM will repeat ────────────────────────────────────────────────

const BRACKET_DATE = /\s*\((?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\)/gi;
const TRAILING_WHEN = /\s+(?:tomorrow|today|tonight|this (?:morning|afternoon|evening|week))\s*$/i;

/** A task's wording as SAiM says it: the first sentence, without the scheduling talk of the moment it was written. */
function sayTitle(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  let t = raw.split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
  t = t.replace(BRACKET_DATE, '').replace(/[.!?]+$/, '').trim();
  t = t.replace(TRAILING_WHEN, '').trim().replace(/[\s,;:–—-]+$/, '').trim();
  return t.length >= 8 ? t : raw;
}

// ── Deadlines ───────────────────────────────────────────────────────────────

/**
 * When an approval actually has to be dealt with. If it expires before Nick's
 * next working start, the deadline that matters is when he stops work today.
 */
function effectiveDeadline(deadlineAt, ww, now) {
  const d = ms(deadlineAt);
  if (d == null) return null;
  const end = ww && ms(ww.todayEnd);
  const next = ww && ms(ww.nextStart);
  if (end != null && next != null && now < end && d > end && d <= next) return { at: new Date(end).toISOString(), basis: 'end of today’s working hours — it expires before you next start' };
  return { at: new Date(d).toISOString(), basis: 'its own expiry' };
}

const hhmmOf = (iso) => { const t = ms(iso); if (t == null) return null; const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayWord = (iso, now) => {
  const t = ms(iso); if (t == null) return '';
  const a = new Date(t); const b = new Date(now);
  const sameDay = a.toDateString() === b.toDateString();
  const tomorrow = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1).toDateString() === a.toDateString();
  return sameDay ? 'today' : tomorrow ? 'tomorrow' : a.toDateString();
};

// ── The decision ────────────────────────────────────────────────────────────

/**
 * @param {object} input   neuro-candidates-v1
 * @param {{surface?: string, now?: number}} opts
 */
function decide(input, { surface = 'work-desktop', now = Date.now() } = {}) {
  const sf = SURFACES[surface];
  if (!sf) throw new Error(`unknown surface "${surface}" — one of ${Object.keys(SURFACES).join(', ')}`);
  const all = (input && Array.isArray(input.candidates)) ? input.candidates : [];
  const k = (input && input.constraints) || {};
  const ww = k.workingWindow || null;

  // 1. Scope — before any choice.
  const excluded = {};
  const cands = [];
  for (const c of all) {
    if (inScope(c, sf.scope)) cands.push(c);
    else { const s = (c.sphere && c.sphere.value) || 'unknown'; excluded[s] = (excluded[s] || 0) + 1; }
  }

  const of = (kind) => cands.filter((c) => c.kind === kind);
  const runningBlock = of('block').find((c) => c.facts.state === 'running' || c.facts.state === 'interrupted') || null;
  const upcomingBlock = of('block').find((c) => c.facts.state === 'upcoming') || null;
  const runningMeeting = of('meeting').find((c) => c.facts.running) || null;
  const protectedTime = runningBlock ? null : of('protected-time').find((c) => c.facts.running) || null;
  // S2 is GENUINE RISK only. An item NEURO rated critical for its clock (an
  // imminent meeting, the pre-11 standup) carries `risk: 'none'` and an
  // `urgency` instead, and never reaches S2.
  const critical = cands.find((c) => c.facts && c.facts.risk === 'critical' && c.facts.riskBasis === 'classified') || null;
  // S2u: NEURO said critical about a KIND of item nobody has classified yet.
  // Conservative: it leads as possible risk (it is never quietly demoted), but
  // under its own rule, so it can never pass for classified risk — and it is
  // listed in `review` until the type is classified deliberately.
  const unclassifiedCritical = cands.find((c) => c.facts && c.facts.risk === 'critical' && c.facts.riskBasis !== 'classified') || null; // a missing basis is unclassified, never assumed
  // S3a: a meeting with other people starting within MEETING_TRANSITION_MINUTES.
  // From the diary when it was read; from NEURO's meeting card otherwise.
  const soonMin = (c) => { const t = ms(c.time && c.time.startAt); return t == null ? null : (t - now) / 60000; };
  const diaryTransition = of('meeting').filter((c) => !c.facts.running && c.facts.othersAttending === true)
    .map((c) => ({ c, min: soonMin(c) })).filter((x) => x.min != null && x.min >= -1 && x.min <= MEETING_TRANSITION_MINUTES)
    .sort((a, b) => a.min - b.min)[0] || null;
  const cardTransition = of('attention-item').find((c) => c.facts.urgency === 'meeting-transition' && c.facts.othersAttending !== false) || null;
  const transition = diaryTransition
    ? { c: diaryTransition.c, min: Math.max(0, Math.round(diaryTransition.min)), card: of('attention-item').find((a) => a.facts.type === 'meeting' && a.title === diaryTransition.c.title) || null }
    : cardTransition ? { c: cardTransition, min: cardTransition.time && Number.isFinite(cardTransition.time.minutesAway) ? Math.max(0, cardTransition.time.minutesAway) : null, card: cardTransition } : null;
  const approvals = of('approval').map((a) => ({ c: a, eff: effectiveDeadline(a.time && a.time.deadlineAt, ww, now) }))
    .sort((x, y) => (ms(x.eff && x.eff.at) ?? Infinity) - (ms(y.eff && y.eff.at) ?? Infinity));
  const topItem = of('attention-item').find((c) => c.facts.gatePosition === 'primary') || null;
  const needsNow = [...of('home'), ...of('personal-date')].find((c) => c.facts.needsNow) || null;
  const ritual = of('ritual')[0] || null;
  // Blind is judged on what THIS scope depends on: work on NEURO's attention
  // pool, home on the household model. "I couldn't look" is never "nothing".
  const blindWork = k.poolReadable === false;
  const blindHome = k.homeReadable === false;
  const blind = sf.scope === 'home' ? blindHome : blindWork;

  const trace = [];
  const rule = (id, applies, why) => { trace.push({ rule: id, applies: Boolean(applies), why }); return Boolean(applies); };

  const blockEnd = runningBlock ? ms(runningBlock.time.endAt) : null;
  const interrupting = runningBlock && approvals.find((a) => a.eff && ms(a.eff.at) != null && ms(a.eff.at) < blockEnd + BLOCK_END_MARGIN_MINUTES * 60000) || null;
  const firstApproval = approvals[0] || null;

  let lead = null;
  const leadOf = (c, ruleId, why, deciding) => ({ ref: c ? c.id : null, kind: c ? c.kind : 'none', title: c ? leadTitle(c) : null, rule: ruleId, why, deciding });

  if (rule('S1 blind', blind, sf.scope === 'home'
    ? (blindHome ? 'NEURO could not read the household model' : 'household model read')
    : (blindWork ? 'NEURO could not read the attention pool' : 'pool read'))) {
    lead = sf.scope === 'home'
      ? leadOf(null, 'S1 blind', 'I can’t see the house right now — this isn’t an all-clear.', ['constraints.homeReadable = false'])
      : leadOf(null, 'S1 blind', 'I can’t see your work right now — this isn’t an all-clear.', ['constraints.poolReadable = false']);
    lead.kind = 'blind';
  } else if (rule('S2 critical risk', critical, critical ? `“${critical.title}” carries critical risk (${critical.facts.type || critical.facts.homeKind || critical.kind})` : 'no item carries critical risk in scope')) {
    lead = leadOf(critical, 'S2 critical risk', `${critical.title} is critical${(critical.facts.reason || critical.facts.why) ? `: ${critical.facts.reason || critical.facts.why}` : ''}.`, [`${critical.id}.risk = critical`]);
  } else if (rule('S2u unclassified potential risk', unclassifiedCritical,
    unclassifiedCritical ? `“${unclassifiedCritical.title}” — NEURO said critical, but type “${unclassifiedCritical.facts.type || unclassifiedCritical.facts.homeKind || unclassifiedCritical.kind}” is unclassified` : 'no unclassified critical item in scope')) {
    const t = unclassifiedCritical.facts.type || unclassifiedCritical.facts.homeKind || unclassifiedCritical.kind;
    lead = leadOf(unclassifiedCritical, 'S2u unclassified potential risk',
      `${String(leadTitle(unclassifiedCritical)).replace(/[.!?]+$/, '')} — NEURO rated it critical, but this kind of item (${t}) hasn’t been classified yet, so I’m treating it as possible risk.`,
      [`${unclassifiedCritical.id}.risk = critical`, `${unclassifiedCritical.id}.riskBasis = unclassified`]);
  } else if (rule('S3 meeting', runningMeeting, runningMeeting ? `“${runningMeeting.title}” is running with other people in it` : 'no meeting running in scope')) {
    lead = leadOf(runningMeeting, 'S3 meeting', `You’re in ${runningMeeting.title} until ${runningMeeting.time.end}; I’m holding everything else.`, [`${runningMeeting.id}.running`, `${runningMeeting.id}.othersAttending`]);
  } else if (rule('S3a imminent meeting transition', transition,
    transition ? `“${transition.c.title}” with other people starts ${transition.min == null ? 'now' : `in ${transition.min} min`} (≤ ${MEETING_TRANSITION_MINUTES})${runningBlock ? ` — outranks ${runningBlock.id}` : ''}` : `no meeting with others within ${MEETING_TRANSITION_MINUTES} min`)) {
    const when = transition.min ? `in ${transition.min} minute${transition.min === 1 ? '' : 's'}` : 'now';
    lead = leadOf(transition.c, 'S3a imminent meeting transition',
      `${transition.c.title} starts ${when}${runningBlock ? `; I’ll hold ${leadTitle(runningBlock)} for after it` : ''}.`,
      [`${transition.c.id}.startAt = ${transition.c.time && transition.c.time.startAt}`, `${transition.c.id}.othersAttending`]);
    lead.transition = { kind: 'meeting', startsInMinutes: transition.min };
  } else if (rule('S4 deadline inside the block', interrupting,
    runningBlock ? (firstApproval ? (firstApproval.eff ? `effective deadline ${hhmmOf(firstApproval.eff.at)} ${dayWord(firstApproval.eff.at, now)} (${firstApproval.eff.basis}); block ends ${runningBlock.time.end} + ${BLOCK_END_MARGIN_MINUTES} min` : 'approval has no deadline') : 'no approval waiting in scope') : 'no block running')) {
    lead = leadOf(interrupting.c, 'S4 deadline inside the block', `${interrupting.c.title} has to be dealt with before ${hhmmOf(interrupting.eff.at)}, and this block runs to ${runningBlock.time.end}.`,
      [`${interrupting.c.id}.deadlineAt = ${interrupting.c.time.deadlineAt}`, `effective ${interrupting.eff.at}`, `${runningBlock.id}.end = ${runningBlock.time.end}`]);
  } else if (rule('S5 protected block', runningBlock, runningBlock ? `${runningBlock.id} ${runningBlock.time.start}–${runningBlock.time.end} is ${runningBlock.facts.state}` : 'no task block running in scope')) {
    lead = leadOf(runningBlock, 'S5 protected block', `This is the time you blocked for ${leadTitle(runningBlock)}. I’m holding the rest until ${runningBlock.time.end}.`, [`${runningBlock.id}.state = ${runningBlock.facts.state}`]);
  } else if (rule('S6 judgement waiting', firstApproval, firstApproval ? `${approvals.length} approval(s) waiting and no block protecting the time` : 'no approval waiting in scope')) {
    const by = firstApproval.eff ? ` before ${hhmmOf(firstApproval.eff.at)} ${dayWord(firstApproval.eff.at, now)}` : '';
    lead = leadOf(firstApproval.c, 'S6 judgement waiting', `${firstApproval.c.title} is waiting for you in NEURO${by}.`, [`${firstApproval.c.id}.status = prepared`]);
  } else if (rule('S7 top item', topItem || needsNow, topItem ? `the gate’s top item: “${topItem.title}”` : needsNow ? `“${needsNow.title}” needs you` : 'no top item in scope')) {
    const c = topItem || needsNow;
    const why = c.facts.reason || c.facts.why || null;
    lead = leadOf(c, 'S7 top item', `${String(leadTitle(c)).replace(/[.!?]+$/, '')}${why ? ` — ${why}` : ''}.`, [topItem ? `${c.id}.gatePosition = primary` : `${c.id}.needsNow`]);
  } else if (rule('S8 protected diary time', protectedTime, protectedTime ? `“${protectedTime.title}” is a running solo diary entry` : 'no protected time running')) {
    lead = leadOf(protectedTime, 'S8 protected diary time', 'The diary protects this time, but no task block says what it’s for.', [`${protectedTime.id}.running`]);
  } else if (rule('S9 block about to start', upcomingBlock, upcomingBlock ? `${upcomingBlock.id} starts at ${upcomingBlock.time.start}` : 'no block about to start')) {
    lead = leadOf(upcomingBlock, 'S9 block about to start', `${leadTitle(upcomingBlock)} starts at ${upcomingBlock.time.start}.`, [`${upcomingBlock.id}.state = upcoming`]);
  } else if (rule('S10 ritual', ritual, ritual ? `${ritual.title} is outstanding` : 'no ritual outstanding in scope')) {
    lead = leadOf(ritual, 'S10 ritual', `${ritual.facts.ritual === 'eod' ? 'The end-of-day wrap' : 'The standup'} hasn’t been done yet.`, [`${ritual.id}.outstanding`]);
  } else {
    rule('S11 nothing', true, 'no rule applied');
    lead = leadOf(null, 'S11 nothing', 'Nothing needs you right now.', []);
  }

  // Protected context: what SAiM is guarding, kept even when it did not lead.
  const guard = runningMeeting || runningBlock || protectedTime;
  const protectedCtx = guard ? { ref: guard.id, kind: guard.kind, what: leadTitle(guard), until: guard.time.end } : null;

  // Judgement: waiting approvals that are not the lead.
  const judgement = approvals.filter((a) => a.c.id !== lead.ref).map((a) => ({
    ref: a.c.id, what: a.c.title, where: a.c.facts.where, deadline: a.c.time.deadlineAt,
    effectiveDeadline: a.eff ? a.eff.at : null, effectiveBasis: a.eff ? a.eff.basis : null,
  }));

  // Held: everything displaced, returning when the guard ends.
  const returns = protectedCtx ? `at ${protectedCtx.until}` : 'after this';
  const blockTaskIds = new Set(runningBlock ? runningBlock.facts.tasks.map((t) => Number(t.taskId)) : []);
  const held = [];
  for (const c of cands) {
    if (c.id === lead.ref || (guard && c.id === guard.id)) continue;
    // NEURO's meeting card is the same meeting as the diary entry — never held twice.
    if (c.kind === 'attention-item' && c.facts.type === 'meeting' && (c.title === lead.title || of('meeting').some((m) => m.title === c.title))) continue;
    let why = null;
    if (c.kind === 'ritual') why = c.facts.reason || 'outstanding';
    else if (c.kind === 'attention-item') why = c.facts.reason || `${c.facts.type || 'item'} from NEURO`;
    else if (c.kind === 'held') why = c.facts.why || 'held back by NEURO';
    else if (c.kind === 'commitment' && c.facts.daysLate >= 0 && !blockTaskIds.has(Number(c.taskId))) why = c.facts.daysLate === 0 ? 'due today' : `${c.facts.daysLate} day${c.facts.daysLate === 1 ? '' : 's'} overdue`;
    else if ((c.kind === 'home' || c.kind === 'personal-date') && c.facts.needsNow) why = c.facts.why || 'needs you';
    if (!why) continue;
    held.push({ ref: c.id, kind: c.kind, title: leadTitle(c), why, returns, wordingConflict: c.facts.wordingConflict || null });
  }

  // Next: the first thing in scope that starts later today.
  const later = cands.filter((c) => (c.kind === 'block' || c.kind === 'meeting' || c.kind === 'protected-time') && !isRunning(c) && c.id !== lead.ref && ms(c.time && c.time.startAt) > now)
    .sort((a, b) => ms(a.time.startAt) - ms(b.time.startAt));
  const next = later[0] ? { ref: later[0].id, kind: later[0].kind, title: leadTitle(later[0]), start: later[0].time.start, inMinutes: Math.round((ms(later[0].time.startAt) - now) / 60000) } : null;

  // Recommended action, then alternatives — limited by the manifestation, never by changing the lead.
  const leadCand = cands.find((c) => c.id === lead.ref) || null;
  let options = actionsFor(leadCand);
  if (lead.rule === 'S3a imminent meeting transition' && transition && transition.card && transition.card !== leadCand) options = [...actionsFor(transition.card), ...options];
  const m = sf.manifestation;
  let recommended = options[0] || null;
  let alternatives = options.slice(1);
  if (m.actions === 'none') {
    recommended = leadCand && options.length ? { handOff: 'the desktop', say: options[0].say } : null;
    alternatives = [];
  } else if (m.actions === 'limited') alternatives = alternatives.slice(0, Math.max(0, (m.maxActions || 2) - 1));
  if (leadCand && leadCand.kind === 'approval') recommended = { handOff: leadCand.facts.where, say: 'Review it in NEURO' };

  // Corrections: data-quality facts SAiM will not repeat.
  const corrections = [];
  for (const c of cands) {
    if (c.facts && c.facts.wordingConflict) corrections.push({ ref: c.id, taskId: c.taskId ?? null, issue: c.facts.wordingConflict });
  }

  // Policy review: every unclassified kind seen, in or out of scope, so a new
  // type is classified deliberately rather than living as "critical" for ever.
  const unclassified = {};
  for (const c of all) {
    if (!c.facts || !(c.facts.riskBasis === 'unclassified' || (c.facts.risk === 'critical' && c.facts.riskBasis !== 'classified'))) continue;
    const t = c.facts.type || c.facts.homeKind || c.kind;
    const u = (unclassified[t] = unclassified[t] || { type: t, count: 0, refs: [], neuroUrgency: new Set(), ledThisDecision: false });
    u.count += 1; if (u.refs.length < 5) u.refs.push(c.id);
    u.neuroUrgency.add(c.facts.neuroUrgency || c.facts.risk || 'unknown');
    if (c.id === lead.ref) u.ledThisDecision = true;
  }
  const review = {
    unclassified: Object.values(unclassified).map((u) => ({ ...u, neuroUrgency: [...u.neuroUrgency] })),
    action: Object.keys(unclassified).length ? 'Classify these types in neuro-candidates (CLASSIFIED_TYPES / HOME_RISK), then review the policy.' : null,
  };

  return {
    contract: CONTRACT,
    owner: 'saim',
    policyVersion: POLICY_VERSION,
    decidedAt: new Date(now).toISOString(),
    surface: { id: surface, scope: sf.scope, manifestation: m },
    scope: { id: sf.scope, excluded },
    lead,
    protected: protectedCtx,
    held: m.held === 'count' ? { count: held.length } : held,
    judgement,
    next,
    recommended,
    alternatives,
    corrections,
    review,
    trace,
  };
}

/** The words SAiM uses for a candidate: a task as she would say it, never a stale clause. */
function leadTitle(c) {
  if (!c) return null;
  if (c.kind === 'block') {
    const t = c.facts.tasks || [];
    if (t.length === 1) return sayTitle(t[0].text);
    if (t.length > 1) return `${t.length} tasks`;
    return sayTitle(c.title);
  }
  // Anything that is a task underneath (a commitment, a household obligation) is
  // said neutrally — SAiM never repeats scheduling talk that may have gone stale.
  if (c.kind === 'commitment' || c.taskId != null) return sayTitle(c.title);
  return c.title;
}

function actionsFor(c) {
  if (!c) return [];
  const out = [];
  if (c.kind === 'block') {
    const t = c.facts.tasks || [];
    const sessionLive = c.facts.session && c.facts.session.status && !['done', 'abandoned'].includes(c.facts.session.status);
    if (t.length === 1 && !sessionLive && c.blockId != null) out.push({ say: 'I’m on it', intent: { kind: 'start-block', taskId: t[0].taskId, text: t[0].text, blockId: c.blockId } });
  }
  if (c.kind === 'ritual') out.push({ say: c.facts.ritual === 'eod' ? 'Start the end-of-day wrap' : 'Start the standup', intent: { kind: 'navigate', tab: 'review' } });
  for (const a of c.actions || []) out.push(a);
  return out;
}

module.exports = { CONTRACT, POLICY_VERSION, SURFACES, BLOCK_END_MARGIN_MINUTES, MEETING_TRANSITION_MINUTES, decide, inScope, effectiveDeadline, sayTitle };
