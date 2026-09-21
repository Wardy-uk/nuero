'use strict';

/**
 * How SAiM's name is said out loud.
 *
 * ⚠⚠ THE BUG THESE EXIST FOR, heard in the living room on 21 Sep 2026: the
 * satellite said "say-im". `CLAUDE.md`'s FIRST LINE has documented
 * *"pronounced 'Sam'"* since the rename, and a grep across every speech path —
 * `tts.js`, the greeter, `voiceUtils.js`, iOS `SaimVoice` — found no
 * implementation at all. The rule existed and nothing read it.
 *
 * ⚠ The Swift copy in `nuero-ios` is pinned by `SpokenFormTests` there. Two
 * languages cannot share a module (the `PRICES_PER_MTOK` situation), so the
 * cases below and the cases there are deliberately the same list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spokenForm } = require('../../shared/spoken.cjs');

test('every spelling of the name is said the same way', () => {
  // The rename's own spelling rules — SCREAMING_SNAKE, PascalCase, slug — read
  // back out loud. They are one name to a reader and to a synthesiser.
  assert.equal(spokenForm('This is SAiM.'), 'This is Sam.');
  assert.equal(spokenForm('Ask SAIM about it'), 'Ask Sam about it');
  assert.equal(spokenForm('Saim is ready'), 'Sam is ready');
  assert.equal(spokenForm('the saim surface'), 'the Sam surface');
});

/**
 * ⚠ WHOLE WORD ONLY. `entities.js` learned this the expensive way — an
 * `includes()` fired "Liam" inside "William". A bare replace would rewrite a
 * word that merely contains the letters.
 */
test('a word that merely contains the name is untouched', () => {
  assert.equal(spokenForm('a mosaic pattern'), 'a mosaic pattern');
  assert.equal(spokenForm('SAiMtastic'), 'SAiMtastic');
  assert.equal(spokenForm('disclaim the warranty'), 'disclaim the warranty');
});

test('a possessive keeps its apostrophe', () => {
  assert.equal(spokenForm("SAiM's reading your diary"), "Sam's reading your diary");
});

/**
 * ⚠ NOTHING IS ADDED, DROPPED OR REORDERED. Every speaking surface carries a
 * rule that the brain's words are passed verbatim; this changes how ONE name is
 * said and must never become a place where wording is edited. A line with no
 * name in it must come back byte-identical.
 */
test('a line without the name comes back unchanged', () => {
  const line = 'Morning, Nick. Standup in 10 minutes.';
  assert.equal(spokenForm(line), line);
});

test('word count never changes', () => {
  const before = 'Morning, Nick. SAiM here — standup in 10 minutes.';
  const after = spokenForm(before);
  assert.equal(after.split(/\s+/).length, before.split(/\s+/).length);
  assert.notEqual(after, before, 'positive control: this line DOES contain the name');
});

test('nothing but a string is touched', () => {
  assert.equal(spokenForm(null), null);
  assert.equal(spokenForm(undefined), undefined);
  assert.equal(spokenForm(''), '');
  assert.equal(spokenForm(42), 42);
});
