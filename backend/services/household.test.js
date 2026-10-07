'use strict';

/**
 * Who's in the house (7 Oct 2026): the roster, the route, the photo boundary,
 * and a REAL render of the shared card.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-household-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.HOUSEHOLD_PHOTO_DIR = path.join(tmp, 'photos');
fs.mkdirSync(process.env.HOUSEHOLD_PHOTO_DIR);
process.env.HA_PRESENCE_ENTITIES = 'person.nick,binary_sensor.household_others_home';

const db = require('../db/database');
const hh = require('./household');
const hp = require('./ha-presence');
const bus = require('./event-bus');

test.before(async () => { await db.init(); require('./world-model'); require('./source-health'); });

const MEMBERS = [
  { name: 'Helen', role: 'resident', state: 'home' },
  { name: 'Isaac', role: 'resident', state: 'away' },
  { name: 'Lizzy', role: 'visitor', state: 'home' },
  { name: 'Daniel', role: 'visitor', state: 'unknown' },
];

test('the roster: Nick first, residents, visitors, then Ember — and Ember is never a person with a whereabouts', () => {
  const m = hh.compose({ nick: 'work', householdMembers: MEMBERS }, [{ name: 'Ember', species: 'Dog' }]);
  assert.deepEqual(m.map((x) => x.id), ['nick', 'helen', 'isaac', 'daniel', 'lizzy', 'ember']);
  assert.deepEqual(m[0], { id: 'nick', name: 'Nick', role: 'self', state: 'away', detail: 'At work' });
  assert.equal(m.find((x) => x.id === 'ember').state, 'untracked');
  assert.equal(m.find((x) => x.id === 'daniel').state, 'unknown', 'unknown stays unknown');
});

test('presence carries the member roster through the spine — classes only, junk dropped', async () => {
  const st = [
    { entity_id: 'person.nick', state: 'home', last_changed: '2026-10-07T07:00:00Z', attributes: {} },
    { entity_id: 'binary_sensor.household_others_home', state: 'on', last_changed: '2026-10-07T06:00:00Z',
      attributes: { who_is_home: ['Helen', 'Lizzy'], unreadable: [], unreadable_visitors: [],
        members: [...MEMBERS, { name: 'Mallory', role: 'burglar', state: 'home' }, { name: 'X', role: 'visitor', state: 'Bolton' }] } },
  ];
  const r = await hp.poll({ now: Date.parse('2026-10-07T08:00:00Z'), deps: { isConfigured: () => true, fetchStates: async () => st } });
  assert.equal(r.ok, true);
  await bus.pumpAll();
  const p = hp.read();
  assert.deepEqual(p.householdMembers.map((m) => m.name), ['Daniel', 'Helen', 'Isaac', 'Lizzy'], 'an unknown role or a place-name state is dropped');
  const out = hh.read();
  assert.equal(out.known, true);
  assert.equal(out.members.find((m) => m.id === 'nick').state, 'home');
  assert.equal(out.homeCount, 3, 'Nick, Helen, Lizzy');
  const payloads = db.all("SELECT payload FROM event_log WHERE type = 'observation.presence.changed'").map((x) => x.payload).join('\n');
  assert.doesNotMatch(payloads, /Bolton|Mallory/, 'nothing outside the class vocabulary reaches the log');
});

test('a down presence source makes EVERYONE unknown — never "everyone is out"', async () => {
  for (let i = 0; i < 3; i += 1) {
    await hp.poll({ now: Date.parse('2026-10-07T09:00:00Z') + i * 120e3, deps: { isConfigured: () => true, fetchStates: async () => { throw new Error('ECONNREFUSED'); } } });
  }
  await bus.pumpAll();
  const out = hh.read();
  assert.equal(out.known, false);
  for (const m of out.members.filter((x) => x.role !== 'companion')) assert.equal(m.state, 'unknown', m.id);
});

test('photos: found by id from the photo dir, never by a path the caller supplies', () => {
  fs.writeFileSync(path.join(process.env.HOUSEHOLD_PHOTO_DIR, 'helen.jpg'), 'x');
  assert.equal(hh.photoFile('helen').ext, 'jpg');
  assert.equal(hh.photoFile('isaac'), null);
  for (const bad of ['../secret', 'helen.jpg', '..', '', 'a/b', '%2e%2e']) assert.equal(hh.photoFile(bad), null, bad);
});

test('route: the roster and a photo over HTTP; a missing photo is a 404, not a broken image', async () => {
  const express = require('express');
  const app = express();
  app.use('/api/household', require('../routes/household'));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/household`)).json();
    assert.ok(list.members.find((m) => m.id === 'helen').photo, 'helen has a photo');
    assert.equal(list.members.find((m) => m.id === 'isaac').photo, null);
    const ok = await fetch(`${base}/api/household/photo/helen`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control'), /private/);
    assert.equal((await fetch(`${base}/api/household/photo/isaac`)).status, 404);
    assert.equal((await fetch(`${base}/api/household/photo/..%2F..%2Fetc`)).status, 404);
  } finally { server.close(); }
});

test('the photo directory is outside the repository (it is public)', () => {
  delete process.env.HOUSEHOLD_PHOTO_DIR;
  const repo = path.resolve(__dirname, '..', '..');
  const dir = hh.photoDir();
  assert.ok(!path.resolve(dir).startsWith(repo + path.sep), `${dir} must not be inside ${repo}`);
  process.env.HOUSEHOLD_PHOTO_DIR = path.join(tmp, 'photos');
});

// ── a REAL render of the shared card ─────────────────────────────────────────

test('the card renders every state in words, and a down source is not an empty house', async () => {
  const out = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', '..', 'saim', 'shared-ui', 'HouseholdCard.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'css', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const { HouseholdView } = mod.exports;
  assert.equal(typeof HouseholdView, 'function', 'positive control: the view is exported');

  const data = { known: true, members: hh.compose({ nick: 'home', householdMembers: MEMBERS }, [{ name: 'Ember', species: 'Dog' }]).map((m) => ({ ...m, photo: null })) };
  const html = renderToString(React.createElement(HouseholdView, { data }));
  for (const word of ['Nick', 'Helen', 'Isaac', 'Lizzy', 'Daniel', 'Ember', 'Home', 'Out', "Can&#x27;t tell", 'Not tracked', 'visiting', '3 home']) {
    assert.ok(html.includes(word), `renders ${word}`);
  }
  assert.match(html, /hh-face--unknown/);
  assert.ok(html.includes('>H<'), 'no photo → an initial, not a broken image');

  const down = renderToString(React.createElement(HouseholdView, { data: { known: false, members: data.members.map((m) => ({ ...m, state: m.role === 'companion' ? 'untracked' : 'unknown' })) } }));
  assert.ok(down.includes('isn&#x27;t “everyone&#x27;s out”'), 'says the house could not be read');
  assert.doesNotMatch(down, /Nobody home/);
});
