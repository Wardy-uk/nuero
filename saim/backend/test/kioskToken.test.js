'use strict';

/**
 * Build 14C: the kiosk's own credential. NEURO's authority guard refuses a
 * machine caller on human-only routes (an accepted room offer, a Planner tick),
 * so the living-room screen — which forwards what a PERSON pressed — sends its
 * own token when it has one, and the API token only as a fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const neuroConfig = require('../src/integrations/neuroConfig');

test('the kiosk token is preferred and travels in its own header', () => {
  const env = { NEURO_KIOSK_TOKEN: 'k', NEURO_API_TOKEN: 't', NEURO_PIN: 'p' };
  assert.deepEqual(neuroConfig.authHeaders(env), { 'x-neuro-kiosk-token': 'k' });
  assert.equal(neuroConfig.readiness({ ...env, NEURO_BASE_URL: 'http://x' }).credentialKind, 'kiosk-token');
});

test('without one, the API token (a machine) and then the PIN are used as before', () => {
  assert.deepEqual(neuroConfig.authHeaders({ NEURO_API_TOKEN: 't', NEURO_PIN: 'p' }), { 'x-neuro-api-token': 't' });
  assert.deepEqual(neuroConfig.authHeaders({ NEURO_PIN: 'p' }), { 'x-neuro-pin': 'p' });
  assert.equal(neuroConfig.readiness({ NEURO_BASE_URL: 'http://x', NEURO_KIOSK_TOKEN: 'k' }).ready, true);
});
