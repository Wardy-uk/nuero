'use strict';

/**
 * Tasks, lit by her — step 3 of the design build order.
 *
 * ⚠ A LIST IS A LIST. MANIFESTATION.md is explicit: its job is to be scanned,
 * and a hero on it just makes one row arbitrarily loud. So this screen spends
 * NO lead at all, which is the direct counterpart of Now spending exactly one,
 * and both are counted rather than eyeballed.
 *
 * Source scans with positive controls; the primitive itself has a real esbuild
 * render in `lit-primitives.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'views');
const SHARED = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui');
const jsx = () => fs.readFileSync(path.join(VIEWS, 'Tasks.jsx'), 'utf8');
const css = () => fs.readFileSync(path.join(VIEWS, 'Tasks.css'), 'utf8');
// ⚠ Comments stripped: the rule below would otherwise fail on the comment
// EXPLAINING why `var(--accent)` went. Fourth time this repo has learned that a
// name inside a comment is not a use.
const cssCode = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ nothing on Tasks is a flat card any more', () => {
  const src = jsx();
  assert.match(src, /tasks__item/, 'could not read Tasks.jsx');   // positive control
  const flat = src.match(/className="card\b[^"]*"/g) || [];
  assert.deepEqual(flat, [], `still flat: ${flat.join(', ')}`);
  // And the template-literal form, which is how the row and the add-note were
  // written — a scan that only knew the quoted form would have missed both.
  assert.ok(!/className=\{`card /.test(src), 'a templated flat card survived');
});

test('⚠ a list spends NO lead', () => {
  const src = jsx();
  // The counterpart of Now's "exactly one". A task list has no single answer,
  // so the brightest thing on it would be an arbitrary row — and once one row
  // is loud the scan the list exists for stops working.
  const leads = src.match(/tone="lead"/g) || [];
  assert.equal(leads.length, 0, `a list must have no lead, found ${leads.length}`);
});

test('⚠ rows are `row` — lit, and carrying no glow', () => {
  const src = jsx();
  assert.match(src, /tone="row"/, 'the task rows must use the list tone');

  const sheet = cssCode();
  // A card is a thing you pick up and one glow says so; sixty of them down a
  // list is haze rather than hierarchy.
  assert.match(sheet.length ? fs.readFileSync(path.join(SHARED, 'Lit.css'), 'utf8') : '',
               /\.lit--row\s*\{[^}]*box-shadow:\s*none/s);
  // ⚠ And it is NOT `statement`: a row is something he can act on, a statement
  // is a fact he cannot, and collapsing them makes every task look as inert as
  // "Nothing open".
  const lit = fs.readFileSync(path.join(SHARED, 'Lit.css'), 'utf8');
  assert.ok(!/\.lit--row[^}]*background:\s*transparent/s.test(lit));
});

test('⚠ only a real fault gets the alarm treatment', () => {
  const src = jsx();
  const sheet = cssCode();
  // An empty filter, a held-back row and "asking the brain" are STATEMENTS.
  for (const cls of ['tasks__clear', 'tasks__held', 'tasks__headline']) {
    const uses = src.match(new RegExp(`<Lit[^>]*className="[^"]*${cls}[^"]*"`, 'g')) || [];
    assert.ok(uses.length > 0, `${cls} is not rendered through Lit`);
    for (const use of uses) assert.match(use, /tone="statement"/, `${cls}: ${use}`);
  }
  // The failed read is the one exception, and it is the only alarm colour here.
  assert.match(src, /className="tasks__fault err"/);
  assert.match(sheet, /\.tasks__fault\s*\{[^}]*224, 84, 58/s);
});

test('⚠ no screen-local palette — her colour or nothing', () => {
  assert.match(css(), /\.tasks__item\b/, 'could not read Tasks.css');   // positive control
  const sheet = cssCode();
  assert.ok(sheet.length < css().length, 'comment stripping removed nothing');

  const accents = sheet.match(/var\(--accent[^)]*\)/g) || [];
  assert.deepEqual(accents, [], `Tasks.css still picks the system accent: ${accents.join(', ')}`);
  assert.match(sheet, /var\(--saim-rgb/, 'the screen must carry HER colour');
});

test('⚠ MoSCoW and domain keep THEIR colours — those are not her state', () => {
  const sheet = cssCode();
  // ⚠ A DELIBERATE REFUSAL, recorded because it looks like an omission. These
  // encode the TASK's urgency and which part of his life it belongs to, not how
  // the day is going; repainting them in her colour would make three different
  // claims on one row read as one, and the file already reasons about exactly
  // that ("a third colour saying 'this is a different part of your life' must
  // not read as a third urgency").
  assert.match(sheet, /\.tasks__moscow--must\s*\{[^}]*#4a1420/s, 'MoSCoW lost its own meaning');
  assert.match(sheet, /\.tasks__domain\s*\{[^}]*#0f766e/s, 'the personal badge lost its own meaning');
});

test('⚠ priority is named, not numbered — and in iOS\'s words', () => {
  const src = jsx();
  assert.match(src, /PRIORITY_OPTIONS/, 'could not find the priority control');  // positive control

  // It said "P1 P2 P3" with the direction in a `title` a phone cannot show —
  // and the scale runs BACKWARDS from the usual convention (P3 is highest), so
  // the natural guess was wrong. iOS had already solved it, and better:
  // `TaskEdit.priorityLabel` renders High / Normal / Low, which leaves nothing
  // to explain. One vocabulary, taken verbatim.
  assert.match(src, /function priorityLabel\(p\)/);
  assert.match(src, /\{priorityLabel\(p\)\}/, 'the button must show the word');
  assert.ok(!/>P\{p\}</.test(src), 'the bare number is back');
  assert.ok(!/Most pressing/.test(src), 'the direction is back in a tooltip');

  // ⚠ THE NUMBERS STAY ON THE WIRE. Sending the words would be two
  // vocabularies for one field — iOS's own reason for keeping them.
  assert.match(src, /priority: draft\.priority === p \? null : p/);
});

test('⚠ the primitive carries the BOX, not only the light', () => {
  // `.lit` replaced `.card`, which supplied `padding: 1rem` and a bottom
  // margin. The first screen converted did not re-add them, so fifteen cards
  // came out flush against their own text — a regression introduced by step 2
  // and found by reading the stylesheet it replaced rather than by looking at
  // the page. One definition, in the primitive, so no caller has to remember.
  const lit = fs.readFileSync(path.join(SHARED, 'Lit.css'), 'utf8');
  const block = lit.match(/\n\.lit \{([^}]*)\}/s);
  assert.ok(block, 'could not read the .lit rule');
  assert.match(block[1], /padding:\s*1rem/);
  assert.match(block[1], /margin-bottom:/);
});
