// SAiM Alt v2 — desktop manifestation ADAPTER (local-only, read-only; 15 Oct 2026).
//
// PURE: three contracts in, the approved `working` view-model out.
//   neuro-candidates-v2  (NEURO's facts)
//   saim-attention-v2    (SAiM's decision: lead, protected, held, judgement, next, known, display)
//   saim-handoff-v1      (SAiM's hand-off: where to go, or why not, or "What will you use?")
//
// It DECIDES NOTHING. It never re-runs the policy or the resolver, never infers
// an activity, never reads a raw title or reason, and never falls back to v1:
// any contract it does not support is refused, on screen, as "not an all-clear".
// Every word a person sees comes from a C5 `display` field, a resolver label, or
// this file's own fixed vocabulary — and passes the shared safety check.

import CONTRACTS from '../../../shared/attention-contracts.cjs';
import DISPLAY from '../../../shared/display-text.cjs';

const shown = (s) => (typeof s === 'string' && s && DISPLAY.isSafeDisplay(s) ? s : null);

/** One row per rule: the state the fixed frame shows. Words are this file's own. */
export const STATE = Object.freeze({
  'S1 blind': { tone: 'blind', word: 'can’t see your work', label: () => 'Can’t see your work' },
  'S2 critical risk': { tone: 'risk', word: 'risk', label: () => 'Risk · now' },
  'S3 meeting': { tone: 'meeting', word: 'in a meeting', label: (d) => `In a meeting${d.protected ? ` · until ${d.protected.until}` : ''}` },
  'S2u unclassified potential risk': { tone: 'possible', word: 'possible risk', label: () => 'Possible risk · not yet classified' },
  'S3a imminent meeting transition': { tone: 'soon', word: 'meeting next', label: () => 'Meeting about to start' },
  'S4 deadline inside the block': { tone: 'deadline', word: 'deadline inside this block', label: () => 'Due before this block ends' },
  'S5 protected block': { tone: 'block', word: 'working', label: (d) => `Active${d.protected ? ` · until ${d.protected.until}` : ''}` },
  'S6 judgement waiting': { tone: 'judge', word: 'waiting on you', label: () => 'Waiting for your decision' },
  'S7 top item': { tone: 'item', word: 'working', label: () => 'Top of the list' },
  'S8 protected diary time': { tone: 'guard', word: 'protected time', label: (d) => `Protected time${d.protected ? ` · until ${d.protected.until}` : ''}` },
  'S9 block about to start': { tone: 'soon', word: 'block next', label: () => 'Starting soon' },
  'S10 ritual': { tone: 'ritual', word: 'ritual due', label: () => 'Ritual due' },
  'S11 nothing': { tone: 'calm', word: 'clear', label: () => 'Nothing needs you' },
});

/** What the protected item is doing while something else leads — by the rule that displaced it. */
const GUARD_VERB = Object.freeze({
  'S2 critical risk': 'paused while you deal with this — not lost',
  'S2u unclassified potential risk': 'paused while you check this — not lost',
  'S3a imminent meeting transition': 'held for after the meeting',
  'S4 deadline inside the block': 'resumes once this is dealt with',
});

/** The field drive per rule (approved): colour carries the state, never visibility. */
const DRIVE = Object.freeze({
  'S1 blind': { degraded: true },
  'S2 critical risk': { activity: 'working', confidenceLevel: 'high', pressing: true },
  'S2u unclassified potential risk': { activity: 'firefighting', confidenceLevel: 'high' },
  'S3 meeting': { activity: 'in-meeting', confidenceLevel: 'high', quiet: true },
  'S3a imminent meeting transition': { activity: 'pre-meeting', confidenceLevel: 'high' },
  'S5 protected block': { activity: 'in-focus-session', confidenceLevel: 'high' },
  'S8 protected diary time': { activity: 'working', confidenceLevel: 'moderate' },
  'S10 ritual': { activity: 'ritual', confidenceLevel: 'high' },
  'S11 nothing': { activity: 'steady', confidenceLevel: 'high' },
});

const HEADING = Object.freeze({ work: 'Best next place', meeting: 'The meeting', judgement: 'Decided in NEURO', control: 'Where to act', connection: 'Where to look' });
const WHERE = Object.freeze({ desk: 'opens on the laptop', link: 'opens in a new tab', elsewhere: 'on the desktop', already: null });

function refusal(why, problem) {
  return {
    refused: { why, problem: problem || null },
    tone: 'blind', presence: 'SAiM · desk active · can’t read SAiM’s decision', state: 'Can’t read SAiM’s decision',
    title: 'I can’t read SAiM’s decision right now — this isn’t an all-clear.', sentence: null,
    guard: null, actions: [], handoff: null, ask: null, handoffNote: null, joinGap: null,
    rail: { next: { unread: true, why: 'nothing was read' }, held: { unread: true, why: 'nothing was read' }, judgement: { unread: true, why: 'nothing was read' } },
    drive: { degraded: true }, rule: null,
  };
}

/** Which hand-off this is, from the destination's own type and role — never its words. */
function kindOf(h, rule) {
  if (rule === 'S1 blind') return 'connection';
  if (rule === 'S3 meeting' || rule === 'S3a imminent meeting transition') return 'meeting';
  if (rule === 'S4 deadline inside the block' || rule === 'S6 judgement waiting') return 'judgement';
  if (rule === 'S2 critical risk' || rule === 'S2u unclassified potential risk') return 'control';
  return 'work';
}

const dest = (d) => {
  const label = shown(d && d.label);
  if (!label || !d.target) return null;
  return { label, type: d.target.type, href: d.target.type === 'link' ? d.target.href : null, app: d.target.app || null, where: WHERE[d.target.type] || null };
};

/**
 * @param {{ candidates, saim, handoff }} payload  — the three fields of /api/canonical/now
 */
export function manifest(payload) {
  const p = payload || {};
  const c = CONTRACTS.checkCandidates(p.candidates);
  if (!c.ok) return refusal('NEURO’s candidates aren’t a version this screen reads.', `${c.family}: ${c.reason}`);
  const a = CONTRACTS.checkAttention(p.saim);
  if (!a.ok) return refusal('SAiM’s decision isn’t a version this screen reads.', `${a.family}: ${a.reason}`);
  const h = CONTRACTS.checkHandoff(p.handoff);
  if (!h.ok) return refusal('SAiM’s hand-off isn’t a version this screen reads.', `${h.family}: ${h.reason}`);
  const d = p.saim;
  const ho = p.handoff;
  if (ho.decidedFor !== d.lead.ref || ho.rule !== d.lead.rule) return refusal('SAiM’s hand-off was for a different moment.', 'saim-handoff: decidedFor does not match the lead');
  const st = STATE[d.lead.rule];
  if (!st) return refusal('SAiM’s decision names a rule this screen doesn’t know.', `rule ${d.lead.rule}`);

  const disp = d.display;
  const blind = d.lead.rule === 'S1 blind';
  const title = shown(disp.lead.title);
  const leadIsGuard = d.protected && d.protected.ref === d.lead.ref;

  // The action row: SAiM's own recommended sentence + alternatives (read-only here). A hand-off is not an action.
  const acts = d.recommended && !d.recommended.handOff ? [d.recommended, ...(d.alternatives || [])] : [];
  const actions = acts.map((x) => shown(x && x.say)).filter(Boolean).map((say) => ({ say }));

  // Hand-off box (resolver labels only) — or its honest absence.
  let handoff = null; let ask = null; let handoffNote = null;
  if (ho.handoff) {
    const primary = dest(ho.handoff.primary);
    handoff = primary ? { kind: kindOf(ho, d.lead.rule), heading: HEADING[kindOf(ho, d.lead.rule)], primary, alternatives: (ho.handoff.alternatives || []).map(dest).filter(Boolean).slice(0, 3), why: shown(ho.handoff.why) } : null;
  } else {
    handoffNote = shown(ho.reason);
    if (ho.ask) {
      ask = {
        question: shown(ho.ask.question) || 'What will you use?',
        options: ho.ask.options.map((o) => ({ label: shown(o.label), suggested: Boolean(o.suggested), basis: o.basis === 'source' ? 'from where it came from' : o.basis === 'observed' ? 'from what you used before' : null })).filter((o) => o.label),
        deviceSpecific: Boolean(ho.ask.deviceSpecific),
      };
    }
  }
  // A meeting with no join link (or no app) is said as NEURO's gap — never an invented Teams button.
  // NEURO's gap FIELD NAMES for the lead (structured, from the candidate itself — never its wording).
  const leadCand = p.candidates.candidates.find((x) => x.id === d.lead.ref) || null;
  const gaps = [...new Set([...(Array.isArray(ho.neuroGaps) ? ho.neuroGaps : []),
    ...(leadCand && Array.isArray(leadCand.handoffGaps) ? leadCand.handoffGaps.map((g) => g && g.field).filter(Boolean) : [])])];
  const meetingLead = d.lead.rule === 'S3 meeting' || d.lead.rule === 'S3a imminent meeting transition';
  const joinGap = meetingLead && gaps.includes('join')
    ? `No join link — NEURO’s diary doesn’t keep meeting join links yet${gaps.includes('provider') ? ', or which app hosts the meeting' : ''}, so SAiM won’t guess one.`
    : null;

  const sec = (name, fn) => (d.known[name].known ? fn() : { unread: true, why: d.known[name].why });
  const rail = {
    next: sec('next', () => (disp.next ? { title: shown(disp.next.title), when: shown(disp.next.when) } : { empty: true })),
    held: sec('held', () => (Array.isArray(disp.held)
      ? { count: disp.held.length, returns: disp.held[0] ? shown(disp.held[0].returns) : null, items: disp.held.map((x) => ({ title: shown(x.title) || 'Held item', why: shown(x.why), risky: x.why === 'possible risk — not yet classified' })) }
      : { count: disp.held.count, returns: null, items: [] })),
    judgement: sec('judgement', () => ({ items: disp.judgement.map((j) => ({ what: shown(j.what) || 'An action waiting for your approval', by: shown(j.by), basis: shown(j.basis) })) })),
  };

  return {
    refused: null,
    rule: d.lead.rule,
    tone: st.tone,
    presence: `SAiM · desk active · ${st.word}`,
    state: st.label(disp),
    title: title || shown(disp.lead.sentence),
    sentence: title ? shown(disp.lead.sentence) : null,
    when: shown(disp.lead.when),
    guard: disp.protected && !leadIsGuard ? { what: shown(disp.protected.what) || 'Protected time', until: shown(disp.protected.until), verb: GUARD_VERB[d.lead.rule] || 'still protected' } : null,
    unreadLead: blind ? ['your tasks and blocks', 'the diary', 'approvals waiting'] : null,
    actions,
    handoff, ask, handoffNote, joinGap,
    rail,
    drive: { activity: 'working', confidenceLevel: 'high', quiet: false, degraded: false, pressing: false, ...(DRIVE[d.lead.rule] || {}) },
  };
}

/** Every string the view-model would put on screen — for the safety tests. */
export function visibleStrings(vm) {
  const out = [];
  const walk = (x) => {
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (!['href', 'app', 'type', 'tone', 'rule', 'drive', 'problem', 'kind'].includes(k)) walk(v);
  };
  walk(vm);
  return out;
}
