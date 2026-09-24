'use strict';

/**
 * People gap review — the rules that decide what is OFFERED.
 *
 * Pure throughout: no vault, no DB, no clock. The four judgements here are the
 * product (what is not a person, what is a near miss, what line goes into a
 * note, what counts as news), and every one of them is a decision about Nick's
 * own second brain, so they pin without an environment.
 *
 * Fixtures are the LIVE names off the 23 Sep report and the real `aliases:`
 * blocks in the vault, never invented ones — the whole finding is that the
 * plausible implementation is wrong on the actual data.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  nonPersonReason, nearestPerson, insertAlias, newCandidates,
} = require('./people-gap');

// ── Not a person ──────────────────────────────────────────────────────────

test('a room is refused, and the reason names the rule that caught it', () => {
  const reason = nonPersonReason('The Scrum Room');
  assert.ok(reason, 'The Scrum Room must be refused — it came back every night');
  assert.match(reason, /Room|The/);
});

test('the suffix is anchored to the LAST word, never a substring', () => {
  // A real colleague whose surname contains a rule word must survive. Matching
  // anywhere is how a person stops existing.
  assert.equal(nonPersonReason('Mark Roomes'), null);
  assert.equal(nonPersonReason('Helen Officer'), null);
  assert.equal(nonPersonReason('Sarah Deskins'), null);
});

test('every live candidate that IS a person survives the filter', () => {
  const live = ['Melanie Ellis', 'Richard Power', 'Catherine Thorpe',
    'Naomi Winkworth', 'Abigail Brown', 'Joshua Mills', 'Steven Ryan'];
  for (const name of live) {
    assert.equal(nonPersonReason(name), null, name + ' must not be filtered out');
  }
});

test('a single word is never refused by these rules', () => {
  // `looksLikePerson` already rejects a bare word; this rule must not also claim
  // it, or the reported reason names the wrong cause.
  assert.equal(nonPersonReason('Room'), null);
  assert.equal(nonPersonReason('The'), null);
});

// ── Near misses ───────────────────────────────────────────────────────────

const ROSTER = ['Naomi Wentworth', 'Chris Middleton', 'Chris Smith',
  'Abdi Mohamed', 'Nick Ward', 'Ben Methrington'];

test('the live mis-transcription is matched to the real person', () => {
  const hit = nearestPerson('Naomi Winkworth', ROSTER);
  assert.ok(hit, 'Winkworth/Wentworth is the case this exists for');
  assert.equal(hit.name, 'Naomi Wentworth');
});

test('a shared FIRST name is never enough — two real colleagues stay two people', () => {
  // Chris Middleton and Chris Smith share a first name and nothing else. A rule
  // letting both halves drift would offer to fold one real colleague into
  // another, which has no undo from a card.
  assert.equal(nearestPerson('Chris Middleton', ROSTER), null);
  assert.equal(nearestPerson('Chris Smith', ROSTER), null);
});

test('a DIFFERENT first name is never a near miss, however close the surname', () => {
  // ⚠ The surname must be CLOSE BUT NOT EQUAL, or the "same person" guard
  // answers null on its own and the first-name gate could be deleted with this
  // test still green — which is exactly what the first draft of it did.
  assert.equal(nearestPerson('Naoise Wenworth', ['Naomi Wentworth']), null);
  assert.equal(nearestPerson('Kris Middletown', ['Chris Middleton']), null);
});

test('ambiguity is REFUSED, not ranked', () => {
  // Two plausible owners means the evidence does not identify one person.
  assert.equal(nearestPerson('Chris Smyth', ['Chris Smith', 'Chris Smythe']), null);
});

test('a short surname is not folded on the same edit budget as a long one', () => {
  // Three edits in "Li" is a different name; three in "Wentworth" is one
  // syllable misheard. Scaling to the shorter surname is what keeps those apart.
  assert.equal(nearestPerson('David Li', ['David Yu']), null);
});

test('an exact name is not a near miss of itself', () => {
  assert.equal(nearestPerson('Naomi Wentworth', ROSTER), null);
});

// ── Writing an alias ──────────────────────────────────────────────────────

// Naomi Wentworth's real frontmatter, block-list form.
const BLOCK_NOTE = [
  '---',
  'type: person',
  'aliases:',
  '  - Naomi',
  '  - Naomi Winkworth',
  'role: Customer Service Agent (CSA)',
  'email: naomi.wentworth@nurtur.tech',
  '---',
  '',
  '# Naomi Wentworth',
  '',
].join('\n');

test('an alias is appended to the block list and NOTHING ELSE MOVES', () => {
  const out = insertAlias(BLOCK_NOTE, 'Naomi Wenworth');
  assert.equal(out.ok, true);
  assert.equal(out.line, '  - Naomi Wenworth');
  // ⚠ The rule `updateFrontmatter` breaks: every other alias must survive.
  assert.match(out.text, /- Naomi\n/);
  assert.match(out.text, /- Naomi Winkworth\n/);
  assert.match(out.text, /- Naomi Wenworth/);
  // And every other key.
  assert.match(out.text, /role: Customer Service Agent \(CSA\)/);
  assert.match(out.text, /email: naomi\.wentworth@nurtur\.tech/);
  assert.match(out.text, /# Naomi Wentworth/);
});

test('an alias already present is a no-op, not a failure and not a duplicate', () => {
  const out = insertAlias(BLOCK_NOTE, 'naomi winkworth');
  assert.equal(out.ok, true);
  assert.equal(out.already, true);
  assert.equal(out.text, BLOCK_NOTE);
});

test('an inline list is extended in place rather than converted', () => {
  const note = '---\ntype: person\naliases: [Seb, Sebastian B]\nrole: x\n---\n\n# S\n';
  const out = insertAlias(note, 'Seb B');
  assert.equal(out.ok, true);
  assert.match(out.text, /aliases: \[Seb, Sebastian B, Seb B\]/);
  assert.match(out.text, /role: x/);
});

test('a note with no aliases key gets one, under `type:`', () => {
  const note = '---\ntype: person\nrole: x\n---\n\n# A\n';
  const out = insertAlias(note, 'Al');
  assert.equal(out.ok, true);
  assert.match(out.text, /---\ntype: person\naliases:\n {2}- Al\nrole: x\n---/);
});

test('CRLF survives the edit', () => {
  // Half the vault is CRLF and \r is a JS line terminator.
  const out = insertAlias(BLOCK_NOTE.replace(/\n/g, '\r\n'), 'Naomi W');
  assert.equal(out.ok, true);
  assert.ok(out.text.includes('\r\n'), 'must not silently rewrite the note to LF');
  assert.ok(!/[^\r]\n/.test(out.text), 'must not leave mixed line endings');
});

test('a note with no frontmatter is REFUSED, never given some', () => {
  const out = insertAlias('# Just a heading\n', 'X');
  assert.equal(out.ok, false);
  assert.match(out.reason, /frontmatter/);
});

test('an empty alias is refused', () => {
  assert.equal(insertAlias(BLOCK_NOTE, '   ').ok, false);
});

// ── What counts as news ───────────────────────────────────────────────────

const LIVE = [
  { name: 'Melanie Ellis', count: 3 },
  { name: 'Richard Power', count: 3 },
  { name: 'Catherine Thorpe', count: 2 },
];

test('the same list three nights running is news exactly once', () => {
  assert.equal(newCandidates(LIVE, []).length, 3);
  assert.equal(newCandidates(LIVE, LIVE.map(c => c.name)).length, 0);
});

test('only the genuinely new name is pushed', () => {
  const fresh = newCandidates([...LIVE, { name: 'Steven Ryan', count: 2 }],
    LIVE.map(c => c.name));
  assert.deepEqual(fresh.map(c => c.name), ['Steven Ryan']);
});

test('a different word order is not a new person', () => {
  // Graph hands back "Ellis, Melanie"; the memory must not read that as news.
  assert.equal(newCandidates([{ name: 'Ellis, Melanie' }], ['Melanie Ellis']).length, 0);
});

test('an unreadable memory pushes everything rather than nothing', () => {
  // Between repeating a notification and silently swallowing a new colleague,
  // the repeat is the failure that can be seen.
  assert.equal(newCandidates(LIVE, null).length, 3);
  assert.equal(newCandidates(LIVE, undefined).length, 3);
});
