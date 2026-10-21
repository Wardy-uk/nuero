'use strict';

// The desktop window opens the ONE canonical SAiM (21 Oct 2026 cutover).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CANONICAL, resolveTarget } = require('./target');

test('no SAIM_URL → the canonical app, never the old local shell', () => {
  assert.equal(CANONICAL, 'https://sara.nickward.co.uk/');
  assert.deepEqual(resolveTarget(undefined), { url: CANONICAL, reason: 'default' });
  assert.deepEqual(resolveTarget('   '), { url: CANONICAL, reason: 'default' });
});

test('the existing shortcut’s retired host (and every Alt/legacy host) opens the canonical app, path and query kept', () => {
  assert.deepEqual(resolveTarget('https://saim.nickward.co.uk'), { url: CANONICAL, reason: 'retired', from: 'saim.nickward.co.uk' });
  assert.equal(resolveTarget('https://saim-alt.nickward.co.uk/?tab=now#x').url, 'https://sara.nickward.co.uk/?tab=now#x');
  assert.equal(resolveTarget('https://saim-alt-v1.nickward.co.uk/review').url, 'https://sara.nickward.co.uk/review');
  assert.equal(resolveTarget('https://SAIM-ALT-NICKWARD.netlify.app/').reason, 'retired');
  assert.equal(resolveTarget('http://localhost:3005/').url, CANONICAL, 'the old local shell is retired too');
});

test('the canonical app and an explicit local preview are left as given; junk falls back to canonical', () => {
  assert.deepEqual(resolveTarget('https://sara.nickward.co.uk'), { url: CANONICAL, reason: 'explicit' });
  assert.equal(resolveTarget('http://127.0.0.1:5185/').url, 'http://127.0.0.1:5185/');
  assert.equal(resolveTarget('not a url').url, CANONICAL);
  assert.equal(resolveTarget('file:///C:/x.html').url, CANONICAL);
});

test('main.js loads only what the resolver returns — no other default', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(src, /resolveTarget\(process\.env\.SAIM_URL\)/);
  assert.doesNotMatch(src, /process\.env\.SAIM_URL \|\|/, 'no fallback that bypasses the resolver');
  assert.doesNotMatch(src, /localhost:3005/);
});
