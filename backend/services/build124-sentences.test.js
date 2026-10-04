'use strict';

/**
 * Build 12.4 — each synthesis theme carries ONE natural line (`sentence`) and
 * the facts under it (`support`), so the native phone can draw a continuous
 * scene without writing grammar of its own. PURE.
 *
 * What is pinned:
 *   • the live Sunday reads as the three lines Nick asked for;
 *   • the sentence says nothing the theme did not already carry;
 *   • support never repeats the sentence (said once);
 *   • every theme in every fixture has a non-empty sentence;
 *   • the additive fields change no existing field (order, headline, lines).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { composePresentation } = require('./presentation-intent');
const { sentenceCase, whenPhrase } = require('./situation-synthesis');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const NOW = Date.parse('2026-10-04T17:00:00Z');

function sunday(extra = {}) {
  return {
    poolAvailable: true,
    surface: 'off-duty',
    context: { activity: 'off', duty: { onDuty: false, reason: 'weekend' }, confidence: { level: 'high' } },
    life: {
      doing: 'watching-tv', label: 'Watching TV', confidence: 'medium',
      place: { kind: 'home', label: 'living room' },
      household: { othersHome: true, who: ['Helen', 'Isaac'] },
    },
    // Lowercase, exactly as the live calendar entry is typed.
    agenda: { known: true, events: [{ id: 'ev-hike', subject: 'hiking', start: '2026-10-10T00:00:00', end: '2026-10-10T23:59:00', allDay: true }] },
    rooms: { known: true, considered: [{ area: 'Living Room', temperature: { known: true, reading: { currentC: 20 } } }] },
    weather: { known: true, tempC: 17 },
    lastNight: { known: true, asleepHours: 10.53, usualLine: 'usually 8h29 on a Sunday', notable: false },
    readiness: { known: true, status: 'ok', score: 66, label: 'Elevated', hrv: 12.5, baselineMs: 20, deviation: -0.9, baselineDays: 15, caveats: [], notable: true },
    gaps: [],
    ...extra,
  };
}
const syn = (p) => composePresentation(p, { now: NOW }).synthesis;

test('12.4-1. the live Sunday reads as three natural lines, in the server’s order', () => {
  const t = syn(sunday()).themes;
  assert.deepEqual(t.map((x) => x.type), ['schedule', 'recovery', 'presence'], 'order unchanged by 12.4');
  assert.deepEqual(t.map((x) => x.sentence), [
    'Hiking on Saturday',
    'Recovery is lower than usual.',
    'You’re home with Helen and Isaac.',
  ]);
  assert.deepEqual(t[1].support, ['HRV 12.5ms vs 20 baseline', 'Slept 10h32 — usually 8h29 on a Sunday']);
  assert.deepEqual(t[0].support, []);
  assert.deepEqual(t[2].support, [], 'the household is IN the sentence, so it is not repeated under it');
});

test('12.4-2. the additive fields leave every 12.3 field exactly as it was', () => {
  const t = syn(sunday()).themes;
  assert.equal(t[0].headline, 'hiking', 'the headline is still the calendar’s own wording');
  assert.equal(t[0].label, 'Saturday');
  assert.equal(t[1].headline, 'Lower than usual');
  assert.equal(t[2].headline, 'You’re home.');
  assert.deepEqual(t[2].lines, ['Helen and Isaac are home too.']);
});

test('12.4-3. support never repeats its own sentence, across every fixture', () => {
  const payloads = [sunday(), ...Object.values(FIXTURES).map((f) => f.payload || f)];
  for (const p of payloads) {
    const s = syn(p);
    if (!s) continue;
    for (const t of s.themes) {
      assert.ok(typeof t.sentence === 'string' && t.sentence.trim(), `${t.type} has a sentence`);
      assert.ok(Array.isArray(t.support), `${t.type} support is a list`);
      assert.ok(!t.support.includes(t.sentence), `${t.type}: "${t.sentence}" said twice`);
    }
  }
});

test('12.4-4. no sentence diagnoses, advises or claims a cause', () => {
  const forbidden = /\b(ill|sick|illness|rest up|take it easy|you should|should|because|due to|recover by|caused)\b/i;
  const payloads = [sunday(), ...Object.values(FIXTURES).map((f) => f.payload || f)];
  for (const p of payloads) {
    const s = syn(p);
    if (!s) continue;
    const text = s.themes.flatMap((t) => [t.sentence, ...t.support]).join(' \n ');
    assert.ok(!forbidden.test(text), text);
  }
});

test('12.4-5. HRV above baseline: "Recovery is higher than usual." (the sign is still the service’s)', () => {
  const p = sunday({ readiness: { ...sunday().readiness, deviation: 1.2, hrv: 31 } });
  assert.equal(syn(p).themes.find((t) => t.type === 'recovery').sentence, 'Recovery is higher than usual.');
});

test('12.4-6. a night-only theme keeps its headline as the sentence — no invented clause', () => {
  const p = sunday({
    readiness: { ...sunday().readiness, label: 'Balanced', notable: false },
    lastNight: { known: true, asleepHours: 4.2, usualLine: 'usually 8h29 on a Sunday', notable: true },
  });
  const rec = syn(p).themes.find((t) => t.type === 'recovery');
  assert.equal(rec.sentence, rec.headline);
  assert.ok(!/Recovery is/.test(rec.sentence));
});

test('12.4-7. home alone is just "You’re home." — one name gets no "and"', () => {
  const alone = sunday({ life: { ...sunday().life, household: { othersHome: false, who: [] } } });
  assert.equal(syn(alone).themes.find((t) => t.type === 'presence').sentence, 'You’re home.');
  const one = sunday({ life: { ...sunday().life, household: { othersHome: true, who: ['Helen'] } } });
  assert.equal(syn(one).themes.find((t) => t.type === 'presence').sentence, 'You’re home with Helen.');
});

test('12.4-8. when-phrases: weekday, today/tomorrow, relative, and none', () => {
  assert.equal(whenPhrase('Saturday', null), 'on Saturday');
  assert.equal(whenPhrase('Saturday', '09:00'), 'on Saturday at 09:00');
  assert.equal(whenPhrase('Tomorrow', '14:30'), 'tomorrow at 14:30');
  assert.equal(whenPhrase('Today', null), 'today');
  assert.equal(whenPhrase('Soon', 'in 20 min'), 'in 20 min');
  assert.equal(whenPhrase('Next', null), null, '"Next" is a label, never a phrase');
  assert.equal(whenPhrase('Next', '3 Oct 12:30'), 'on 3 Oct at 12:30');
  assert.equal(whenPhrase('Next', '3 Oct'), 'on 3 Oct');
  assert.equal(whenPhrase('Next', '15:00'), 'at 15:00', 'a bare time is later today');
});

test('12.4-9. sentence case touches only a leading lowercase letter', () => {
  assert.equal(sentenceCase('hiking'), 'Hiking');
  assert.equal(sentenceCase('NT standup'), 'NT standup');
  assert.equal(sentenceCase('1-2-1 with Hope'), '1-2-1 with Hope');
  assert.equal(sentenceCase(''), '');
});
