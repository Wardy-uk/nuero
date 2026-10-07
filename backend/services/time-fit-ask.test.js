'use strict';

// "I have some time" — the button on TimeFitCard that asks how long Nick has
// and lists every task that fits, in priority order. Source scans, because the
// card fetches in useEffect and a render test would only see the loading state.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const card = fs.readFileSync(path.join(__dirname, '../../frontend/src/components/TimeFitCard.jsx'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../routes/time.js'), 'utf8');

test('positive control: the card still fetches what-fits', () => {
  assert.ok(card.includes('/api/time/what-fits'));
});

test('the card offers "I have some time" and asks how long', () => {
  assert.ok(card.includes('I have some time'));
  assert.ok(card.includes('How long have you got?'));
});

test('an asked-for time requests more than the default five', () => {
  assert.ok(/limit=\$\{ASKED_LIMIT\}/.test(card));
});

test('an unreadable diary does not hide an asked-for time', () => {
  assert.ok(card.includes('!calendarKnown && !override'));
});

test('the route raises the limit but bounds it', () => {
  assert.ok(route.includes('MAX_FIT_LIMIT'));
  assert.ok(/Math\.min\(Math\.max\(parseInt\(req\.query\.limit\)/.test(route));
});
