'use strict';

/**
 * What SARA shows, and what Nick could say next.
 *
 * The composer is PURE, so all of this pins without a Pi, a vault or a clock.
 * Most of what follows is a REFUSAL — the dashboards are easy and the honesty
 * is the product, so the honesty is what is under test.
 *
 *   run: node --test backend/services/sara-surface.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const surface = require('./sara-surface');
const { compose, surfaceFor, SURFACES, MAX_UTTERANCES } = surface;

// A payload shaped like `attention.build()`'s, with only what the composer reads.
function payload(over = {}) {
  return Object.assign({
    context: { activity: 'steady', duty: { onDuty: true, known: true } },
    primary: null,
    secondary: [],
    agenda: { known: true, scope: 'today', events: [] },
    weeklyTarget: null,
    poolAvailable: true,
    gaps: [],
  }, over);
}

function card(over = {}) {
  return Object.assign({
    kind: 'item',
    id: 'todo-overdue-top',
    type: 'todo',
    title: 'Succession plan',
    say: 'Overdue by three days.',
    urgency: 'high',
    tab: 'tasks',
    recordId: 'rec_1',
    actions: ['acknowledge', 'defer', 'open', 'complete', 'dismiss'],
  }, over);
}

const sentences = (r) => r.utterances.map((u) => u.say);
const intents = (r) => r.utterances.map((u) => u.intent);

// ── Positive control ────────────────────────────────────────────────────────

test('positive control — a steady payload composes a real dashboard', () => {
  // Without this every refusal below passes on a composer that returns nothing,
  // which proves only that it is broken.
  const r = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [{ start: '2026-08-31T14:30:00', subject: '1-2-1 — Naomi', attendeesOther: true }],
    },
    primary: card(),
  }));

  assert.equal(r.surface, SURFACES.STEADY);
  assert.equal(r.dashboard.kind, SURFACES.STEADY);
  assert.ok(r.dashboard.rows.length >= 1, 'the meeting should be a row');
  assert.match(r.dashboard.rows[0].what, /Naomi/);
  assert.ok(r.dashboard.now, 'a read diary always answers "what am I in right now"');
  assert.ok(r.utterances.length > 1);
});

// ── Which dashboard ─────────────────────────────────────────────────────────

test('surface FOLLOWS context.activity and does not re-derive it', () => {
  // The moment this starts adding conditions of its own it has become a second
  // opinion about what kind of moment this is — which is what `inference.js`
  // was retired for.
  const map = {
    'in-meeting': SURFACES.IN_MEETING,
    'pre-meeting': SURFACES.PRE_MEETING,
    firefighting: SURFACES.FIREFIGHTING,
    'in-focus-session': SURFACES.SESSION,
    ritual: SURFACES.RITUAL,
    off: SURFACES.OFF_DUTY,
    steady: SURFACES.STEADY,
  };
  for (const [activity, expected] of Object.entries(map)) {
    assert.equal(surfaceFor(payload({ context: { activity } })), expected, activity);
  }
});

test('⚠ an unreadable pool outranks EVERY activity', () => {
  // A dashboard drawn over work SARA could not see is a confident picture of a
  // day nobody read. `blind` is the only override, and it is absolute.
  for (const activity of ['steady', 'firefighting', 'in-meeting', 'off', 'ritual']) {
    const r = compose(payload({ context: { activity }, poolAvailable: false }));
    assert.equal(r.surface, SURFACES.BLIND, `${activity} should still be blind`);
  }
});

test('⚠ the blind dashboard REFUSES an all-clear, in words', () => {
  const r = compose(payload({
    poolAvailable: false,
    gaps: [{ input: 'calendar', why: 'Graph auth expired' }],
  }));
  assert.match(r.dashboard.note, /all-clear/i);
  assert.match(r.dashboard.note, /couldn.t look/i);
  // The gap is NAMED, not counted.
  assert.match(r.dashboard.rows[0].what, /calendar/i);
  assert.match(r.dashboard.rows[0].note, /Graph auth expired/);
});

test('⚠ an unrecognised activity is steady, never nothing', () => {
  // A missing surface renders as a blank screen, and silence is never a valid
  // answer for a screen.
  assert.equal(surfaceFor(payload({ context: { activity: 'teleporting' } })), SURFACES.STEADY);
  assert.equal(surfaceFor(payload({ context: {} })), SURFACES.STEADY);
  assert.equal(surfaceFor(null), SURFACES.BLIND);
  const r = compose(null);
  assert.ok(r.dashboard, 'a null payload must still produce a dashboard');
  assert.ok(r.utterances.length > 0);
});

// ── Honesty inside a dashboard ──────────────────────────────────────────────

test('⚠ "I couldn’t read your diary" is never rendered as an empty day', () => {
  const unread = compose(payload({ agenda: { known: false, events: [] } }));
  assert.equal(unread.dashboard.rows.length, 0);
  assert.match(unread.dashboard.note, /couldn.t read your diary/i);

  assert.equal(unread.dashboard.now, null, '⚠ an unreadable diary is never rendered as "free"');

  // An empty diary that WAS read is a different fact, and good news. It says so
  // rather than going silent — a blank panel and a broken one look identical.
  const empty = compose(payload({ agenda: { known: true, scope: 'today', events: [] } }));
  assert.doesNotMatch(empty.dashboard.note, /couldn.t/i, 'a read-but-empty diary must not claim it was unreadable');
  assert.match(empty.dashboard.note, /Nothing else/i);
  assert.equal(empty.dashboard.now.free, true);
});

test('⚠ gaps ride on EVERY dashboard, not only the blind one', () => {
  // A partly-read day is the normal case. A dashboard showing four of five
  // sources without saying so is "partly live rendered as total confidence".
  const r = compose(payload({
    context: { activity: 'steady' },
    gaps: [{ input: 'queue', why: 'timeout' }],
  }));
  assert.notEqual(r.surface, SURFACES.BLIND);
  assert.equal(r.dashboard.gaps.length, 1);
  assert.equal(r.dashboard.gaps[0].input, 'queue');
});

test('⚠ calendar times are SLICED, never parsed into a Date', () => {
  // The backend already asked Graph for Europe/London wall-clock times.
  // Re-parsing re-applies an offset and shows every BST event an hour out —
  // NEURO's calendar had this bug once and VESTA's had it after.
  assert.equal(surface._internals.timeOf({ start: '2026-08-31T14:30:00' }), '14:30');
  const r = compose(payload({
    agenda: { known: true, scope: 'today', events: [{ start: '2026-08-31T14:30:00', subject: 'Sync' }] },
  }));
  assert.equal(r.dashboard.rows[0].when, '14:30', 'a BST event must not shift');
});

test('⚠ "on your own" is said only when the brain KNOWS', () => {
  // `attendeesOther` is three-valued: null means we could not tell, and half
  // Nick's diary is solo blocks, so a guess is wrong in a way he would notice.
  const r = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [
        { start: '2026-08-31T10:00:00', subject: 'A', attendeesOther: true },
        { start: '2026-08-31T11:00:00', subject: 'B', attendeesOther: false },
        { start: '2026-08-31T12:00:00', subject: 'C', attendeesOther: null },
      ],
    },
  }));
  assert.equal(r.dashboard.rows[0].meta, 'with others');
  assert.equal(r.dashboard.rows[1].meta, 'on your own');
  assert.equal(r.dashboard.rows[2].meta, null, 'undecidable must say nothing at all');
});

// ── The countdown, the "now" slot, and saying it once ───────────────────────
//
// Nick, 8 Sep 2026, on the Surface: the next thing in the diary should count
// down from half an hour; there should be a "current" section saying what he is
// in or that he is free; and he should not see the same thing three times.

test('the NEXT thing counts down, from half an hour, and only the next one', () => {
  const r = compose(payload({
    agenda: {
      known: true,
      scope: 'today',
      events: [
        { start: '2026-09-08T14:00:00', subject: 'Micom', minutesAway: 9 },
        { start: '2026-09-08T15:45:00', subject: 'F&C', minutesAway: 114 },
      ],
    },
  }));
  assert.equal(r.dashboard.rows[0].countdown, 'in 9 min');
  // ⚠ A countdown on every row is noise competing with the one that matters.
  assert.equal(r.dashboard.rows[1].countdown, null);
});

test('⚠ nothing beyond half an hour counts down, and null is NOT zero', () => {
  const far = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [{ start: '2026-09-08T17:00:00', subject: 'Late', minutesAway: 31 }],
    },
  }));
  assert.equal(far.dashboard.rows[0].countdown, null, '31 minutes is past the line Nick drew');

  // ⚠ A rolled-forward agenda carries `minutesAway: null` — "across a day
  // boundary", not "starting now". Printing "now" over tomorrow morning is a
  // placeholder rendered as a fact.
  const ahead = compose(payload({
    agenda: {
      known: true, scope: 'tomorrow',
      events: [{ start: '2026-09-09T09:00:00', subject: 'Standup', minutesAway: null }],
    },
  }));
  assert.equal(ahead.dashboard.rows[0].countdown, null);

  // An all-day event has no minute to count down to.
  const allDay = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [{ start: '2026-09-08T00:00:00', subject: 'Hiking', minutesAway: 5, allDay: true }],
    },
  }));
  assert.equal(allDay.dashboard.rows[0].countdown, null);
});

test('the "now" slot says what he is IN, with when it ends', () => {
  const r = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [
        { start: '2026-09-08T14:00:00', end: '2026-09-08T15:00:00', subject: 'Micom', running: true, minutesAway: -6 },
        { start: '2026-09-08T15:45:00', subject: 'F&C', minutesAway: 99 },
      ],
    },
  }));
  assert.equal(r.dashboard.now.what, 'Micom');
  assert.equal(r.dashboard.now.meta, 'until 15:00');
  assert.equal(r.dashboard.now.free, false);
  assert.equal(r.dashboard.rows[0].what, 'F&C');
  // ⚠ The thing he is in is NOT also a row. "What am I in" and "what is coming"
  // are different questions; answering both with one list is what put the same
  // meeting on screen twice.
  assert.equal(r.dashboard.rows.length, 1);
});

test('⚠ "free" is a claim about the DIARY, and only ever when it was read', () => {
  const clear = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [{ start: '2026-09-08T14:00:00', subject: 'Micom', minutesAway: 9 }],
    },
  }));
  assert.equal(clear.dashboard.now.free, true);
  assert.equal(clear.dashboard.now.meta, 'free until 14:00');
  // It speaks about the diary. "You're free" is a claim about his workload that
  // a calendar cannot support, with the task list one panel below.
  assert.match(clear.dashboard.now.what, /diary/i);

  // ⚠ A rolled-forward agenda is here BECAUSE today has nothing left, so it may
  // say so — but never "free until 09:00" about tomorrow morning.
  const rolled = compose(payload({
    agenda: {
      known: true, scope: 'tomorrow',
      events: [{ start: '2026-09-09T09:00:00', subject: 'Standup', minutesAway: null }],
    },
  }));
  assert.equal(rolled.dashboard.now.meta, 'clear for the rest of the day');

  // ⚠ And an unreadable diary never claims either.
  assert.equal(compose(payload({ agenda: { known: false, events: [] } })).dashboard.now, null);
});

test('⚠ a card the dashboard already shows is reported as covered', () => {
  const r = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [{ start: '2026-09-08T14:00:00', subject: 'Nurtur - Micom', minutesAway: 9 }],
    },
    primary: card(),
    secondary: [
      card({ id: 'cal-1', type: 'meeting', title: 'Nurtur - Micom' }),
      card({ id: 'email-urgent', type: 'email', title: '6 emails need action' }),
    ],
  }));
  assert.deepEqual(r.covered.cardIds, ['cal-1']);
  // ⚠ ADVISORY. The pool leaves the composer exactly as it arrived — filtering
  // it here would be this layer re-ranking the feed, which is the gate's job.
  assert.equal(r.dashboard.rows.length, 1);
});

test('⚠ the free-time wording can never suppress a card', () => {
  // "Nothing in the diary" is a sentence, not a title. A card that happened to
  // be phrased like it must still reach the screen.
  const r = compose(payload({
    agenda: { known: true, scope: 'today', events: [] },
    secondary: [card({ id: 'odd', title: 'Nothing in the diary' })],
  }));
  assert.equal(r.dashboard.now.free, true);
  assert.deepEqual(r.covered.cardIds, []);
});

test('⚠ the transition naming the primary is a FACT, not an instruction', () => {
  // The prompt, the headline and the row were the same meeting three times. The
  // composer says the first two are the same thing; whether to hide one is the
  // renderer's call, because the transition can be dismissed on the client and
  // a screen with no lead at all is the worse failure.
  const t = { kind: 'leave-now', prompt: '"Micom" starts in 9 minutes.', meta: { subject: 'Micom' } };
  const same = compose(payload({
    transition: t,
    primary: card({ type: 'meeting', title: 'Micom' }),
    agenda: { known: true, scope: 'today', events: [{ start: '2026-09-08T14:00:00', subject: 'Micom', minutesAway: 9 }] },
  }));
  assert.equal(same.covered.transitionIsPrimary, true);
  // ⚠ And the row does NOT count down, because the prompt above it already is.
  assert.equal(same.dashboard.rows[0].countdown, null);

  const other = compose(payload({
    transition: t,
    primary: card({ title: 'Succession plan' }),
    agenda: { known: true, scope: 'today', events: [{ start: '2026-09-08T14:00:00', subject: 'Something else', minutesAway: 9 }] },
  }));
  assert.equal(other.covered.transitionIsPrimary, false);
  assert.equal(other.dashboard.rows[0].countdown, 'in 9 min');
});

test('⚠ the primary is NOT restated inside the dashboard', () => {
  // It used to be appended as an `open` row carrying the same title and the
  // same `say` the headline two lines above had just given.
  const r = compose(payload({
    agenda: { known: true, scope: 'today', events: [] },
    primary: card({ title: 'Succession plan' }),
  }));
  assert.equal(r.dashboard.rows.length, 0);
  assert.ok(!JSON.stringify(r.dashboard.rows).includes('Succession plan'));
});

test('⚠ firefighting never renders an empty box', () => {
  // The brain called it firefighting, so something IS live. An empty
  // escalations panel under that word reads as an all-clear at the moment it is
  // least true, so an unmatched pool is shown rather than dropped.
  const r = compose(payload({
    context: { activity: 'firefighting' },
    primary: card({ type: 'todo', title: 'Something live', urgency: 'critical' }),
  }));
  assert.equal(r.surface, SURFACES.FIREFIGHTING);
  assert.equal(r.dashboard.rows.length, 1);
  assert.equal(r.dashboard.rows[0].level, 'crit');
});

test('"That’s finished" leads in a meeting, and is a `meeting` intent', () => {
  // Nick, 8 Sep 2026. The diary is a plan, and a meeting that broke up twenty
  // minutes early otherwise costs twenty minutes in which SARA refuses to help.
  // It leads because it is the only thing on this surface that changes anything.
  const r = compose(payload({
    context: { activity: 'in-meeting' },
    meeting: { key: 'id:evt-1::2026-09-08T14:00:00Z', subject: 'Micom', scheduledEnd: '2026-09-08T14:30:00Z' },
  }));
  assert.equal(r.utterances[0].say, 'That’s finished');
  const i = r.utterances[0].intent;
  // ⚠ NOT an `act`. The primary here is a CONTEXT card with no `recordId` and
  // the attention lifecycle would refuse the verb — a sentence NEURO cannot
  // honour is worse than none, the same reason the session verbs are their own
  // kind.
  assert.equal(i.kind, 'meeting');
  assert.equal(i.action, 'finished');
  // ⚠ It names the OCCURRENCE. Without a key it would mean "whatever meeting
  // you think I'm in", which is a different question the moment two overlap.
  assert.equal(i.key, 'id:evt-1::2026-09-08T14:00:00Z');
  assert.ok(sentences(r).includes('Show me everything'), 'the escape hatch survives');
});

test('⚠ no key, no button — it is never offered where it would do nothing', () => {
  const r = compose(payload({ context: { activity: 'in-meeting' } }));
  assert.ok(!sentences(r).includes('That’s finished'));
});

test('⚠ "finished" is offered ONLY in a meeting', () => {
  // There is deliberately no way to declare yourself INTO one: the calendar
  // decides that, and a manual way to make SARA go quiet is a mute button
  // wearing a meeting's clothes.
  for (const activity of ['steady', 'pre-meeting', 'firefighting', 'ritual', 'off', 'in-focus-session']) {
    const r = compose(payload({
      context: { activity },
      meeting: { key: 'id:evt-1::2026-09-08T14:00:00Z' },
      primary: card(),
    }));
    assert.ok(!sentences(r).includes('That’s finished'), activity);
  }
});

test('⚠ in a meeting she still shows the DIARY — the restraint is about the pool', () => {
  // It showed nothing at all under "nothing, on purpose" (Nick, 8 Sep 2026:
  // "rest of day is missing"). The gate holds back WORK while he is in a room
  // with people; it was never a reason to withhold when this one ends or what
  // is after it, neither of which is something to decide about.
  const r = compose(payload({
    context: { activity: 'in-meeting' },
    agenda: {
      known: true, scope: 'today',
      events: [
        { start: '2026-09-08T14:00:00', end: '2026-09-08T14:30:00', subject: 'Micom', running: true, minutesAway: -9 },
        { start: '2026-09-08T15:45:00', subject: 'F&C', minutesAway: 105 },
      ],
    },
  }));
  assert.equal(r.dashboard.kind, SURFACES.IN_MEETING);
  assert.equal(r.dashboard.rows.length, 1, 'what is AFTER this, not this');
  assert.equal(r.dashboard.rows[0].what, 'F&C');
  // ⚠ "Due to end", never "ends" — it is the scheduled end, not a claim about
  // when he will actually get out.
  assert.match(r.dashboard.note, /Due to end at 14:30/);
});

test('⚠ no `now` band in a meeting — the headline above already names it', () => {
  // The context card reads "In a meeting / You're in X". A band repeating X is
  // the same thing twice on one screen, which is the whole complaint. The end
  // time is the fact the headline does NOT carry, so it goes in the note.
  const r = compose(payload({
    context: { activity: 'in-meeting' },
    agenda: {
      known: true, scope: 'today',
      events: [{ start: '2026-09-08T14:00:00', end: '2026-09-08T14:30:00', subject: 'Micom', running: true }],
    },
  }));
  assert.equal(r.dashboard.now, null);
  assert.ok(!JSON.stringify(r.dashboard.rows).includes('Micom'), 'the meeting he is IN is not a row either');
});

test('⚠ in a meeting the restraint is stated in EVERY branch', () => {
  // Without it the panel reads as a complete picture of what is waiting, when
  // the point of the state is that things are deliberately held back.
  const cases = [
    { known: false, events: [] },
    { known: true, scope: 'today', events: [] },
    { known: true, scope: 'today', events: [{ start: '2026-09-08T15:45:00', subject: 'F&C', minutesAway: 105 }] },
  ];
  for (const agenda of cases) {
    const r = compose(payload({ context: { activity: 'in-meeting' }, agenda }));
    assert.match(r.dashboard.note, /still be there/i, JSON.stringify(agenda));
  }
  // ⚠ And an unreadable diary says so rather than rendering as "nothing after".
  const blind = compose(payload({ context: { activity: 'in-meeting' }, agenda: { known: false, events: [] } }));
  assert.match(blind.dashboard.note, /couldn.t read your diary/i);
});

test('⚠ in a meeting she says WHY the screen is empty', () => {
  const r = compose(payload({ context: { activity: 'in-meeting' } }));
  assert.equal(r.dashboard.rows.length, 0);
  assert.ok(r.dashboard.note && r.dashboard.note.length > 0,
    'an empty screen with no reason is indistinguishable from a broken one');
});

// ── The session ─────────────────────────────────────────────────────────────

test('⚠ an ASSUMED duration survives all the way to the figure', () => {
  // "Thirty minutes" and "half an hour because nobody said" are different
  // claims. Laundering the second into the first is what #87 rules out.
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: { taskTitle: 'Succession plan', elapsedMinutes: 22, plannedMinutes: 30, plannedAssumed: true },
  });
  assert.match(r.dashboard.figure.ofLabel, /assumed/);

  const typed = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: { taskTitle: 'x', elapsedMinutes: 10, plannedMinutes: 45, plannedAssumed: false },
  });
  assert.match(typed.dashboard.figure.ofLabel, /planned/);
});

test('⚠ elapsed comes from the session, never re-derived from startedAt', () => {
  // It is FOCUS time with paused stretches excluded. A surface computing it
  // from the start time would silently show wall clock and be wrong the moment
  // Nick is pulled away — the one case the return prompt exists for.
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: {
      taskTitle: 'x',
      startedAt: '2026-08-31T09:00:00.000Z',  // hours ago
      elapsedMinutes: 12,                      // but only 12 minutes of focus
      plannedMinutes: 30,
    },
  });
  assert.equal(r.dashboard.figure.value, 12);
});

test('⚠ an overrun is stated, and the bar is clamped', () => {
  // An overrun is normal. A bar past its end reads as broken, so the fact rides
  // on `overrun` instead.
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: { taskTitle: 'x', elapsedMinutes: 90, plannedMinutes: 30, overrun: true },
  });
  assert.equal(r.dashboard.figure.pct, 100);
  assert.equal(r.dashboard.figure.overrun, true);
  assert.ok(r.dashboard.note);
});

test('⚠ a shrink is stated as evidence, never as failure', () => {
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: { taskTitle: 'Succession plan', elapsedMinutes: 5, plannedMinutes: 30, shrinkCount: 2 },
  });
  const line = JSON.stringify(r.dashboard);
  assert.match(line, /made smaller 2 times/);
  // The forbidden-wording rule the friction service already follows.
  for (const word of ['avoid', 'failed', 'struggling', 'procrastin', 'again']) {
    assert.doesNotMatch(line.toLowerCase(), new RegExp(word), `"${word}" must not appear`);
  }
});

test('an unreadable session says so rather than drawing a zeroed bar', () => {
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), { session: null });
  assert.equal(r.dashboard.figure, null);
  assert.match(r.dashboard.note, /couldn.t read it/i);
});

// ── Off duty ────────────────────────────────────────────────────────────────

test('⚠ off duty shows what he DID, never what he owes', () => {
  // That distinction is the whole reason `resolveDuty` exists, and putting the
  // pool here would undo it.
  const r = compose(payload({
    context: { activity: 'off' },
    primary: card({ title: 'Succession plan', urgency: 'high' }),
    weeklyTarget: { state: 'on-track', done: 28, target: 24 },
  }));
  assert.equal(r.surface, SURFACES.OFF_DUTY);
  assert.equal(r.dashboard.figure.value, 28);
  assert.doesNotMatch(JSON.stringify(r.dashboard.rows), /Succession plan/,
    'an ordinary open task must not appear on the off-duty surface');
});

test('⚠ a CRITICAL item still shows off duty', () => {
  // Hiding a breaching escalation because it is Saturday is the wrong failure.
  const r = compose(payload({
    context: { activity: 'off' },
    primary: card({ title: 'NT-14855 breaching', urgency: 'critical' }),
  }));
  assert.match(JSON.stringify(r.dashboard.rows), /NT-14855/);
});

test('⚠ an unset weekly target is NOT a target of zero', () => {
  // A target of zero renders as "you did none of the nothing you set".
  const unset = compose(payload({ context: { activity: 'off' }, weeklyTarget: { state: 'unset' } }));
  assert.equal(unset.dashboard.figure, null);
  assert.match(unset.dashboard.rows[0].what, /No target set/i);

  // And "I couldn't count" is a third state, not a bad week.
  const unknown = compose(payload({
    context: { activity: 'off' },
    weeklyTarget: { state: 'unknown', reason: 'ledger unreadable' },
  }));
  assert.equal(unknown.dashboard.figure, null);
  assert.equal(unknown.dashboard.rows[0].level, 'warn');
});

// ── Utterances ──────────────────────────────────────────────────────────────

test('⚠ NOTHING an utterance offers leaves the building', () => {
  // No utterance may send an email, book a meeting or chase a person. Those
  // queue behind the approval gate on the desktop, and an ambient surface that
  // can send is one that can send by accident.
  const forbidden = ['send', 'reply', 'email', 'book', 'chase', 'approve', 'invite'];
  for (const activity of ['steady', 'pre-meeting', 'firefighting', 'in-focus-session', 'ritual', 'off', 'in-meeting']) {
    for (const poolAvailable of [true, false]) {
      const r = compose(payload({ context: { activity }, poolAvailable, primary: card() }),
        { session: { taskTitle: 'x', elapsedMinutes: 1, plannedMinutes: 30 } });
      const blob = JSON.stringify(r.utterances).toLowerCase();
      for (const word of forbidden) {
        assert.doesNotMatch(blob, new RegExp(word), `"${word}" reachable on ${activity}`);
      }
      for (const i of intents(r)) {
        assert.ok(['act', 'session', 'navigate', 'ask', 'reveal', 'refresh'].includes(i.kind),
          `unknown intent kind "${i.kind}" on ${activity}`);
      }
    }
  }
});

test('⚠ utterances are BOUNDED by what the record allows', () => {
  // `attention-lifecycle` decides which verbs a card accepts — an escalation is
  // deliberately not dismissable. Offering a sentence NEURO will refuse is
  // worse than offering none, because he will have said it out loud first.
  const r = compose(payload({
    primary: card({ actions: ['acknowledge', 'open'] }),
  }));
  const acts = r.utterances.filter((u) => u.intent.kind === 'act').map((u) => u.intent.action);
  assert.ok(acts.includes('acknowledge'));
  assert.ok(!acts.includes('dismiss'), 'dismiss was offered on a card that refuses it');
  assert.ok(!acts.includes('complete'), 'complete was offered on a card that refuses it');
});

test('⚠ a card with NO recordId gets no act utterances at all', () => {
  // The engine's suppression is a timer and cannot express "seen it" or "this
  // is finished". Substituting it is the exact bug the lifecycle replaced.
  const r = compose(payload({ primary: card({ recordId: undefined }) }));
  assert.equal(r.utterances.filter((u) => u.intent.kind === 'act').length, 0);
  // It still says something useful rather than going silent.
  assert.ok(r.utterances.length > 1);
});

test('⚠ "not now" carries HOW LONG and WHY', () => {
  // A snooze whose length SARA picked is one Nick has no reason to trust, and a
  // thing put off three times for `too-big` is a different problem from one put
  // off for `not-now`. Neither is recoverable after the gesture.
  const r = compose(payload({ primary: card() }));
  const defers = r.utterances.filter((u) => u.intent.action === 'defer');
  assert.ok(defers.length >= 2);
  for (const d of defers) {
    assert.ok(Number.isFinite(d.intent.minutes), 'a deferral with no length');
    assert.ok(typeof d.intent.reason === 'string' && d.intent.reason, 'a deferral with no reason');
  }
  assert.ok(defers.some((d) => d.intent.reason === 'too-big'));
});

test('⚠ "Make it smaller" LEADS on the session surface', () => {
  // Nick's difficulty is INITIATION. Shrinking is the only control that lowers
  // the barrier rather than rescheduling it; a menu without it first pushes him
  // to abandon, which loses the thread and reads as failure.
  const r = compose(payload({ context: { activity: 'in-focus-session' }, primary: card() }), {
    session: { taskTitle: 'x', elapsedMinutes: 5, plannedMinutes: 30 },
  });
  assert.equal(sentences(r)[0], 'Make it smaller');
});

test('⚠ a startable card LEADS with "I’m on it" and keeps "That’s done" inside the cap', () => {
  // Nick, 11 Sep 2026: on an escalation the old order cut "That's done" off
  // entirely, and there was no way to say he had picked it up.
  const esc = card({
    type: 'escalation', title: 'NT-30940 — Re: Formal Complaint', tab: 'surface',
    actionHint: 'Open Queue → Escalations',
    actions: ['acknowledge', 'defer', 'open', 'start', 'complete'],
  });
  const r = compose(payload({ context: { activity: 'firefighting' }, primary: esc }));
  assert.deepEqual(sentences(r), [
    'I’m on it', 'Open Queue → Escalations', 'Not now — an hour', 'That’s done', 'Show me everything',
  ]);
  const onIt = r.utterances[0].intent;
  assert.equal(onIt.kind, 'session', 'start lives on /api/session, not the lifecycle');
  assert.equal(onIt.action, 'start');
  assert.equal(onIt.text, 'NT-30940 — Re: Formal Complaint');
  assert.equal(onIt.recordId, 'rec_1');

  // A session already running: never offered (no silent switch, no kiosk
  // confirm) — and "That's done" is still there.
  const busy = compose(payload({ context: { activity: 'firefighting' }, primary: esc }),
    { session: { taskTitle: 'Something else', elapsedMinutes: 12, plannedMinutes: 30 } });
  assert.ok(!sentences(busy).includes('I’m on it'));
  assert.ok(sentences(busy).includes('That’s done'));

  // Negative: `start` must be EXPLICITLY allowed. A card without it keeps the
  // original order, and an empty action set never infers one.
  assert.ok(!sentences(compose(payload({ primary: card() }))).includes('I’m on it'));
  assert.ok(!sentences(compose(payload({ primary: card({ actions: [] }) }))).includes('I’m on it'));
});

test('⚠ "Show me everything" is always present, and always last', () => {
  // The escape hatch is non-negotiable: Nick's failure mode is avoidance, and a
  // thing he cannot find is worse than a menu he does not need.
  for (const activity of ['steady', 'in-meeting', 'firefighting', 'off', 'in-focus-session', 'ritual']) {
    for (const poolAvailable of [true, false]) {
      const r = compose(payload({ context: { activity }, poolAvailable, primary: card() }));
      const last = r.utterances[r.utterances.length - 1];
      assert.equal(last.say, 'Show me everything', `missing on ${activity}/${poolAvailable}`);
      assert.equal(last.intent.kind, 'reveal');
      assert.ok(r.utterances.length <= MAX_UTTERANCES,
        `the fallback must not become the menu it replaced (${r.utterances.length})`);
    }
  }
});

test('⚠ every utterance reads as a SENTENCE, not a UI verb', () => {
  // One vocabulary, so the mute path teaches the spoken path. "Defer" and
  // "Dismiss" are things an interface says; they are not things Nick says.
  const banned = new Set(['defer', 'dismiss', 'acknowledge', 'complete', 'snooze', 'submit', 'ok', 'cancel']);
  for (const activity of ['steady', 'firefighting', 'in-focus-session', 'off', 'ritual', 'in-meeting']) {
    const r = compose(payload({ context: { activity }, primary: card() }),
      { session: { taskTitle: 'x', elapsedMinutes: 1, plannedMinutes: 30 } });
    for (const s of sentences(r)) {
      assert.ok(!banned.has(s.trim().toLowerCase()), `"${s}" is a UI verb, not a sentence`);
      assert.ok(s.length > 2, `"${s}" is too terse to be something anyone would say`);
    }
  }
});

test('⚠ session verbs are `session` intents, never `act` ones', () => {
  // The attention lifecycle accepts acknowledge / defer / open / start /
  // complete / dismiss. `shrink`, `step-away` and `finish` live on
  // `/api/session/*` and it will 400 on all three — so routing them through an
  // `act` intent would be exactly the "a sentence NEURO will refuse" failure
  // the bounding rule exists to prevent. Caught by reading the routes rather
  // than assuming the two verb sets matched.
  const LIFECYCLE = new Set(['acknowledge', 'defer', 'open', 'start', 'complete', 'dismiss']);
  const SESSION = new Set(['start', 'shrink', 'step-away', 'finish', 'pause', 'resume', 'check-in']);

  const r = compose(payload({ context: { activity: 'in-focus-session' }, primary: card() }), {
    session: { taskTitle: 'Succession plan', elapsedMinutes: 5, plannedMinutes: 30 },
  });
  const sess = r.utterances.filter((u) => u.intent.kind === 'session');
  assert.ok(sess.length >= 2, 'the session surface lost its session verbs');
  for (const u of sess) assert.ok(SESSION.has(u.intent.action), `${u.intent.action} is not a session verb`);

  // And across every surface, an `act` intent may only carry a lifecycle verb.
  for (const activity of ['steady', 'pre-meeting', 'firefighting', 'ritual', 'in-focus-session', 'off']) {
    const c = compose(payload({ context: { activity }, primary: card() }),
      { session: { taskTitle: 'x', elapsedMinutes: 1, plannedMinutes: 30 } });
    for (const u of c.utterances.filter((x) => x.intent.kind === 'act')) {
      assert.ok(LIFECYCLE.has(u.intent.action),
        `act intent carries "${u.intent.action}", which the lifecycle will refuse (${activity})`);
    }
  }
});

// ── Asking moves the dashboard ──────────────────────────────────────────────

test('a question moves the DASHBOARD, deterministically', () => {
  // Nick's principle: everything she can do should be achievable
  // conversationally. Before this, asking streamed an answer and left the
  // screen showing whatever it had been showing.
  const { surfaceForQuestion } = surface;
  assert.equal(surfaceForQuestion("what's in my inbox"), SURFACES.INBOX);
  assert.equal(surfaceForQuestion('anything escalating?'), SURFACES.FIREFIGHTING);
  assert.equal(surfaceForQuestion('what have I got on'), SURFACES.STEADY);
  assert.equal(surfaceForQuestion('how am I doing this week'), SURFACES.OFF_DUTY);
  assert.equal(surfaceForQuestion('make it smaller'), SURFACES.SESSION);
});

test('⚠ an unrecognised question leaves the dashboard exactly where it was', () => {
  // Guessing a panel from a question she does not understand is how she comes
  // to answer a different question from the one asked. The streamed answer is
  // shown either way, so a miss costs nothing.
  const { surfaceForQuestion } = surface;
  assert.equal(surfaceForQuestion('who is Bob'), null);
  assert.equal(surfaceForQuestion(''), null);
  assert.equal(surfaceForQuestion(null), null);

  const r = compose(payload({ context: { activity: 'steady' } }), { ask: 'who is Bob' });
  assert.equal(r.surface, SURFACES.STEADY, 'the context surface must survive an unrouted question');
  assert.equal(r.askedSurface, null);
});

test('⚠ a question can NEVER move the surface off blind', () => {
  // Answering "what's in my inbox" with a confident panel while she cannot see
  // his work is precisely what the blind state exists to prevent.
  const r = compose(payload({ poolAvailable: false }), { ask: "what's in my inbox" });
  assert.equal(r.surface, SURFACES.BLIND);
  assert.equal(r.askedSurface, null);
  assert.match(r.dashboard.note, /all-clear/i);
});

test('askedSurface says the screen moved because he ASKED', () => {
  // A surface that changes under him with no explanation is the dishonest half
  // of being adaptive.
  const r = compose(payload({ context: { activity: 'steady' } }), { ask: 'anything escalating?' });
  assert.equal(r.surface, SURFACES.FIREFIGHTING);
  assert.equal(r.askedSurface, SURFACES.FIREFIGHTING);

  const unasked = compose(payload({ context: { activity: 'firefighting' } }));
  assert.equal(unasked.surface, SURFACES.FIREFIGHTING);
  assert.equal(unasked.askedSurface, null, 'the context arriving there is not him asking');
});

test('⚠ utterances follow the surface SHOWN, not the context', () => {
  // Offering "what did I finish" under an inbox panel is the mute path
  // disagreeing with the screen it is attached to.
  const r = compose(payload({ context: { activity: 'off' } }), { ask: 'anything escalating?' });
  assert.equal(r.surface, SURFACES.FIREFIGHTING);
  assert.ok(!r.utterances.some((u) => /finish/i.test(u.say)),
    'off-duty utterances leaked onto an asked-for firefighting dashboard');
});

// ── The bodies ──────────────────────────────────────────────────────────────

test('firefighting shows REAL escalations when it can read them', () => {
  const r = compose(payload({
    context: { activity: 'firefighting' },
    escalations: {
      known: true,
      items: [
        { key: 'NT-14855', summary: 'Portal sync failing', priority: 'Critical', assignee: 'Unassigned', status: 'Reopened' },
        { key: 'NT-14790', summary: 'Export timeout', priority: null, assignee: null, status: null },
      ],
    },
  }));
  assert.equal(r.dashboard.rows.length, 2);
  assert.equal(r.dashboard.rows[0].when, 'NT-14855');
  assert.equal(r.dashboard.rows[0].level, 'crit');
  // A nulled default (Nick's own name, "Unset", "Open") is nulled UPSTREAM, and
  // what survives is the finding — so an all-null row simply carries no badges.
  assert.equal(r.dashboard.rows[1].meta, null);
});

test('⚠ unreadable escalations are NOT an empty firefighting panel', () => {
  // Under the word "firefighting", an empty box reads as an all-clear at the
  // moment it is least true.
  const r = compose(payload({
    context: { activity: 'firefighting' },
    escalations: { known: false, items: [] },
  }));
  assert.equal(r.dashboard.rows.length, 0);
  assert.match(r.dashboard.note, /all-clear/i);
});

test('⚠ an unreadable inbox is not an empty one', () => {
  const blind = compose(payload({ inbox: { known: false, urgent: [] } }), { ask: 'my inbox' });
  assert.equal(blind.surface, SURFACES.INBOX);
  assert.match(blind.dashboard.note, /couldn.t read your inbox/i);

  // Read fine and genuinely clear is a different fact, and good news.
  const clear = compose(payload({ inbox: { known: true, urgent: [] } }), { ask: 'my inbox' });
  assert.match(clear.dashboard.note, /Nothing needing an answer/i);
});

test('the inbox reads the triage record fields, not the retired table names', () => {
  // `from_name`/`from_email` belonged to the deleted `inbox_items` table and
  // yield `undefined` — the exact bug the urgent-email nudge shipped with.
  const r = compose(payload({
    inbox: { known: true, urgent: [{ subject: 'Contract renewal', from: 'Jo Smith <j@x.com>' }] },
  }), { ask: 'inbox' });
  assert.equal(r.dashboard.rows[0].what, 'Contract renewal');
  assert.equal(r.dashboard.rows[0].meta, 'Jo Smith');
});

test('⚠ an EMPTY firefighting panel still says something', () => {
  // Caught on the live Pi by asking "anything escalating?" on a calm day: the
  // escalations read fine, there were none, the pool was empty, and the panel
  // rendered nothing at all — indistinguishable from one that failed to load,
  // on the surface where that mistake costs most. Three cases, three lines.
  const none = compose(payload({
    context: { activity: 'steady' },
    escalations: { known: true, items: [] },
  }), { ask: 'anything escalating?' });
  assert.equal(none.dashboard.rows.length, 0);
  assert.match(none.dashboard.note, /Nothing escalating/i);

  // Unread is a different fact and must not read as the good news above.
  const unread = compose(payload({
    context: { activity: 'steady' },
    escalations: { known: false, items: [] },
  }), { ask: 'anything escalating?' });
  assert.doesNotMatch(unread.dashboard.note, /Nothing escalating/i);
});
