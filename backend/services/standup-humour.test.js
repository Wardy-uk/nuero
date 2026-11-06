'use strict';
// 6 Nov 2026: Nick said "hahaha - podcast? thats overdue is it? not seen that
// one ;)  yeah - add it to today" and SAiM read the joke as "has no idea what it
// is", said she would drop it, ignored "add it to today", and left #531 open
// after "Share PDF is done" because she only tried resolve_commitment, which
// refuses a task that is not on the carried list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'standup-session.js'), 'utf8');

test('both rituals are told a joke is not a decision', () => {
  const shared = src.slice(src.indexOf('const SHARED_VOICE'), src.indexOf('const STANDUP_PROMPT'));
  assert.match(shared, /Jokes are not decisions/);
  assert.match(shared, /Never drop, close or forget something on the strength of a joke/);
});

test('a task that is not carried is closed with complete_task, not resolve_commitment', () => {
  const shared = src.slice(src.indexOf('const SHARED_VOICE'), src.indexOf('const STANDUP_PROMPT'));
  assert.match(shared, /call complete_task with that id/);
  assert.match(shared, /set_focus with its task_id/);
});

test('the "no idea what it is" drop rule only applies when said plainly', () => {
  assert.match(src, /If he says plainly — not as a joke — that he never committed/);
});
