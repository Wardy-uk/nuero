// WS1-WP1 contract smoke tests. Zero deps — Node's built-in test runner.
//   run: npm test   (from sara/backend)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getState, getHealth, buildModel } = require('../src/state/stateEngine');
const { validate, CONTRACT, SCHEMA_VERSION, DOMAINS } = require('../src/state/contract');

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

test('health derives from the same model and reports valid', () => {
  const h = getHealth();
  assert.equal(h.status, 'ok');
  assert.equal(h.valid, true);
  assert.equal(h.contract, CONTRACT);
});

test('validate rejects a model missing a domain (degrades honestly)', () => {
  const broken = buildModel();
  delete broken.domains.queue;
  const { valid, errors } = validate(broken);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('queue')), 'expected a queue error');
});
