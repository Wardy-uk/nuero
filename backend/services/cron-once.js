// node-cron, with recovery of late ticks — and at most ONE run per matched second.
//
// `recoverMissedExecutions` (Build 3A) makes a late timer run the second it
// missed. But node-cron 3.0.3 records the last execution with its milliseconds
// zeroed while comparing against candidate dates that keep theirs, and every
// tick looks back one second (the timer is ~1000ms and the elapsed time floors
// to 1). So a job that fired at 13:00:00.300 is offered 13:00:00.30x again on
// the next tick, 13:00:00.000 < 13:00:00.30x, and it fires twice. Measured on
// pi5, 7 Oct 2026: the 9am and 1pm briefs both ran twice, a few ms apart — two
// emails, two pushes — with ONE backend process and one "[Scheduler] Started".
// Whether a given tick doubles depends on sub-millisecond timer phase, which is
// why it came and went rather than happening every day.
//
// The guard is keyed on the matched SECOND node-cron hands the task, per task,
// so a genuine run in a later second (every minute, every 5 minutes) is never
// suppressed. A manual or init run (`now` is a string) passes straight through.

function onceWrapper(fn) {
  let lastSecond = null;
  return (now) => {
    if (now instanceof Date) {
      const second = Math.floor(now.getTime() / 1000);
      if (second === lastSecond) return undefined;
      lastSecond = second;
    }
    return fn(now);
  };
}

function createCron(nodeCron) {
  return {
    schedule: (expr, fn, opts = {}) =>
      nodeCron.schedule(expr, onceWrapper(fn), { recoverMissedExecutions: true, ...opts }),
  };
}

module.exports = { createCron, onceWrapper };
