'use strict';

/**
 * The LOG-ONLY meeting-promises shadow (18 Oct 2026).
 *
 *   run: node --test backend/services/promise-shadow.test.js
 *
 * Real scratch DB, temp vault, the real ledger / policy / observation layer and
 * the REAL read-only canonical Now. Every outbound door is stubbed to THROW.
 * People are pseudonyms; one fixture is an employment matter.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pshadow-'));
process.env.NEURO_DB_PATH = path.join(tmp, 's.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'HA_TOKEN', 'HA_URL', 'PROMISE_SHADOW_ENABLED']) delete process.env[k];

const V = process.env.OBSIDIAN_VAULT_PATH;
const put = (rel, text) => { const f = path.join(V, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('People/Alex Reed.md', '---\nemail: alex.reed@nurtur.tech\n---\n');
put('People/Sam Patel.md', '---\nemail: sam.patel@nurtur.tech\n---\n');
put('People/Jordan Kay.md', '---\nemail: jordan.kay@nurtur.tech\n---\n');
put('Meetings/2026/09/2026-09-14 - Ops sync.md', [
  '- Nick to send Alex Reed the list of ticket types blocked by skill gaps',
  '- Nick to write the onboarding guide for Sam Patel', '- Nick to review the escalation rota with Sam Patel',
  '- Nick to share the QA rubric with Alex Reed', '',
].join('\n'));
put('Meetings/2026/09/2026-09-22 - Jordan Kay 1-2-1.md', '- Nick to agree the outcome of Jordan Kay\'s flexible working request\n');

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
const shadow = require('./promise-shadow');
const SC = require('./saim-policy-scenarios');

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const lday = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
function london(day, hm) {
  for (const off of [0, 1]) {
    const ms = Date.parse(`${day}T${hm}:00Z`) - off * 3600000;
    if (new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(11, 16) === hm) return ms;
  }
  throw new Error('bad time');
}
let d0 = Date.now() + DAY;
while (new Date(`${lday(d0)}T12:00:00Z`).getUTCDay() !== 1) d0 += DAY;
const MON = lday(d0); const TUE = lday(d0 + DAY); const MON2 = lday(d0 + 7 * DAY);

const nowPayload = (o = {}, at = SC.at(12, 30)) => { const { decision, candidates, payload } = SC.build({ now: at, surface: 'work-desktop', ...o }); return { ...payload, saim: decision, candidates }; };
const STEADY = async () => nowPayload();
const T = {};
function task(text, note, daysAgo) {
  const r = taskStore.createTask({ text, source: 'meeting-promotion', origin_path: note, due_date: ymd(Date.now() + 3 * DAY) });
  const id = (r.task || r).id;
  db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [new Date(Date.now() - daysAgo * DAY).toISOString().replace('T', ' ').slice(0, 19), id]);
  return id;
}
const slip = (id, n) => { for (let i = 1; i <= n; i += 1) taskStore.updateTask(id, { due_date: ymd(Date.now() + (3 + i) * DAY) }); };

/** Every table's rows AND the schema itself. */
function fingerprint({ except = [] } = {}) {
  const out = { __schema: crypto.createHash('sha1').update(JSON.stringify(db.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"))).digest('hex') };
  for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    if (except.includes(name)) continue;
    out[name] = crypto.createHash('sha1').update(JSON.stringify(db.all(`SELECT * FROM "${name}"`))).digest('hex');
  }
  return out;
}
const rows = (where = '1=1', params = []) => db.all(`SELECT * FROM promise_shadow_log WHERE ${where} ORDER BY id`, params);
const scheduled = [];
const fakeSchedule = (expr, fn, opts) => { scheduled.push({ expr, fn, opts }); return { stop() {} }; };

test.before(async () => {
  await db.init();
  T.alex = task('Nick to send Alex Reed the list of ticket types blocked by skill gaps', 'Meetings/2026/09/2026-09-14 - Ops sync.md', 34);
  T.guide = task('Nick to write the onboarding guide for Sam Patel', 'Meetings/2026/09/2026-09-14 - Ops sync.md', 34);
  T.rota = task('Nick to review the escalation rota with Sam Patel', 'Meetings/2026/09/2026-09-14 - Ops sync.md', 34);
  T.rubric = task('Nick to share the QA rubric with Alex Reed', 'Meetings/2026/09/2026-09-14 - Ops sync.md', 30);
  slip(T.alex, 2); slip(T.guide, 2); slip(T.rota, 3); slip(T.rubric, 2);
});
test.after(() => assert.deepEqual(doors, [], `an outbound door was reached: ${doors.join(', ')}`));

// ── 1. Default-off ───────────────────────────────────────────────────────────

test('OFF: every value but exactly "true" — no table, no schema change, no write, no timer', () => {
  const before = fingerprint();
  for (const env of [{}, { PROMISE_SHADOW_ENABLED: '' }, { PROMISE_SHADOW_ENABLED: 'false' }, { PROMISE_SHADOW_ENABLED: 'TRUE' },
    { PROMISE_SHADOW_ENABLED: 'True' }, { PROMISE_SHADOW_ENABLED: '1' }, { PROMISE_SHADOW_ENABLED: 'yes' }, { PROMISE_SHADOW_ENABLED: 'on' },
    { PROMISE_SHADOW_ENABLED: ' true' }, { PROMISE_SHADOW_ENABLED: 'true ' }, null]) {
    const r = shadow.registerPromiseShadow(env, { schedule: fakeSchedule });
    assert.deepEqual(r, { enabled: false }, JSON.stringify(env));
  }
  assert.equal(scheduled.length, 0, 'no timer');
  assert.equal(shadow.logExists(), false, 'no table');
  assert.deepEqual(fingerprint(), before, 'nothing in the database or its schema changed');
});

test('OFF: a pass, the report and the review commands neither create the table nor write', async () => {
  const before = fingerprint();
  assert.deepEqual(await shadow.tick({ now: london(MON, '07:30'), readNow: STEADY }), { disabled: true, logged: 0 });
  assert.equal(shadow.report().ok, false);
  assert.equal(shadow.label(1, { label: 'tp' }).ok, false);
  assert.equal(shadow.missed({ text: 'x' }).ok, false);
  assert.equal(shadow.logExists(), false);
  assert.deepEqual(fingerprint(), before);
});

test('OFF: no schema file, migration or boot path creates the log', () => {
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'), /promise_shadow/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'db', 'database.js'), 'utf8'), /promise_shadow/);
  const sched = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8');
  assert.equal((sched.match(/promise-shadow/g) || []).length, 1, 'the scheduler only calls registerPromiseShadow');
  assert.match(sched, /require\('\.\/promise-shadow'\)\.registerPromiseShadow\(process\.env\)/);
  assert.match(fs.readFileSync(path.join(__dirname, 'promise-shadow.js'), 'utf8'), /env\.PROMISE_SHADOW_ENABLED !== 'true'\) return \{ enabled: false \}/);
});

test('ON: exactly "true" creates the dedicated log and schedules the shadow (plain cron, London)', () => {
  const r = shadow.registerPromiseShadow({ PROMISE_SHADOW_ENABLED: 'true' }, { schedule: fakeSchedule });
  assert.equal(r.enabled, true);
  assert.equal(shadow.logExists(), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].expr, '*/5 7-18 * * 1-5');
  assert.equal(scheduled[0].opts.timezone, 'Europe/London');
  assert.ok(r.identity && 'runningSha' in r.identity && 'codeHash' in r.identity);
});

// ── 2. Enabled writes ONLY promise_shadow_log (the REAL read-only Now) ──────

test('ON: passes through the REAL read-only canonical Now leave every other table and the schema byte-identical', async () => {
  const before = fingerprint({ except: ['promise_shadow_log'] });
  const r1 = await shadow.tick({ now: london(MON, '07:30') });
  const r2 = await shadow.tick({ now: london(TUE, '12:30') });
  assert.equal(r1.read, 'ok'); assert.equal(r2.read, 'ok');
  assert.ok(rows().length > 0, 'the passes were logged');
  assert.deepEqual(fingerprint({ except: ['promise_shadow_log'] }), before, 'only promise_shadow_log changed');
  for (const t of ['runtime_job_runs', 'event_log', 'prepared_actions', 'goals', 'push_log', 'attention_records', 'attention_events']) {
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM "${t}"`).n, 0, `${t} untouched`);
  }
  assert.equal(db.getState('goal_proposals'), null);
  assert.equal(db.getState('room_episode_state'), null, 'the room visit was not saved');
});

test('ON: every row carries the build it ran under', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }).trim();
  for (const r of rows()) {
    const b = JSON.parse(r.build_json);
    assert.equal(b.runningSha, head);
    assert.equal(typeof b.dirty, 'boolean');
    assert.match(b.codeHash, /^[0-9a-f]{16}$/);
    assert.equal(b.policyVersion, require('../../saim/policy/promises.cjs').POLICY_VERSION);
    assert.equal(b.checkoutSha, head);
    assert.equal(b.stale, false);
  }
});

// ── 3. Behaviour of the passes (payloads from the REAL attention policy) ────

test('discovery once; the next Monday it is still "waiting", never raised twice', async () => {
  db.run('DELETE FROM promise_shadow_log');
  await shadow.tick({ now: london(MON, '07:30'), readNow: STEADY });
  await shadow.tick({ now: london(MON2, '07:30'), readNow: STEADY });
  const p = rows("kind = 'proposal'");
  assert.equal(p.length, 2);
  assert.equal(p[0].decision, 'would-raise', p[0].reason);
  assert.equal(p[1].decision, 'suppressed');
  assert.match(p[1].reason, /already raised/);
  assert.equal((await shadow.tick({ now: london(MON, '07:35'), readNow: STEADY })).idle, true, 'each moment once');
});

test('context unknown: silent, and the suppression and its reason are logged', async () => {
  await shadow.tick({ now: london(TUE, '12:30'), readNow: async () => { throw new Error('HA unreachable'); } });
  const s = rows('moment = ?', [`window:${TUE}:1`]);
  assert.equal(s.length, 1); assert.equal(s[0].kind, 'suppression');
  assert.match(s[0].reason, /no SAiM decision — staying quiet/);
  const p0 = JSON.parse(s[0].payload_json);
  assert.equal(p0.contextUnknown, true);
  assert.deepEqual(p0.read, { ok: false, error: 'HA unreachable' });
  await shadow.tick({ now: london(TUE, '17:30'), readNow: async () => nowPayload({ activity: 'unknown' }) });
  const u = rows('moment = ?', [`window:${TUE}:2`])[0];
  assert.match(u.reason, /context unknown — staying quiet/);
  assert.equal(JSON.parse(u.payload_json).gate.reason, u.reason, 'the row records the gate’s own reason');
});

test('a pre-meeting moment: one would-be prompt for that person’s promise, once per meeting', async () => {
  const day = lday(d0 + 3 * DAY);
  db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, attendees_other) VALUES (?, ?, ?, ?, 0, 1)`,
    ['evt-1to1', '1-2-1 Nick / Alex Reed', `${day}T15:30:00`, `${day}T16:00:00`]);
  await shadow.tick({ now: london(day, '15:10'), readNow: STEADY });
  const m = rows("moment LIKE 'meeting:%'");
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'prompt');
  assert.ok([`promise:${T.alex}`, `promise:${T.rubric}`].includes(m[0].promise_key));
  await shadow.tick({ now: london(day, '15:15'), readNow: STEADY });
  assert.equal(rows("moment LIKE 'meeting:%'").length, 1);
  db.run("DELETE FROM calendar_cache WHERE event_id = 'evt-1to1'");
});

test('heartbeats: one per hour the pass ran', () => {
  const hb = rows("kind = 'heartbeat'").map((r) => r.moment);
  assert.equal(new Set(hb).size, hb.length);
  assert.ok(hb.length >= 3);
});

test('a moved checkout is recorded as stale, rows attributed to the commit actually running', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pshadow-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a'), '1'); git('add', 'a'); git('commit', '-qm', 'one');
  const first = git('rev-parse', 'HEAD');
  shadow._resetIdentity();
  shadow.registerPromiseShadow({ PROMISE_SHADOW_ENABLED: 'true' }, { schedule: fakeSchedule, repoDir: repo });
  fs.writeFileSync(path.join(repo, 'a'), '2'); git('commit', '-qam', 'two');
  const day = lday(d0 + 4 * DAY);
  await shadow.tick({ now: london(day, '07:30'), readNow: STEADY, repoDir: repo });
  const b = JSON.parse(rows('moment = ?', [`window:${day}:0`])[0].build_json);
  assert.equal(b.runningSha, first);
  assert.equal(b.checkoutSha, git('rev-parse', 'HEAD'));
  assert.equal(b.stale, true);
  fs.writeFileSync(path.join(repo, 'a'), 'dirty');
  assert.equal(shadow.captureIdentity({ repoDir: repo }).dirty, true, 'an uncommitted change is reported as dirty');
  shadow._resetIdentity();
});

// ── 4. Review ────────────────────────────────────────────────────────────────

test('review: labels, a missed promise, and the report', () => {
  const prompt = rows("kind = 'prompt'")[0];
  assert.equal(shadow.label(prompt.id, { label: 'maybe' }).code, 400);
  assert.equal(shadow.label(rows("kind = 'heartbeat'")[0].id, { label: 'tp' }).code, 409);
  assert.equal(shadow.label(prompt.id, { label: 'tp', note: 'yes, owed and late' }).ok, true);
  assert.equal(shadow.missed({}).code, 400);
  assert.equal(shadow.missed({ text: 'Send the roadmap to Sam', note: 'said in the corridor' }).ok, true);
  const r = shadow.report({ days: 60, now: london(MON2, '18:00') });
  assert.equal(r.ok, true);
  assert.equal(r.proposals.total, 1);
  assert.equal(r.prompts.tp, 1);
  assert.ok(r.builds.length >= 1 && r.builds.every((b) => b.rows > 0));
  assert.ok(Object.keys(r.suppressions.byReason).some((k) => /no SAiM decision|context unknown/.test(k)));
  assert.equal(r.missed.length, 1);
});

test('a shadow row is a record: only its label can change (build included)', () => {
  const id = rows()[0].id;
  assert.throws(() => db.run('UPDATE promise_shadow_log SET reason = ? WHERE id = ?', ['rewritten', id]), /only its review label/);
  assert.throws(() => db.run('UPDATE promise_shadow_log SET build_json = ? WHERE id = ?', ['{}', id]), /only its review label/);
});

// ── 5. Source scans: every excluded capability ───────────────────────────────

const src = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('the shadow modules cannot reach a sender, the executor, the durable runtime, or any writer of tasks, goals, proposals, calendar or UI', () => {
  const FORBIDDEN_MODULES = ['prepared-actions', 'action-executor', 'action-mail', 'action-calendar', 'webpush', 'email-sender', 'smtp-mail', 'personal-mail',
    'microsoft', 'teams', 'apns', 'task-store', 'task-blocks', 'goal-proposals', 'promise-loop', 'runtime-jobs', 'event-bus', 'ha-rooms', 'household'];
  for (const file of ['promise-shadow.js', 'promise-observe.js', 'promise-ledger.js']) {
    const s = src(file);
    for (const mod of FORBIDDEN_MODULES) assert.doesNotMatch(s, new RegExp(`require\\(['"]\\./${mod}['"]\\)`), `${file} → ${mod}`);
    for (const call of ['setState(', 'saveGoal(', 'createTask(', 'updateTask(', 'sendToAll(', 'express', 'router.', 'app.use']) {
      assert.ok(!s.includes(call), `${file} contains ${call}`);
    }
  }
  const sh = src('promise-shadow.js');
  assert.match(sh, /now\(\{ now: nowMs, readOnly: true \}\)/, 'canonical Now is read read-only');
  assert.match(sh, /policy\.sponsorshipGate\(/, 'the shared gate decides');
  assert.match(sh, /require\('\.\/cron-once'\)/, 'plain cron');
  assert.match(sh, /INSERT INTO \$\{TABLE\}/, 'positive control: the scan reads the file');
  // The only INSERT/UPDATE statements in the shadow target its own table.
  const writes = [...sh.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+([^\s(]+)\s*(\(|SET\b|WHERE\b)/g)];
  assert.ok(writes.length >= 2, 'positive control: the shadow’s own writes are found');
  for (const m of writes) assert.equal(m[2], '${TABLE}', m[0]);
});

test('excluded features are absent from the branch: no briefing, proposals, goals, routes, loop or task-block changes', () => {
  const root = path.join(__dirname, '..', '..');
  for (const rel of ['saim/policy/briefing.cjs', 'backend/services/goal-proposals.js', 'backend/services/promise-loop.js', 'backend/routes/promises.js']) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, rel);
  }
  // 21 Oct 2026 (Keep my word): ONE promise door is permitted — preparing the
  // governed email that delivers a promise (services/promise-delivery). It
  // never sends (approval code in Actions), is machine-refused and interactive
  // in the gateway. Everything else stays excluded, pinned exactly.
  const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
  assert.deepEqual(server.split(/\r?\n/).filter((l) => /promise/i.test(l)), ["app.use('/api/promises', require('./routes/promise-delivery'));"], 'only the delivery door is mounted');
  const door = fs.readFileSync(path.join(root, 'backend', 'routes', 'promise-delivery.js'), 'utf8');
  assert.deepEqual([...door.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`), ['post /:key/prepare'], 'the door has exactly one route');
  const matrixSrc = fs.readFileSync(path.join(__dirname, 'authority-matrix.js'), 'utf8');
  assert.deepEqual(matrixSrc.split('\n').filter((l) => /R\(.*\/api\/promises/.test(l)).map((l) => l.trim()), ["R('POST', '/api/promises/:key/prepare', 'email.send', { machine: 'refuse' }),"]);
  const gw = fs.readFileSync(path.join(root, 'mcp-server', 'remote', 'api-policy.js'), 'utf8');
  assert.deepEqual([...gw.matchAll(/(\w*promises\w*):/g)].map((m) => m[1]), ['post_promises_by_key_prepare']);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'canonical-read.js'), 'utf8'), /sponsorship|promiseFeed|promise-shadow|promise-observe|goal-proposals|saveGoal\([^)]*sponsor/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'task-blocks.js'), 'utf8'), /plannedAfterDue/);
});
