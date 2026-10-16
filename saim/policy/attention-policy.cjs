'use strict';

/**
 * SAiM Attention Policy — `saim-attention-v2`. OWNED BY SAiM (15 Oct 2026).
 * Contract: docs/saim-attention-policy-contract.md (approved in principle 14 Oct,
 * §3 scope amendment 15 Oct).
 *
 * NEURO owns facts (`neuro-candidates-v2`, checked by shared/attention-contracts.cjs); SAiM owns attention judgement: what
 * she leads with, what she asks Nick to do now, what she protects, and how that
 * shows on each surface. This file is that judgement. NEURO's backend EXECUTES
 * it so every surface receives one answer, but nothing here is a NEURO fact and
 * NEURO never reads it back as one. It writes nothing.
 *
 * PURE: candidates in, decision out. No I/O, no clock (`now` is passed), no
 * require of anything in backend/.
 *
 * CONTRACTS (C6, 15 Oct 2026): the input is checked against the supported
 * `neuro-candidates` versions BEFORE anything is read. An unsupported name, a
 * v1 shape under any label, or a missing required field is REFUSED: the
 * decision is an honest S1 blind ("this isn't an all-clear") carrying
 * `refused`, never a partial read and never S11 "nothing".
 *
 * ORDER OF WORK
 *   1. SCOPE filters the candidates (work / home / all) — before any choice.
 *   2. The RULES (S1–S11) pick the lead from what is left.
 *   3. MANIFESTATION shapes the output for the surface — never the lead.
 */

const CONTRACTS = require('../../shared/attention-contracts.cjs');
const D = require('../../shared/display-text.cjs');

const CONTRACT = CONTRACTS.SAIM_ATTENTION;
const POLICY_VERSION = '2026-10-16.2';

/** How long before a block's end an approval deadline must fall to interrupt it. */
const BLOCK_END_MARGIN_MINUTES = 15;

/**
 * How close a meeting with other people must be before it becomes the lead
 * (S3a) — including over a running task block. Matches the window in which
 * NEURO itself calls a meeting imminent (decision-engine, ≤ 10 min).
 */
const MEETING_TRANSITION_MINUTES = 10;

/**
 * S4r (16 Oct 2026): how short a ritual NEURO says is due NOW and comes first must be
 * for it to lead over a running task block. The pre-11 standup is two minutes; a ritual
 * with no stated length, or a longer one, never interrupts a block.
 */
const SHORT_RITUAL_MINUTES = 5;

/** A focus session that is still Nick's (NEURO's statuses). */
const LIVE = Object.freeze(['active', 'paused', 'interrupted', 'needs-smaller']);

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

const HEADLINE_MAX = 72;
/**
 * A headline: the item as a short phrase, never the whole task wording (15 Oct 2026).
 * NEURO's own extracted commitments read "Nick Ward to …" — said to Nick, that is
 * the verb. Past the limit it ends at the first natural break (": ", " — ", " (",
 * ", ") that leaves a phrase of at least 24 characters, else at a word with "…".
 */
function headline(text) {
  let t = String(text || '').trim();
  if (!t) return t;
  const own = t.match(/^Nick(?:\s+Ward)?\s+(?:to|will)\s+(\S)([\s\S]*)$/);
  if (own) t = own[1].toUpperCase() + own[2];
  if (t.length <= HEADLINE_MAX) return t;
  let cut = -1;
  for (const sep of [': ', ' — ', ' – ', ' (', ', ']) {
    let i = t.indexOf(sep);
    while (i !== -1 && i < 24) i = t.indexOf(sep, i + 1);
    if (i !== -1 && i <= HEADLINE_MAX && (cut === -1 || i < cut)) cut = i;
  }
  if (cut !== -1) return t.slice(0, cut).replace(/[\s,;:–—-]+$/, '').trim();
  const words = t.slice(0, HEADLINE_MAX).replace(/\s+\S*$/, '').replace(/[\s,;:–—-]+$/, '').trim();
  return `${words}…`;
}

/** Comparable form of display text — case, quotes and punctuation removed. */
const comparable = (s) => String(s || '').toLowerCase().replace(/[“”"‘’'.,;:!?()…—–-]/g, ' ').replace(/\s+/g, ' ').trim();
/** True when `a` already says `b` (so showing both repeats it). */
const repeats = (a, b) => { const x = comparable(a); const y = comparable(b); return Boolean(x && y && (x.includes(y) || y.includes(x))); };

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
 * @param {object} input   neuro-candidates-v2 (anything else is refused)
 * @param {{surface?: string, now?: number}} opts
 */
function decide(input, { surface = 'work-desktop', now = Date.now() } = {}) {
  const sf = SURFACES[surface];
  if (!sf) throw new Error(`unknown surface "${surface}" — one of ${Object.keys(SURFACES).join(', ')}`);
  const check = CONTRACTS.checkCandidates(input);
  if (!check.ok) return refusedDecision(check, surface, sf, now);
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
  // S5f: what Nick chose to do now ("Do now" → a NEURO focus session). NEURO marks it.
  const focusCand = runningBlock ? null : cands.find((c) => c.facts && c.facts.inFocus && LIVE.includes(c.facts.inFocus.status)) || null;
  // S2 is GENUINE RISK only. An item NEURO rated critical for its clock (an
  // imminent meeting, the pre-11 standup) carries `risk: 'none'` and an
  // `urgency` instead, and never reaches S2.
  const critical = cands.find((c) => c.facts && c.facts.risk === 'critical' && c.facts.riskBasis === 'classified') || null;
  // S2u: NEURO said critical about a KIND of item nobody has classified yet.
  // Ordered BELOW S3 (a running meeting keeps the lead; the item stays visible
  // in held as 'possible risk — not yet classified') and ABOVE S3a/S4/S5.
  // Otherwise it leads as possible risk (never quietly demoted), but
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
  // S4r: a ritual NEURO says is due now, comes before anything else, and takes a few
  // minutes (decision-engine's structured meta — never the reason line). A ritual that is
  // merely later carries none of these and never leads here.
  const shortRitual = of('attention-item').find((c) => c.facts.type === 'nudge' && c.facts.urgency === 'ritual-due'
    && c.facts.doFirst === true && Number.isFinite(c.facts.estimateMinutes) && c.facts.estimateMinutes > 0
    && c.facts.estimateMinutes <= SHORT_RITUAL_MINUTES) || null;
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
  } else if (rule('S3 meeting', runningMeeting, runningMeeting ? `“${runningMeeting.title}” is running with other people in it` : 'no meeting running in scope')) {
    lead = leadOf(runningMeeting, 'S3 meeting', `You’re in ${runningMeeting.title} until ${runningMeeting.time.end}; I’m holding everything else.`, [`${runningMeeting.id}.running`, `${runningMeeting.id}.othersAttending`]);
  } else if (rule('S2u unclassified potential risk', unclassifiedCritical,
    unclassifiedCritical ? `“${unclassifiedCritical.title}” — NEURO said critical, but type “${unclassifiedCritical.facts.type || unclassifiedCritical.facts.homeKind || unclassifiedCritical.kind}” is unclassified` : 'no unclassified critical item in scope')) {
    const t = unclassifiedCritical.facts.type || unclassifiedCritical.facts.homeKind || unclassifiedCritical.kind;
    lead = leadOf(unclassifiedCritical, 'S2u unclassified potential risk',
      `${String(leadTitle(unclassifiedCritical)).replace(/[.!?]+$/, '')} — NEURO rated it critical, but this kind of item (${t}) hasn’t been classified yet, so I’m treating it as possible risk.`,
      [`${unclassifiedCritical.id}.risk = critical`, `${unclassifiedCritical.id}.riskBasis = unclassified`]);
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
  } else if (rule('S4r short ritual due now', shortRitual, shortRitual
    ? `“${shortRitual.title}” is due now, comes first and takes ${shortRitual.facts.estimateMinutes} min (≤ ${SHORT_RITUAL_MINUTES})${runningBlock ? ` — ${runningBlock.id} stays protected and resumes after` : ''}`
    : `no short ritual due now (due-now, do-first and ≤ ${SHORT_RITUAL_MINUTES} min, from NEURO)`)) {
    const n = shortRitual.facts.estimateMinutes;
    lead = leadOf(shortRitual, 'S4r short ritual due now',
      `${String(shortRitual.title).replace(/[.!?]+$/, '')} — about ${n} minute${n === 1 ? '' : 's'}, before anything else${runningBlock ? `; ${leadTitle(runningBlock)} resumes right after it` : ''}.`,
      [`${shortRitual.id}.urgency = ritual-due`, `${shortRitual.id}.doFirst`, `${shortRitual.id}.estimateMinutes = ${n}`]);
  } else if (rule('S5 protected block', runningBlock, runningBlock ? `${runningBlock.id} ${runningBlock.time.start}–${runningBlock.time.end} is ${runningBlock.facts.state}` : 'no task block running in scope')) {
    lead = leadOf(runningBlock, 'S5 protected block', `This is the time you blocked for ${leadTitle(runningBlock)}. I’m holding the rest until ${runningBlock.time.end}.`, [`${runningBlock.id}.state = ${runningBlock.facts.state}`]);
  } else if (rule('S5f chosen focus', focusCand, focusCand ? `Nick is in a focus session on ${focusCand.id} (${focusCand.facts.inFocus.status})` : 'no focus session on an item outside a block')) {
    lead = leadOf(focusCand, 'S5f chosen focus', `You chose ${String(leadTitle(focusCand)).replace(/[.!?]+$/, '')}; I’m holding the rest while you’re on it.`, [`${focusCand.id}.inFocus = ${focusCand.facts.inFocus.status}`]);
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
  const guard = runningMeeting || runningBlock || protectedTime || focusCand;
  const protectedCtx = guard ? { ref: guard.id, kind: guard.kind, what: leadTitle(guard), until: (guard.time && guard.time.end) || null } : null;

  // Judgement: waiting approvals that are not the lead.
  const judgement = approvals.filter((a) => a.c.id !== lead.ref).map((a) => ({
    ref: a.c.id, what: a.c.title, where: a.c.facts.where, deadline: a.c.time.deadlineAt,
    effectiveDeadline: a.eff ? a.eff.at : null, effectiveBasis: a.eff ? a.eff.basis : null,
  }));

  // Held: everything displaced, returning when the guard ends.
  const returns = protectedCtx ? (protectedCtx.until ? `at ${protectedCtx.until}` : 'when you finish this') : 'after this';
  // The tasks the screen is already ABOUT (the running block's, or the lead block's) are never also held.
  const leadBlock = cands.find((c) => c.id === lead.ref && c.kind === 'block') || null;
  const blockTaskIds = new Set([runningBlock, leadBlock].filter(Boolean).flatMap((b) => (b.facts.tasks || []).map((t) => Number(t.taskId))));
  const held = [];
  for (const c of cands) {
    if (c.id === lead.ref || (guard && c.id === guard.id)) continue;
    // NEURO's meeting card is the same meeting as the diary entry — never held twice.
    if (c.kind === 'attention-item' && c.facts.type === 'meeting' && (c.title === lead.title || of('meeting').some((m) => m.title === c.title))) continue;
    let why = null;
    // An S2u item displaced by a running meeting stays visibly present (15 Oct 2026).
    if (c.facts && c.facts.risk === 'critical' && c.facts.riskBasis !== 'classified') why = 'possible risk — not yet classified';
    else if (c.kind === 'ritual') why = c.facts.reason || 'outstanding';
    else if (c.kind === 'attention-item') why = c.facts.reason || `${c.facts.type || 'item'} from NEURO`;
    else if (c.kind === 'held') why = c.facts.why || 'held back by NEURO';
    else if (c.kind === 'commitment' && c.facts.daysLate >= 0 && !blockTaskIds.has(Number(c.taskId))) {
      why = c.facts.daysLate === 0 ? 'due today' : `${c.facts.daysLate} day${c.facts.daysLate === 1 ? '' : 's'} overdue`;
      const b = c.facts.inBlock;
      if (b && b.start) {
        const today = b.date === new Date(now).toLocaleDateString('en-CA');
        const mins = today ? untilMinutes(b.start, now) : null;
        why += !today ? ' · already has a block' : mins > 0 ? ` · blocked at ${b.start}` : ` · its ${b.start} block has passed`;
      }
    }
    else if ((c.kind === 'home' || c.kind === 'personal-date') && c.facts.needsNow) why = c.facts.why || 'needs you';
    if (!why) continue;
    held.push({ ref: c.id, kind: c.kind, title: leadTitle(c), why, returns, wordingConflict: c.facts.wordingConflict || null });
  }

  // What Nick can do with each waiting item (16 Oct 2026). Nothing protected or imminent:
  // "Do now" — NEURO's own focus-session start for that exact item. Protected or imminent
  // (a meeting, a block, timed diary time, his chosen focus, risk, a deadline, a ritual
  // due now, a block about to start): never "Do now" — "Make next" books its own window
  // after this (NEURO's task-block route) or "After HH:MM" defers the card until then.
  const busyRules = ['S2 critical risk', 'S2u unclassified potential risk', 'S3 meeting', 'S3a imminent meeting transition', 'S4 deadline inside the block', 'S4r short ritual due now', 'S9 block about to start'];
  const busy = Boolean(guard) || busyRules.includes(lead.rule);
  const leadC = cands.find((c) => c.id === lead.ref) || null;
  const busyUntil = protectedCtx && protectedCtx.until ? protectedCtx.until
    : lead.rule === 'S3a imminent meeting transition' && transition && transition.c.time && transition.c.time.end ? transition.c.time.end
      : lead.rule === 'S9 block about to start' && leadC && leadC.time ? leadC.time.end : null;
  for (const h of held) h.actions = heldActions(cands.find((c) => c.id === h.ref), { busy, until: busyUntil, now });

  // Next: the first thing in scope that starts later today.
  const later = cands.filter((c) => (c.kind === 'block' || c.kind === 'meeting' || c.kind === 'protected-time') && !isRunning(c) && c.id !== lead.ref && ms(c.time && c.time.startAt) > now)
    .sort((a, b) => ms(a.time.startAt) - ms(b.time.startAt));
  const next = later[0] ? { ref: later[0].id, kind: later[0].kind, title: leadTitle(later[0]), start: later[0].time.start, inMinutes: Math.round((ms(later[0].time.startAt) - now) / 60000),
    // "I'm not going" — only when NEURO put that action on the meeting (a real meeting still to start).
    actions: later[0].kind === 'meeting' ? (later[0].actions || []).filter(isAttendance) : [] } : null;

  // Recommended action, then alternatives — limited by the manifestation, never by changing the lead.
  const leadCand = cands.find((c) => c.id === lead.ref) || null;
  let options = actionsFor(leadCand, now);
  const routeSources = [leadCand, lead.rule === 'S3a imminent meeting transition' && transition && transition.card !== leadCand ? transition.card : null].filter(Boolean);
  const heldRoutes = routeSources.flatMap((c) => (c.actions || []).filter(isRoute));
  if (lead.rule === 'S3a imminent meeting transition' && transition && transition.card && transition.card !== leadCand) options = [...actionsFor(transition.card, now), ...options];
  options = options.filter((o, i) => options.findIndex((x) => x.say === o.say) === i);
  // "I'm not going" is offered, never recommended: it goes last and never takes the lead button.
  options = [...options.filter((o) => !isAttendance(o)), ...options.filter(isAttendance)];
  const m = sf.manifestation;
  let recommended = options[0] && !isAttendance(options[0]) ? options[0] : null;
  let alternatives = recommended ? options.slice(1) : options;
  if (m.actions === 'none') {
    recommended = leadCand && recommended ? { handOff: 'the desktop', say: recommended.say } : null;
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
    // NEURO 'open' actions kept out of the action row: routes belong to the hand-off (15 Oct 2026).
    routesHeld: heldRoutes.map((a) => a.say),
    corrections,
    review,
    known: knownFor(k, sf.scope, blind),
    display: displayFor({ lead, leadCand: cands.find((c) => c.id === lead.ref) || null, guard, protectedCtx, held, judgement, approvals, next, cands, transition, runningBlock, interrupting, firstApproval, shortRitual, now, countOnly: m.held === 'count' }),
    trace,
  };
}

/**
 * The decision for input SAiM will not read. Same shape as any decision, so no
 * consumer needs a special case; it leads S1 blind because "I couldn't read it"
 * is never "nothing".
 */
function refusedDecision(check, surface, sf, now) {
  const why = 'I can’t read NEURO’s candidates right now — this isn’t an all-clear.';
  const reason = `${check.reason}${check.got ? ` (got ${check.got})` : ''}`;
  return {
    contract: CONTRACT,
    owner: 'saim',
    policyVersion: POLICY_VERSION,
    decidedAt: new Date(now).toISOString(),
    surface: { id: surface, scope: sf.scope, manifestation: sf.manifestation },
    scope: { id: sf.scope, excluded: {} },
    lead: { ref: null, kind: 'blind', title: null, rule: 'S1 blind', why, deciding: [`contract refused: ${reason}`] },
    protected: null,
    held: sf.manifestation.held === 'count' ? { count: 0 } : [],
    judgement: [],
    next: null,
    recommended: null,
    alternatives: [],
    corrections: [],
    review: { unclassified: [], action: null },
    refused: { family: check.family, reason: check.reason, got: check.got, supported: check.supported },
    known: Object.fromEntries(SECTIONS.map((s) => [s, { known: false, why: 'NEURO’s candidates couldn’t be read' }])),
    display: { lead: { title: null, sentence: why, when: null }, protected: null, held: sf.manifestation.held === 'count' ? { count: 0 } : [], judgement: [], next: null },
    trace: [{ rule: 'contract', applies: true, why: `refused: ${reason}; supported ${check.supported.join(', ')}` }],
  };
}

// ── C3: per rail section, was it read? ─────────────────────────────────────

const SECTIONS = Object.freeze(['protected', 'held', 'judgement', 'next']);

/**
 * Each rail section says whether NEURO could read what it depends on, from the
 * constraints NEURO states. A flag that is missing or not `true` is NOT read —
 * "NEURO didn't say" is never "nothing there".
 */
function knownFor(k, scope, blind) {
  const read = (flags) => {
    const missing = flags.filter(([f]) => k[f] !== true).map(([, words]) => words);
    return missing.length ? { known: false, why: `couldn’t read ${missing.join(' or ')}` } : { known: true, why: null };
  };
  if (blind) {
    const why = scope === 'home' ? 'couldn’t read the household model' : 'couldn’t read the attention pool';
    return Object.fromEntries(SECTIONS.map((s) => [s, { known: false, why }]));
  }
  const diary = [['blocksReadable', 'task blocks'], ['diaryReadable', 'the diary']];
  return {
    protected: read(diary),
    next: read(diary),
    judgement: read([['approvalsReadable', 'approvals']]),
    held: scope === 'home' ? read([['homeReadable', 'the household model']])
      : read([['poolReadable', 'the attention pool'], ['commitmentsReadable', 'commitments']]),
  };
}

// ── C5: what a screen may show ───────────────────────────────────────────────

/**
 * Display text for the decision, built ONLY from NEURO's per-candidate
 * `display` fields and SAiM's own words — never a raw title, id, type or
 * timestamp. Anything that fails shared/display-text's check is replaced with
 * a plain fallback, never shown. The machine fields (`lead.why`, `trace`)
 * are unchanged.
 */
function displayFor({ lead, leadCand, guard, protectedCtx, held, judgement, approvals, next, cands, transition, runningBlock, interrupting, firstApproval, shortRitual, now, countOnly }) {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const ok = (s) => (typeof s === 'string' && s && D.isSafeDisplay(s) ? s : null);
  // Every title on screen is a HEADLINE — the item as a short phrase, never the whole wording.
  const titleOf = (c) => (c && c.display ? ok(headline(sayTitle(c.display.title))) : null);
  const expl = (c) => (c && c.display ? ok(c.display.explanation) : null);
  const strip = (s) => String(s).replace(/[.!?]+$/, '');
  const t = titleOf(leadCand);
  const when = leadCand && leadCand.display ? ok(leadCand.display.timing) : null;
  // An explanation adds something only if neither the headline nor the timing already says it.
  const adds = (s) => (s && !repeats(t, s) && !repeats(when, s) ? s : null);
  const ex = adds(expl(leadCand));
  const guardTitle = titleOf(guard);
  const effWhen = (a) => (a && a.eff ? D.whenText(a.eff.at, now) : null);
  // The sentence SUPPORTS the headline: it never restates it (Nick, 15 Oct 2026 — "do not
  // show the full task wording twice"). Each rule refers back to the headline as "this"/"it".
  let sentence;
  switch (lead.rule) {
    case 'S1 blind': case 'S10 ritual': case 'S11 nothing': case 'S8 protected diary time':
      sentence = lead.why; break;
    case 'S2 critical risk':
      sentence = `This is critical${ex ? `: ${strip(ex)}` : ''}.`; break;
    case 'S2u unclassified potential risk':
      sentence = 'NEURO rated this critical, but this kind of item hasn’t been classified yet, so I’m treating it as possible risk.'; break;
    case 'S3 meeting':
      sentence = `You’re in it${guard && guard.time ? ` until ${guard.time.end}` : ''}; I’m holding everything else.`; break;
    case 'S3a imminent meeting transition': {
      const min = lead.transition && lead.transition.startsInMinutes;
      sentence = `It starts ${min ? `in ${min} minute${min === 1 ? '' : 's'}` : 'now'}${runningBlock && titleOf(runningBlock) ? `; I’ll hold ${titleOf(runningBlock)} for after it` : ''}.`;
      break;
    }
    case 'S4 deadline inside the block':
      sentence = `This has to be dealt with before ${effWhen(interrupting) || 'the block ends'}${runningBlock ? `, and this block runs to ${runningBlock.time.end}` : ''}.`; break;
    case 'S4r short ritual due now': {
      const n = shortRitual && shortRitual.facts.estimateMinutes;
      sentence = `About ${n} minute${n === 1 ? '' : 's'}, and it comes before anything else${runningBlock && titleOf(runningBlock) ? `. ${titleOf(runningBlock)} picks up right after` : ''}.`;
      break;
    }
    case 'S5 protected block':
      sentence = `This is your blocked time for it. I’m holding the rest until ${runningBlock.time.end}.`; break;
    case 'S5f chosen focus':
      sentence = 'You chose this. I’m holding the rest while you’re on it.'; break;
    case 'S6 judgement waiting':
      sentence = `It’s waiting for you in NEURO${effWhen(firstApproval) ? ` — before ${effWhen(firstApproval)}` : ''}.`; break;
    case 'S7 top item':
      sentence = ex ? `${strip(ex)}.` : 'It’s top of your list right now.'; break;
    case 'S9 block about to start':
      sentence = `It starts at ${leadCand && leadCand.time ? leadCand.time.start : 'soon'}.`; break;
    default: sentence = null;
  }
  // Backstop for the one sentence built from NEURO's words: if it still restates the headline, SAiM's own line replaces it.
  if (lead.rule === 'S7 top item' && t && repeats(sentence, t)) sentence = 'It’s top of your list right now.';
  return {
    lead: { title: t, sentence: ok(sentence) || 'SAiM has something for you, but couldn’t word it safely — open NEURO to see it.', when,
      // A block's focus clock, from NEURO's session — never a timer of SAiM's own.
      clock: leadCand && leadCand.kind === 'block' ? blockClock(leadCand, now) : leadCand && leadCand.facts && leadCand.facts.inFocus ? focusClock(leadCand.facts.inFocus) : null },
    protected: protectedCtx ? { what: guardTitle || 'Protected time', until: protectedCtx.until || null } : null,
    held: countOnly ? { count: Array.isArray(held) ? held.length : 0 } : held.map((h) => ({ title: titleOf(byId.get(h.ref)) || 'Held item', why: ok(h.why) || ok(expl(byId.get(h.ref))) || null, returns: h.returns })),
    judgement: judgement.map((j) => {
      const c = byId.get(j.ref);
      const a = approvals.find((x) => x.c.id === j.ref);
      return { what: titleOf(c) || 'An action waiting for your approval', by: effWhen(a), basis: a && a.eff && a.eff.basis !== 'its own expiry' ? a.eff.basis : null };
    }),
    next: next ? { title: titleOf(byId.get(next.ref)) || 'Next in the diary', when: `at ${next.start}` } : null,
  };
}

/** The clock for an item Nick chose to focus on: the session's own elapsed and planned minutes. */
function focusClock(s) {
  if (!s || !LIVE.includes(s.status)) return null;
  const paused = s.status !== 'active';
  const e = Number.isFinite(s.elapsedMinutes) ? s.elapsedMinutes : null;
  const p = Number.isFinite(s.plannedMinutes) ? s.plannedMinutes : null;
  const left = e != null && p != null ? p - e : null;
  return {
    state: paused ? 'paused' : 'running',
    elapsed: e != null ? `${e} min in${paused ? ' — paused' : ''}` : (paused ? 'Paused' : 'Started'),
    remaining: left == null ? null : left >= 0 ? `${left} min left of ${p}${s.plannedAssumed ? ' (assumed)' : ''}` : `${-left} min over ${p}${s.plannedAssumed ? ' (assumed)' : ''}`,
    started: s.startedTime ? `started ${s.startedTime}` : null,
  };
}

/**
 * What a waiting item offers (16 Oct 2026). Each comes from a NEURO route that exists:
 *   Do now     — POST /api/session/start for the task (or the card's own "I'm on it" start);
 *   Make next  — POST /api/task-blocks for the task: NEURO books its next free window;
 *   After HH:MM — the card's own defer, until then (only when NEURO offers a defer on it).
 * An item with no task and no card start gets nothing — never an invented action.
 */
function heldActions(c, { busy, until, now }) {
  if (!c) return [];
  const taskId = (c.kind === 'commitment' || c.kind === 'home') && c.taskId != null ? Number(c.taskId) : null;
  const cardStart = (c.actions || []).find((a) => a.intent && a.intent.kind === 'session' && a.intent.action === 'start');
  const cardDefer = (c.actions || []).find((a) => a.intent && a.intent.kind === 'act' && a.intent.action === 'defer' && a.intent.recordId);
  if (!busy) {
    if (taskId != null) return [{ say: 'Do now', intent: { kind: 'session', action: 'start', taskId, text: c.title } }];
    if (cardStart) return [{ say: 'Do now', intent: { ...cardStart.intent } }];
    return [];
  }
  // NEURO books one window per task: a task an open block already holds (or one NEURO could not
  // check — inBlock null) gets no "Make next"; the booking it has is said instead (heldWhy).
  if (taskId != null && c.facts.inBlock === false) return [{ say: until ? `Make next · after ${until}` : 'Make next', intent: { kind: 'block-next', taskId } }];
  const mins = untilMinutes(until, now);
  if (cardDefer && mins != null && mins > 0) return [{ say: `After ${until}`, intent: { kind: 'act', action: 'defer', recordId: cardDefer.intent.recordId, minutes: mins, reason: 'not-now' } }];
  return [];
}

/** Minutes from now until today's HH:MM, or null. */
function untilMinutes(hhmm, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const d = new Date(now); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return Math.ceil((d.getTime() - now) / 60000);
}

/**
 * The focus clock for a block, said from NEURO's facts (16 Oct 2026). Not started → null
 * (the action row offers "Start focus"). Started → the session's own elapsed minutes and
 * the minutes left in the block's window. SAiM keeps no clock of its own.
 */
function blockClock(c, now) {
  const s = c.facts && c.facts.session;
  if (!s || !s.status || !['active', 'paused', 'interrupted', 'needs-smaller'].includes(s.status)) return null;
  const end = ms(c.time && c.time.endAt);
  const left = end == null ? null : Math.max(0, Math.round((end - now) / 60000));
  const paused = s.status !== 'active';
  return {
    state: paused ? 'paused' : 'running',
    elapsed: Number.isFinite(s.elapsedMinutes) ? `${s.elapsedMinutes} min in${paused ? ' — paused' : ''}` : (paused ? 'Paused' : 'Started'),
    remaining: left == null ? null : left === 0 ? 'the block’s time is up' : `${left} min left in this block`,
    started: s.startedTime ? `started ${s.startedTime}` : null,
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

function actionsFor(c, now = Date.now()) {
  if (!c) return [];
  const out = [];
  // An item Nick is focused on: the session's own verbs (as for a block).
  if (c.kind !== 'block' && c.facts && c.facts.inFocus && LIVE.includes(c.facts.inFocus.status)) {
    if (c.facts.inFocus.status === 'active') {
      out.push({ say: 'Pause', intent: { kind: 'session', action: 'pause' } });
      out.push({ say: 'That’s done', intent: { kind: 'session', action: 'finish', ...(c.recordId ? { recordId: c.recordId } : {}) } });
      out.push({ say: 'Something came up', intent: { kind: 'session', action: 'step-away' } });
    } else {
      out.push({ say: 'Resume', intent: { kind: 'session', action: 'resume' } });
      out.push({ say: 'That’s done', intent: { kind: 'session', action: 'finish', ...(c.recordId ? { recordId: c.recordId } : {}) } });
    }
    return out;
  }
  if (c.kind === 'block') {
    // NEURO's own block actions (16 Oct 2026): "Start focus" starts a focus session on the
    // block's task through POST /api/session/start — the route NEURO's task list uses — for
    // the minutes left in the block. Once started, the session's own verbs. Never a timer here.
    const t = c.facts.tasks || [];
    const st = c.facts.session && c.facts.session.status;
    const live = ['active', 'paused', 'interrupted', 'needs-smaller'].includes(st);
    if (!live && t.length === 1 && c.blockId != null) {
      const end = ms(c.time && c.time.endAt);
      const left = end == null ? null : Math.round((end - now) / 60000);
      out.push({ say: 'Start focus', intent: { kind: 'start-block', taskId: t[0].taskId, text: t[0].text, blockId: c.blockId, ...(left > 0 ? { minutes: left } : {}) } });
    }
    if (st === 'active') {
      out.push({ say: 'Pause', intent: { kind: 'session', action: 'pause' } });
      out.push({ say: 'That’s done', intent: { kind: 'session', action: 'finish' } });
      out.push({ say: 'Something came up', intent: { kind: 'session', action: 'step-away' } });
    } else if (live) {
      out.push({ say: 'Resume', intent: { kind: 'session', action: 'resume' } });
      out.push({ say: 'That’s done', intent: { kind: 'session', action: 'finish' } });
    }
    // The surface's own session sentences say the same things — never twice.
    for (const a of c.actions || []) if (!isRoute(a) && !(a.intent && a.intent.kind === 'session') && !out.some((o) => o.say === a.say)) out.push(a);
    return out;
  }
  // The short ritual's own start: the standup happens in SAiM's Review.
  if (c.kind === 'attention-item' && c.facts.urgency === 'ritual-due' && c.facts.nudgeType === 'standup') {
    out.push({ say: 'Start the standup', intent: { kind: 'navigate', tab: 'review' } });
  }
  if (c.kind === 'ritual') out.push({ say: c.facts.ritual === 'eod' ? 'Start the end-of-day wrap' : 'Start the standup', intent: { kind: 'navigate', tab: 'review' } });
  // NEURO's own "open it" actions are ROUTES, not responses (15 Oct 2026). A route belongs to the
  // hand-off, which SAiM's resolver decides; offering one here as well gave the screen two answers
  // to "where do I go" — "Open State of Play" beside "no next step to open". Held out, and named
  // in the trace by the caller.
  for (const a of c.actions || []) if (!isRoute(a)) out.push(a);
  return out;
}

/** NEURO's attendance action on a meeting — "I'm not going" / "I'm not in it". */
function isAttendance(a) {
  const i = a && a.intent;
  return Boolean(i && i.kind === 'meeting' && i.action === 'not-attending' && typeof i.key === 'string' && i.key);
}

/** An action that takes Nick somewhere rather than recording his state. */
function isRoute(a) {
  const i = a && a.intent;
  return Boolean(i && i.kind === 'navigate' && (i.action === 'open' || i.recordId != null || i.view || i.href));
}

module.exports = { CONTRACT, POLICY_VERSION, SURFACES, BLOCK_END_MARGIN_MINUTES, MEETING_TRANSITION_MINUTES, SHORT_RITUAL_MINUTES, decide, inScope, effectiveDeadline, sayTitle };
