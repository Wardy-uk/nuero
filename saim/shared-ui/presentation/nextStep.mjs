// The one next step on SAiM's home (21 Oct 2026). PURE — no React, no I/O.
//
// Nick's live screen said "In a meeting" and offered nothing to do, while the
// payload under it already carried SAiM's hand-off ("Join in Teams", with
// "Open meeting prep" as the alternative). This turns THAT decision into one
// visible control. It decides nothing new:
//   - WHERE to go is `handoff` (saim-handoff-v1, saim/policy/handoff.cjs),
//     composed server-side; its order is kept, its labels are used verbatim;
//   - a destination is shown ONLY when this shell can complete it (`can`) —
//     a button that cannot finish is worse than none;
//   - nothing here sends, approves, books or grants anything. Every action is
//     a navigation, an external link NEURO supplied, or the existing desk
//     intent.
//
// Scope, deliberately narrow: the meeting rules. A promise's control lives in
// the Keep-my-word thread (one control per state, the contract's rule); a
// needs-you card carries its own controls; a calm screen stays quiet.

export const MEETING_RULES = Object.freeze(['S3 meeting', 'S3a imminent meeting transition']);

/**
 * One hand-off destination → an action this shell can complete, or null.
 *   can = { external: bool, tab: (id) => bool, desk: bool, neuro: bool }
 */
export function actionFor(dest, can = {}) {
  const t = dest && dest.target;
  if (!t || typeof dest.label !== 'string' || !dest.label) return null;
  if (t.type === 'link' && typeof t.href === 'string') {
    if (/^https:\/\//i.test(t.href)) return can.external ? { label: dest.label, run: { type: 'external', href: t.href } } : null;
    if (t.href.startsWith('neuro:')) {
      // Meeting prep is SAiM's own Prep view; anything else opens in NEURO.
      if (t.role === 'prep' && can.tab && can.tab('prep')) return { label: dest.label, run: { type: 'tab', tab: 'prep' } };
      return can.neuro ? { label: dest.label, run: { type: 'neuro', href: t.href } } : null;
    }
    return null;
  }
  if (t.type === 'desk' && typeof t.app === 'string') return can.desk ? { label: dest.label, run: { type: 'desk', app: t.app } } : null;
  // 'already' (it is in front) and 'elsewhere' (no launch here) are facts, not actions.
  return null;
}

/**
 * The step for the moment:
 *   { primary, alternatives, why }  — one clear action, then the resolver's others
 *   null                            — nothing honest to offer here
 */
export function nextStep({ handoff = null, presentation = null, context = null, can = {} } = {}) {
  const activity = context && context.activity;
  const mode = presentation && presentation.mode;
  const inMeeting = mode === 'in-meeting' || activity === 'in-meeting';
  const preMeeting = activity === 'pre-meeting';
  if (!inMeeting && !preMeeting) return null;

  const h = handoff && MEETING_RULES.includes(handoff.rule) ? handoff.handoff : null;
  const dests = h ? [h.primary, ...(Array.isArray(h.alternatives) ? h.alternatives : [])] : [];
  const seen = new Set();
  const acts = dests.map((d) => actionFor(d, can)).filter((a) => {
    if (!a) return false;
    const k = `${a.run.type}:${a.run.href || a.run.tab || a.run.app}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (acts.length) return { primary: acts[0], alternatives: acts.slice(1, 2), why: h.why || null };

  // No usable hand-off. In a meeting, a focused capture is always completable
  // where the shell has its Capture view; before one, its own Prep view.
  if (inMeeting && can.tab && can.tab('capture')) {
    return { primary: { label: 'Capture from this meeting', run: { type: 'tab', tab: 'capture' } }, alternatives: [], why: null };
  }
  if (preMeeting && can.tab && can.tab('prep')) {
    return { primary: { label: 'Open meeting prep', run: { type: 'tab', tab: 'prep' } }, alternatives: [], why: null };
  }
  return null;
}
