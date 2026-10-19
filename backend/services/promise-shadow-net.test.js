'use strict';

/**
 * The shadow's bounded local network contract (19 Oct 2026).
 *
 *   run: node --test backend/services/promise-shadow-net.test.js
 *
 * With Home Assistant CONFIGURED (as on the Pi), a shadow pass — the shadow and
 * the real read-only canonical Now under it — may reach only:
 *   GET  localhost:8123 /api/states, /api/states/<weather entity>, /api/history/period/<ISO>
 *   POST localhost:8123 /api/template with a body holding only the template
 *   GET  localhost:3005 /api/presence/room
 * Everything else is refused BEFORE the network: other hosts, schemes, ports,
 * methods and Home Assistant paths, and every /api/services or /api/events call
 * (incl. the weather/get_forecasts service normal Now makes).
 *
 * Proves: the pure contract, both ways; the guard leaves the rest of the
 * backend untouched; a real pass sends only allowed requests, reaches no HA
 * service and changes no HA state; no token, request body or HA source data
 * reaches promise_shadow_log; the refused forecast changes no decision.
 * Home Assistant here is a fake that ANSWERS (refusing everything would hide
 * calls Now only makes after a successful read). People are pseudonyms.
 */

// Pins the wall clock to each pass's simulated instant (see the helper).
const clock = require('./fixtures/promise-shadow/clock');
clock.install();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pnet-'));
process.env.NEURO_DB_PATH = path.join(tmp, 's.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'PROMISE_SHADOW_ENABLED', 'SAIM_BASE_URL', 'HA_WEATHER_ENTITY']) delete process.env[k];
// Home Assistant configured exactly as on the Pi. The token is a marker that must never be logged.
const TOKEN = 'TOKEN-MARKER-7f3a91c2';
process.env.HA_URL = 'http://localhost:8123';
process.env.HA_TOKEN = TOKEN;

const V = process.env.OBSIDIAN_VAULT_PATH;
const put = (rel, text) => { const f = path.join(V, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('People/Alex Reed.md', '---\nemail: alex.reed@nurtur.tech\n---\n');
put('People/Sam Patel.md', '---\nemail: sam.patel@nurtur.tech\n---\n');
put('Meetings/2026/09/2026-09-14 - Ops sync.md', '- Nick to send Alex Reed the list of ticket types blocked by skill gaps\n- Nick to write the onboarding guide for Sam Patel\n');

// Source data Home Assistant and the presence service hand back, each carrying a marker.
const SECRET = 'HA-SOURCE-MARKER-c81d';
const ROOM = 'Marker Study 4471';

// ── A fake Home Assistant that ANSWERS, with state that only a mutation could change ──
const haState = { 'person.nick': 'home', 'light.kitchen': 'off', 'climate.living_room': 'heat' };
const reached = []; // every request that got past the guard to the "network"
const okRes = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeNetwork(input, init = {}) {
  const url = String(input); const method = String(init.method || 'GET').toUpperCase();
  reached.push({ url, method, body: init.body == null ? null : String(init.body), auth: (init.headers || {}).Authorization || null });
  const u = new URL(url);
  if (u.port === '3005') return Promise.resolve(okRes({ confidence: 'sure', room: ROOM, offsite: false }));
  if (u.pathname.startsWith('/api/services/')) { // a service call is what would change HA
    const [, , , domain, service] = u.pathname.split('/');
    if (domain === 'light') haState['light.kitchen'] = service === 'turn_on' ? 'on' : 'off';
    return Promise.resolve(okRes({ service_response: { 'weather.forecast_home': { forecast: [{ datetime: '2026-10-20T13:00:00', condition: 'rainy', precipitation: 2 }] } } }));
  }
  if (u.pathname === '/api/template') return Promise.resolve(okRes(JSON.stringify([{ area: SECRET, entities: ['light.kitchen'] }])));
  if (u.pathname.startsWith('/api/history/')) return Promise.resolve(okRes([[]]));
  if (u.pathname.startsWith('/api/states/')) return Promise.resolve(okRes({ entity_id: 'weather.forecast_home', state: 'sunny', attributes: { temperature: 12, friendly_name: SECRET } }));
  if (u.pathname === '/api/states') {
    return Promise.resolve(okRes(Object.entries(haState).map(([entity_id, state]) => ({ entity_id, state, attributes: { friendly_name: `${SECRET} ${entity_id}` }, last_updated: new Date().toISOString(), last_changed: new Date().toISOString() }))));
  }
  return Promise.resolve(okRes({}));
}
global.fetch = fakeNetwork;

const doors = [];
function stub(rel, ex) { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports: ex }; }
const boom = (w) => async () => { doors.push(w); throw new Error(`${w} reached from the shadow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });
stub('./action-mail', { createDraft: boom('action-mail'), sendDraft: boom('action-mail'), DEFINITIVE_SEND_REFUSALS: new Set() });
stub('./microsoft', { getSignedInAddress: async () => 'nickw@nurtur.tech', getAccessToken: boom('graph'), graphWrite: boom('graphWrite'), sendMail: boom('ms.sendMail') });

const db = require('../db/database');
const taskStore = require('./task-store');
const net = require('./promise-shadow-net');
const shadow = require('./promise-shadow');

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const lday = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
function london(d, hm) {
  for (const off of [0, 1]) {
    const ms = Date.parse(`${d}T${hm}:00Z`) - off * 3600000;
    if (new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(11, 16) === hm) return ms;
  }
  throw new Error('bad time');
}
let d0 = Date.now() + DAY;
while (new Date(`${lday(d0)}T12:00:00Z`).getUTCDay() !== 2) d0 += DAY; // a Tuesday
const DAYKEY = lday(d0);

function task(text, daysAgo) {
  const r = taskStore.createTask({ text, source: 'meeting-promotion', origin_path: 'Meetings/2026/09/2026-09-14 - Ops sync.md', due_date: ymd(Date.now() + 3 * DAY) });
  const id = (r.task || r).id;
  db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [new Date(Date.now() - daysAgo * DAY).toISOString().replace('T', ' ').slice(0, 19), id]);
  for (let i = 1; i <= 2; i += 1) taskStore.updateTask(id, { due_date: ymd(Date.now() + (3 + i) * DAY) });
  return `promise:${id}`;
}
const allRows = () => db.all('SELECT * FROM promise_shadow_log ORDER BY id');

test.before(async () => {
  await db.init();
  clock.reportsSent([london(DAYKEY, '12:30')]); // the simulated week's report to Chris, recorded as sent (see the clock helper)
  task('Nick to send Alex Reed the list of ticket types blocked by skill gaps', 34);
  task('Nick to write the onboarding guide for Sam Patel', 30);
  shadow.registerPromiseShadow({ PROMISE_SHADOW_ENABLED: 'true' }, { schedule: () => ({ stop() {} }) });
  shadow._resetRuntime();
});
test.after(() => { assert.deepEqual(doors, [], `an outbound door was reached: ${doors.join(', ')}`); });

// ── The pure contract ────────────────────────────────────────────────────────

const T = JSON.stringify({ template: '{{ states | count }}' });
const ALLOW = [
  ['http://localhost:8123/api/states', {}, 'ha.states'],
  ['http://localhost:8123/api/states/weather.forecast_home', {}, 'ha.weather-state'],
  ['http://localhost:8123/api/history/period/2026-10-18T23%3A00%3A00.000Z?filter_entity_id=device_tracker.x&end_time=2026-10-19T10%3A00%3A00.000Z', {}, 'ha.history'],
  ['http://localhost:8123/api/history/period/2026-10-18T23:00:00Z?minimal_response&no_attributes', { method: 'GET' }, 'ha.history'],
  ['http://localhost:8123/api/template', { method: 'POST', body: T }, 'ha.template'],
  ['http://localhost:3005/api/presence/room', {}, 'saim.room-presence'],
];
const REFUSE = [
  // other destinations, schemes and ports
  ['http://127.0.0.1:8123/api/states', {}, 'destination'],
  ['https://localhost:8123/api/states', {}, 'destination'],
  ['http://localhost:8124/api/states', {}, 'destination'],
  ['http://localhost:3006/api/presence/room', {}, 'destination'],
  ['http://localhost/api/states', {}, 'destination'],
  ['https://api.example.com/x', {}, 'destination'],
  ['http://100.100.28.58:8123/api/states', {}, 'destination'],
  ['http://user:pw@localhost:8123/api/states', {}, 'credentials-in-url'],
  ['not a url', {}, 'unparseable-url'],
  // Home Assistant services, actions and events — never, whatever the method
  ['http://localhost:8123/api/services/weather/get_forecasts?return_response', { method: 'POST', body: '{"entity_id":"weather.forecast_home","type":"hourly"}' }, 'ha-service-or-event'],
  ['http://localhost:8123/api/services/light/turn_on', { method: 'POST', body: '{"entity_id":"light.kitchen"}' }, 'ha-service-or-event'],
  ['http://localhost:8123/api/services/climate/set_temperature', { method: 'POST', body: '{}' }, 'ha-service-or-event'],
  ['http://localhost:8123/api/services', {}, 'ha-service-or-event'],
  ['http://localhost:8123/api/events/call_service', { method: 'POST', body: '{}' }, 'ha-service-or-event'],
  // other methods on allowed paths
  ['http://localhost:8123/api/states/weather.forecast_home', { method: 'POST', body: '{"state":"x"}' }, 'ha-method'],
  ['http://localhost:8123/api/states', { method: 'DELETE' }, 'ha-method'],
  ['http://localhost:8123/api/history/period/2026-10-18T23:00:00Z', { method: 'PUT' }, 'ha-method'],
  ['http://localhost:8123/api/states', { method: 'GET', body: '{}' }, 'ha-body'],
  ['http://localhost:8123/api/template', {}, 'ha-template-method'],
  ['http://localhost:8123/api/template?x=1', { method: 'POST', body: T }, 'ha-template-query'],
  ['http://localhost:8123/api/template', { method: 'POST', body: JSON.stringify({ template: 'x', entity_id: 'light.kitchen' }) }, 'ha-template-body'],
  ['http://localhost:8123/api/template', { method: 'POST', body: 'not json' }, 'ha-template-body'],
  ['http://localhost:8123/api/template', { method: 'POST' }, 'ha-template-body'],
  ['http://localhost:3005/api/presence/room', { method: 'POST' }, 'presence-method'],
  ['http://localhost:3005/api/presence/room?x=1', {}, 'presence-query'],
  ['http://localhost:3005/api/presence/display/wake', {}, 'presence-path'],
  ['http://localhost:3005/api/neuro/actions', {}, 'presence-path'],
  // any other Home Assistant path or entity
  ['http://localhost:8123/api/states/light.kitchen', {}, 'ha-state-entity'],
  ['http://localhost:8123/api/states/person.nick', {}, 'ha-state-entity'],
  ['http://localhost:8123/api/states?x=1', {}, 'ha-states-query'],
  ['http://localhost:8123/api/history/period/yesterday', {}, 'ha-history-path'],
  ['http://localhost:8123/api/history/period/2026-10-18T23:00:00Z?significant_changes_only=0&foo=1', {}, 'ha-history-query'],
  ['http://localhost:8123/api/config', {}, 'ha-path'],
  ['http://localhost:8123/api/', {}, 'ha-path'],
  ['http://localhost:8123/api/logbook', {}, 'ha-path'],
  ['http://localhost:8123/api/config/core/check_config', { method: 'POST', body: '{}' }, 'ha-method'],
  ['http://localhost:8123/api/intent/handle', { method: 'POST', body: '{}' }, 'ha-method'],
];

test('contract: each allowed local read is accepted, as exactly that operation', () => {
  for (const [u, init, op] of ALLOW) assert.deepEqual(net.check(u, init), { ok: true, op }, u);
  assert.deepEqual(net.ALLOWED.slice().sort(), [...new Set(ALLOW.map((a) => a[2]))].sort(), 'the allowlist is exactly these operations');
});

test('contract: every other destination, port, method and Home Assistant path is refused, with the reason', () => {
  for (const [u, init, category] of REFUSE) assert.deepEqual(net.check(u, init), { ok: false, category }, `${init.method || 'GET'} ${u}`);
});

test('contract: the weather state read follows HA_WEATHER_ENTITY, and only that entity', () => {
  const env = { HA_WEATHER_ENTITY: 'weather.home_met' };
  assert.equal(net.check('http://localhost:8123/api/states/weather.home_met', {}, env).ok, true);
  assert.equal(net.check('http://localhost:8123/api/states/weather.forecast_home', {}, env).category, 'ha-state-entity');
});

// ── The guard ────────────────────────────────────────────────────────────────

test('guard: outside a shadow pass, fetch is the backend\'s own — nothing is judged or refused', async () => {
  net.install();
  assert.ok(net.installed());
  const n = reached.length;
  await global.fetch('http://localhost:8123/api/services/light/turn_off', { method: 'POST', body: '{}' });
  assert.equal(reached.length, n + 1, 'the normal backend still reaches its own services');
  assert.equal(haState['light.kitchen'], 'off');
  assert.deepEqual(net.counts().refused, {}, 'nothing refused outside a pass');
});

test('guard: inside a pass a refused request never reaches the network — also from timers it starts', async () => {
  const n = reached.length;
  await net.run(async () => {
    await assert.rejects(() => global.fetch('http://localhost:8123/api/services/light/turn_on', { method: 'POST', body: '{"entity_id":"light.kitchen"}' }), (e) => e instanceof net.ShadowNetRefused && e.category === 'ha-service-or-event');
    await new Promise((r) => setTimeout(r, 1));
    await assert.rejects(() => global.fetch('https://api.example.com/'), (e) => e.category === 'destination');
    const delayed = await new Promise((r) => setTimeout(() => r(global.fetch('http://localhost:8124/x').catch((e) => e)), 5));
    assert.equal(delayed.category, 'destination', 'a timer started inside the pass is still judged');
  });
  assert.equal(reached.length, n, 'none reached the network');
  assert.equal(haState['light.kitchen'], 'off', 'no state changed');
  const msg = new net.ShadowNetRefused('ha-service-or-event').message;
  assert.doesNotMatch(msg, /localhost|8123|\/api\/|light|Bearer/, 'a refusal names a category, never the request');
  net._resetCounts();
});

test('guard: re-installs if something replaced global fetch, and keeps calling the real one', async () => {
  const saved = global.fetch;
  global.fetch = fakeNetwork;
  assert.equal(net.installed(), false);
  const n = reached.length;
  await net.run(async () => { await global.fetch('http://localhost:8123/api/states'); });
  assert.ok(net.installed());
  assert.equal(reached.length, n + 1, 'an allowed read goes through to the real fetch');
  global.fetch = saved;
  net._resetCounts();
});

// ── A real pass, Home Assistant configured and answering ─────────────────────

let pass = null;
test('a real pass: only allowed requests reach the network; no HA service, no HA state change', async () => {
  const before = JSON.stringify(haState);
  const n = reached.length;
  const at730 = london(DAYKEY, '07:30');
  const res = await clock.at(at730, () => shadow.tick({ now: at730 }));
  pass = { res, sent: reached.slice(n), stats: shadow.stats() };
  assert.equal(res.read, 'ok', 'canonical Now was read');
  assert.ok(pass.sent.length > 0, 'positive control: the pass did use the network');
  for (const r of pass.sent) {
    const v = net.check(r.url, { method: r.method, body: r.body });
    assert.ok(v.ok, `a request outside the contract reached the network: ${r.method} ${r.url}`);
  }
  const ops = new Set(pass.sent.map((r) => net.check(r.url, { method: r.method, body: r.body }).op));
  for (const op of ['ha.states', 'ha.template', 'ha.history', 'ha.weather-state', 'saim.room-presence']) assert.ok(ops.has(op), `Now used ${op} (positive control)`);
  assert.ok(!pass.sent.some((r) => /\/api\/(services|events)/.test(r.url)), 'no Home Assistant service or event');
  assert.ok(pass.sent.filter((r) => r.method !== 'GET').every((r) => r.url === 'http://localhost:8123/api/template'), 'the only non-GET is the template render');
  assert.equal(JSON.stringify(haState), before, 'Home Assistant state unchanged');
  assert.ok((pass.stats.net.refused['ha-service-or-event'] || 0) >= 1, 'normal Now\'s forecast SERVICE call was refused before the network');
  assert.deepEqual(Object.keys(pass.stats.net.refused), ['ha-service-or-event'], 'nothing else was refused');
});

test('a real pass still decides: the refused forecast costs no decision', () => {
  const rows = allRows().filter((r) => r.kind === 'prompt' || r.kind === 'suppression');
  assert.ok(rows.some((r) => r.decision === 'would-prompt'), 'the 07:30 bundle still offers a promise');
  // The forecast feeds presentation only. The gate reads SAiM's lead rule
  // (attention policy over NEURO's candidates), the context and the feed —
  // none of which reads weather.
  for (const f of ['promise-observe.js', 'neuro-candidates.js', '../../saim/policy/promises.cjs', '../../saim/policy/attention-policy.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(src.length > 1000, `positive control: ${f} was read`);
    assert.doesNotMatch(src, /weather|forecast/i, `${f} reads no weather`);
  }
  const shadowSrc = fs.readFileSync(path.join(__dirname, 'promise-shadow.js'), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  assert.doesNotMatch(shadowSrc, /weather|forecast/i, 'promise-shadow.js code reads no weather');
});

test('no token, request body or Home Assistant source data reaches promise_shadow_log', () => {
  const text = JSON.stringify(allRows());
  assert.ok(allRows().length > 0, 'positive control: the pass logged');
  assert.ok(pass.sent.some((r) => r.auth && r.auth.includes(TOKEN)), 'positive control: the token WAS used on the wire');
  assert.ok(pass.sent.some((r) => r.body && r.body.includes('template')), 'positive control: a request body WAS sent');
  for (const needle of [TOKEN, 'Bearer', SECRET, ROOM, 'localhost:8123', 'localhost:3005', '/api/', '{%', '{{', 'friendly_name', 'light.kitchen', 'person.nick', 'service_response']) {
    assert.ok(!text.includes(needle), `the log contains ${needle}`);
  }
});

test('the counters carry operation names and refusal categories only — no URL', () => {
  const s = JSON.stringify(shadow.stats().net);
  assert.ok(s.includes('ha.template') && s.includes('ha-service-or-event'), 'positive control');
  assert.doesNotMatch(s, /localhost|\/api\/|http|8123|3005/);
});

// ── Default-off ──────────────────────────────────────────────────────────────

test('default-off: tick() with no log installs no guard, wraps no fetch, reads and writes nothing (fresh process)', () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pnet-off-'));
  const script = `
    process.env.NEURO_DB_PATH = ${JSON.stringify(path.join(dir, 'off.db'))};
    process.env.OBSIDIAN_VAULT_PATH = ${JSON.stringify(path.join(dir, 'vault'))};
    process.env.HA_URL = 'http://localhost:8123'; process.env.HA_TOKEN = 'x';
    delete process.env.PROMISE_SHADOW_ENABLED;
    const calls = []; const mine = async (u) => { calls.push(String(u)); throw new Error('no'); };
    globalThis.fetch = mine;
    (async () => {
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))}); await db.init();
      const schema = () => JSON.stringify(db.all('SELECT type, name, sql FROM sqlite_master ORDER BY type, name'));
      const s0 = schema(); const c0 = db.get('SELECT total_changes() AS n').n;
      const shadow = require(${JSON.stringify(path.join(__dirname, 'promise-shadow'))});
      const net = require(${JSON.stringify(path.join(__dirname, 'promise-shadow-net'))});
      const reg = shadow.registerPromiseShadow(process.env, { schedule: () => { throw new Error('a timer was scheduled'); } });
      const t = await shadow.tick({ now: Date.parse('2026-10-20T06:30:00Z') });
      console.log(JSON.stringify({ reg, t, installed: net.installed(), fetchOriginal: globalThis.fetch === mine, calls: calls.length,
        log: shadow.logExists(), schema: schema() === s0, changes: db.get('SELECT total_changes() AS n').n - c0 }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(process.execPath, ['-e', script], { env: process.env, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  assert.deepEqual(r.reg, { enabled: false });
  assert.deepEqual(r.t, { disabled: true, logged: 0 });
  assert.equal(r.installed, false, 'no network guard installed');
  assert.equal(r.fetchOriginal, true, 'global fetch untouched');
  assert.equal(r.calls, 0, 'no network');
  assert.equal(r.log, false, 'no table');
  assert.equal(r.schema, true, 'schema unchanged');
  assert.equal(r.changes, 0, 'no database write');
});

test('default-off: registering without the flag installs no guard', () => {
  const src = fs.readFileSync(path.join(__dirname, 'promise-shadow.js'), 'utf8');
  const reg = src.slice(src.indexOf('function registerPromiseShadow'));
  const off = reg.slice(0, reg.indexOf('ensureLog();'));
  assert.ok(off.includes("PROMISE_SHADOW_ENABLED !== 'true'"), 'positive control: the off branch');
  assert.doesNotMatch(off, /net\.|install/, 'the off branch touches no network guard');
  assert.doesNotMatch(src.slice(0, src.indexOf('function registerPromiseShadow')).replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''), /net\.install\(/, 'the guard is installed only by a pass (net.run)');
  const netSrc = fs.readFileSync(path.join(__dirname, 'promise-shadow-net.js'), 'utf8');
  assert.doesNotMatch(netSrc.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''), /^install\(\);?$/m, 'the module does not install itself on require');
});
