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
// Navigation carries CONTEXT the target screen needs to be specific:
//   - prep → `{ eventId }` read from NEURO's own `neuro:?item=meeting-prep:<id>`
//     link, so Prep opens THIS meeting rather than the next one to start;
//   - capture → `{ meeting }`, the canonical running meeting (`payload.meeting`,
//     key + subject) or null when NEURO did not name one — never guessed.
//
// Scope, deliberately narrow: the meeting rules. A promise's control lives in
// the Keep-my-word thread (one control per state, the contract's rule); a
// needs-you card carries its own controls; a calm screen stays quiet.

export const MEETING_RULES = Object.freeze(['S3 meeting', 'S3a imminent meeting transition']);
export const CAPTURE_LABEL = 'Capture from this meeting';

/** The exact event id in NEURO's meeting-prep link, or null. */
export function prepEventId(href) {
  const m = /^neuro:\?(.*)$/.exec(String(href || ''));
  if (!m) return null;
  let item = null;
  try { item = new URLSearchParams(m[1]).get('item'); } catch { return null; }
  if (!item || !item.startsWith('meeting-prep:')) return null;
  const id = item.slice('meeting-prep:'.length);
  return id && id.length <= 600 ? id : null;
}

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
      // Meeting prep is SAiM's own Prep view — for THIS event; anything else opens in NEURO.
      if (t.role === 'prep' && can.tab && can.tab('prep')) {
        const eventId = prepEventId(t.href);
        return { label: dest.label, run: { type: 'tab', tab: 'prep', context: eventId ? { eventId } : null } };
      }
      return can.neuro ? { label: dest.label, run: { type: 'neuro', href: t.href } } : null;
    }
    return null;
  }
  if (t.type === 'desk' && typeof t.app === 'string') return can.desk ? { label: dest.label, run: { type: 'desk', app: t.app } } : null;
  // 'already' (it is in front) and 'elsewhere' (no launch here) are facts, not actions.
  return null;
}

/** The canonical running meeting, as Capture may name it — key + subject only. */
function meetingRef(meeting) {
  return meeting && typeof meeting.key === 'string' && meeting.key && typeof meeting.subject === 'string' && meeting.subject.trim()
    ? { key: meeting.key, subject: meeting.subject.trim(), scheduledEnd: meeting.scheduledEnd || null }
    : null;
}

/**
 * The step for the moment:
 *   { primary, alternatives, why }  — one clear action, then at most two others
 *   null                            — nothing honest to offer here
 */
export function nextStep({ handoff = null, presentation = null, context = null, meeting = null, can = {} } = {}) {
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
  // In a RUNNING meeting, capturing what was just said is always worth a place
  // where the shell can save it — after SAiM's own destinations, never ahead.
  const capture = inMeeting && can.tab && can.tab('capture')
    ? { label: CAPTURE_LABEL, run: { type: 'tab', tab: 'capture', context: { meeting: meetingRef(meeting) } } }
    : null;
  if (acts.length) {
    const alternatives = acts.slice(1, 2);
    if (capture) alternatives.push(capture);
    return { primary: acts[0], alternatives, why: h.why || null };
  }
  if (capture) return { primary: capture, alternatives: [], why: null };
  if (preMeeting && can.tab && can.tab('prep')) {
    return { primary: { label: 'Open meeting prep', run: { type: 'tab', tab: 'prep', context: null } }, alternatives: [], why: null };
  }
  return null;
}
