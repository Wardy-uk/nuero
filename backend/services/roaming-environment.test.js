'use strict';
// Roaming sensor + phone barometer + now playing (5 Oct 2026).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-roam-')), 'scratch.db');
const db = require('../db/database');
const env = require('./environment');
const np = require('./now-playing');
const { composePresentation } = require('./presentation-intent');

test.before(async () => { await db.init(); });

test('a live roaming reading is tagged with the place; a downloaded old one is not', () => {
  const now = 1_800_000_000;
  env.store('F69F4CC2', 'Blue Maestro Disc Maxi', [
    { t: now - 60, tempC: 21.4, humidityPct: 48, pressureHpa: 1012.3, timingErrorSeconds: 0 },
    { t: now - 3 * 86400, tempC: 9.1, humidityPct: 80, pressureHpa: 990, timingErrorSeconds: 0 },
  ], { place: 'work', nowSeconds: now });
  const rows = db.all('SELECT t, place FROM environment_readings ORDER BY t');
  assert.equal(rows[0].place, null, 'three-day-old log record is not "at work"');
  assert.equal(rows[1].place, 'work');
  const h = env.here({ nowSeconds: now });
  assert.equal(h.roaming.fresh, true);
  assert.equal(h.roaming.tempC, 21.4);
  assert.equal(h.outdoor, null, 'no outdoor-baseline sensor yet');
  assert.equal(env.here({ nowSeconds: now + 3600 }).roaming.fresh, false, 'an hour later it is not "here, now"');
});

test('roles: refused when unknown; an outdoor-baseline sensor answers `outdoor`', () => {
  assert.equal(env.setRole('X', 'garden').ok, false);
  assert.equal(env.setRole('OUT1', 'outdoor-baseline').ok, true);
  const now = 1_800_000_100;
  env.store('OUT1', 'diy-bme280', [{ t: now - 30, tempC: 14.2, humidityPct: 70, pressureHpa: 1011, timingErrorSeconds: 0 }], { nowSeconds: now });
  assert.equal(env.here({ nowSeconds: now }).outdoor.tempC, 14.2);
});

test('phone pressure: stored, range-checked, idempotent', () => {
  const now = 1_800_000_200;
  assert.equal(env.storePressure('iphone', [{ t: now, pressureHpa: 1013.2 }, { t: now - 1, pressureHpa: 42 }], { place: 'work', nowSeconds: now }).stored, 1);
  assert.equal(env.storePressure('iphone', [{ t: now, pressureHpa: 1013.2 }], { nowSeconds: now }).stored, 0);
  assert.equal(env.storePressure('../x', [{ t: now, pressureHpa: 1000 }]).ok, false);
});

test('now playing: shown only while playing and recent; an older report never replaces a newer', () => {
  const t0 = Date.parse('2030-01-01T12:00:00Z');
  assert.equal(np.record({ state: 'playing', title: 'Teardrop', artist: 'Massive Attack', at: new Date(t0).toISOString() }, { now: t0 }).ok, true);
  assert.equal(np.current({ now: t0 + 60000 }).title, 'Teardrop');
  assert.equal(np.current({ now: t0 + 20 * 60000 }), null, 'stale after 15 minutes');
  assert.equal(np.record({ state: 'paused', title: 'Old', at: new Date(t0 - 60000).toISOString() }, { now: t0 }).stored, false);
  assert.equal(np.record({ state: 'loud', at: new Date(t0).toISOString() }).ok, false);
});

test('presentation: away from home the air here and the track appear in context; at home they do not replace rooms', () => {
  const base = { life: { place: { kind: 'work' } }, environmentHere: { roaming: { fresh: true, tempC: 21.4, humidityPct: 48, pressureHpa: 1012.3 }, pressure: null, outdoor: null },
    nowPlaying: { title: 'Teardrop', artist: 'Massive Attack' } };
  const ctx = (composePresentation(base) || {}).context || [];
  const here = ctx.find((c) => c.id === 'here');
  assert.ok(here, 'a Here line');
  assert.equal(here.value, '21° · 48% · 1012 hPa');
  assert.ok(ctx.find((c) => c.id === 'music' && /Teardrop — Massive Attack/.test(c.label)));
  const home = (composePresentation({ ...base, life: { place: { kind: 'home' } } }) || {}).context || [];
  assert.equal(home.find((c) => c.id === 'here'), undefined);
});
