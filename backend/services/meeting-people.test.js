'use strict';

/**
 * Who is this meeting with?
 *
 * Pure, so what is under test is the product: which names count, and — the
 * expensive half — which do not. Every refusal here has already cost this
 * codebase something once:
 *
 *   - a bare first name attributed one Lucy's 16 commitments across four Lucys,
 *     and Chris Middleton's 31 to a Chris Smith;
 *   - `includes()` fired "Liam" inside "William";
 *   - an unreadable roster read as "nobody", which is a claim rather than a gap.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mp = require('../../shared/meeting-people.cjs');

// Shaped like the live roster: `full` is every People note, `firstNames` holds
// ONLY the first names that map to exactly one person — which is what makes
// them safe to match on.
const ROSTER = {
  full: ['Hope Goodall', 'Nathan Button', 'Nathan Rutland', 'Chris Middleton', 'Chris Smith', 'Lucy Bradshaw', 'William Ashby', 'Liam Deane'],
  firstNames: { Hope: 'Hope Goodall', Lucy: 'Lucy Bradshaw' },
};

const match = (s, r = ROSTER) => mp.matchPeopleInSubject(s, r);

// ── The names that count ─────────────────────────────────────────────────────

test('a full name in the subject is the person', () => {
  assert.deepEqual(match('1-2-1 Hope Goodall').people, ['Hope Goodall']);
});

test('an unambiguous first name counts', () => {
  assert.deepEqual(match('Catch up with Hope').people, ['Hope Goodall']);
});

test('people come back in the order the subject names them', () => {
  const r = match('Handover: Chris Middleton and Hope Goodall');
  assert.deepEqual(r.people, ['Chris Middleton', 'Hope Goodall']);
});

test('a subject naming two of the team is a GROUP, not two 1-2-1s', () => {
  const r = match('Hope Goodall / Chris Smith sync');
  assert.equal(r.group, true);
  assert.equal(r.people.length, 2);
});

test('one person is not a group', () => {
  assert.equal(match('1-2-1 Hope Goodall').group, false);
});

// ── The four-Lucys rule ──────────────────────────────────────────────────────

test('⚠ NEGATIVE: an AMBIGUOUS first name matches nobody', () => {
  // Two Nathans and two Chrises in the vault, so neither first name is in
  // `firstNames` — and guessing one is how 31 commitments went to the wrong man.
  assert.deepEqual(match('1-2-1 Nathan').people, []);
  assert.deepEqual(match('Catch up with Chris').people, []);
});

test('but their FULL names are unambiguous and do match', () => {
  assert.deepEqual(match('1-2-1 Nathan Rutland').people, ['Nathan Rutland']);
  assert.deepEqual(match('Chris Smith review').people, ['Chris Smith']);
});

// ── The William trap ─────────────────────────────────────────────────────────

test('⚠ NEGATIVE: a name inside another word is not a match', () => {
  // `includes()` fires "Liam" inside "William" — the documented bug.
  const r = match('Project handover with William Ashby');
  assert.deepEqual(r.people, ['William Ashby'], 'Liam Deane is not in this meeting');
});

test('punctuation is a word boundary, not part of a name', () => {
  assert.deepEqual(match('1-2-1: Hope Goodall (weekly)').people, ['Hope Goodall']);
  assert.deepEqual(match('Hope Goodall/Chris Smith').people.length, 2);
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test('⚠ NO ROSTER is `known:false`, never "nobody"', () => {
  // A surface saying "you're on your own" because the vault was unreadable is
  // stating a fact it does not have.
  // ⚠ Called DIRECTLY, not through the helper: `match` has a default parameter,
  // so passing `undefined` silently substituted the real roster and the test
  // could not test what it claimed. Same family as every other silent
  // substitution found today.
  for (const bad of [null, undefined, {}, { full: null }]) {
    const r = mp.matchPeopleInSubject('1-2-1 Hope Goodall', bad);
    assert.equal(r.known, false, JSON.stringify(bad));
    assert.deepEqual(r.people, []);
  }
});

test('a read roster with nobody named is known:true and empty', () => {
  const r = match('Quarterly planning');
  assert.equal(r.known, true, 'we looked');
  assert.deepEqual(r.people, []);
});

test('⚠ a name NOT in the roster is nobody — customers are not colleagues', () => {
  assert.deepEqual(match('Escalation call with Sandford').people, []);
});

test('an empty or missing subject yields nobody, without throwing', () => {
  for (const s of ['', '   ', null, undefined, 42]) {
    assert.deepEqual(match(s).people, [], JSON.stringify(s));
  }
});

test('nobody is counted twice when named by both first and full name', () => {
  assert.deepEqual(match('Hope Goodall — Hope to bring numbers').people, ['Hope Goodall']);
});

// ── The word matcher itself ──────────────────────────────────────────────────

test('hasWord is whole-word and case-insensitive', () => {
  assert.equal(mp.hasWord('Meeting with hope goodall', 'Hope Goodall'), true);
  assert.equal(mp.hasWord('William', 'Liam'), false);
  assert.equal(mp.hasWord('Liam, William', 'Liam'), true);
  assert.equal(mp.hasWord('', 'Hope'), false);
  assert.equal(mp.hasWord('Hope', ''), false);
});
