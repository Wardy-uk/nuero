'use strict';

/**
 * The management report is WORK ONLY (Nick, 9 Oct 2026: "the two domains must
 * never cross"). A personal task must move no figure on it — open, overdue,
 * undated, closed or dropped, in any bucket — and the report must not mention
 * that anything was left out.
 *
 * Each personal fixture is the twin of a work one, so a missing filter on any
 * single query shows up as that figure being out by exactly one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wr-domain-'));
process.env.NEURO_DB_PATH = path.join(root, 'wr-domain.db');

const db = require('../db/database');
const weeklyRisk = require('./weekly-risk');

const WEEK = weeklyRisk.weekCommencing();
// A day inside last week, for completed_at.
const [y, m, d] = weeklyRisk.previousWeek(WEEK).split('-').map(Number);
const LAST_WEEK_DAY = new Date(y, m - 1, d + 2);
const lastWeekStamp = `${LAST_WEEK_DAY.getFullYear()}-${String(LAST_WEEK_DAY.getMonth() + 1).padStart(2, '0')}-${String(LAST_WEEK_DAY.getDate()).padStart(2, '0')} 12:00:00`;

let n = 0;
function insert({ domain, origin = null, status = 'open', due = null, completedAt = null }) {
  n += 1;
  // domain undefined = column omitted, so the schema default applies.
  const cols = ['text', 'dedupe_key', 'status', 'origin', 'due_date', 'completed_at', 'source'];
  const vals = [`fixture ${n}`, `fixture-${n}`, status, origin, due, completedAt, 'test'];
  if (domain !== undefined) { cols.push('domain'); vals.push(domain); }
  db.run(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
}

function seed(domain) {
  insert({ domain, origin: 'commitment', due: '2020-01-01' });          // overdue commitment
  insert({ domain, origin: 'improvement', due: '2020-01-01' });         // overdue improvement
  insert({ domain, origin: null });                                      // undated unclassified
  insert({ domain, origin: 'commitment', status: 'done', completedAt: lastWeekStamp });
  insert({ domain, status: 'dropped', completedAt: lastWeekStamp });
}

test.before(async () => { await db.init(); });

test('personal tasks move no figure on the management report', () => {
  seed('work');
  const workOnly = weeklyRisk.taskCounts(WEEK);
  // Positive control: the work fixtures ARE counted, so a pass below cannot be
  // the counts simply being empty.
  assert.equal(workOnly.open, 3);
  assert.equal(workOnly.commitments.overdue, 1);
  assert.equal(workOnly.closedLastWeek, 1);
  assert.equal(workOnly.droppedLastWeek, 1);

  seed('personal');
  const after = weeklyRisk.taskCounts(WEEK);
  assert.deepEqual(after, workOnly);
});

test('a task created without a domain counts as work (the schema default)', () => {
  const before = weeklyRisk.taskCounts(WEEK).open;
  insert({});
  assert.equal(weeklyRisk.taskCounts(WEEK).open, before + 1);
});

test('the rendered report says nothing about personal work', () => {
  const src = fs.readFileSync(path.join(__dirname, 'weekly-risk.js'), 'utf-8');
  const render = src.slice(src.indexOf('function render('));
  assert.ok(render.length > 1000, 'positive control: found render()');
  assert.doesNotMatch(render, /personal/i);
});
