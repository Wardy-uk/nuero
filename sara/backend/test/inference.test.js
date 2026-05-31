// WS5-WP1 context-inference tests. Zero deps — Node's built-in test runner.
//   run: npm test   (from sara/backend)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deriveInference, RECOMMENDABLE_VIEWS, ACTIVITY } = require('../src/state/inference');
const { getState, getHealth, buildModel } = require('../src/state/stateEngine');
const { validate } = require('../src/state/contract');
const ha = require('../src/telemetry/homeAssistant');

// A minimal contract-shaped set of domain inputs the inference reads. Helpers below
// tweak one axis at a time so each branch of the bounded enum is exercised in isolation.
function baseDomains(overrides = {}) {
  return {
    queue: { source: 'seed', summary: '', open: 3, breaching: 0, sections: {} },
    focus: { source: 'seed', summary: '', current: null, deferEscalation: [] },
    people: { source: 'seed', summary: '', members: [{ name: 'Adele', status: 'solid' }] },
    vault: { source: 'seed', summary: '', picks: [] },
    ...overrides,
  };
}

const noTelemetry = { source: 'home-assistant', available: false, signals: { location: null, presence: null, environment: null } };
const seedLocation = { source: 'seed', label: 'Office', context: 'on-site' };

test('breaching queue -> firefighting, recommends executive dashboard', () => {
  const inf = deriveInference({
    domains: baseDomains({ queue: { source: 'seed', summary: '', open: 3, breaching: 2, sections: {} } }),
    telemetry: noTelemetry,
    location: seedLocation,
  });
  assert.equal(inf.activity, ACTIVITY.FIREFIGHTING);
  assert.equal(inf.recommendedView, RECOMMENDABLE_VIEWS.EXECUTIVE_DASHBOARD);
  assert.ok(inf.reasons.some((r) => /breaching SLA/.test(r)), 'reason should cite breaching SLA');
});

test('a current focus task with a calm queue -> focused-task, recommends focus', () => {
  const inf = deriveInference({
    domains: baseDomains({ focus: { source: 'seed', summary: '', current: { title: 'Prep review' }, deferEscalation: [] } }),
    telemetry: noTelemetry,
    location: seedLocation,
  });
  assert.equal(inf.activity, ACTIVITY.FOCUSED_TASK);
  assert.equal(inf.recommendedView, RECOMMENDABLE_VIEWS.FOCUS);
});

test('away (live presence not present) -> away, recommends presence', () => {
  const inf = deriveInference({
    domains: baseDomains({ focus: { source: 'seed', summary: '', current: { title: 'Prep review' }, deferEscalation: [] } }),
    telemetry: { source: 'home-assistant', available: true, signals: { location: null, presence: { present: false, label: 'Office occupancy' }, environment: null } },
    location: seedLocation,
  });
  // away outranks the focus task in the priority resolution
  assert.equal(inf.activity, ACTIVITY.AWAY);
  assert.equal(inf.recommendedView, RECOMMENDABLE_VIEWS.PRESENCE);
});

test('a slipping report with calm queue and no focus -> team-attention', () => {
  const inf = deriveInference({
    domains: baseDomains({ people: { source: 'seed', summary: '', members: [{ name: 'Nathan', status: 'slipping' }] } }),
    telemetry: noTelemetry,
    location: seedLocation,
  });
  assert.equal(inf.activity, ACTIVITY.TEAM_ATTENTION);
  assert.equal(inf.recommendedView, RECOMMENDABLE_VIEWS.EXECUTIVE_DASHBOARD);
});

test('nothing pressing -> steady default, recommends mission control', () => {
  const inf = deriveInference({ domains: baseDomains(), telemetry: noTelemetry, location: seedLocation });
  assert.equal(inf.activity, ACTIVITY.STEADY);
  assert.equal(inf.recommendedView, RECOMMENDABLE_VIEWS.MISSION_CONTROL);
});

test('contradiction (away + breaching) is surfaced and lowers confidence', () => {
  const calm = deriveInference({
    domains: baseDomains({ queue: { source: 'seed', summary: '', open: 3, breaching: 2, sections: {} } }),
    telemetry: { source: 'home-assistant', available: true, signals: { location: null, presence: { present: true }, environment: null } },
    location: seedLocation,
  });
  const conflicted = deriveInference({
    domains: baseDomains({ queue: { source: 'seed', summary: '', open: 3, breaching: 2, sections: {} } }),
    telemetry: { source: 'home-assistant', available: true, signals: { location: null, presence: { present: false }, environment: null } },
    location: seedLocation,
  });
  // work still wins (firefighting), but the conflict is recorded and confidence drops
  assert.equal(conflicted.activity, ACTIVITY.FIREFIGHTING);
  assert.ok(conflicted.contradictions.length >= 1, 'contradiction should be recorded');
  assert.ok(conflicted.confidence.score < calm.confidence.score, 'contradiction must lower confidence');
});

test('malformed inputs -> unknown, no view recommended, honest low confidence', () => {
  const inf = deriveInference({
    domains: { queue: { source: 'seed' } /* missing required keys; other domains absent */ },
    telemetry: noTelemetry,
    location: seedLocation,
  });
  assert.equal(inf.activity, ACTIVITY.UNKNOWN);
  assert.equal(inf.recommendedView, null, 'no confident recommendation when inputs are incomplete');
  assert.equal(inf.confidence.level, 'low');
  assert.ok(inf.reasons.length, 'must explain why it cannot infer');
});

test('every inference is contractually advisory and carries confidence + reasons', () => {
  const inf = deriveInference({ domains: baseDomains(), telemetry: noTelemetry, location: seedLocation });
  assert.equal(inf.advisory, true, 'recommendation must be advisory only');
  assert.equal(inf.source, 'derived');
  assert.equal(typeof inf.confidence.score, 'number');
  assert.ok(Array.isArray(inf.reasons) && inf.reasons.length, 'reasons must be present');
});

// --- Integration with the shared model -------------------------------------

test('the shared model exposes inference and stays contract-valid', () => {
  ha._setSnapshotForTest(null);
  const s = getState();
  assert.ok(s.inference, 'inference block missing from the shared model');
  assert.equal(s.inference.advisory, true);
  assert.equal(typeof s.inference.activity, 'string');
  assert.ok('recommendedView' in s.inference, 'recommendedView must be exposed');
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('health echoes the same inference verdict the state model carries (no split-brain)', () => {
  ha._setSnapshotForTest(null);
  const s = getState();
  const h = getHealth();
  assert.equal(h.inference.activity, s.inference.activity);
  assert.equal(h.inference.recommendedView, s.inference.recommendedView);
  assert.equal(h.inference.advisory, true);
});

test('contract rejects a model whose recommendation is not advisory', () => {
  const broken = buildModel();
  broken.inference.advisory = false;
  const { valid, errors } = validate(broken);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('advisory')), 'expected an advisory error');
});

test('contract rejects a model with no inference block', () => {
  const broken = buildModel();
  delete broken.inference;
  const { valid, errors } = validate(broken);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('inference')), 'expected an inference error');
});
