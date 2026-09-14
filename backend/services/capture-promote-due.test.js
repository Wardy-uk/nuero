'use strict';

/**
 * Approving a spotted commitment gives it a due date (14 Sep 2026).
 *
 * The rule itself is pinned pure in `commitment-due.test.js`. This file exists
 * because the rule being right proves nothing about it being REACHED: the whole
 * bug it fixes was `action-candidates` hard-coding `dueDate: null` and the
 * executor faithfully storing it, with every part working exactly as written.
 * So this goes through the real `executeAction` into a real task row.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-promote-'));
process.env.NEURO_DB_PATH = path.join(root, 'promote.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const suggestionEngine = require('./suggestion-engine');
const { DEFAULT_DUE_DAYS } = require('./commitment-due');

test.before(async () => { await db.init(); });

/** The date `days` from now, local — the same arithmetic the rule does. */
function daysOut(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Promote a candidate exactly as approving its card does, and read the row back. */
async function promote(payload) {
  const result = await suggestionEngine.executeAction({ type: 'capture_todo', payload });
  assert.equal(result.ok, true, result.detail || 'promotion failed');
  const id = Number(/#(\d+)/.exec(result.detail)[1]);
  return db.getTaskRow(id);
}

test('a commitment with no stated deadline is due in ten days', async () => {
  const row = await promote({
    text: 'Nick Ward to send breakdown of Parsons contacts: consent vs non-consent',
    sourcePath: 'Meetings/2026/09/note.md',
  });
  assert.equal(row.due_date, daysOut(DEFAULT_DUE_DAYS),
    'before this, a promoted commitment arrived with no due date at all');
});

test('a deadline the sentence states is used instead of the default', async () => {
  const stated = daysOut(3);
  const row = await promote({
    text: `Document the WFH productivity study and publish internally by ${stated}`,
    sourcePath: 'Meetings/2026/09/note.md',
  });
  assert.equal(row.due_date, stated, 'the meeting named a date and it must win');
});

test('a start date in the text is NOT taken as the deadline', async () => {
  // The real sentence that motivated the cue rule. Taking any date it could see
  // would put this task's due date on the day the policy BEGINS.
  const starts = daysOut(2);
  const row = await promote({
    text: `Implement Support WFH one day per week and monitor metrics starting ${starts}`,
    sourcePath: 'Meetings/2026/09/note.md',
  });
  assert.equal(row.due_date, daysOut(DEFAULT_DUE_DAYS));
  assert.notEqual(row.due_date, starts);
});

test('an explicit payload due date still beats both', async () => {
  // Nothing sets one today, but a future extractor that does must not be
  // second-guessed by a rule reading the same sentence.
  const row = await promote({
    text: 'Something with no date in the words at all',
    dueDate: '2027-03-09',
    sourcePath: 'Meetings/2026/09/note.md',
  });
  assert.equal(row.due_date, '2027-03-09');
});

test('the promoted task is never born overdue', async () => {
  // The property worth defending: overdue COMMITMENTS are what the weekly risk
  // report counts, so a date NEURO invents in the past is a broken promise it
  // manufactured itself.
  for (const text of [
    'Raise the issue including the 2026-06-04 escalation with Maria',
    'Chase Billin for outstanding July and August 2026 invoices',
    'Produce a formal RCA document by the morning of August 18, 2020',
  ]) {
    const row = await promote({ text, sourcePath: 'Meetings/2026/09/note.md' });
    assert.ok(row.due_date >= daysOut(0), `${text} was promoted already overdue (${row.due_date})`);
  }
});
