'use strict';

/**
 * Build 12A/B/D/F/G/N — the presentation intent composer, over the canonical
 * semantic fixtures in shared/presentation-fixtures.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const compose = (id) => {
  const f = FIXTURES.find((x) => x.id === id);
  assert.ok(f, `fixture ${id}`);
  return P.composePresentation(f.payload, { now: f.at });
};
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3', 'P4']);

test('every fixture composes to the contract with a known mode and only semantic priorities', () => {
  for (const f of FIXTURES) {
    const out = P.composePresentation(f.payload, { now: f.at });
    assert.equal(out.contract, 'presentation-v1', f.id);
    assert.ok(P.MODES.includes(out.mode), `${f.id}: ${out.mode}`);
    assert.equal(typeof out.situation.headline, 'string', f.id);
    assert.ok(out.situation.headline.length > 0 && out.situation.headline.length <= 40, `${f.id} headline bounded`);
    for (const list of ['needsYou', 'next', 'offers', 'context', 'observations', 'details', 'tracked']) {
      for (const it of out[list]) assert.ok(PRIORITIES.has(it.priority), `${f.id}.${list} ${it.id}`);
    }
    for (const it of out.needsYou) assert.equal(it.priority, 'P0');
    for (const it of out.details) assert.equal(it.priority, 'P4');
  }
});

test('the contract carries no layout instruction', () => {
  for (const f of FIXTURES) {
    const json = JSON.stringify(P.composePresentation(f.payload, { now: f.at }));
    for (const word of ['"column', '"px', 'width', 'grid', '"card"', 'layout']) {
      assert.ok(!json.includes(word), `${f.id} must not carry ${word}`);
    }
  }
});

test('calm Saturday: a human headline, the clear line, the next thing, ordinary context as P3', () => {
  const out = compose('calm-saturday');
  assert.equal(out.mode, 'off-duty');
  assert.equal(out.situation.headline, 'Quiet Saturday');
  assert.equal(out.situation.summary, 'Nothing needs you right now.');
  assert.equal(out.situation.attentionLevel, 'none');
  assert.equal(out.next[0].title, "Tracey Allen's birthday");
  assert.equal(out.next[0].when, 'Friday');
  assert.deepEqual(out.context.map((c) => c.id), ['place', 'room', 'activity', 'weather', 'sleep']);
  assert.ok(out.context.every((c) => c.priority === 'P3'));
  assert.equal(out.situation.honesty.complete, true);
});

test('one pending approval: P0 dominates, and it is a hand-off, never a button', () => {
  const out = compose('approval');
  assert.equal(out.mode, 'needs-attention');
  assert.equal(out.situation.headline, 'Something needs you');
  assert.equal(out.situation.summary, 'The weekly report is ready for your approval.');
  assert.equal(out.needsYou.length, 1);
  assert.match(out.needsYou[0].handOff, /desktop/);
  assert.equal(out.needsYou[0].actionRef, undefined, 'an approval carries no action a surface could press');
  assert.equal(out.situation.attentionLevel, 'high');
});

test('meeting in 20 minutes: the event IS the situation', () => {
  const out = compose('meeting-soon');
  assert.equal(out.mode, 'upcoming');
  assert.equal(out.situation.summary, 'Tech Leadership starts in 20 minutes.');
  assert.equal(out.next[0].when, 'in 20 min');
  assert.equal(out.next[1].when, '16:30');
});

test('personal deadline tomorrow: not called quiet, and the deadline is the summary', () => {
  const out = compose('personal-deadline');
  assert.equal(out.mode, 'off-duty');
  assert.equal(out.situation.headline, 'Saturday');
  assert.equal(out.situation.summary, 'Renew the car insurance is due tomorrow.');
  assert.equal(out.next[0].kind, 'commitment');
});

test('positive control: without the deadline the same day IS quiet', () => {
  const f = FIXTURES.find((x) => x.id === 'personal-deadline');
  const payload = { ...f.payload, situation: { sections: {} } };
  assert.equal(P.composePresentation(payload, { now: f.at }).situation.headline, 'Quiet Saturday');
});

test('source blindness: a partial read never says "right now" and the source is a P4 detail', () => {
  const out = compose('source-blind');
  assert.equal(out.mode, 'working');
  assert.equal(out.situation.summary, 'Nothing pressing that I can see.');
  assert.equal(out.situation.honesty.complete, false);
  assert.match(out.situation.honesty.say, /presence/);
  assert.ok(out.details.some((d) => d.kind === 'source' && /Apple Health/.test(d.label)));
});

test('working with several low items: one primary P1, the rest tracked, never promoted', () => {
  const out = compose('working-busy');
  assert.equal(out.mode, 'working');
  assert.equal(out.situation.headline, 'Working');
  assert.equal(out.primary.priority, 'P1');
  assert.equal(out.primary.actionRef.recordId, 'rec-1');
  assert.equal(out.tracked.length, 3);
  assert.equal(out.needsYou.length, 0);
  assert.equal(out.next[0].when, '12:00');
});

test('critical secondary item becomes P0 needs-you', () => {
  const f = FIXTURES.find((x) => x.id === 'working-busy');
  const payload = { ...f.payload, secondary: [{ kind: 'item', id: 'esc', recordId: 'r9', title: 'NT-1 breaching', urgency: 'critical' }] };
  const out = P.composePresentation(payload, { now: f.at });
  assert.equal(out.mode, 'needs-attention');
  assert.equal(out.needsYou[0].title, 'NT-1 breaching');
  assert.equal(out.tracked.length, 0);
});

test('degraded: says it cannot see and never says nothing needs you', () => {
  const out = compose('degraded');
  assert.equal(out.mode, 'degraded');
  assert.equal(out.situation.tone, 'uncertain');
  assert.match(out.situation.summary, /isn’t an all-clear/);
  assert.doesNotMatch(out.situation.summary, /Nothing needs you/);
});

test('travelling: the travel frame, and rain within three hours is promoted', () => {
  const out = compose('travelling');
  assert.equal(out.mode, 'travelling');
  assert.equal(out.situation.headline, 'On the road');
  const rain = out.observations.find((o) => o.id === 'rain');
  assert.ok(rain && rain.promoted && rain.priority === 'P2');
  assert.equal(rain.title, 'Rain from 12:00');
});

test('bedtime: names the first thing tomorrow, and a 31° bedroom is promoted out of the annotations', () => {
  const out = compose('bedtime');
  assert.equal(out.mode, 'bedtime');
  assert.equal(out.situation.headline, 'Winding down');
  assert.equal(out.situation.summary, 'First up: Standup, Tomorrow 09:15.');
  const hot = out.observations.find((o) => o.id === 'room-temp');
  assert.ok(hot && hot.promoted, 'bedroom 31° promoted');
  assert.equal(hot.title, 'Bedroom is 31°');
});

test('positive control: a 20° bedroom stays an annotation', () => {
  const f = FIXTURES.find((x) => x.id === 'bedtime');
  const payload = { ...f.payload, rooms: { known: true, considered: [{ area: 'Bedroom', temperature: { known: true, reading: { currentC: 20 } } }] } };
  const out = P.composePresentation(payload, { now: f.at });
  assert.equal(out.observations.find((o) => o.id === 'room-temp'), undefined);
  assert.ok(out.context.find((c) => c.id === 'room'));
});

test('empty: calm, nothing next, no correction question forced on him', () => {
  const out = compose('empty');
  assert.equal(out.situation.headline, 'Quiet Saturday');
  assert.equal(out.next.length, 0);
  assert.equal(out.correction.asking, false);
  assert.equal(out.correction.current, null);
  assert.ok(out.correction.options.length > 0, 'correction options always exist');
});

test('live Sunday: the duplicate birthday renders ONCE, keeping the richer title', () => {
  const out = compose('live-sunday');
  const events = out.next.filter((n) => n.kind === 'event');
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Tracey Allen’s 16th Birthday');
  assert.deepEqual(events[0].mergedFrom, ["Tracey Allen's birthday"]);
  assert.equal(out.situation.headline, 'Quiet Sunday');
  assert.equal(out.situation.summary, 'Nothing needs you that I can see.');
  assert.equal(out.correction.asking, true);
  assert.equal(out.ambientState.inferredActivity.basis, 'none');
});

test('dedupe never folds genuinely distinct events', () => {
  const ev = (title, start, allDay = false) => ({ title, start, allDay });
  assert.equal(P.sameEvent(ev('Standup', '2026-10-06T09:15:00'), ev('Standup', '2026-10-06T16:00:00')), false, 'same title, different time');
  assert.equal(P.sameEvent(ev('1-2-1 Hope', '2026-10-06T15:00:00'), ev('1-2-1 Zoe', '2026-10-06T15:00:00')), false, 'same time, different person');
  assert.equal(P.sameEvent(ev('Birthday', '2026-10-09T00:00:00', true), ev('Tracey Birthday', '2026-10-09T00:00:00', true)), false, 'one-word titles never fold into a longer one');
  assert.equal(P.sameEvent(ev("Tracey Allen's birthday", '2026-10-09T00:00:00', true), ev('Tracey Allen’s 16th Birthday', '2026-10-10T00:00:00', true)), false, 'different day');
  assert.equal(P.sameEvent(ev('Tech Leadership', '2026-10-06T14:00:00'), ev('Tech  leadership', '2026-10-06T14:00:00')), true, 'positive control');
});

test('the local day is read in Europe/London, not the host clock', () => {
  // 23:30 UTC on Sat 3 Oct is 00:30 BST on Sunday.
  assert.equal(P.localParts(Date.parse('2026-10-03T23:30:00Z')).weekday, 'Sunday');
  assert.equal(P.localParts(Date.parse('2026-10-03T23:30:00Z')).key, '2026-10-04');
  const src = fs.readFileSync(path.join(__dirname, 'presentation-intent.js'), 'utf8');
  assert.match(src, /timeZone: TZ/);
  assert.doesNotMatch(src, /new Date\(ev\.start\)|Date\.parse\(ev\.start\)/, 'event times are sliced, never parsed');
});

test('correction: a declared activity offers "Changed?", an inferred one "Not quite?"', () => {
  const f = FIXTURES.find((x) => x.id === 'calm-saturday');
  const inferred = P.composePresentation(f.payload, { now: f.at });
  assert.equal(inferred.correction.prompt, 'Not quite?');
  assert.equal(inferred.ambientState.inferredActivity.label, 'Watching TV');
  const declared = P.composePresentation({ ...f.payload, life: { ...f.payload.life, declared: { doing: 'hobby', until: '2026-10-03T11:00:00Z' }, doing: 'hobby', label: 'On a project of your own' } }, { now: f.at });
  assert.equal(declared.correction.prompt, 'Changed?');
  assert.equal(declared.ambientState.inferredActivity.basis, 'declared');
});

test('the primary title is never also a next item', () => {
  const f = FIXTURES.find((x) => x.id === 'working-busy');
  const payload = { ...f.payload, agenda: { known: true, events: [{ start: '2026-10-06T12:00:00', subject: 'Reply to Simon about renewals', minutesAway: 90 }] } };
  const out = P.composePresentation(payload, { now: f.at });
  assert.equal(out.next.filter((n) => n.title === 'Reply to Simon about renewals').length, 0);
});

test('canonical now carries the presentation and never fails the feed', () => {
  const src = fs.readFileSync(path.join(__dirname, 'canonical-read.js'), 'utf8');
  assert.match(src, /payload\.presentation = require\('\.\/presentation-intent'\)\.composePresentation/);
  assert.match(src, /payload\.presentation = null/);
});
