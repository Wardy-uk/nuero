// "Not today" — ONE vocabulary for every surface (7 Nov 2026, audit).
//
// Three wordings for the same four reasons had grown up (Tasks, Next steps, the
// Now card). The keys are attention-lifecycle's DEFER_REASONS, which friction.js
// reads back as evidence about the work — so the key must be what Nick meant,
// never a stand-in ("Tomorrow" is a WHEN, not a reason: it records `not-now`).
//
// `too-big` is special: every surface offers "Smallest first step?" instead of
// hiding the task (see startTask.mjs `startSmallestStep`).

export const NOT_TODAY_REASONS = Object.freeze([
  { key: 'not-now', label: 'Just not today', desc: 'Nothing wrong with it — another day' },
  { key: 'too-big', label: "It's too big", desc: 'Pick the smallest first step and start that' },
  { key: 'waiting-on-someone', label: "I'm blocked", desc: 'Waiting on somebody else' },
  { key: 'no-context', label: 'Missing something', desc: 'Wrong place, or something I need isn’t here' },
]);

/** Read a stored reason back in words. Unknown → null, never the raw key. */
export function reasonWords(key) {
  const r = NOT_TODAY_REASONS.find((x) => x.key === key);
  return r ? r.label.replace(/^It's /, '').replace(/^I'm /, '').toLowerCase() : null;
}
