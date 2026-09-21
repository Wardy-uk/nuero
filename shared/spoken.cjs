'use strict';

/**
 * How a written line should be SAID.
 *
 * ⚠⚠ WHY THIS EXISTS. `CLAUDE.md`'s first line has said **"SAiM — Situational
 * Awareness & Intelligence Module, pronounced 'Sam'"** since the rename on
 * 15 Sep 2026, and NOTHING implemented it. Every speech path — piper through
 * Home Assistant, the tablet's own TextToSpeech, `services/tts.js`, the
 * browser's speechSynthesis, iOS's AVSpeechUtterance — was handed the written
 * form and said "say-im", or spelled it out. Confirmed aloud in the living room
 * on 21 Sep 2026. A rule written down and wired to nothing is the failure this
 * codebase names more often than any other.
 *
 * ⚠ THIS IS RENDERING, NOT REPHRASING. Every speaking surface carries a rule
 * that the brain's words are passed VERBATIM — `SaimVoice.speak`'s "nothing
 * here rephrases, truncates or appends", `greeter`'s composed text, the
 * Surface's `speech`. That rule is about the CONTENT of what she says and this
 * changes none of it: the same distinction as rendering a date as "Tuesday"
 * rather than 2026-09-22. Nothing here may ever add, drop or reorder a word.
 *
 * ⚠ IT IS APPLIED AT THE SPEECH BOUNDARY, NEVER AT COMPOSITION. The written
 * form is correct everywhere it is READ — on screen, in the vault, in a
 * notification — so a composer that emitted "Sam" would put the wrong spelling
 * on every surface in order to fix one. `spokenForm` is called by the thing
 * that hands text to a synthesiser, and by nothing else.
 *
 * ⚠ AND THE SERVER DOES IT FOR THE CLIENTS THAT CANNOT. The greeter normalises
 * before the text leaves NEURO, which covers BOTH the Home Assistant satellite
 * and the Android tablet — so the Kotlin app needs no change and cannot drift.
 * Only surfaces that speak text they received in some other way (iOS's feed
 * line, the browser's chat reply) need their own copy.
 */

/**
 * Spellings that all mean the product. ⚠ `SAIM` in SCREAMING_SNAKE, `Saim` in
 * PascalCase and `saim` in paths are all the same name to a reader and to a
 * synthesiser, so all of them are spoken the same way — the rename's own
 * spelling rules, read back out loud.
 */
const NAME = /\bsaim\b/gi;

/**
 * ⚠ WHOLE WORD ONLY. `entities.js` learned this the expensive way — an
 * `includes()` fired "Liam" inside "William" — and the rename doc records the
 * mirror image: `sara` followed by `h` is a real person's device and never a
 * match. A bare replace would rewrite a hostname or a slug mid-word.
 *
 * ⚠ A POSSESSIVE SURVIVES BY CONSTRUCTION: `\b` sits between "SAiM" and "'s",
 * so "SAiM's" becomes "Sam's" rather than being skipped.
 */
function spokenForm(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(NAME, 'Sam');
}

module.exports = { spokenForm };
