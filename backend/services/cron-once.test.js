const { test } = require('node:test');
const assert = require('node:assert');
const nodeCron = require('node-cron');
const { createCron, onceWrapper } = require('./cron-once');

// The real double-fire: node-cron's scheduler offers the same matched second
// twice, a few ms apart (13:00:00.300, then 13:00:00.305 on the next tick).
test('a second offered twice by node-cron runs the job once', () => {
  let runs = 0;
  const task = createCron(nodeCron).schedule('0 13 * * *', () => { runs++; }, { scheduled: false });
  task._scheduler.emit('scheduled-time-matched', new Date('2026-10-07T12:00:00.300Z'));
  task._scheduler.emit('scheduled-time-matched', new Date('2026-10-07T12:00:00.305Z'));
  assert.strictEqual(runs, 1);
  task.stop();
});

test('a later matched second still runs (every-minute jobs are not suppressed)', () => {
  const seen = [];
  const run = onceWrapper((now) => seen.push(now));
  run(new Date('2026-10-07T12:00:00.300Z'));
  run(new Date('2026-10-07T12:01:00.300Z'));
  run(new Date('2026-10-07T12:02:00.010Z'));
  assert.strictEqual(seen.length, 3);
});

test('each task has its own guard', () => {
  let a = 0, b = 0;
  const ra = onceWrapper(() => { a++; });
  const rb = onceWrapper(() => { b++; });
  const t = new Date('2026-10-07T12:00:00.300Z');
  ra(t); rb(t);
  assert.deepStrictEqual([a, b], [1, 1]);
});

test('manual and init runs pass straight through', () => {
  let runs = 0;
  const run = onceWrapper(() => { runs++; });
  run('manual'); run('manual'); run('init');
  assert.strictEqual(runs, 3);
});

test('recovery stays on', () => {
  let got;
  createCron({ schedule: (e, f, o) => { got = o; } }).schedule('* * * * *', () => {});
  assert.strictEqual(got.recoverMissedExecutions, true);
});
