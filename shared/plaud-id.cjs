'use strict';

/**
 * A PLAUD recording id, in whatever form PLAUD is handing them out this month.
 *
 * ⚠⚠ PLAUD CHANGED THE ID FORMAT AND EVERY GUARD WE HAD WAS KEYED ON IT (15 Sep 2026).
 * Ids arrived prefixed `of_` — `of_f15f43b4…` for the recording previously known as
 * `f15f43b4…` — and BOTH defences against re-pulling a recording are keyed on that
 * string: the sync ledger (`syncedRecordings[id]`) and the existing-note index built
 * from `plaud_id` frontmatter. Neither matched, so every recording read as NEVER
 * SYNCED, 118 were re-downloaded, and because the filenames were taken they landed as
 * 111 `" 2.md"` twins of notes already in the vault. Those twins were new files to
 * `action-candidates`, so it re-extracted every commitment in them: 364 candidates,
 * 340 of which Nick had already rejected or done. Nothing errored. The ledger simply
 * held the same 118 recordings twice, under two spellings.
 *
 * ⚠ THE PREFIX LIST IS DELIBERATELY NARROW, AND THE ASYMMETRY IS WHY. Stripping any
 * short `xx_` prefix would generalise to the next format change — and would also merge
 * two genuinely different recordings if PLAUD ever mints an id that happens to be a
 * prefix plus another id, which LOSES A MEETING with nothing to say so. An unknown
 * prefix that goes unstripped only duplicates a note: visible, and recoverable. So we
 * strip what we have evidence for and `unknownPrefix()` makes the next one LOUD rather
 * than silent — the failure here was never the format, it was that nothing said it had
 * changed.
 *
 * ⚠ CANONICAL IS FOR KEYS, NEVER FOR THE API. `recording.id` is what PLAUD answers
 * `get_file`/`get_note`/`get_transcript` on; passing a canonicalised id back to PLAUD
 * asks for a file that does not exist. Canonical is what we key state on and what we
 * write into `plaud_id` frontmatter, so a note written today matches one written in
 * July.
 */

// Evidenced, not guessed: all 118 ids that arrived on 15 Sep 2026 were `of_` plus an id
// already in the ledger.
const KNOWN_PREFIXES = ['of_'];

// A bare id is a long run of hex-ish characters. Used to refuse stripping a prefix off
// something that would not leave a plausible id behind.
const BARE_ID = /^[A-Za-z0-9]{16,}$/;

// Anything of the shape `<short lowercase run>_<rest>`, whether or not we know it.
const PREFIXED = /^([a-z]{1,8})_(.+)$/;

function clean(value) {
  return String(value == null ? '' : value).trim().replace(/^"+|"+$/g, '');
}

/**
 * The key form of a recording id: the same recording always yields the same string,
 * whichever spelling PLAUD used. Returns '' for nothing usable, never undefined — a
 * caller keying state on `undefined` is how `plaud_id: "undefined"` reached the vault.
 */
function canonicalPlaudId(value) {
  const raw = clean(value);
  if (!raw) return '';

  for (const prefix of KNOWN_PREFIXES) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    // Refuse to strip if what is left is not a plausible id. `of_` on a short or
    // punctuated string is more likely to BE the id than to decorate one.
    if (BARE_ID.test(rest)) return rest;
    return raw;
  }

  return raw;
}

/**
 * The prefix on an id we do not know about, or null. Callers LOG this: a new prefix is
 * the exact condition that cost 111 duplicate notes, and it is only expensive while
 * nothing is saying it happened.
 */
function unknownPrefix(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (BARE_ID.test(raw)) return null;

  const match = raw.match(PREFIXED);
  if (!match) return null;

  const prefix = `${match[1]}_`;
  if (KNOWN_PREFIXES.includes(prefix)) return null;
  if (!BARE_ID.test(match[2])) return null;

  return prefix;
}

/** Do these two spellings name the same recording? */
function samePlaudRecording(a, b) {
  const left = canonicalPlaudId(a);
  return Boolean(left) && left === canonicalPlaudId(b);
}

module.exports = { canonicalPlaudId, unknownPrefix, samePlaudRecording, KNOWN_PREFIXES };
