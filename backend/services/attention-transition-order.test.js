'use strict';

// 9 Oct 2026: meeting-with read `transition` above its `let` declaration, so
// every pre-meeting poll threw "Cannot access 'transition' before
// initialization" and the card showed "Couldn't read: meeting-with". The block
// is inside a try, so nothing failed loudly — pin the order instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('transition is declared before meeting-with reads it', () => {
  const src = fs.readFileSync(path.join(__dirname, 'attention.js'), 'utf8');
  const decl = src.indexOf('let transition = null');
  const read = src.indexOf('transition && transition.subject');
  assert.ok(decl > 0, 'positive control: the declaration exists');
  assert.ok(read > 0, 'positive control: the read exists');
  assert.ok(decl < read, 'declared after its reader is a temporal dead zone');
});
