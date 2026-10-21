'use strict';

/**
 * desk-relevance (21 Oct 2026): "On the desktop" offers only apps that bear on
 * the moment — never the installed catalogue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { relevantApps, MAX } = require('./desk-relevance');
const { APPS } = require('./desk-intents');

// Every app the laptop can open — Nick's first-use screen showed all of these.
const CATALOGUE = { known: true, host: 'DESKTOP-TEST', why: null, apps: Object.keys(APPS).map((id) => ({ id, label: id.toUpperCase() })) };
const dest = (app) => ({ label: `Open ${app}`, target: { type: 'desk', app } });
const handoff = (primary, ...alts) => ({ contract: 'saim-handoff-v1', handoff: { primary: primary ? dest(primary) : null, alternatives: alts.map(dest), why: 'x' } });
const device = (front) => ({ contract: 'saim-device-v1', known: true, apps: [{ id: 'music', foreground: false }, ...(front ? [{ id: front, foreground: true }] : [])] });

test('the whole installed catalogue with no link to the moment offers NOTHING', () => {
  assert.deepEqual(relevantApps({ offer: CATALOGUE }), []);
  assert.deepEqual(relevantApps({ offer: CATALOGUE, handoff: null, device: { known: true, apps: [] } }), []);
});

test('the app the hand-off names for what leads now comes first, then alternatives, then the app in front', () => {
  const r = relevantApps({ offer: CATALOGUE, handoff: handoff('teams', 'outlook'), device: device('code') });
  assert.deepEqual(r.map((a) => a.id), ['teams', 'outlook', 'code']);
  assert.equal(r[0].label, 'TEAMS', 'label is the offer’s own');
  assert.ok(r.every((a) => typeof a.why === 'string' && a.why));
});

test('capped at three, deterministic, and never duplicated', () => {
  const r = relevantApps({ offer: CATALOGUE, handoff: handoff('teams', 'outlook', 'teams', 'excel', 'word'), device: device('code') });
  assert.equal(MAX, 3);
  assert.deepEqual(r.map((a) => a.id), ['teams', 'outlook', 'excel']);
  assert.deepEqual(relevantApps({ offer: CATALOGUE, handoff: handoff('teams', 'outlook', 'excel'), device: device('code') }),
    relevantApps({ offer: CATALOGUE, handoff: handoff('teams', 'outlook', 'excel'), device: device('code') }));
});

test('an app the laptop cannot open is never offered, however relevant', () => {
  const small = { known: true, host: 'H', apps: [{ id: 'code', label: 'VS Code' }] };
  assert.deepEqual(relevantApps({ offer: small, handoff: handoff('teams'), device: device('code') }).map((a) => a.id), ['code']);
  assert.deepEqual(relevantApps({ offer: small, handoff: handoff('teams'), device: device('excel') }), []);
});

test('fails closed: unknown offer, unknown device, malformed input → []', () => {
  assert.deepEqual(relevantApps({ offer: { ...CATALOGUE, known: false }, handoff: handoff('teams') }), []);
  assert.deepEqual(relevantApps({ offer: CATALOGUE, device: { known: false, apps: [{ id: 'code', foreground: true }] } }), []);
  assert.deepEqual(relevantApps({ offer: null, handoff: handoff('teams') }), []);
  assert.deepEqual(relevantApps({ offer: CATALOGUE, handoff: { handoff: { primary: { target: { type: 'neuro' } } } } }), []);
  assert.deepEqual(relevantApps(), []);
});

test('canonical Now attaches `relevant` and never fails Now over it; renderers read only `relevant`', () => {
  const src = fs.readFileSync(path.join(__dirname, 'canonical-read.js'), 'utf8');
  assert.match(src, /require\('\.\/desk-relevance'\)\.relevantApps\(\{ offer: payload\.work\.deskOffer, handoff: payload\.handoff/);
  const root = path.join(__dirname, '..', '..');
  const surface = fs.readFileSync(path.join(root, 'saim/shared-ui/AttentionSurface.jsx'), 'utf8');
  const shelf = fs.readFileSync(path.join(root, 'saim/shared-ui/Shelf.jsx'), 'utf8');
  const now = fs.readFileSync(path.join(root, 'frontend/src/components/AdhdPanel.jsx'), 'utf8');
  for (const [name, s] of [['AttentionSurface', surface], ['Shelf', shelf], ['AdhdPanel', now]]) {
    assert.doesNotMatch(s, /deskOffer\.apps\.map|offer\.apps\.map|\(work\.deskOffer\.apps \|\| \[\]\)\.length > 0/, `${name} must not render the catalogue`);
    assert.match(s, /\.relevant/, `${name} reads relevant`);
  }
});
