#!/usr/bin/env node
'use strict';

/**
 * Give every undated COMMITMENT a due date, two per working day, from tomorrow.
 *
 * Nick's ask, 14 Sep 2026, off the "My task position" card: 30 open
 * commitments, 14 of them with NO DUE DATE and labelled there "cannot be
 * chased".
 *
 * ⚠ COMMITMENTS ONLY, and `shared/task-origin.cjs` exists because that is not a
 * detail. A commitment is work somebody else asked for or is waiting on;
 * continual improvement is work Nick set himself. Dating the improvement
 * backlog would push his own stretch goals into the weekly risk report's
 * OVERDUE count — a man who writes down thirty ideas and dates them
 * optimistically then reads, in a compliance report his manager assesses,
 * exactly like a man who has broken thirty promises. So this must never be
 * widened to `origin IS NULL` (the unclassified bucket) or to improvement.
 *
 * ⚠ WORKING DAYS, NOT CALENDAR DAYS, via the same `working-days` service every
 * other dated feature uses. A commitment dated for a Saturday is born
 * unmeetable and one dated for Christmas is worse.
 *
 * ⚠ OLDEST FIRST (`created_at`), so the thing somebody has been waiting longest
 * for gets the nearest date. Ordering by MoSCoW would let a letter Nick
 * assigned outrank how long a colleague has actually been waiting.
 *
 * ⚠ THE FIELD IS `due_date`, NOT `dueDate`. `updateTask` reads
 * `'due_date' in fields`, so the camelCase spelling is silently ignored and the
 * script would report success having written nothing — the same trap that wrote
 * a row of nulls through `upsertCalendarEvent`. Verified by reading the field
 * back after each write rather than trusting the return.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 */

const db = require('../db/database');
const taskStore = require('../services/task-store');
const workingDays = require('../services/working-days');

const PER_DAY = Number(process.env.COMMITMENTS_PER_DAY || 2);
const APPLY = process.argv.includes('--apply');

/** Local YYYY-MM-DD. Never toISOString() — the Pi may run UTC. */
function localDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  await db.init();

  if (!Number.isInteger(PER_DAY) || PER_DAY < 1) {
    console.error(`Refusing: COMMITMENTS_PER_DAY must be a positive integer, got ${PER_DAY}`);
    process.exit(1);
  }

  // Refresh first so the feed is as current as it can be; it never throws and
  // leaves the previous source in place on failure, which is the whole point.
  await workingDays.refresh();
  const status = workingDays.status();
  const holidays = workingDays.holidaySet();
  if (!holidays || holidays.size === 0) {
    // The compiled-in floor means this should be unreachable; if even that is
    // empty, something is wrong enough that dating real commitments to Nick's
    // manager onto public holidays is the likely outcome.
    console.error('Refusing: the bank-holiday set is empty, so weekends are the only thing '
      + 'that could be avoided. Dating a commitment onto Christmas is worse than leaving it undated.');
    process.exit(1);
  }
  console.log(`Bank holidays: source=${status.source}, ${status.count} known`
    + (status.ageDays != null ? `, ${status.ageDays}d old` : '')
    + (status.coversTo ? `, covers to ${status.coversTo}` : ''));

  const rows = db.all(
    `SELECT id, text, moscow, priority, created_at, source
       FROM tasks
      WHERE status IN ('open','in-progress')
        AND origin = 'commitment'
        AND (due_date IS NULL OR due_date = '')
      ORDER BY created_at ASC, id ASC`,
    [],
  );

  if (!rows.length) {
    console.log('Nothing to do — every open commitment already carries a due date.');
    return;
  }

  // Start TOMORROW, then walk forward over working days only.
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);

  const plan = [];
  let onThisDay = 0;
  for (const row of rows) {
    while (!workingDays.isWorkingDay(localDay(cursor))) {
      cursor.setDate(cursor.getDate() + 1);
      onThisDay = 0;
    }
    plan.push({ row, due: localDay(cursor) });
    onThisDay += 1;
    if (onThisDay >= PER_DAY) {
      cursor.setDate(cursor.getDate() + 1);
      onThisDay = 0;
    }
  }

  console.log(`\n${rows.length} undated commitments, ${PER_DAY} per working day, `
    + `${plan[0].due} → ${plan[plan.length - 1].due}:\n`);
  for (const { row, due } of plan) {
    console.log(`  ${due}  #${row.id}  ${String(row.text).replace(/\s+/g, ' ').slice(0, 66)}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  let done = 0;
  const failed = [];
  for (const { row, due } of plan) {
    try {
      // Through task-store, the ONE writer: it owns the transition rules and
      // the `task_triaged` activity event the initiation signals read. A direct
      // UPDATE would skip both.
      taskStore.updateTask(row.id, { due_date: due });
      // Read it back. "updateTask returned an object" is not "the date landed" —
      // an unrecognised field name is accepted in silence.
      const after = db.get('SELECT due_date FROM tasks WHERE id = ?', [row.id]);
      if (after && after.due_date === due) done += 1;
      else failed.push({ id: row.id, why: `wrote ${due}, read back ${after?.due_date ?? 'nothing'}` });
    } catch (err) {
      failed.push({ id: row.id, why: err?.message || String(err) });
    }
  }

  console.log(`\nDated ${done} of ${plan.length}, each verified by reading the row back.`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  #${f.id} — ${f.why}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Failed:', err?.message || err);
  process.exit(1);
});
