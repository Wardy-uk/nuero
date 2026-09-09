'use strict';

/**
 * "That's finished" — a meeting that ended early.
 *
 * The pure half pins without a DB or a clock. Most of what follows is a
 * REFUSAL, because the button is easy and the ways it could go wrong are the
 * product: it can only ever release a state, it can only ever release ONE
 * occurrence, and it expires on its own.
 *
 *   run: node --test backend/services/meeting-finish.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mf = require('./meeting-finish');
const { keyFor, prune, applyTo } = mf;

const AT = '2026-09-08T14:10:00.000Z';

function ev(over = {}) {
  return Object.assign({
    id: 'evt-1',
    start: '2026-09-08T14:00:00.000Z',
    end: '2026-09-08T14:30:00.000Z',
    subject: 'Nurtur - Micom (Commercials)',
    attendeesOther: true,
  }, over);
}

function entryFor(event, at = AT) {
  return { [keyFor(event)]: { at, scheduledEnd: event.end, subject: event.subject } };
}

const cal = (events) => ({ known: true, events });

// ── Positive control ────────────────────────────────────────────────────────

test('positive control — an override really does end the meeting early', () => {
  // Without this every refusal below passes on a no-op.
  const e = ev();
  const out = applyTo(cal([e]), entryFor(e), new Date(AT));
  assert.equal(out.events[0].end, AT);
  assert.equal(out.events[0].finishedEarly, true);
  // ⚠ The diary's own fact survives. Nothing has been lost — only what NEURO
  // believes about where Nick is has changed.
  assert.equal(out.events[0].scheduledEnd, '2026-09-08T14:30:00.000Z');
});

// ── Identity ────────────────────────────────────────────────────────────────

test('⚠ the key names an OCCURRENCE, never a meeting or a boolean', () => {
  // A flag reading "not in a meeting" would silence the state for the NEXT
  // meeting too — a different room and different people.
  const tuesday = ev({ id: null, start: '2026-09-08T14:00:00.000Z' });
  const wednesday = ev({ id: null, start: '2026-09-09T14:00:00.000Z' });
  assert.notEqual(keyFor(tuesday), keyFor(wednesday), 'a recurring meeting is not one key');

  // The calendar id is preferred, and the start is in the key either way — the
  // ICS and bridge paths synthesise ids that are not stable across a sync.
  assert.match(keyFor(ev()), /^id:evt-1::/);
  assert.match(keyFor(ev({ id: null })), /^at:/);
});

test('⚠ an unidentifiable event yields NO key, and is refused rather than stored', () => {
  // An entry matching nothing is indistinguishable from one that has expired;
  // an entry matching everything would silence the whole diary.
  assert.equal(keyFor(null), null);
  assert.equal(keyFor({ subject: 'No start' }), null);
  assert.equal(keyFor({ start: '2026-09-08T14:00:00.000Z', id: null, subject: '   ' }), null);
});

// ── What it may and may not do ──────────────────────────────────────────────

test('⚠ it can only ever move an end EARLIER, never later', () => {
  // An override that could extend a meeting is a way to make SARA go quiet for
  // longer, which is the mute button this must never become.
  const e = ev();
  const late = { [keyFor(e)]: { at: '2026-09-08T18:00:00.000Z', scheduledEnd: e.end } };
  const out = applyTo(cal([e]), late, new Date(AT));
  assert.equal(out.events[0].end, e.end, 'clamped to the scheduled end');
});

test('⚠ it never produces a negative-length meeting', () => {
  const e = ev();
  const early = { [keyFor(e)]: { at: '2026-09-08T09:00:00.000Z', scheduledEnd: e.end } };
  const out = applyTo(cal([e]), early, new Date(AT));
  assert.equal(out.events[0].end, e.start, 'clamped to the start');
});

test('⚠ ONE occurrence is released and nothing else is touched', () => {
  const mine = ev();
  const other = ev({ id: 'evt-2', start: '2026-09-08T15:45:00.000Z', end: '2026-09-08T16:15:00.000Z', subject: 'F&C' });
  const out = applyTo(cal([mine, other]), entryFor(mine), new Date(AT));
  assert.equal(out.events[0].finishedEarly, true);
  assert.equal(out.events[1].finishedEarly, undefined, 'the next meeting is untouched');
  assert.equal(out.events[1].end, other.end);
});

test('an unreadable diary, or no overrides, changes nothing at all', () => {
  const unread = { known: false, events: [] };
  assert.equal(applyTo(unread, entryFor(ev()), new Date(AT)), unread);
  const c = cal([ev()]);
  assert.equal(applyTo(c, {}, new Date(AT)), c, 'the same object back, not a rebuilt one');
  assert.equal(applyTo(c, null, new Date(AT)), c);
});

// ── Expiry ──────────────────────────────────────────────────────────────────

test('⚠ an override expires at the meeting’s own scheduled end', () => {
  // Past that the calendar says the same thing, so the record has nothing left
  // to say — and an ever-growing blob of old keys can only ever match something
  // it should not.
  const e = ev();
  const entries = entryFor(e);
  assert.equal(Object.keys(prune(entries, new Date('2026-09-08T14:20:00Z'))).length, 1, 'still live mid-meeting');
  assert.equal(Object.keys(prune(entries, new Date('2026-09-08T14:30:00Z'))).length, 0, 'moot at the scheduled end');
  assert.equal(Object.keys(prune(entries, new Date('2026-09-08T16:00:00Z'))).length, 0);
});

test('⚠ an entry that cannot be aged out is DROPPED, never kept forever', () => {
  const bad = { 'id:x::y': { at: AT }, 'id:z::w': { at: AT, scheduledEnd: 'not a date' } };
  assert.deepEqual(prune(bad, new Date(AT)), {});
  assert.deepEqual(prune(null, new Date(AT)), {});
});

// ── The store ───────────────────────────────────────────────────────────────
//
// `finish` reads and writes `agent_state`, so these drive it against a stubbed
// store rather than a scratch DB — the RULES are what matter and they are all
// decided before the write. The real write is covered end to end by
// `routes/meeting-finish-routing.test.js`.

function withStubbedStore(fn) {
  const path = require.resolve('../db/database');
  const before = require.cache[path];
  let blob = null;
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: {
      getState: () => blob,
      setState: (_k, v) => { blob = v; },
    },
  };
  try { return fn(() => blob); } finally {
    if (before) require.cache[path] = before; else delete require.cache[path];
  }
}

test('⚠ it REFUSES anything that is not a meeting SARA would have gone quiet for', () => {
  // Releasing a state that was never set is a button that appears to do
  // something and does not. Exactly `true`, the same test `isRealMeeting`
  // makes — half Nick's diary is solo blocks.
  withStubbedStore(() => {
    const now = new Date(AT);
    assert.equal(mf.finish(ev({ attendeesOther: false }), now).reason, 'not-a-meeting');
    assert.equal(mf.finish(ev({ attendeesOther: null }), now).reason, 'not-a-meeting');
    assert.equal(mf.finish(ev({ id: null, subject: '' }), now).reason, 'unidentifiable');
  });
});

test('⚠ it refuses a meeting that has not started, or is already over', () => {
  withStubbedStore(() => {
    assert.equal(mf.finish(ev(), new Date('2026-09-08T13:00:00Z')).reason, 'not-started');
    assert.equal(mf.finish(ev(), new Date('2026-09-08T15:00:00Z')).reason, 'already-over');
  });
});

test('finishing then resuming leaves nothing behind — the way back is real', () => {
  // ⚠ NOT OPTIONAL. The cost of a wrong press is SARA speaking up in a real
  // meeting, which is the exact failure the quiet state exists to prevent.
  withStubbedStore((read) => {
    const now = new Date(AT);
    const e = ev();
    const done = mf.finish(e, now);
    assert.equal(done.ok, true);
    assert.equal(Object.keys(JSON.parse(read())).length, 1);

    // And it really does release the meeting while it is stored.
    assert.equal(applyTo(cal([e]), mf.list(now), now).events[0].finishedEarly, true);

    const back = mf.resume(done.key, now);
    assert.equal(back.cleared, true);
    assert.deepEqual(JSON.parse(read()), {});
    assert.equal(applyTo(cal([e]), mf.list(now), now).events[0].finishedEarly, undefined);
  });
});

test('resuming something already resumed is a SUCCESS, not an error', () => {
  // It is already resumed. An error would send him looking for a problem that
  // does not exist.
  withStubbedStore(() => {
    const r = mf.resume('id:nothing::here', new Date(AT));
    assert.equal(r.ok, true);
    assert.equal(r.cleared, false);
  });
});

test('⚠ an unreadable store overrides NOTHING, and stays quiet', () => {
  // The safe direction: the diary's own word stands, so SARA keeps her mouth
  // shut. The opposite failure — a corrupt blob making her speak up in a
  // meeting — is the one that costs something in front of other people.
  const path = require.resolve('../db/database');
  const before = require.cache[path];
  require.cache[path] = {
    id: path, filename: path, loaded: true,
    exports: { getState: () => '{{{not json', setState: () => {} },
  };
  try {
    assert.deepEqual(mf.list(new Date(AT)), {});
  } finally {
    if (before) require.cache[path] = before; else delete require.cache[path];
  }
});
