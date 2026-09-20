'use strict';

/**
 * What Nick SAID, matched against the sentences she had already offered.
 *
 * SAiM's own principle (Nick, 31 Aug 2026): *"everything she can do should be
 * achievable conversationally"*. The sentences have been composed server-side
 * for weeks and could only ever be TAPPED — saying "not now" out loud streamed
 * a chat answer about deferring instead of deferring anything. The tap path and
 * the spoken path were two vocabularies, and only one of them worked.
 *
 * ── Why this is not a parser ────────────────────────────────────────────────
 * ⚠⚠ NO CLIENT PARSES LANGUAGE HERE, and that is the whole design. The server
 * composes, per utterance, the exact PHRASES that mean it (`phrasesFor` in
 * `saim-surface.js`); this module does string equality against that list. A
 * client is therefore never inferring what Nick meant — it is comparing what he
 * said to a closed list the brain wrote, which is the same relationship it
 * already has with `say`, `speech`, `tab` and `label`.
 *
 * ⚠ AMBIGUITY IS REFUSED, NEVER GUESSED. If two offered sentences claim the
 * same phrase, nothing matches and the words fall through to chat — where an
 * answer costs a sentence. Acting on a coin toss costs a deferral he did not
 * make, on a card he was looking at.
 *
 * ⚠ IT ONLY EVER MATCHES WHAT IS ON OFFER. The list is bounded by what
 * `attention-lifecycle` allows on that card, so a sentence NEURO would refuse
 * cannot be reached by saying it any more than by tapping it.
 *
 * PURE. No clock, no storage, no I/O.
 */

/**
 * PURE. The comparable form of something said aloud.
 *
 * ⚠ Dictation is lossy and inconsistent about punctuation, so apostrophes and
 * full stops are stripped rather than trusted — "that's done", "thats done" and
 * "That's done." are one phrase. Curly and straight apostrophes both go, because
 * the composed sentences use curly ones and iOS dictation emits straight.
 */
function normaliseSaid(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Stop talking.
 *
 * ⚠ NOT AN UTTERANCE, because it is not a thing to put on screen — it is an
 * interruption, and a button reading "stop" beside a sentence she is halfway
 * through saying would be furniture for a state that lasts four seconds.
 *
 * ⚠ It cancels SPEECH and closes the exchange. It does not cancel a write
 * already sent: a request that has left is out of this shell's hands, and
 * claiming otherwise is the "a request sent is not an action completed" rule
 * pointed backwards.
 */
const STOP_PHRASES = new Set(['stop', 'stop talking', 'be quiet', 'quiet', 'shush', 'enough', 'cancel that']);

/**
 * PURE. What he said, resolved against what was on offer.
 *
 * @param {string} said        the dictated words
 * @param {Array}  utterances  the payload's own list, each carrying `phrases`
 * @returns {{kind:'utterance', utterance}|{kind:'control', control:'stop'}|null}
 *          null means "this was not a command" — and the caller must then treat
 *          it as a question, never as a failed command.
 */
function matchSaid(said, utterances) {
  const n = normaliseSaid(said);
  if (!n) return null;

  if (STOP_PHRASES.has(n)) return { kind: 'control', control: 'stop' };

  const hits = [];
  for (const u of Array.isArray(utterances) ? utterances : []) {
    if (!u || !u.intent || !Array.isArray(u.phrases)) continue;
    if (u.phrases.some((p) => normaliseSaid(p) === n)) hits.push(u);
  }

  // ⚠ EXACTLY ONE, or nothing. Two sentences claiming one phrase is the
  //   composer's bug to fix, and guessing between them here would hide it while
  //   acting on a card in front of him.
  return hits.length === 1 ? { kind: 'utterance', utterance: hits[0] } : null;
}

module.exports = { normaliseSaid, matchSaid, STOP_PHRASES };
