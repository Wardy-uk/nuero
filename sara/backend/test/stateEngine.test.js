// WS1-WP1 contract smoke tests. Zero deps — Node's built-in test runner.
//   run: npm test   (from sara/backend)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getState, getHealth, buildModel } = require('../src/state/stateEngine');
const { validate, CONTRACT, SCHEMA_VERSION, DOMAINS } = require('../src/state/contract');
const ha = require('../src/telemetry/homeAssistant');

test('assembled model conforms to the v1 contract', () => {
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('getState exposes the v1 contract over the shared model', () => {
  const s = getState();
  assert.equal(s.contract, CONTRACT);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.equal(s.dataSource, 'seed');
  assert.ok(s.servedAt, 'servedAt stamp missing');
  for (const name of DOMAINS) {
    assert.ok(s.domains[name], `missing domain ${name}`);
    assert.equal(s.domains[name].source, 'seed', `${name} not flagged as seed`);
  }
});

test('briefing is derived from domain data, not a fixed string', () => {
  const s = getState();
  // seed has 2 breaching tickets and Nathan slipping -> both must surface
  assert.match(s.briefing.line, /breaching SLA/);
  assert.match(s.briefing.line, /Nathan is slipping/);
});

test('state exposes current location and confidence (WS1 criterion 2)', () => {
  const s = getState();
  // location: seeded input, honestly flagged, carries a human label
  assert.ok(s.location, 'location missing from state');
  assert.equal(s.location.source, 'seed', 'location not flagged as seed');
  assert.equal(typeof s.location.label, 'string');
  assert.ok(s.location.label.length, 'location.label is empty');
  // confidence: derived by the engine, moderate while inputs are seeded
  assert.ok(s.confidence, 'confidence missing from state');
  assert.equal(s.confidence.source, 'derived', 'confidence should be derived, not seeded');
  assert.equal(typeof s.confidence.score, 'number');
  assert.equal(s.confidence.level, 'moderate', 'seed inputs should yield moderate confidence');
});

test('assembled model with location and confidence is contract-valid', () => {
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('health derives from the same model and reports valid', () => {
  const h = getHealth();
  assert.equal(h.status, 'ok');
  assert.equal(h.valid, true);
  assert.equal(h.contract, CONTRACT);
  // location + confidence exposed consistently on the health surface too
  assert.equal(typeof h.location, 'string');
  assert.ok(h.location.length, 'health.location is empty');
  assert.equal(h.confidence.level, 'moderate');
  assert.equal(typeof h.confidence.score, 'number');
});

test('validate rejects a model missing a domain (degrades honestly)', () => {
  const broken = buildModel();
  delete broken.domains.queue;
  const { valid, errors } = validate(broken);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('queue')), 'expected a queue error');
});

// --- WS3-WP1: Home Assistant telemetry bridge ------------------------------

test('model carries a telemetry block and stays contract-valid when HA is absent', () => {
  ha._setSnapshotForTest(null); // restore the unconfigured/unavailable default
  const s = getState();
  assert.ok(s.telemetry, 'telemetry block missing from state');
  assert.equal(s.telemetry.source, 'home-assistant');
  assert.equal(s.telemetry.available, false, 'telemetry should be unavailable with no HA');
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('location falls back to seed honestly when HA telemetry is unavailable', () => {
  ha._setSnapshotForTest(null);
  const s = getState();
  assert.equal(s.location.source, 'seed', 'absent HA must leave location on the seed reader');
  assert.equal(s.telemetry.signals.location, null);
});

test('live HA location signal feeds the shared model (location flips to HA source)', () => {
  ha._setSnapshotForTest({
    source: 'home-assistant',
    available: true,
    reason: null,
    detail: null,
    polledAt: '2026-05-31T09:00:00.000Z',
    signals: {
      location: { entityId: 'person.nick', state: 'home', zone: 'home', label: 'Home' },
      presence: { entityId: 'binary_sensor.occ', state: 'on', present: true, label: 'Office occupancy' },
      environment: { entityId: 'sensor.temp', state: '21.4', unit: '°C', label: 'Office temp: 21.4°C' },
    },
  });
  const s = getState();
  assert.equal(s.location.source, 'home-assistant', 'live HA location must drive the shared location');
  assert.equal(s.location.label, 'Home');
  assert.equal(s.telemetry.available, true);
  assert.equal(s.telemetry.signals.presence.present, true);
  // Still contract-valid with live telemetry folded in.
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
  // Health agrees with state about liveness (no split-brain).
  const h = getHealth();
  assert.equal(h.telemetry.available, true);
  assert.equal(h.locationSource, 'home-assistant');
  ha._setSnapshotForTest(null); // reset so later/other tests see the honest default
});

test('contract rejects a model with no telemetry block', () => {
  const broken = buildModel();
  delete broken.telemetry;
  const { valid, errors } = validate(broken);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('telemetry')), 'expected a telemetry error');
});
