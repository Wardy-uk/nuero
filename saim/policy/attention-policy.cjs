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
const POLICY_VERSION = '2026-10-15.2';

/** How long before a block's end an approval deadline must fall to interrupt it. */
const BLOCK_END_MARGIN_MINUTES = 15;

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
  if (c.kind === 'attention-item') return c.facts.severity === 'critical';
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
  const critical = of('attention-item').find((c) => c.facts.severity === 'critical') || null;
  const approvals = of('approval').map((a) => ({ c: a, eff: effectiveDeadline(a.time && a.time.deadlineAt, ww, now) }))
    .sort((x, y) => (ms(x.eff && x.eff.at) ?? Infinity) - (ms(y.eff && y.eff.at) ?? Infinity));
  const topItem = of('attention-item').find((c) => c.facts.gatePosition === 'primary') || null;
  const needsNow = [...of('home'), ...of('personal-date')].find((c) => c.facts.needsNow) || null;
  const ritual = of('ritual')[0] || null;
  const blind = sf.scope !== 'home' && k.poolReadable === false;

  const trace = [];
  const rule = (id, applies, why) => { trace.push({ rule: id, applies: Boolean(applies), why }); return Boolean(applies); };

  const blockEnd = runningBlock ? ms(runningBlock.time.endAt) : null;
  const interrupting = runningBlock && approvals.find((a) => a.eff && ms(a.eff.at) != null && ms(a.eff.at) < blockEnd + BLOCK_END_MARGIN_MINUTES * 60000) || null;
  const firstApproval = approvals[0] || null;

  let lead = null;
  const leadOf = (c, ruleId, why, deciding) => ({ ref: c ? c.id : null, kind: c ? c.kind : 'none', title: c ? leadTitle(c) : null, rule: ruleId, why, deciding });

  if (rule('S1 blind', blind, blind ? 'NEURO could not read the attention pool' : sf.scope === 'home' ? 'not applied in home scope' : 'pool read')) {
    lead = leadOf(null, 'S1 blind', 'I can’t see your work right now — this isn’t an all-clear.', ['constraints.poolReadable = false']);
    lead.kind = 'blind';
  } else if (rule('S2 critical', critical, critical ? `“${critical.title}” is rated critical` : 'no critical item in scope')) {
    lead = leadOf(critical, 'S2 critical', `${critical.title} is critical${critical.facts.reason ? `: ${critical.facts.reason}` : ''}.`, [`${critical.id}.severity = critical`]);
  } else if (rule('S3 meeting', runningMeeting, runningMeeting ? `“${runningMeeting.title}” is running with other people in it` : 'no meeting running in scope')) {
    lead = leadOf(runningMeeting, 'S3 meeting', `You’re in ${runningMeeting.title} until ${runningMeeting.time.end}; I’m holding everything else.`, [`${runningMeeting.id}.running`, `${runningMeeting.id}.othersAttending`]);
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

module.exports = { CONTRACT, POLICY_VERSION, SURFACES, BLOCK_END_MARGIN_MINUTES, decide, inScope, effectiveDeadline, sayTitle };
