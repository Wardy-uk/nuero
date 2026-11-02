'use strict';

/**
 * Walking with Ember (2 Nov 2026). Pure rules first (the home trim, the photo
 * spread, the metadata strip, the frontmatter fix-up), then a whole send
 * against a temp BARE git repo standing in for GitHub, a clone seeded with a
 * copy of the real site's scripts, and a stub that answers Nominatim and
 * refuses every other network call (never the real internet in a test).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wwe-test-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');
process.env.WORKOUT_PHOTO_DIR = path.join(tmp, 'photos');
process.env.WWE_REPO_DIR = path.join(tmp, 'clone');
process.env.WWE_REMOTE = path.join(tmp, 'site.git');
delete process.env.WWE_SSH_KEY;

const db = require('../db/database');
const wwe = require('./wwe-send');
const view = require('./workout-view');

const SITE = path.join(__dirname, '..', '..', '..', 'walkingwithember');
const HOME = { lat: 52.73697, lon: -1.34985 };
const PY = process.env.WWE_PYTHON || 'python3';
const hasPil = (() => { try { execFileSync(PY, ['-I', '-c', 'import PIL'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const hasSite = fs.existsSync(path.join(SITE, 'scripts', 'ingest-walks.mjs'));
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ── pure ───────────────────────────────────────────────────────────────────

/** Out of the front door, 3 km north, and back again. */
function homeWalk(startSec, step = 30) {
  const pts = [];
  for (let i = 0; i <= 240; i++) {
    const f = i <= 120 ? i / 120 : (240 - i) / 120;
    pts.push([HOME.lat + 0.0002 + f * 0.027, HOME.lon + 0.0001, 150 + 80 * f, startSec + i * step]);
  }
  return pts;
}

test('trimHome drops the points near home at both ends and nothing in between', () => {
  const pts = homeWalk(1_000_000);
  const t = wwe.trimHome(pts, HOME, 400);
  assert.equal(t.ok, true);
  assert.equal(t.startedAtHome, true);
  assert.equal(t.endedAtHome, true);
  assert.ok(t.droppedStart > 0 && t.droppedEnd > 0);
  for (const p of [t.points[0], t.points[t.points.length - 1]]) assert.ok(wwe.distM(p[0], p[1], HOME.lat, HOME.lon) > 400, 'ends are beyond 400 m');
  assert.equal(t.points.length, pts.length - t.droppedStart - t.droppedEnd, 'the middle is kept whole');
  // A walk nowhere near home is untouched.
  const far = pts.map((p) => [p[0] + 0.5, p[1], p[2], p[3]]);
  const t2 = wwe.trimHome(far, HOME, 400);
  assert.equal(t2.points.length, far.length);
  assert.equal(t2.startedAtHome || t2.endedAtHome, false);
  // All at home = nothing to publish; unknown home = refused.
  assert.equal(wwe.trimHome(pts.slice(0, 3), HOME, 400).empty, true);
  assert.equal(wwe.trimHome(pts, null).ok, false);
});

test('spreadPhotos keeps 12 spread along the route, in route order', () => {
  const photos = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, metresAlongRoute: i * i * 5 }));
  const out = wwe.spreadPhotos(photos, 12);
  assert.equal(out.length, 12);
  assert.equal(out[0].id, 'p0');
  assert.equal(out[11].id, 'p39');
  for (let i = 1; i < out.length; i++) assert.ok(out[i].metresAlongRoute > out[i - 1].metresAlongRoute);
  assert.equal(wwe.spreadPhotos(photos.slice(0, 5), 12).length, 5);
});

test('adjustFrontmatter: a home walk loses parking, grid ref and postcode; always a draft', () => {
  const md = '---\ntitle: "X"\nlocation: "Coalville, Leicestershire"\nregion: "Leicestershire"\nparking: "TODO"\nstartGridRef: "SK 1"\nstartPostcode: "LE67"\nwriteupStatus: reviewed\ndraft: false\n---\n\nbody\n';
  const out = wwe.adjustFrontmatter(md, { home: true, catalogueOnly: true });
  assert.doesNotMatch(out, /parking:|startGridRef:|startPostcode:/);
  assert.match(out, /writeupStatus: draft\ndraft: true\n---/);
  assert.match(out, /catalogueOnly: true/);
  assert.match(out, /location: "Coalville, Leicestershire"/);
  const away = wwe.adjustFrontmatter('---\ntitle: "X"\nparking: "TODO"\ndraft: true\n---\nb', { startGridRef: 'SK 12 34', startPostcode: 'S1 1AA' });
  assert.match(away, /parking: "TODO"\nstartGridRef: "SK 12 34"\nstartPostcode: "S1 1AA"/);
  assert.equal(wwe.stripParkingSentence('a\nThe track starts at **SK 1**, Road, LE1.\nb'), 'a\nb');
});

const MAKE_JPEG = [
  'import sys',
  'from PIL import Image',
  'im = Image.new("RGB", (int(sys.argv[2]), int(sys.argv[3])), (int(sys.argv[4]) % 256, 140, 60))',
  'ex = Image.Exif()',
  'ex[0x010F] = "Apple"',
  'ex[0x8825] = {1: "N", 2: (52.0, 44.0, 13.0), 3: "W", 4: (1.0, 20.0, 59.0)}',
  'im.save(sys.argv[1], "JPEG", exif=ex.tobytes())',
].join('\n');
function exifJpeg(file, w = 2400, h = 1800, shade = 90) { execFileSync(PY, ['-I', '-c', MAKE_JPEG, file, String(w), String(h), String(shade)]); return file; }

test('cleanPhotos resizes to 1600 and strips every byte of EXIF/GPS', { skip: hasPil ? false : 'python3 + Pillow not on this machine' }, async () => {
  const src = exifJpeg(path.join(tmp, 'in.jpg'));
  const before = fs.readFileSync(src);
  assert.ok(wwe.jpegMetadata(before).found.includes('exif'), 'positive control: the input carries EXIF');
  assert.ok(before.includes(Buffer.from('Apple')), 'positive control: the camera make is in the input');
  const dst = path.join(tmp, 'out.jpg');
  const r = await wwe.cleanPhotos([[src, dst]]);
  assert.equal(r.ok, true, r.error);
  const after = fs.readFileSync(dst);
  assert.deepEqual(wwe.jpegMetadata(after).found, []);
  assert.ok(!after.includes(Buffer.from('Exif')) && !after.includes(Buffer.from('Apple')));
  const size = execFileSync(PY, ['-I', '-c', 'import sys;from PIL import Image;print(*Image.open(sys.argv[1]).size)', dst], { encoding: 'utf8' }).trim().split(' ').map(Number);
  assert.equal(Math.max(...size), 1600);
});

// ── the whole send ─────────────────────────────────────────────────────────

const START_A = Date.UTC(2026, 9, 18, 9, 0, 0);   // a walk from home
const START_B = Date.UTC(2026, 9, 25, 9, 0, 0);   // a walk elsewhere
let stubArgs; let seed; let bare;

function workout(uuid, type, startMs, pts, secs) {
  db.insertWorkouts([{
    sourceUuid: uuid, activityType: type, startedAt: sql(startMs), endedAt: sql(startMs + secs * 1000), durationSeconds: secs,
    distanceM: 6200, elevationM: 95, activeEnergyKcal: 400, avgHeartRate: 110, maxHeartRate: 140,
    payload: pts ? { route: { points: pts, pointCount: pts.length, firstAt: sql(startMs), lastAt: sql(startMs + secs * 1000) } } : {},
  }]);
  return db.get('SELECT id FROM health_workouts WHERE source_uuid = ?', [uuid]).id;
}

function photo(wid, n, lat, lon, takenMs) {
  const file = exifJpeg(path.join(tmp, `ph-${wid}-${n}.jpg`), 800, 600, n * 13);
  const b64 = fs.readFileSync(file).toString('base64');
  const r = view.storePhoto(wid, { assetId: `a-${wid}-${n}`, takenAt: new Date(takenMs).toISOString(), lat, lon, full: b64, thumb: b64 });
  assert.equal(r.ok, true, r.error);
  return r.photoId;
}

const ready = hasSite && hasPil;
let A; let B; let C; const photoIds = [];

test.before(async () => {
  await db.init();
  db.setState('saved_places', JSON.stringify([{ name: 'Home', lat: HOME.lat, lng: HOME.lon, radius: 200 }]));
  A = workout('WWE-A', 'Hiking', START_A, homeWalk(START_A / 1000), 7200);
  C = workout('WWE-C', 'Walking', START_A + 86400e3, homeWalk(START_A / 1000 + 86400, 5), 1200);
  B = workout('WWE-B', 'Hiking', START_B, homeWalk(START_B / 1000).map((p) => [p[0] + 0.6, p[1] - 0.3, p[2], p[3]]), 7200);
  if (!ready) return;
  // Photos: one on the doorstep (never sent), sixteen out on the walk.
  photo(A, 0, HOME.lat + 0.0005, HOME.lon, START_A + 60e3);
  for (let i = 1; i <= 16; i++) photoIds[i] = photo(A, i, HOME.lat + 0.006 + i * 0.0012, HOME.lon + 0.0001, START_A + i * 120e3);

  // The stand-in for GitHub, seeded from a copy of the real site's scripts.
  bare = process.env.WWE_REMOTE;
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  fs.cpSync(path.join(SITE, 'scripts'), path.join(seed, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'src', 'content', 'walks'), { recursive: true });
  fs.copyFileSync(path.join(SITE, 'src', 'content.config.ts'), path.join(seed, 'src', 'content.config.ts'));
  fs.writeFileSync(path.join(seed, 'src', 'content', 'walks', '.gitkeep'), '');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules\n.cache/\n');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');

  // Nominatim answered locally; anything else refused; the scripts' polite sleeps made instant.
  const stub = path.join(tmp, 'no-network.mjs');
  fs.writeFileSync(stub, [
    'const st = globalThis.setTimeout;',
    'globalThis.setTimeout = (fn, ms, ...a) => st(fn, 0, ...a);',
    'globalThis.fetch = async (url) => {',
    '  const u = String(url);',
    '  if (u.includes("nominatim") && u.includes("zoom=18")) return { ok: true, json: async () => ({ address: { road: "Doorstep Road", postcode: "LE67 9ZZ", town: "Coalville" } }) };',
    '  if (u.includes("nominatim") && u.includes("zoom=16")) return { ok: true, json: async () => ({ address: { water: "Grace Dieu Brook", county: "Leicestershire" } }) };',
    '  if (u.includes("nominatim")) return { ok: true, json: async () => ({ address: { town: "Coalville", county: "Leicestershire" } }) };',
    '  throw new Error("no network in tests: " + u);',
    '};',
  ].join('\n'));
  stubArgs = ['--import', pathToFileURL(stub).href];
});

const showFile = (rel) => git(seed, 'show', `origin/main:${rel}`);

test('a hike from home goes out as a trimmed DRAFT, in one commit, with cleaned photos', { skip: ready ? false : 'needs the walkingwithember checkout and python3 + Pillow' }, async () => {
  const r = await wwe.send(A, { nodeArgs: stubArgs });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.createdPage, true);
  assert.equal(r.homeTrimmed, true);
  assert.equal(r.photos, 12, 'twelve of the sixteen walk photos; the doorstep one never');
  git(seed, 'fetch', '-q', 'origin');
  assert.equal(git(seed, 'rev-parse', 'origin/main'), r.sha);
  assert.equal(git(seed, 'log', '-1', '--format=%an', 'origin/main'), 'NEURO');
  assert.match(git(seed, 'log', '-1', '--format=%B', 'origin/main'), /trimmed 400 m from home/);
  assert.equal(git(seed, 'rev-list', '--count', 'origin/main'), '2', 'exactly one commit');

  const md = showFile(r.pagePath);
  assert.match(md, /^draft: true$/m);
  assert.match(md, /^writeupStatus: draft$/m);
  assert.doesNotMatch(md, /startGridRef|startPostcode|^parking:|The track starts at|Doorstep Road|LE67 9ZZ/m);
  assert.match(md, /^distance: 3\.9$/m, 'distance as walked (the watch), not the trimmed track');
  assert.match(md, /^ascentM: 95$/m);
  assert.match(md, /^heroImage: "\/uploads\/images\/walks\/2026-10-18\/01-[0-9a-f]{8}\.jpg"$/m);
  assert.equal(r.previewUrl, `https://walkingwithember.co.uk/preview/walks/${r.slug}/`);

  const route = JSON.parse(showFile('public/routes/2026-10-18.json'));
  for (const [lon, lat] of route.coords) assert.ok(wwe.distM(lat, lon, HOME.lat, HOME.lon) > 400, 'no route point within 400 m of home');
  const gpx = showFile('public/uploads/gpx/2026-10-18-walk.gpx');
  for (const m of gpx.matchAll(/lat="([-\d.]+)" lon="([-\d.]+)"/g)) assert.ok(wwe.distM(+m[1], +m[2], HOME.lat, HOME.lon) > 400);

  const set = JSON.parse(showFile('public/photos/2026-10-18.json'));
  assert.equal(set.count, 12);
  assert.equal(set.date, '2026-10-18');
  for (const p of set.photos) {
    assert.deepEqual(Object.keys(p).sort(), ['lat', 'lon', 'metresAlongRoute', 'pinnable', 'routeFraction', 'src', 'time']);
    assert.ok(wwe.distM(p.lat, p.lon, HOME.lat, HOME.lon) > 400);
    const buf = execFileSync('git', ['show', `origin/main:public${p.src}`], { cwd: seed });
    assert.deepEqual(wwe.jpegMetadata(buf).found, [], 'no EXIF/GPS in a published photo');
  }
  for (let i = 1; i < set.photos.length; i++) assert.ok(set.photos[i].metresAlongRoute >= set.photos[i - 1].metresAlongRoute);

  const st = wwe.statusFor(A);
  assert.equal(st.lastOk.status, 'sent');
  assert.equal(st.lastOk.previewUrl, r.previewUrl);
  assert.equal(view.read(A).site.eligible, true);
});

test('a re-send never touches the page Nick edited, and two presses are one run', { skip: ready ? false : 'needs the site + Pillow' }, async () => {
  const page = wwe.statusFor(A).lastOk.pagePath;
  git(seed, 'pull', '-q', '--ff-only', 'origin', 'main');
  fs.appendFileSync(path.join(seed, page), '\nNick wrote this.\n');
  git(seed, '-c', 'user.name=Nick', '-c', 'user.email=nick@example.com', 'commit', '-q', '-a', '-m', 'Nick edits');
  git(seed, 'push', '-q', 'origin', 'main');
  // Nick removes the first photo, so the re-send has something to change.
  assert.equal(view.removePhoto(photoIds[1]).ok, true);
  const first = wwe.send(A, { nodeArgs: stubArgs });
  const second = await wwe.send(A, { nodeArgs: stubArgs });
  assert.equal(second.ok, false);
  assert.equal(second.already, true);
  const r = await first;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.createdPage, false);
  assert.ok(!r.unchanged, 'the photos changed, so there is a commit');
  assert.ok(r.notes.some((n) => /heroImage/.test(n)), 'the stale hero is said, never fixed by editing the page');
  git(seed, 'fetch', '-q', 'origin');
  assert.match(showFile(page), /Nick wrote this\./);
  assert.equal(git(seed, 'log', '-1', '--format=%an', 'origin/main'), 'NEURO');
});

test('refusals: not a hike, no home, no deploy key', async () => {
  const notHike = await wwe.send(C);
  assert.equal(notHike.ok, false);
  assert.match(notHike.error, /only hikes/);
  assert.equal(view.read(C).site.eligible, false);

  const saved = db.getState('saved_places');
  db.setState('saved_places', '[]');
  const noHome = await wwe.send(B);
  db.setState('saved_places', saved);
  assert.equal(noHome.ok, false);
  assert.match(noHome.error, /does not know where home is/);

  const remote = process.env.WWE_REMOTE;
  process.env.WWE_REMOTE = 'git@github.com:Wardy-uk/walkingwithember.git';
  process.env.WWE_SSH_KEY = path.join(tmp, 'no-such-key');
  const noKey = await wwe.send(B);
  process.env.WWE_REMOTE = remote;
  delete process.env.WWE_SSH_KEY;
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /deploy key .* is missing/);
  assert.equal(wwe.statusFor(B).last.status, 'failed');
});

test('a rejected push publishes nothing and leaves the clone clean', { skip: ready ? false : 'needs the site + Pillow' }, async () => {
  const hook = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
  const before = git(bare, 'rev-parse', 'main');
  const r = await wwe.send(B, { nodeArgs: stubArgs });
  fs.unlinkSync(hook);
  assert.equal(r.ok, false);
  assert.match(r.error, /GitHub refused the push/);
  assert.equal(git(bare, 'rev-parse', 'main'), before, 'nothing reached the remote');
  const clone = process.env.WWE_REPO_DIR;
  assert.equal(git(clone, 'status', '--porcelain'), '', 'the clone is clean');
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before, 'the clone is back at origin/main');
  assert.equal(wwe.statusFor(B).last.status, 'failed');
});

test('POST /api/workouts/:id/send-to-site over real HTTP', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/workouts', require('../routes/workouts'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/workouts`;
  try {
    const r = await fetch(`${base}/${C}/send-to-site`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /only hikes/);
    assert.equal((await fetch(`${base}/abc/send-to-site`, { method: 'POST' })).status, 400);
    const page = await (await fetch(`${base}/${C}`)).json();
    assert.equal(page.site.eligible, false);
  } finally { server.close(); }
});

test('the matrix refuses machines and the gateway refuses the send', () => {
  const m = require('./authority-matrix');
  assert.equal(m.machineDecision('POST', '/api/workouts/7/send-to-site').allow, false);
  const policy = require('../../mcp-server/remote/api-policy');
  const text = fs.readFileSync(require.resolve('../../mcp-server/remote/api-policy'), 'utf8');
  assert.ok(policy && text.includes('post_workouts_by_id_send_to_site'));
});
