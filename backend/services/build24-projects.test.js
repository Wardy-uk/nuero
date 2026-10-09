'use strict';

/**
 * Build 24 — Personal projects.
 *
 * Real scratch DB, a real temp vault laid out like the live Projects/ folder,
 * real routes over HTTP behind the real api-auth + authority guard, and the
 * snapshot shape the real reporter (scripts/github-snapshot.js) sends, with
 * repo ids and names copied from the 8 Oct 2026 GitHub audit. Anything that
 * could notify is stubbed to THROW. Numbering follows the brief's test list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b24-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b24.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-2424';
process.env.NEURO_API_TOKEN = 'machine-token-24';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { throw new Error(`${what} reached from a Build 24 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });

const db = require('../db/database');
const M = require('./projects-model');
const pj = require('./projects');
const store = require('./task-store');
const fu = require('./build-followups');

const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const plus = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);

// ── the vault, shaped like the live Projects/ folder ────────────────────────

function write(rel, text) {
  const p = path.join(VAULT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
function age(rel, days) { const t = new Date(NOW - days * 86400000); fs.utimesSync(path.join(VAULT, rel), t, t); }

write('Projects/_about.md', '---\ntype: reference\n---\n# Projects\n');
write('Projects/NOVA/NOVA vs n8n Reconciliation.md', '# NOVA vs n8n\n\nCode lives at https://github.com/Wardy-uk/NOVA on nova-codex.\n');
write('Projects/Hill Bagging App/Hill Bagging App.md', [
  '---', 'type: project', 'status: spec', 'created: 2026-09-22', 'tags: [ios, side-project, hillwalking]', '---', '',
  '# One More Hill', '', '> **While you\'re there, bag them all**', '',
  '## Next', '- [ ] Download OS Complete Trig Archive, check field format', '',
].join('\n'));
write('Projects/Walking with Ember/Walking with Ember.md', [
  '---', 'type: project', 'status: active', 'created: 2026-09-28', 'tags: [walking-with-ember, website, portfolio]',
  'repo: "C:\\\\Users\\\\NickW\\\\Claude\\\\walkingwithember"', '---', '',
  '# Walking with Ember', '', '> Turn Walking with Ember into a beautiful, fully finished flagship site.', '',
].join('\n'));
write('Projects/Outdoor Weather/Outdoor Weather.md', [
  '---', 'type: project', 'status: active', 'tags: [saim, esp32]', '---', '', '# Outdoor Weather', '', '## Goal', '', 'Deploy a weatherproof outdoor sensor.', '',
  '## Implementation Status', '', '### 2026-10-05 — Firmware build status', 'Builds.', '',
].join('\n'));
write('Projects/Jira Unify/Jira Unify.md', [
  '---', 'type: project', 'status: parked', 'owner: Nick Ward', '---', '', '# Jira Unify', '', '> Move the Nurtur support spaces into NT.', '',
  '## Status', '- 2026-10-08: **Parked** by Nick after the mapping was finished.', '',
].join('\n'));
write('Projects/Discovery/Discovery.md', '---\ntype: project\nstatus: complete\ncompleted: 2026-03-13\n---\n# Discovery\n\n> 9-phase discovery. Complete.\n');
write('Projects/Quiet Thing/Quiet Thing.md', '---\ntype: project\n---\n# Quiet Thing\n\n> Something with no status at all.\n');
write('Projects/NEURO/NEURO.md', [
  '---', 'type: project', 'parked: [Watch work, SAiM visual redesign]',
  'repos: ["https://github.com/Wardy-uk/nuero", "https://github.com/Wardy-uk/nuero-ios"]', '---', '', '# NEURO', '', '> The brain.', '',
  '## Next', '- [ ] Watch work: add the complication target', '- [ ] Write the Build 25 brief', '',
].join('\n'));
write('Projects/NEURO/NEURO-SAIM — Build 19 Personal Operations.md', `---\ntype: project-record\nbuild: 19\ndate: ${daysAgo(3).slice(0, 10)}\nstatus: deployed (nuero a0af05c)\n---\n# NEURO-SAIM — Build 19\n`);
// Live 8 Oct 2026: a nested spec with `type: project` was taken as NEURO's hub,
// and a Discovery phase note mentioning the NOVA repo pulled NOVA into a likely link.
write('Projects/NEURO/Origins/NEURO - Plaud Render Fix (Spec).md', '---\ntype: project\nstatus: todo\n---\n# Plaud render fix\n');
write('Projects/Side Spec/Origins/Old Spec.md', '---\ntype: project\nstatus: todo\n---\n# Old spec\n');
write('Projects/Discovery/Phase 04 - NOVA Codebase.md', '# Phase 4\n\nRepo: https://github.com/Wardy-uk/NOVA\n');
write('Projects/Archive/Old Idea/Old Idea.md', '---\ntype: project\nstatus: active\n---\n# Old Idea\n');
age('Projects/Hill Bagging App/Hill Bagging App.md', 16);
age('Projects/Quiet Thing/Quiet Thing.md', 200);

// ── the snapshot, shaped like the reporter's ────────────────────────────────

const R = {
  nova: { id: 1164021904, fullName: 'Wardy-uk/NOVA' },
  nuero: { id: 1184105094, fullName: 'Wardy-uk/nuero' },
  ios: { id: 1361736609, fullName: 'Wardy-uk/nuero-ios' },
  omh: { id: 1389260334, fullName: 'Wardy-uk/onemorehill' },
  wwe: { id: 1157267740, fullName: 'Wardy-uk/walkingwithember' },
  tally: { id: 1208533713, fullName: 'Wardy-uk/tally' },
  hb: { id: 9000000001, fullName: 'Wardy-uk/hillbagger' },
  saltz: { id: 264634929, fullName: 'Wardy-uk/charnwood-saltz' },
};
const files = (o) => ({ source: 0, test: 0, config: 0, docs: 0, generated: 0, lock: 0, other: 0, ...o });
function snapshot(extra = {}) {
  return {
    fetchedAt: new Date(NOW - 3600000).toISOString(), account: 'Wardy-uk', reporter: 'github-snapshot on TEST', scope: 'owned by Wardy-uk',
    totalVisible: 1803, orgCounts: { thepropertyjungle: 1693, PropertyTechnology: 55, 'Nurtur-LABS': 24 },
    checkouts: [{ path: 'C:\\Users\\NickW\\Claude\\walkingwithember', fullName: 'wardy-uk/walkingwithember' }],
    repos: [
      { ...R.nova, private: true, pushedAt: daysAgo(0), commits: [{ sha: 'aaaaaaa00001', at: daysAgo(1), subject: 'feat(portal): queue view', files: files({ source: 3 }) }] },
      { ...R.nuero, private: false, pushedAt: daysAgo(0), commits: [
        { sha: 'bbbbbbb00001', at: daysAgo(2), subject: 'feat(build24): projects', files: files({ source: 4, test: 1 }) },
        { sha: 'bbbbbbb00002', at: daysAgo(1), subject: 'chore: regenerate inventory', files: files({ generated: 1 }) },
        { sha: 'bbbbbbb00003', at: daysAgo(0.5), subject: 'docs: fix README typo', files: files({ docs: 1 }) },
        { sha: 'bbbbbbb00004', at: daysAgo(0.4), subject: 'Merge branch main', merge: true, files: files({ source: 9 }) },
      ] },
      { ...R.ios, private: true, pushedAt: daysAgo(1), commits: [{ sha: 'ccccccc00001', at: daysAgo(1), subject: 'fix: geofence off by default', files: files({ source: 1 }) }] },
      { ...R.omh, private: false, pushedAt: daysAgo(12), commits: [{ sha: 'ddddddd00001', at: daysAgo(12), subject: 'build 3 tracker', files: files({ source: 6 }) }],
        releases: [{ tag: 'v0.1.0', at: daysAgo(12), name: 'First TestFlight' }] },
      { ...R.wwe, private: false, pushedAt: daysAgo(10), commits: [{ sha: 'eeeeeee00001', at: daysAgo(10), subject: 'about page', files: files({ source: 2 }) }],
        deployments: [{ id: 501, at: daysAgo(10), environment: 'production', state: 'success' }] },
      { ...R.tally, private: false, pushedAt: daysAgo(0), commits: [{ sha: 'fffffff00001', at: daysAgo(0.2), subject: 'categorise', files: files({ source: 2 }) }] },
      { ...R.hb, private: true, pushedAt: daysAgo(40), commits: [] },
      { ...R.saltz, private: false, archived: true, pushedAt: '2022-01-17T10:00:00Z', commits: [] },
      ...(extra.repos || []),
    ],
  };
}

let server; let base;
const PIN = { 'X-NEURO-PIN': 'pin-2424', 'Content-Type': 'application/json' };
const MACHINE = { 'X-NEURO-API-TOKEN': 'machine-token-24', 'Content-Type': 'application/json' };
async function call(method, p, body, headers = PIN) {
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const enc = encodeURIComponent;
const proj = (id) => pj.read({ now: NOW }).projects.find((p) => p.projectId === id);

let T = {};
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/projects', require('../routes/projects'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Tasks that exist before any link: two in project folders, two by name, one unrelated.
  T.trig = store.createTask({ text: 'Order the OS trig archive for One More Hill', source: 'manual', domain: 'personal', origin_path: 'Projects/Hill Bagging App/Hill Bagging App.md', due_date: plus(3) }).id;
  T.ember = store.createTask({ text: 'Walking with Ember cookie consent banner', source: 'manual', domain: 'personal' }).id;
  T.nova = store.createTask({ text: 'NOVA portal queue view for the combined team', source: 'manual', domain: 'work' }).id;
  T.watch = store.createTask({ text: 'NEURO: Watch work complication target', source: 'manual', domain: 'personal' }).id;
  T.other = store.createTask({ text: 'Renew the car insurance', source: 'manual', domain: 'personal' }).id;
  T.captur = store.createTask({ text: 'Fill in the Captur basics in NEURO: registration, current mileage, MOT, tax and insurance', source: 'build-followup', domain: 'personal' }).id;
  // The machine reporter posts the snapshot (ingest is a machine write).
  const r = await call('POST', '/api/projects/github/snapshot', snapshot(), MACHINE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
});
test.after(() => { server && server.close(); });

// ── classification ───────────────────────────────────────────────────────────

test('1. NOVA is work — the vault project and the repo, by the hard rule', () => {
  const p = proj('p:nova');
  assert.equal(p.sphere.sphere, 'work');
  assert.equal(p.sphere.basis, 'hard-rule');
  const repo = pj.read({ now: NOW }).repos.find((r) => r.repoId === R.nova.id);
  assert.equal(repo.sphere.sphere, 'work');
  assert.equal(p.repos.find((l) => l.repoId === R.nova.id).state, 'confirmed', 'NOVA repo ↔ NOVA project is a known link');
});

test('2. NOVA never appears in Personal Projects, and cannot be reclassified personal', async () => {
  const r = await call('GET', '/api/projects/personal');
  assert.equal(r.status, 200);
  assert.ok(!r.json.projects.some((p) => /nova/i.test(p.name) || p.projectId === 'p:nova'));
  assert.ok(!JSON.stringify(r.json.projects).includes('Wardy-uk/NOVA'), 'not even as a linked repo');
  const c = await call('POST', `/api/projects/${enc('p:nova')}/classify`, { sphere: 'personal' });
  assert.equal(c.status, 409);
  const rr = await call('POST', `/api/projects/repos/${R.nova.id}/classify`, { sphere: 'personal' });
  assert.equal(rr.status, 409);
});

test('1b. the NOVA repo is work on its own, with no project to inherit from', () => {
  assert.equal(M.repoSphere({ id: R.nova.id, fullName: 'Wardy-uk/NOVA', owner: 'Wardy-uk' }).sphere, 'work');
  assert.equal(M.repoSphere({ id: 1, fullName: 'wardy-uk/nova', owner: 'Wardy-uk' }).sphere, 'work', 'by name too, so a re-created repo cannot slip it');
});

test('2b. an unclassified project never appears in Personal Projects', async () => {
  const v = await call('GET', '/api/projects/personal');
  assert.ok(!v.json.projects.some((p) => p.projectId === 'p:quiet-thing'));
  assert.ok(v.json.needsClassifying.some((p) => p.projectId === 'p:quiet-thing'), 'it is listed for Nick to classify instead');
  assert.ok(v.json.projects.every((p) => p.sphere.sphere === 'personal'));
  const m = pj.read({ now: NOW });
  assert.ok(!m.personal.includes('p:quiet-thing'), 'the read model\'s own personal list, not only the view\'s filter');
});

test('3. an unknown repo stays unknown', () => {
  const tally = pj.read({ now: NOW }).repos.find((r) => r.repoId === R.tally.id);
  assert.equal(tally.sphere.sphere, 'unknown');
  assert.equal(tally.linked, false);
});

test('4. a repo is not personal merely because it is not NOVA', () => {
  const m = pj.read({ now: NOW });
  for (const r of m.repos.filter((x) => x.repoId !== R.nova.id && !x.linked)) assert.equal(r.sphere.sphere, 'unknown', r.fullName);
  assert.equal(M.repoSphere({ id: 1, fullName: 'Wardy-uk/x', owner: 'Wardy-uk' }).sphere, 'unknown');
});

test('5. explicit personal classification wins', async () => {
  assert.equal(proj('p:outdoor-weather').sphere.sphere, 'unknown', 'precondition: nothing stated');
  const r = await call('POST', `/api/projects/${enc('p:outdoor-weather')}/classify`, { sphere: 'personal' });
  assert.equal(r.status, 200);
  assert.equal(proj('p:outdoor-weather').sphere.basis, 'vault', 'written into the hub note — the vault is the source of truth');
  assert.match(fs.readFileSync(path.join(VAULT, 'Projects/Outdoor Weather/Outdoor Weather.md'), 'utf8'), /^sphere: "personal"$/m);
  assert.equal(db.get("SELECT sphere FROM project_statements WHERE subject = 'project:p:outdoor-weather'").sphere, null, 'NEURO keeps no copy');
  const v = await call('GET', '/api/projects/personal');
  assert.ok(v.json.projects.some((p) => p.projectId === 'p:outdoor-weather'));
});

test('5b. a project with no hub note keeps the statement in NEURO (nowhere else to write it)', async () => {
  assert.equal(proj('p:side-spec').hubPath, null, 'precondition: no hub');
  const r = await call('POST', `/api/projects/${enc('p:side-spec')}/status`, { status: 'parked' });
  assert.equal(r.status, 200);
  const p = proj('p:side-spec');
  assert.equal(p.status.status, 'parked');
  assert.equal(p.status.basis, 'you');
  await call('POST', `/api/projects/${enc('p:side-spec')}/status`, { status: null });
});

test('6. explicit work classification wins over a side-project tag', async () => {
  assert.equal(proj('p:hill-bagging-app').sphere.sphere, 'personal', 'precondition: tagged side-project');
  await call('POST', `/api/projects/${enc('p:hill-bagging-app')}/classify`, { sphere: 'work' });
  assert.equal(proj('p:hill-bagging-app').sphere.sphere, 'work');
  const v = await call('GET', '/api/projects/personal');
  assert.ok(!v.json.projects.some((p) => p.projectId === 'p:hill-bagging-app'));
  await call('POST', `/api/projects/${enc('p:hill-bagging-app')}/classify`, { sphere: 'unknown' });
  assert.equal(proj('p:hill-bagging-app').sphere.sphere, 'personal', 'clearing returns to the vault evidence');
});

test('7. conflicting evidence stays reviewable', () => {
  const p = { projectId: 'p:x', name: 'X', hub: { sphereEvidence: [{ sphere: 'personal', basis: 'vault', why: 'tagged side-project' }] } };
  const statements = new Map([['repo:7', { sphere: 'work' }]]);
  const s = M.deriveSphere(p, { confirmedRepos: [{ id: 7, fullName: 'a/b' }], statements });
  assert.equal(s.sphere, 'unknown');
  assert.equal(s.basis, 'conflict');
  assert.equal(s.conflicts.length, 2);
  const nick = M.deriveSphere(p, { statement: { sphere: 'personal' }, confirmedRepos: [{ id: 7, fullName: 'a/b' }], statements });
  assert.equal(nick.sphere, 'personal', 'Nick resolves the conflict');
});

// ── identity ─────────────────────────────────────────────────────────────────

test('8. one project can link several repos', () => {
  const p = proj('p:neuro');
  const confirmed = p.repos.filter((l) => l.state === 'confirmed').map((l) => l.repoId).sort();
  assert.deepEqual(confirmed, [R.nuero.id, R.ios.id].sort());
});

test('9. a repo and a vault note converge on ONE project', () => {
  const m = pj.read({ now: NOW });
  const ids = m.projects.map((p) => p.projectId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(m.projects.filter((p) => /walking/i.test(p.name)).length, 1);
  assert.ok(!ids.some((id) => id.startsWith('p:repo-')), 'a repo never becomes a project on its own');
  assert.ok(!ids.includes('p:old-idea'), 'Archive is retired');
});

test('10. similar names do not auto-link; an exact compacted name is only likely', () => {
  const m = pj.read({ now: NOW });
  const hb = m.repos.find((r) => r.repoId === R.hb.id);
  assert.equal(hb.links.length, 0, 'hillbagger ≠ Hill Bagging App');
  const omh = proj('p:hill-bagging-app').repos.find((l) => l.repoId === R.omh.id);
  assert.equal(omh.state, 'likely', 'One More Hill ↔ onemorehill needs confirmation');
  const lp = proj('p:hill-bagging-app').lastProgress;
  assert.ok(!(lp && lp.repo === R.omh.fullName), 'a likely repo drives nothing — its release is not this project\'s progress');
  assert.equal(proj('p:hill-bagging-app').status.status, 'unknown', 'and cannot make it active');
});

test('11. an explicit link works — URL in the hub, and a local path that a checkout maps to the repo', () => {
  const wwe = proj('p:walking-with-ember').repos.find((l) => l.repoId === R.wwe.id);
  assert.equal(wwe.state, 'confirmed');
  assert.equal(wwe.basis, 'vault-path');
  assert.equal(proj('p:neuro').repos.find((l) => l.repoId === R.nuero.id).basis, 'vault-url');
});

// ── status ───────────────────────────────────────────────────────────────────

test('12/13. inactivity never implies parked or abandoned', () => {
  const q = proj('p:quiet-thing');
  assert.equal(q.status.status, 'unknown');
  assert.equal(q.focus.focus, 'no-next-action');
  const old = M.deriveStatus({ hub: { explicitStatus: null, rawStatus: null }, lastProgressAt: daysAgo(400), sphere: 'personal', now: NOW });
  assert.equal(old.status, 'unknown');
  assert.ok(!['parked', 'abandoned', 'paused'].includes(old.status));
});

test('14. explicit parked is respected — no next action is offered', () => {
  const p = proj('p:jira-unify');
  assert.equal(p.status.status, 'parked');
  assert.equal(p.nextAction, null);
  assert.equal(p.focus.focus, 'parked');
});

test('15. Park / Resume write the hub note, and are respected', async () => {
  const hub = path.join(VAULT, 'Projects/Outdoor Weather/Outdoor Weather.md');
  await call('POST', `/api/projects/${enc('p:outdoor-weather')}/status`, { status: 'parked' });
  assert.equal(proj('p:outdoor-weather').status.status, 'parked');
  assert.equal(proj('p:outdoor-weather').focus.focus, 'parked');
  assert.match(fs.readFileSync(hub, 'utf8'), /^status: "parked"$/m);
  assert.match(fs.readFileSync(hub, 'utf8'), /^tags: \[saim, esp32\]$/m, 'nothing else in the frontmatter moved');
  await call('POST', `/api/projects/${enc('p:outdoor-weather')}/status`, { status: 'active' });
  assert.equal(proj('p:outdoor-weather').status.status, 'active');
  assert.match(fs.readFileSync(hub, 'utf8'), /^status: "active"$/m);
});

test('16/17. an explicit blocker yields blocked; resolving it clears blocked', async () => {
  assert.equal(proj('p:walking-with-ember').status.status, 'active');
  const r = await call('POST', `/api/projects/${enc('p:walking-with-ember')}/blockers`, { what: 'Waiting on the hero photograph', unblock: 'a real photo exists', owner: 'other' });
  assert.equal(r.status, 200);
  const p = proj('p:walking-with-ember');
  assert.equal(p.status.status, 'blocked');
  assert.equal(p.focus.focus, 'waiting');
  const res = await call('POST', `/api/projects/${enc('p:walking-with-ember')}/blockers/${enc(r.json.blockerId)}/resolve`, { resolution: 'photo taken' });
  assert.equal(res.status, 200);
  assert.equal(proj('p:walking-with-ember').status.status, 'active');
});

test('18. completed needs evidence — an archived repo is not completion; a stated completion is', () => {
  assert.equal(proj('p:discovery').status.status, 'completed');
  assert.equal(proj('p:discovery').status.basis, 'vault');
  const s = M.deriveStatus({ hub: null, lastProgressAt: null, sphere: 'personal', now: NOW });
  assert.notEqual(s.status, 'completed');
  assert.equal(M.mapStatus('spec'), null, 'an unrecognised word is not a status');
});

// ── progress ─────────────────────────────────────────────────────────────────

const ev = (sha) => db.get('SELECT * FROM project_repo_evidence WHERE ref = ?', [sha]);

test('19. a real commit is activity AND meaningful progress', () => {
  assert.equal(ev('bbbbbbb00001').meaningful, 1);
  assert.equal(proj('p:neuro').lastProgress.kind === 'commit' || proj('p:neuro').lastProgress.kind === 'milestone', true);
});

test('20. a generated-only commit is not meaningful', () => {
  assert.equal(ev('bbbbbbb00002').meaningful, 0);
  assert.equal(M.classifyCommit({ subject: 'update', files: files({ generated: 2 }) }).meaningful, false);
  assert.equal(M.classifyCommit({ subject: 'update', files: files({ lock: 1 }) }).meaningful, false);
  assert.equal(M.classifyCommit({ subject: 'update', files: null }).meaningful, false, 'unseen files → activity only');
  assert.equal(M.classifyCommit({ subject: 'Integrate the portal work', merge: true, files: files({ source: 9 }) }).meaningful, false, 'a merge is activity whatever its subject');
});

test('21. a completed linked task counts as progress', () => {
  store.updateTask(T.ember, { status: 'done' });
  const p = proj('p:walking-with-ember');
  assert.ok(p.recentProgress.some((x) => x.kind === 'task-done'));
});

test('22. a successful deployment counts as a milestone, and is logged once as Activity', () => {
  assert.equal(db.get("SELECT meaningful FROM project_repo_evidence WHERE kind = 'deployment' AND ref = '501'").meaningful, 1);
  const rows = db.all("SELECT * FROM personal_ops_events WHERE kind = 'project-milestone'");
  assert.equal(rows.length, 0, 'the first refresh is a silent baseline');
  const s = snapshot();
  s.repos.find((r) => r.id === R.wwe.id).deployments.push({ id: 502, at: daysAgo(0.1), environment: 'production', state: 'success' });
  return call('POST', '/api/projects/github/snapshot', s, MACHINE).then(() => {
    const after = db.all("SELECT * FROM personal_ops_events WHERE kind = 'project-milestone'");
    assert.equal(after.length, 1);
    assert.match(after[0].detail_json, /deployment/);
    pj.refresh({ now: NOW });
    assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'project-milestone'").length, 1, 'not logged again');
  });
});

test('23. a README typo is not a milestone', () => {
  assert.equal(ev('bbbbbbb00003').meaningful, 0);
  assert.ok(!proj('p:neuro').recentProgress.some((x) => x.ref === 'bbbbbbb00003'));
});

test('24. last activity and last meaningful progress are different facts', () => {
  const p = proj('p:neuro');
  assert.ok(p.lastActivity.at > p.lastProgress.at, `${p.lastActivity.at} vs ${p.lastProgress.at}`);
  assert.notEqual(p.lastActivity.what, p.lastProgress.what);
});

// ── tasks ────────────────────────────────────────────────────────────────────

test('25. linking never changes a task\'s domain — a personal-project task stays personal', async () => {
  const r = await call('POST', `/api/projects/${enc('p:outdoor-weather')}/tasks`, { taskId: T.other, state: 'linked' });
  assert.equal(r.status, 200);
  assert.equal(db.getTaskRow(T.other).domain, 'personal');
  await call('POST', `/api/projects/${enc('p:outdoor-weather')}/tasks`, { taskId: T.other, state: null });
});

test('26. a work task linked to NOVA remains work and stays out of Personal', async () => {
  assert.ok(!proj('p:nova').tasks.open.some((t) => t.id === T.nova), 'a single word is never a name link');
  const r = await call('POST', `/api/projects/${enc('p:nova')}/tasks`, { taskId: T.nova, state: 'linked' });
  assert.equal(r.status, 200);
  const p = proj('p:nova');
  assert.ok(p.tasks.open.some((t) => t.id === T.nova && t.basis === 'you'));
  assert.equal(db.getTaskRow(T.nova).domain, 'work');
  const v = await call('GET', '/api/projects/personal');
  assert.ok(!JSON.stringify(v.json).includes('NOVA portal queue view'));
});

test('26b. live regressions: "in NEURO" is a place, a nested spec is not a hub, a mention of NOVA is not a link', async () => {
  const neuro = proj('p:neuro');
  assert.ok(!neuro.tasks.open.some((t) => t.id === T.captur), 'the Captur follow-up is not a NEURO-project task');
  assert.equal(neuro.hubPath, 'Projects/NEURO/NEURO.md');
  assert.notEqual(neuro.rawStatus, 'todo');
  const side = proj('p:side-spec');
  assert.equal(side.hubPath, null, 'a folder whose only type:project note is nested has no hub');
  assert.equal(side.rawStatus, null);
  assert.ok(!proj('p:discovery').repos.some((l) => l.repoId === R.nova.id), 'Discovery mentions the NOVA repo; that is not a link');
  const v = await call('GET', '/api/projects/personal');
  assert.doesNotMatch(JSON.stringify(v.json), /Wardy-uk\/NOVA/);
  assert.equal(M.nameMatcher('NEURO'), null);
  assert.ok(M.nameMatcher('Walking with Ember').test('Walking with Ember cookie banner'), 'positive control: a multi-word name still matches');
});

test('27. no duplicate task store — links hold ids only, the tasks table is the only task text', () => {
  const before = db.get('SELECT COUNT(*) AS n FROM tasks').n;
  pj.read({ now: NOW });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, before);
  for (const t of pj.TABLES) {
    const cols = db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    assert.ok(!cols.includes('text') && !cols.includes('due_date'), `${t} must not hold task fields`);
  }
});

test('28. next action uses an existing actionable task when the hub states none', () => {
  const p = proj('p:walking-with-ember');
  // ember task done (21); add an open one linked by source path
  const id = store.createTask({ text: 'Skip-to-content link and accessibility pass', source: 'manual', domain: 'personal', origin_path: 'Projects/Walking with Ember/Walking with Ember.md' }).id;
  const q = proj('p:walking-with-ember');
  assert.equal(q.nextAction.taskId, id);
  assert.equal(q.nextAction.basis, 'source-path');
  void p;
});

test('29. no invented next action — repo activity alone yields none, and parked parts are never offered', () => {
  const n = M.deriveNextAction({ status: 'active', hub: { nextActions: [] }, tasks: [] });
  assert.equal(n, null);
  const neuro = proj('p:neuro');
  assert.equal(neuro.nextAction.text, 'Write the Build 25 brief', 'the Watch-work line in Next is skipped, the next one is offered');
  assert.deepEqual(neuro.parkedComponents, ['Watch work', 'SAiM visual redesign']);
  const parkedProject = M.deriveNextAction({ status: 'parked', hub: { nextActions: ['Do the thing'] }, tasks: [{ id: 1, text: 'open task', status: 'open' }] });
  assert.equal(parkedProject, null, 'a parked project offers nothing, even with a stated next and an open task');
  const fromTasks = M.deriveNextAction({ status: 'active', hub: { nextActions: [] }, parked: ['Watch work'],
    tasks: [{ id: T.watch, text: 'NEURO: Watch work complication target', status: 'in-progress' }, { id: 99, text: 'Write release notes', status: 'open' }] });
  assert.equal(fromTasks.taskId, 99, 'a started task about a parked part is still not the next action');
});

// ── Radar ────────────────────────────────────────────────────────────────────

test('30/32. an undated or merely quiet project never enters the Radar', () => {
  const r = pj.radar({ today: TODAY, last: plus(30), now: NOW });
  assert.ok(!r.items.some((i) => /quiet|inactive|no commit|hasn.t changed/i.test(`${i.title} ${i.whyVisible.join(' ')}`)));
  assert.ok(!r.items.some((i) => i.projectId === 'p:quiet-thing'));
});

test('31. a dated linked task and a stated deadline can enter the Radar', () => {
  const r = pj.radar({ today: TODAY, last: plus(14), now: NOW });
  const trig = r.items.find((i) => i.id === `task:neuro:${T.trig}`);
  assert.ok(trig, 'the Hill Bagging trig task (source path, due in 3 days)');
  assert.equal(trig.actionState, 'preparation_open');
  write('Projects/Outdoor Weather/Outdoor Weather.md', fs.readFileSync(path.join(VAULT, 'Projects/Outdoor Weather/Outdoor Weather.md'), 'utf8').replace('tags: [saim, esp32]', `tags: [saim, esp32]\ndeadline: ${plus(1)}`));
  pj._resetCache();
  const r2 = pj.radar({ today: TODAY, last: plus(14), now: NOW });
  const dl = r2.items.find((i) => i.id === 'project:p:outdoor-weather:deadline');
  assert.ok(dl);
  assert.equal(dl.actionState, 'needs_you', 'due tomorrow — the existing needs-now rule');
  const fr = require('./future-radar');
  const composed = fr.composeRadar({ today: TODAY, horizonDays: 14, obligations: [], projects: r2.items });
  assert.ok(composed.items.some((i) => i.kind === 'project'));
});

test('31b. a task linked only by NAME, or a parked project\'s deadline, never enters the Radar', async () => {
  const named = store.createTask({ text: 'Hill Bagging App store listing screenshots', source: 'manual', domain: 'personal', due_date: plus(2) }).id;
  assert.ok(proj('p:hill-bagging-app').tasks.open.some((t) => t.id === named && t.basis === 'name'), 'precondition: linked by name');
  assert.ok(!pj.radar({ today: TODAY, last: plus(14), now: NOW }).items.some((i) => i.id === `task:neuro:${named}`));
  const f = 'Projects/Jira Unify/Jira Unify.md';
  const was = fs.readFileSync(path.join(VAULT, f), 'utf8');
  write(f, was.replace('owner: Nick Ward', `owner: Nick Ward\ndeadline: ${plus(2)}`));
  await call('POST', `/api/projects/${enc('p:jira-unify')}/classify`, { sphere: 'personal' });
  pj._resetCache();
  assert.equal(proj('p:jira-unify').deadline, plus(2), 'precondition: the deadline is read');
  assert.ok(!pj.radar({ today: TODAY, last: plus(14), now: NOW }).items.some((i) => i.projectId === 'p:jira-unify'), 'parked stays off the Radar');
  write(f, was);
  await call('POST', `/api/projects/${enc('p:jira-unify')}/classify`, { sphere: 'unknown' });
  pj._resetCache();
});

test('33. a blocker requiring Nick is not a new nag — attention never reads projects', () => {
  for (const f of ['decision-engine.js', 'attention.js', 'ambient-push.js', 'notification-policy.js']) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /require\(['"]\.\/projects['"]\)/, f);
  }
  const r = pj.radar({ today: TODAY, last: plus(30), now: NOW });
  assert.ok(!r.items.some((i) => /blocked/i.test(i.title)), 'an undated blocker is not a Radar item');
});

// ── privacy ──────────────────────────────────────────────────────────────────

test('34/35. no code, paths or secrets are stored', async () => {
  const leaky = snapshot({ repos: [{ id: 123456, fullName: 'Wardy-uk/leaky', pushedAt: daysAgo(1), content: 'function secret(){}',
    commits: [{ sha: '1234567aaaaa', at: daysAgo(1), subject: 'oops ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 committed', files: { source: 1, patch: 'diff --git a/x' },
      patch: 'diff --git a/src/secret.js', filenames: ['src/secret.js'] }] }] });
  const r = await call('POST', '/api/projects/github/snapshot', leaky, MACHINE);
  assert.equal(r.status, 200);
  assert.equal(r.json.redacted, 1);
  const dump = JSON.stringify([db.all('SELECT * FROM project_repos'), db.all('SELECT * FROM project_repo_evidence'), db.getState(pj.META_KEY)]);
  assert.doesNotMatch(dump, /ghp_ABCDEF/);
  assert.doesNotMatch(dump, /diff --git|function secret|src\/secret\.js/);
});

test('36. GitHub activity is bounded metadata', async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ sha: (`9${String(i).padStart(11, '0')}`), at: daysAgo(i / 10), subject: `c${i}`, files: files({ source: 1 }) }));
  const r = await call('POST', '/api/projects/github/snapshot', snapshot({ repos: [{ id: 777, fullName: 'Wardy-uk/busy', pushedAt: daysAgo(0), commits: many }] }), MACHINE);
  assert.equal(r.status, 200);
  assert.ok(db.get('SELECT COUNT(*) AS n FROM project_repo_evidence WHERE repo_id = 777').n <= 60);
  const tooMany = await call('POST', '/api/projects/github/snapshot', { ...snapshot(), repos: Array.from({ length: 401 }, (_, i) => ({ id: i + 1, fullName: `a/r${i}` })) }, MACHINE);
  assert.equal(tooMany.status, 400);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'github-snapshot.js'), 'utf8');
  assert.match(src, /method: 'GET'/);
  assert.doesNotMatch(src, /method:\s*'(PUT|PATCH|DELETE)'/);
  assert.equal((src.match(/method: 'POST'/g) || []).length, 1, 'the only POST is to NEURO');
  assert.match(src, /\/api\/projects\/github\/snapshot/);
});

// ── user-action ledger ───────────────────────────────────────────────────────

test('37/40. Nick\'s follow-ups become real tasks, personal by default', () => {
  const r = fu.reconcile(fu.BUILD_24, { apply: true, now: NOW });
  assert.ok(r.results.every((x) => x.outcome === 'created'), JSON.stringify(r.results));
  for (const x of r.results) assert.equal(db.getTaskRow(x.taskId).domain, 'personal');
  assert.equal(fu.verify(fu.BUILD_24).ok, true);
});

test('38. an existing task is reused, not duplicated', () => {
  const id = store.createTask({ text: 'Tag the release for One More Hill on TestFlight', source: 'manual', domain: 'personal' }).id;
  const list = [{ key: 'tag-omh-release', build: 'Build 24', title: 'Tag the release for One More Hill on TestFlight', projectId: 'p:hill-bagging-app' }];
  const before = db.get('SELECT COUNT(*) AS n FROM tasks').n;
  const r = fu.reconcile(list, { apply: true, now: NOW });
  assert.equal(r.results[0].outcome, 'reused');
  assert.equal(r.results[0].taskId, id);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, before);
});

test('39. a follow-up that names its project is linked to it explicitly', () => {
  const p = proj('p:hill-bagging-app');
  assert.ok(p.tasks.open.some((t) => /Tag the release/.test(t.text) && t.basis === 'you'));
});

// ── authority, routing, rendering ────────────────────────────────────────────

test('machines are refused every statement and allowed the snapshot', async () => {
  for (const [m, p, b] of [
    ['POST', `/api/projects/${enc('p:quiet-thing')}/classify`, { sphere: 'personal' }],
    ['POST', `/api/projects/${enc('p:quiet-thing')}/status`, { status: 'parked' }],
    ['POST', `/api/projects/${enc('p:quiet-thing')}/repos`, { repoId: R.tally.id }],
    ['POST', `/api/projects/${enc('p:quiet-thing')}/tasks`, { taskId: T.other }],
    ['POST', `/api/projects/${enc('p:quiet-thing')}/blockers`, { what: 'x y z' }],
    ['POST', `/api/projects/repos/${R.tally.id}/classify`, { sphere: 'work' }],
    ['POST', '/api/projects/owners/Nurtur-LABS/classify', { sphere: 'work' }],
    ['POST', '/api/projects/declare', { repoId: R.tally.id }],
  ]) {
    const r = await call(m, p, b, MACHINE);
    assert.equal(r.status, 403, `${p} → ${r.status}`);
  }
  assert.equal(proj('p:quiet-thing').sphere.sphere, 'unknown', 'nothing changed');
});

test('literal routes are not swallowed by /:projectId', async () => {
  const r = await call('GET', '/api/projects/repos');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.repos));
  const d = await call('GET', `/api/projects/${enc('p:neuro')}`);
  assert.equal(d.json.project.name, 'NEURO');
});

test('Nick can make a project from a repo, and it is never created without him', async () => {
  const r = await call('POST', '/api/projects/declare', { repoId: R.tally.id, name: 'Tally' });
  assert.equal(r.status, 200);
  const p = proj(`p:repo-${R.tally.id}`);
  assert.equal(p.repos[0].state, 'confirmed');
  assert.equal(p.sphere.sphere, 'unknown', 'still unclassified until he says');
});

test('the card renders the personal view for real, with no NOVA', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const ROOT = path.join(__dirname, '..', '..');
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'canonical', 'ProjectsCard.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  assert.equal(typeof m.exports.ProjectsView, 'function', 'positive control');
  const html = renderToString(React.createElement(m.exports.ProjectsView, { data: pj.personalView({ now: NOW }), busy: false, act: async () => {} })).replace(/<!-- -->/g, '');
  assert.match(html, /Personal projects/);
  assert.match(html, /Hill Bagging App/);
  assert.match(html, /Real progress|No real progress NEURO can see/);
  assert.match(html, /cn-seg/, 'classify buttons are one segmented control per row');
  assert.match(html, /Whose are these\?/);
  assert.doesNotMatch(html, /cn-rowtitle">NOVA|Wardy-uk\/NOVA|NOVA portal queue/);
  assert.match(html, /NOVA is work by rule/, 'positive control: the word appears only in the rule text');
});
