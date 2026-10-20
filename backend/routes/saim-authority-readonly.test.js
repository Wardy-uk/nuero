'use strict';

/**
 * May do's status read is GENUINELY read-only (20 Oct 2026).
 *
 * Found on the first production release: opening May do (GET
 * /api/saim-authority/status) created the five empty authority tables on first
 * view. Schema only, no rows — but a write caused by looking. Now every read
 * asks `has()` and reports the zero state; only an intentional state change
 * creates the schema, in one transaction.
 *
 * Proven here over real HTTP, through NEURO's real api-auth and authority
 * guard, on a FRESH scratch database:
 *   1. status, called repeatedly AND concurrently, leaves the database file,
 *      its schema and every table's content byte-identical, makes no network
 *      call, and creates no authority object;
 *   2. the May do screen renders from that zero state (the real component);
 *   5. API-token, declared-machine and unauthenticated callers are refused on
 *      every route before the authority module is touched at all;
 *   3. a real grant creates exactly the authority schema and its one allowance
 *      record (plus the spent confirmation and the audit line) — nothing else;
 *   4. existing authority data still reads correctly, and reading it changes
 *      nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-authority-ro-'));
const DBFILE = path.join(tmp, 'agent.db');
process.env.NEURO_DB_PATH = DBFILE;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
delete process.env.SAIM_PREPARED_MOVE_EXECUTION;

const db = require('../db/database');

// Any outbound network call during the run is counted (there must be none).
let netCalls = 0;
const realFetch = global.fetch;
global.fetch = async (...a) => { netCalls += 1; return realFetch(...a); };

// Every function the routes can reach on the authority module is counted, so a
// refusal can be shown to happen BEFORE the module is touched.
const budget = require('../services/authority-budget');
const touched = [];
for (const k of Object.keys(budget)) {
  if (typeof budget[k] !== 'function') continue;
  const fn = budget[k];
  budget[k] = (...a) => { touched.push(k); return fn(...a); };
}

let server; let base;
test.before(async () => {
  await db.init();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/saim-authority', require('./saim-authority'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { global.fetch = realFetch; await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const PIN = { 'X-NEURO-PIN': 'pin-1234' };
function call(method, route, body, headers = PIN) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/saim-authority/${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}') }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** The database, three ways: the file's bytes, its whole schema, every table's content. */
function fingerprint() {
  const g = db.getDb();
  g.pragma('wal_checkpoint(TRUNCATE)');
  const schema = g.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
  const tables = {};
  for (const { name } of schema.filter((r) => r.type === 'table' && !r.name.startsWith('sqlite_'))) {
    tables[name] = sha(JSON.stringify(g.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()));
  }
  return { file: sha(fs.readFileSync(DBFILE)), schema: sha(JSON.stringify(schema)), tables, authorityObjects: schema.filter((r) => /saim_authority/.test(r.name)).map((r) => `${r.type}:${r.name}`).sort() };
}

const ROUTES = [['GET', 'status'], ['POST', 'grant/preview', {}], ['POST', 'grant', { confirmToken: `ac_${'0'.repeat(20)}` }], ['POST', 'revoke', {}], ['POST', 'stop', {}], ['POST', 'resume/preview', {}], ['POST', 'resume', { confirmToken: `ac_${'0'.repeat(20)}` }]];

test('1. on a fresh database, status — repeated and concurrent — writes nothing, creates nothing, calls nothing', async () => {
  const before = fingerprint();
  assert.deepEqual(before.authorityObjects, [], 'fresh: no authority object exists');
  touched.length = 0; netCalls = 0;
  for (let i = 0; i < 10; i += 1) assert.equal((await call('GET', 'status')).status, 200);
  const many = await Promise.all(Array.from({ length: 25 }, () => call('GET', 'status')));
  assert.ok(many.every((r) => r.status === 200));
  const s = many[0].json;
  // The correct zero state.
  assert.equal(s.contract, 'saim-authority-v1');
  assert.equal(s.gates.device.open, false); assert.equal(s.gates.device.say, 'SAiM is technically locked on this device.');
  assert.equal(s.grant, null); assert.equal(s.gates.allowance.say, 'SAiM has no allowance to act today.');
  for (const k of ['blocks', 'minutes', 'notes', 'moves']) assert.deepEqual([s.allowance[k].granted, s.allowance[k].used, s.allowance[k].left], [0, 0, 0], k);
  assert.equal(s.allowance.spendPence, 0); assert.equal(s.allowance.contacts, 0);
  assert.equal(s.stopped, false); assert.deepEqual(s.receipts, []); assert.equal(s.active.state, 'none'); assert.equal(s.canAct, false);
  // Nothing changed — the file, the schema, any table.
  const after = fingerprint();
  assert.deepEqual(after, before, 'byte-identical database, schema and content');
  assert.equal(netCalls, 0, 'no network activity');
  assert.ok(touched.includes('status'), 'positive control: the status route really ran');
  module.exports.zero = s;
});

test('2. the May do screen renders from that zero state, and rendering changes nothing', async () => {
  const before = fingerprint();
  const s = (await call('GET', 'status')).json;
  const esbuild = require('esbuild'); const React = require('react'); const { renderToString } = require('react-dom/server');
  const APP = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src');
  const out = await esbuild.build({
    entryPoints: [path.join(APP, 'views', 'Authority.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const html = renderToString(React.createElement(mod.exports.AuthorityView, { state: { kind: 'ready', status: s } }));
  const t = html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(t, /SAiM is technically locked on this device\./);
  assert.match(t, /SAiM has no allowance to act today\./);
  assert.match(t, /Calendar blocks 0 of 0/); assert.match(t, /None yet\./);
  assert.match(html, /Stop all SAiM actions/);
  assert.deepEqual(fingerprint(), before, 'rendering May do from the zero state wrote nothing');
});

test('5. machine, declared-machine and unauthenticated callers are refused before the authority module is touched', async () => {
  const before = fingerprint();
  touched.length = 0;
  for (const [m, r, b] of ROUTES) {
    assert.equal((await call(m, r, b, { 'X-NEURO-API-TOKEN': 'tok-5678' })).status, 403, `token ${m} ${r}`);
    assert.equal((await call(m, r, b, { ...PIN, 'X-Neuro-Machine-Client': 'mcp-local' })).status, 403, `declared machine ${m} ${r}`);
    assert.equal((await call(m, r, b, {})).status, 401, `no credential ${m} ${r}`);
  }
  assert.deepEqual(touched, [], 'no authority function ran — not a read, not a schema check');
  const after = fingerprint();
  assert.deepEqual(after.authorityObjects, [], 'no authority object was created');
  assert.equal(after.schema, before.schema, 'no schema change at all');
  // The ONE intended write on a refusal is the existing audit line (Build 14):
  // a machine refused by the authority guard is logged to activity_log. Every
  // other table is untouched.
  const changed = Object.keys(after.tables).filter((k) => after.tables[k] !== before.tables[k]);
  assert.ok(changed.every((k) => k === 'activity_log'), `only the refusal audit may change: ${changed}`);
});

test('3. a real grant creates exactly the authority schema and its one allowance record', async () => {
  const before = fingerprint();
  const p = await call('POST', 'grant/preview', { blockMinutes: 30 });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const g = await call('POST', 'grant', { confirmToken: p.json.confirmToken });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const after = fingerprint();
  assert.deepEqual(after.authorityObjects, [
    'index:idx_saim_authority_grants_day', 'index:idx_saim_authority_res_day',
    // SQLite's own indexes for the tables' TEXT primary keys and UNIQUE(idem_key).
    'index:sqlite_autoindex_saim_authority_controls_1', 'index:sqlite_autoindex_saim_authority_grants_1', 'index:sqlite_autoindex_saim_authority_pending_1',
    'index:sqlite_autoindex_saim_authority_reservations_1', 'index:sqlite_autoindex_saim_authority_reservations_2',
    'table:saim_authority_controls', 'table:saim_authority_events', 'table:saim_authority_grants', 'table:saim_authority_pending', 'table:saim_authority_reservations',
    'trigger:saim_authority_events_append_only_d', 'trigger:saim_authority_events_append_only_u', 'trigger:saim_authority_grants_immutable', 'trigger:saim_authority_grants_no_delete',
  ], 'exactly the authority schema, nothing else');
  const changed = Object.keys(after.tables).filter((k) => !/^saim_authority/.test(k) && after.tables[k] !== before.tables[k]);
  assert.deepEqual(changed, [], 'no other table changed');
  const c = (t) => db.get(`SELECT COUNT(*) n FROM ${t}`).n;
  assert.equal(c('saim_authority_grants'), 1, 'the one allowance record');
  assert.equal(c('saim_authority_pending'), 1, 'the confirmation that granted it (now spent)');
  assert.equal(db.get('SELECT COUNT(*) n FROM saim_authority_pending WHERE used_at IS NOT NULL').n, 1);
  assert.equal(c('saim_authority_events'), 1, 'one audit line');
  assert.equal(c('saim_authority_reservations'), 0); assert.equal(c('saim_authority_controls'), 0);
});

test('3b. the schema is created atomically: concurrent first writers both succeed, the schema lands once', async () => {
  // Drop back to a schema-less database copy is not possible in-process; instead
  // prove the creation is ONE transaction: ensure() runs exec inside
  // transaction(...).immediate(), so a partial schema cannot be observed.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'authority-budget.js'), 'utf8');
  assert.match(src, /g\.transaction\(\(\) => g\.exec\(`[\s\S]*CREATE TABLE IF NOT EXISTS saim_authority_grants[\s\S]*`\)\)\.immediate\(\);/);
  // And concurrent first writes from separate processes on a fresh file both land without error.
  const { spawnSync } = require('child_process');
  const fresh = path.join(tmp, 'race.db');
  const script = (i) => `process.env.NEURO_DB_PATH=${JSON.stringify(fresh)};(async()=>{const db=require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))});await db.init();const b=require(${JSON.stringify(path.join(__dirname, '..', 'services', 'authority-budget'))});b.stop({by:'race-${i}'});console.log('ok')})().catch(e=>{console.log('ERR '+e.message)})`;
  // Initialise the base schema once so the race is only over the authority schema.
  spawnSync(process.execPath, ['-e', `process.env.NEURO_DB_PATH=${JSON.stringify(fresh)};require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))}).init().then(()=>console.log('init'))`], { encoding: 'utf8' });
  const { spawn } = require('child_process');
  const runs = await Promise.all([0, 1, 2].map((i) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', script(i)]); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => resolve(o.trim()));
  })));
  assert.deepEqual(runs.map((r) => r.split('\n').pop()), ['ok', 'ok', 'ok'], `every racing first writer succeeded: ${runs}`);
  const Database = require('better-sqlite3'); const d = new Database(fresh, { readonly: true });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'saim_authority%' AND type='table'").get().n, 5);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM saim_authority_events').get().n, 3, 'all three stops recorded once each');
  d.close();
});

test('4. existing authority data reads correctly — and reading it changes nothing', async () => {
  let s = (await call('GET', 'status')).json;
  assert.equal(s.grant.blockMinutes, 30);
  assert.deepEqual([s.allowance.blocks.left, s.allowance.minutes.left, s.allowance.notes.left], [1, 30, 1]);
  // A move uses its allowance (as the executor would), and leaves a receipt.
  const r = budget.reserve({ moveKey: 'm1', title: 'x', steps: [{ key: 'm1:calendar', kind: 'calendar.solo', minutes: 30 }, { key: 'm1:note', kind: 'vault.note' }] });
  assert.equal(r.ok, true);
  budget.settle('m1:calendar', 'used'); budget.settle('m1:note', 'used');
  budget.recordReceipt({ target: 'sandbox', complete: true, plain: 'Both are in place and checked.', at: new Date().toISOString(), steps: [{ step: 'calendar', status: 'done' }, { step: 'note', status: 'done' }] }, { title: 'x' });
  assert.equal((await call('POST', 'stop', {})).status, 200);
  const before = fingerprint();
  touched.length = 0;
  const reads = await Promise.all(Array.from({ length: 15 }, () => call('GET', 'status')));
  s = reads[0].json;
  assert.deepEqual([s.allowance.blocks.used, s.allowance.minutes.used, s.allowance.notes.used, s.allowance.moves.used], [1, 30, 1, 1]);
  assert.equal(s.stopped, true); assert.equal(s.summary, 'All SAiM actions are stopped.');
  assert.equal(s.receipts.length, 1); assert.equal(s.active.practice, true);
  assert.deepEqual(fingerprint(), before, 'reading existing authority data changed nothing');
});
