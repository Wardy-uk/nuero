'use strict';

// Who is this meeting with? (13 Sep 2026)
//
// PURE and browser-safe. Takes a meeting subject and the roster, returns the
// people it names. No vault, no DB, no network — the caller supplies both.
//
// It exists because `pre-meeting` is the moment SARA could most obviously earn
// her keep — walking into a 1-2-1, showing who it is with and what they are
// owed — and the dashboard rendered the diary and nothing else. The attendee
// list is NOT available: `calendar_cache` stores no names, and `agendaFor`
// carries only the three-valued `attendeesOther`. The subject is what there is.
//
// ⚠ FULL NAMES ALWAYS; A FIRST NAME ONLY WHEN IT IDENTIFIES ONE PERSON. This is
//   the four-Lucys bug, which is documented in this codebase twice over: 16 of
//   one Lucy's commitments were attributed across four Lucys, and Chris
//   Middleton's 31 went to a Chris Smith. `roster.firstNames` is already the
//   set that survives that test — it holds a first name only where the vault
//   has exactly one person with it — so this consults that rather than
//   splitting names itself.
//
// ⚠ WHOLE WORD, NEVER `includes()`. `entities.js` learned this the hard way:
//   a substring match fired "Liam" inside "William". Every comparison here is
//   bounded by a non-letter.
//
// ⚠ A SUBJECT NAMING SEVERAL OF THE TEAM IS A GROUP MEETING, not a 1-2-1 with
//   each of them in turn. It still reports them; what it refuses to do is call
//   a three-hander a one-to-one, because the prep for those is different.
//
// ⚠ NOTHING IS INFERRED FROM A NAME THAT IS NOT IN THE ROSTER. A customer, a
//   supplier or a word that happens to look like a name yields nobody — the
//   roster is the authority on who Nick works with, exactly as `team-roster`
//   made it for every other consumer.

/** Is `needle` present in `haystack` as a whole word? Case-insensitive. */
function hasWord(haystack, needle) {
  const h = String(haystack || '').toLowerCase();
  const n = String(needle || '').toLowerCase().trim();
  if (!h || !n) return false;
  let from = 0;
  for (;;) {
    const i = h.indexOf(n, from);
    if (i === -1) return false;
    const before = i === 0 ? '' : h[i - 1];
    const after = i + n.length >= h.length ? '' : h[i + n.length];
    const boundary = c => c === '' || !/[a-z0-9]/i.test(c);
    if (boundary(before) && boundary(after)) return true;
    from = i + 1;
  }
}

/**
 * @param {string} subject   the meeting title
 * @param {object} roster    `entities.getRoster()` — { full: [], firstNames: {} }
 * @returns {{ people, group, known }}
 *   people  full names, in the order they appear in the subject
 *   group   true when the subject names more than one of them
 *   known   false when there is no roster to match against — which is NOT the
 *           same as a meeting with nobody in it
 */
function matchPeopleInSubject(subject, roster) {
  const text = typeof subject === 'string' ? subject : '';
  const full = roster && Array.isArray(roster.full) ? roster.full : null;
  const firsts = roster && roster.firstNames && typeof roster.firstNames === 'object'
    ? roster.firstNames : {};

  // ⚠ No roster is UNKNOWN, never "nobody". A surface that says "on your own"
  // because the vault was unreadable is stating a fact it does not have.
  if (!full) return { people: [], group: false, known: false };
  if (!text.trim()) return { people: [], group: false, known: true };

  const found = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    found.push({ name, at: String(text).toLowerCase().indexOf(String(name).toLowerCase()) });
  };

  for (const name of full) {
    if (hasWord(text, name)) add(name);
  }

  // First names, but only the ones the roster says are unambiguous.
  for (const [first, name] of Object.entries(firsts)) {
    if (!name || seen.has(name)) continue;
    if (hasWord(text, first)) {
      found.push({ name, at: String(text).toLowerCase().indexOf(String(first).toLowerCase()) });
      seen.add(name);
    }
  }

  found.sort((a, b) => (a.at < 0 ? 1e9 : a.at) - (b.at < 0 ? 1e9 : b.at));
  const people = found.map(f => f.name);
  return { people, group: people.length > 1, known: true };
}

module.exports = { matchPeopleInSubject, hasWord };
