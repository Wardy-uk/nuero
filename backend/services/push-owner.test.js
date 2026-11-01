'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { ownerOf, routeByOwner, normaliseApp } = require('./push-owner');

const neuro = { endpoint: 'n', app: 'neuro', label: 'phone' };
const saim = { endpoint: 's', app: 'saim' };
const legacy = { endpoint: 'l', app: null };

test('a SAiM-owned push reaches SAiM only — never twice', () => {
  const r = routeByOwner([neuro, saim], 'meeting_alert');
  assert.deepEqual(r.subscriptions.map(s => s.endpoint), ['s']);
  assert.equal(r.fellBack, false);
});

test('a NEURO-owned push reaches NEURO only', () => {
  const r = routeByOwner([neuro, saim], 'router_health');
  assert.deepEqual(r.subscriptions.map(s => s.endpoint), ['n']);
});

test('a subscription that has not said its app still gets everything', () => {
  assert.deepEqual(routeByOwner([neuro, legacy], 'meeting_alert').subscriptions.map(s => s.endpoint), ['l']);
  assert.deepEqual(routeByOwner([saim, legacy], 'router_health').subscriptions.map(s => s.endpoint), ['l']);
});

test('no subscription for the owner falls back to the other app rather than nothing', () => {
  const r = routeByOwner([saim], 'router_health');
  assert.deepEqual(r.subscriptions.map(s => s.endpoint), ['s']);
  assert.equal(r.fellBack, true);
});

test('a probe goes everywhere', () => {
  assert.equal(routeByOwner([neuro, saim], 'test', { probe: true }).subscriptions.length, 2);
});

test('owners follow the agreed split', () => {
  for (const t of ['meeting_prep', 'escalation_alert', 'watched_reply', 'ticket_commitment', 'email', 'standup', 'day_plan', 'brief', 'hike_checkin', 'ambient', 'uat_volunteers']) {
    assert.equal(ownerOf(t), 'saim', t);
  }
  for (const t of ['router_health', 'system_alert', 'sense_alert', 'vault_hygiene', 'weekly_risk', 'soap_report', 'journeys', 'energy_unusual', 'leave_declined']) {
    assert.equal(ownerOf(t), 'neuro', t);
  }
  assert.equal(ownerOf('something_new'), 'saim');
});

test('app ids are a closed set', () => {
  assert.equal(normaliseApp('SAiM'), 'saim');
  assert.equal(normaliseApp('vesta'), undefined);
});
