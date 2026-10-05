'use strict';
// Next is a sequence in time: one column on every profile, never an auto-fill grid.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '../../saim/shared-ui/presentation/Situation.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('positive control: the Next list rule is still in the stylesheet', () => {
  assert.match(css, /\.sit__nextlist\s*\{/);
});

test('no profile lays Next out in columns', () => {
  const rules = [...css.matchAll(/([^{}]*\.sit__nextlist[^{}]*)\{([^}]*)\}/g)];
  for (const [, sel, body] of rules) {
    assert.doesNotMatch(body, /grid-template-columns\s*:\s*repeat\(/, `${sel.trim()} turns Next into columns`);
  }
});
