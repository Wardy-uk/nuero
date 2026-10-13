'use strict';

// Journal prompts are read by Nick as written. A small local model labels its
// lines ("**Prompt 1:**") whatever it is told; that label reached the screen on
// 13 Oct 2026. These are the shapes seen or likely.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanPromptLine } = require('./journal');

test('a model label, number, bullet, bold or quote never reaches the screen', () => {
  const cases = {
    "**Prompt 1:** How's the day felt, Nick?": "How's the day felt, Nick?",
    'Prompt 3: Anything left over?': 'Anything left over?',
    '2. What starts tomorrow?': 'What starts tomorrow?',
    '- "Did you get outside?"': 'Did you get outside?',
    '**What went well?**': 'What went well?',
    'Question 2) Who did you help?': 'Who did you help?',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(cleanPromptLine(raw), want, raw);
});

test('positive control: a clean question passes through untouched', () => {
  assert.equal(cleanPromptLine('What did Ember make of the rain?'), 'What did Ember make of the rain?');
});

test('the prompt no longer invites a retired source', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'journal.js'), 'utf8');
  assert.doesNotMatch(src, /If Strava/);
});
