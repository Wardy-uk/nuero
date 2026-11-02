'use strict';

/**
 * Send one walk to "Walking with Ember" (2 Nov 2026).
 *
 * Nick's design, unchanged:
 *   • ONE walk per press → ONE commit to the site's `main` (Netlify builds it).
 *   • The page is ALWAYS created `draft: true` + `writeupStatus: draft`; nothing
 *     goes public until Nick publishes it in the site's own editor.
 *   • A re-send updates the GPX, the route, the photos and the weather cache but
 *     NEVER the markdown page once it exists — he writes prose there. Same rule
 *     as the site's scaffold-walks ("existing files are never overwritten").
 *   • It runs the SITE'S OWN portable scripts in NEURO's clone of the site
 *     (ingest-walks, route-waypoints, fetch-weather, scaffold-walks,
 *     draft-writeups). The photo scripts are macOS-only and are never used —
 *     NEURO supplies the photos itself.
 *
 * ⚠⚠ HOME TRIM — the privacy rule the whole feature turns on. Every track point
 * within 400 m of home is dropped from the START and the END of the walk before
 * anything is written. A walk that started or ended at home gets NO start grid
 * ref, NO postcode and NO parking line, and its location is the town. Home
 * unknown = REFUSED: never publish an untrimmed track.
 *
 * ⚠ No token is held anywhere in NEURO. The Pi pushes over SSH with a
 * repo-scoped write DEPLOY KEY (WWE_SSH_KEY, default /home/nickw/.ssh/wwe_deploy),
 * named to git through GIT_SSH_COMMAND per network command — ~/.ssh/config is
 * never touched. A missing key file REFUSES the send.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function _db() { return require('../db/database'); }

const HOME_RADIUS_M = 400;
const MAX_PHOTOS = 12;
const PHOTO_EDGE = 1600;
const SITE_URL = 'https://walkingwithember.co.uk'; // astro.config.mjs `site`
const DEFAULT_REMOTE = 'git@github.com:Wardy-uk/walkingwithember.git';
const FALLBACK_EMAIL = 'neuro@nickward.co.uk';
const AUTHOR = 'NEURO';

// ── configuration ──────────────────────────────────────────────────────────

function repoDir() {
  if (process.env.WWE_REPO_DIR) return process.env.WWE_REPO_DIR;
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `neuro-wwe-test-${process.pid}`);
  if (fs.existsSync('/mnt/data')) return '/mnt/data/walkingwithember';
  return path.join(__dirname, '..', 'data', 'walkingwithember');
}
function remote() { return process.env.WWE_REMOTE || DEFAULT_REMOTE; }

// ── the deploy key ─────────────────────────────────────────────────────────

function sshKey() { return process.env.WWE_SSH_KEY || '/home/nickw/.ssh/wwe_deploy'; }
/** An ssh remote (scp-like `git@host:path` or `ssh://`) — the only kind that needs the key. */
function isSshRemote(url) { return /^ssh:\/\//.test(String(url)) || /^[\w.-]+@[\w.-]+:/.test(String(url)); }
function keyStatus(url = remote()) {
  if (!isSshRemote(url)) return { ok: true, needed: false };
  const k = sshKey();
  return fs.existsSync(k)
    ? { ok: true, needed: true, key: k }
    : { ok: false, needed: true, key: k, error: `the deploy key ${k} is missing on this machine, so NEURO cannot push to Walking with Ember` };
}

// ── PURE: geometry ─────────────────────────────────────────────────────────

const R_EARTH = 6371008.8;
function distM(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r; const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * PURE. Drop every point within `radiusM` of home from the start and the end:
 * keep from the first point beyond the radius to the last one beyond it.
 * Points are NEURO's `[lat, lon, ele, unixSeconds]`.
 */
function trimHome(points, home, radiusM = HOME_RADIUS_M) {
  const pts = Array.isArray(points) ? points : [];
  if (!home || !Number.isFinite(home.lat) || !Number.isFinite(home.lon)) {
    return { ok: false, error: 'home is not known', points: [] };
  }
  const far = (p) => distM(p[0], p[1], home.lat, home.lon) > radiusM;
  const first = pts.findIndex(far);
  if (first < 0) return { ok: true, points: [], empty: true, startedAtHome: pts.length > 0, endedAtHome: pts.length > 0, droppedStart: pts.length, droppedEnd: 0 };
  let last = pts.length - 1;
  while (last > first && !far(pts[last])) last--;
  return {
    ok: true,
    points: pts.slice(first, last + 1),
    empty: false,
    startedAtHome: first > 0,
    endedAtHome: last < pts.length - 1,
    droppedStart: first,
    droppedEnd: pts.length - 1 - last,
  };
}

/** PURE. Cumulative metres along a track. */
function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distM(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]));
  return cum;
}

/** PURE. Where along the track a lat/lon sits: metres + fraction of the nearest point. */
function alongRoute(points, cum, lat, lon) {
  let best = 0; let bd = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = distM(points[i][0], points[i][1], lat, lon);
    if (d < bd) { bd = d; best = i; }
  }
  const total = cum[cum.length - 1] || 0;
  return { metres: Math.round(cum[best]), fraction: total ? Number((cum[best] / total).toFixed(3)) : 0, offRouteM: Math.round(bd) };
}

/**
 * PURE. Choose up to `n` photos spread evenly along the route by their position.
 * `photos` carry `metresAlongRoute`; the result keeps route order.
 */
function spreadPhotos(photos, n = MAX_PHOTOS) {
  const list = [...photos].sort((a, b) => a.metresAlongRoute - b.metresAlongRoute || String(a.takenAt).localeCompare(String(b.takenAt)));
  if (list.length <= n) return list;
  const lo = list[0].metresAlongRoute; const hi = list[list.length - 1].metresAlongRoute;
  const used = new Set();
  for (let k = 0; k < n; k++) {
    const target = n === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * k) / (n - 1);
    let best = -1; let bd = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(list[i].metresAlongRoute - target);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) used.add(best);
  }
  return list.filter((_, i) => used.has(i));
}

/**
 * PURE. The metadata segments a JPEG carries before its image data. APP1 holds
 * EXIF (and with it GPS) and XMP; APP13 holds IPTC. A clean file has neither.
 */
function jpegMetadata(buf) {
  const found = [];
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { jpeg: false, found };
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1) {
      const head = buf.slice(i + 4, i + 4 + 30).toString('latin1');
      found.push(head.startsWith('Exif') ? 'exif' : head.includes('ns.adobe.com/xap') ? 'xmp' : 'app1');
    } else if (marker === 0xed) found.push('iptc');
    else if (marker === 0xfe) found.push('comment');
    i += 2 + len;
  }
  return { jpeg: true, found };
}

/** PURE. GPX text from NEURO points (times kept — the site's scripts need them). */
function toGpx(points, name) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pts = points.map((p) => `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${Number.isFinite(p[2]) ? `<ele>${p[2].toFixed(1)}</ele>` : ''}${Number.isFinite(p[3]) ? `<time>${new Date(p[3] * 1000).toISOString()}</time>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="NEURO" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${esc(name)}</name><trkseg>\n${pts}\n  </trkseg></trk>\n</gpx>\n`;
}

/**
 * PURE. Fix up the frontmatter of a page NEURO has JUST created (never one that
 * already existed). Home walk: no parking, no startGridRef, no startPostcode,
 * the town as location. Otherwise the start grid ref + postcode are added.
 */
function adjustFrontmatter(md, { home = false, town = null, region = null, startGridRef = null, startPostcode = null, catalogueOnly = false } = {}) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return md;
  let lines = m[1].split('\n');
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const drop = (key) => { lines = lines.filter((l) => !l.startsWith(`${key}:`)); };
  const set = (key, value, after) => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (i >= 0) { lines[i] = `${key}: ${value}`; return; }
    const j = after ? lines.findIndex((l) => l.startsWith(`${after}:`)) : -1;
    if (j >= 0) lines.splice(j + 1, 0, `${key}: ${value}`); else lines.push(`${key}: ${value}`);
  };
  if (home) {
    drop('parking'); drop('startGridRef'); drop('startPostcode');
    if (town) set('location', q(region ? `${town}, ${region}` : town));
  } else {
    if (startGridRef) set('startGridRef', q(startGridRef), 'parking');
    if (startPostcode) set('startPostcode', q(startPostcode), 'startGridRef');
  }
  if (catalogueOnly) set('catalogueOnly', 'true', 'region');
  // Always a draft, always an unreviewed write-up — however the scripts behave.
  drop('draft'); drop('writeupStatus');
  lines.push('writeupStatus: draft', 'draft: true');
  return `---\n${lines.join('\n')}\n---\n${md.slice(m[0].length)}`;
}

/** PURE. Remove the "The track starts at …" sentence draft-writeups adds. */
function stripParkingSentence(md) {
  return md.replace(/^The track starts at .*\n/m, '');
}

// ── home ───────────────────────────────────────────────────────────────────

/** Nick's home: the saved place named Home, else Home Assistant's zone.home. */
function home() {
  try {
    const p = require('./place-naming').savedPlaces().find((x) => /^home$/i.test(String(x.name || '').trim()) || x.kind === 'home');
    if (p) {
      const lon = Number.isFinite(p.lon) ? p.lon : p.lng;
      if (Number.isFinite(p.lat) && Number.isFinite(lon)) return { lat: p.lat, lon, source: 'saved place' };
    }
  } catch { /* fall through */ }
  try {
    const states = require('./ha').cachedStates() || [];
    const z = (Array.isArray(states) ? states : []).find((s) => s.entity_id === 'zone.home');
    const a = z && z.attributes;
    if (a && Number.isFinite(a.latitude) && Number.isFinite(a.longitude)) return { lat: a.latitude, lon: a.longitude, source: 'Home Assistant zone.home' };
  } catch { /* unknown */ }
  return null;
}


// ── the record ─────────────────────────────────────────────────────────────

function _ensureTable() {
  _db().run(`CREATE TABLE IF NOT EXISTS wwe_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER NOT NULL,
    walk_date TEXT,
    status TEXT NOT NULL,
    commit_sha TEXT, slug TEXT, page_path TEXT, preview_url TEXT,
    created_page INTEGER DEFAULT 0, home_trimmed INTEGER DEFAULT 0, photos INTEGER DEFAULT 0,
    error TEXT, sent_at TEXT NOT NULL)`);
}
function _record(row) {
  _ensureTable();
  _db().run(`INSERT INTO wwe_sends (workout_id, walk_date, status, commit_sha, slug, page_path, preview_url, created_page, home_trimmed, photos, error, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [row.workoutId, row.date || null, row.status, row.sha || null, row.slug || null, row.pagePath || null, row.previewUrl || null,
    row.createdPage ? 1 : 0, row.homeTrimmed ? 1 : 0, row.photos || 0, row.error ? String(row.error).slice(0, 1000) : null, new Date().toISOString()]);
}
const _shape = (r) => (r ? {
  status: r.status, at: r.sent_at, date: r.walk_date, sha: r.commit_sha, slug: r.slug, pagePath: r.page_path, previewUrl: r.preview_url,
  createdPage: !!r.created_page, homeTrimmed: !!r.home_trimmed, photos: r.photos, error: r.error,
} : null);

/** What the walk page shows: the latest attempt and the latest success. */
function statusFor(workoutId) {
  try {
    // A read creates nothing: no table yet = never sent.
    if (!_db().get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wwe_sends'")) return { last: null, lastOk: null };
    const last =_db().get('SELECT * FROM wwe_sends WHERE workout_id = ? ORDER BY id DESC LIMIT 1', [workoutId]);
    const lastOk = _db().get("SELECT * FROM wwe_sends WHERE workout_id = ? AND status IN ('sent','unchanged') ORDER BY id DESC LIMIT 1", [workoutId]);
    return { last: _shape(last), lastOk: _shape(lastOk) };
  } catch (e) { return { last: null, lastOk: null, why: e.message }; }
}

// ── running things ─────────────────────────────────────────────────────────

function _run(cmd, args, { cwd, env, timeout = 5 * 60 * 1000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env: { ...process.env, ...env }, timeout, maxBuffer: 1 << 26, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : null });
    });
    if (input != null) { child.stdin.end(input); }
  });
}

function _gitEnv() {
  const env = { GIT_TERMINAL_PROMPT: '0' };
  if (isSshRemote(remote())) env.GIT_SSH_COMMAND = `ssh -i ${sshKey()} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  return env;
}

async function _git(dir, args) {
  const r = await _run('git', args, { cwd: dir, env: _gitEnv() });
  if (!r.ok) {
    const e = new Error(`git ${args[0]} failed: ${(r.stderr || r.error || '').trim().split('\n').slice(-3).join(' ')}`);
    e.gitStep = args[0];
    throw e;
  }
  return r.stdout.trim();
}

async function _node(dir, script, args, nodeArgs) {
  const r = await _run(process.execPath, [...nodeArgs, path.join('scripts', script), ...args], { cwd: dir });
  if (!r.ok) throw new Error(`${script} failed: ${(r.stderr || r.error || '').trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}

const CLEAN_PY = [
  'import sys',
  'from PIL import Image, ImageOps',
  'edge = int(sys.argv[1])',
  'args = sys.argv[2:]',
  'for i in range(0, len(args), 2):',
  '    src, dst = args[i], args[i + 1]',
  '    im = Image.open(src)',
  '    im = ImageOps.exif_transpose(im)',
  '    im = im.convert("RGB")',
  '    im.thumbnail((edge, edge), Image.LANCZOS)',
  '    out = Image.frombytes("RGB", im.size, im.tobytes())',
  '    out.save(dst, "JPEG", quality=85, optimize=True)',
].join('\n');

/**
 * Resize to `edge` and drop ALL metadata: the pixels are copied into a brand
 * new image (no info dict at all) and saved without EXIF/ICC/XMP. Then every
 * output is CHECKED in JS — a file still carrying EXIF fails the send.
 */
async function cleanPhotos(pairs, { python = process.env.WWE_PYTHON || 'python3', edge = PHOTO_EDGE } = {}) {
  if (!pairs.length) return { ok: true };
  const args = ['-I', '-c', CLEAN_PY, String(edge)];
  for (const [src, dst] of pairs) args.push(src, dst);
  const r = await _run(python, args, { timeout: 3 * 60 * 1000 });
  if (!r.ok) return { ok: false, error: `photos could not be cleaned (python3 + Pillow): ${(r.stderr || r.error || '').trim().split('\n').slice(-1)[0]}` };
  for (const [, dst] of pairs) {
    let buf;
    try { buf = fs.readFileSync(dst); } catch { return { ok: false, error: 'a cleaned photo was not written' }; }
    const md = jpegMetadata(buf);
    if (!md.jpeg) return { ok: false, error: 'a cleaned photo is not a JPEG' };
    if (md.found.length) return { ok: false, error: `a cleaned photo still carries ${md.found.join(', ')} metadata` };
  }
  return { ok: true };
}

// ── the send ───────────────────────────────────────────────────────────────

let running = null;

function _ymd(d) { return d.replace(/-/g, ''); }
const _exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

async function _ensureClone(dir) {
  if (_exists(path.join(dir, '.git'))) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await _run('git', ['clone', '--branch', 'main', remote(), dir], { env: _gitEnv() });
  if (!r.ok) throw new Error(`git clone failed: ${(r.stderr || r.error || '').trim().split('\n').slice(-2).join(' ')}`);
}

async function _resetClone(dir) {
  try {
    await _git(dir, ['fetch', 'origin', 'main']);
    await _git(dir, ['reset', '--hard', 'origin/main']);
    await _git(dir, ['clean', '-fd', '--', 'public', 'src']);
  } catch { /* best effort — the next send starts from a reset too */ }
}

function _pagesFor(dir, date) {
  try { return fs.readdirSync(path.join(dir, 'src', 'content', 'walks')).filter((f) => f.startsWith(date) && f.endsWith('.md')); } catch { return []; }
}

/**
 * Send one walk. `opts` (tests only): { nodeArgs, python, now }.
 * Returns { ok, status?, error?, ... } and records every attempt it got far
 * enough to judge.
 */
async function send(workoutId, opts = {}) {
  const wid = Number(workoutId);
  if (!Number.isInteger(wid) || wid <= 0) return { ok: false, status: 400, error: 'id must be a workout number' };
  if (running) return { ok: false, status: 409, already: true, error: 'already sending a walk to Walking with Ember — wait for it to finish' };
  running = wid;
  try {
    const r = await _send(wid, opts);
    if (!r.notRecorded) _record({ workoutId: wid, ...r, status: r.ok ? (r.unchanged ? 'unchanged' : 'sent') : 'failed', error: r.ok ? null : r.error });
    delete r.notRecorded;
    return r;
  } catch (e) {
    const err = e.message;
    _record({ workoutId: wid, status: 'failed', error: err });
    return { ok: false, status: 500, error: err };
  } finally {
    running = null;
  }
}

async function _send(wid, opts) {
  const view = require('./workout-view');
  const model = require('./workout-view-model');
  const v = view.read(wid);
  if (!v.ok) return { ...v, notRecorded: v.status === 404 || v.status === 400 };
  if (!v.workout.hike) return { ok: false, status: 409, error: 'only hikes go to Walking with Ember — this is not one' };
  const route = v.workout.uuid ? _db().getWorkoutRoute(v.workout.uuid) : null;
  const raw = route ? model.cleanPoints(route.points) : [];
  if (raw.length < 2 || !v.map || !v.map.line || v.map.line.length < 2) return { ok: false, status: 409, error: 'this walk has no GPS track to send' };

  const key = keyStatus();
  if (!key.ok) return { ok: false, status: 409, error: key.error };

  const h = home();
  if (!h) return { ok: false, status: 409, error: 'NEURO does not know where home is (no saved place called Home), so it will not publish a track that might start there' };
  const trim = trimHome(raw, h, HOME_RADIUS_M);
  if (!trim.ok) return { ok: false, status: 409, error: trim.error };
  if (trim.empty || trim.points.length < 2) return { ok: false, status: 409, error: 'the whole walk is within 400 m of home — nothing to publish' };
  const atHome = trim.startedAtHome || trim.endedAtHome;
  const pts = trim.points;
  const date = new Date(pts[0][3] * 1000).toISOString().slice(0, 10); // ingest-walks dates by the UTC start

  // Two walks on one day cannot share the site's per-date files.
  try {
    _ensureTable();
    const other = _db().get("SELECT workout_id FROM wwe_sends WHERE walk_date = ? AND workout_id != ? AND status IN ('sent','unchanged') LIMIT 1", [date, wid]);
    if (other) return { ok: false, status: 409, date, error: `another walk on ${date} (workout ${other.workout_id}) is already on the site — the site keeps one walk per day` };
  } catch { /* first send */ }

  const dir = opts.repoDir || repoDir();
  const nodeArgs = opts.nodeArgs || [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wwe-'));
  const notes = [];
  let manifestBackup = null;
  const manifestPath = path.join(dir, '.cache', 'walks-manifest.json');
  try {
    await _ensureClone(dir);
    await _git(dir, ['checkout', 'main']);
    await _git(dir, ['reset', '--hard']);
    await _git(dir, ['clean', '-fd', '--', 'public', 'src']);
    await _git(dir, ['pull', '--ff-only', 'origin', 'main']);

    const existingPages = _pagesFor(dir, date);
    const pageExisted = existingPages.length > 0;

    // 1. The trimmed track through the site's own ingest.
    const inDir = path.join(tmp, 'in');
    fs.mkdirSync(inDir);
    fs.writeFileSync(path.join(inDir, `Hiking-Route-${_ymd(date)}.gpx`), toGpx(pts, `Walk ${date}`));
    await _node(dir, 'ingest-walks.mjs', [inDir, '--min-minutes', '0', '--since', date, '--force'], nodeArgs);

    // 2. Distance, ascent and time as WALKED (the watch), not the trimmed track.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifest.find((w) => w.date === date);
    if (!entry) throw new Error('ingest-walks did not produce this walk');
    const full = model.measure(raw);
    const distM = Number.isFinite(v.watch.distanceM) ? v.watch.distanceM : (full.known ? full.stats.distanceM : null);
    const ascM = Number.isFinite(v.watch.ascentM) ? v.watch.ascentM : (full.known ? full.stats.ascentM : null);
    if (Number.isFinite(distM)) entry.distanceMiles = Number((distM / 1609.344).toFixed(1));
    if (Number.isFinite(ascM)) { entry.ascentM = Math.round(ascM); entry.ascentFt = Math.round(ascM * 3.281); }
    if (Number.isFinite(v.watch.durationSeconds)) {
      entry.durationMin = Math.round(v.watch.durationSeconds / 60);
      entry.durationLabel = `${Math.floor(entry.durationMin / 60)}h${String(entry.durationMin % 60).padStart(2, '0')}`;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // 3. If an existing page points at a different GPX file, that file is the
    //    one people download — it gets the trimmed track too.
    const newGpxRel = entry.gpxDownload;
    if (pageExisted) {
      const src = fs.readFileSync(path.join(dir, 'src', 'content', 'walks', existingPages[0]), 'utf8');
      const ref = /^gpxDownload:\s*"?([^"\n]+)"?\s*$/m.exec(src);
      if (ref && /^\/uploads\/gpx\/[\w.-]+\.gpx$/.test(ref[1]) && ref[1] !== newGpxRel) {
        fs.copyFileSync(path.join(dir, 'public', newGpxRel), path.join(dir, 'public', ref[1]));
        fs.unlinkSync(path.join(dir, 'public', newGpxRel));
      }
    }

    // 4. Places and weather (the site's own scripts, this walk only).
    await _node(dir, 'route-waypoints.mjs', ['--walk', date], nodeArgs);
    await _node(dir, 'fetch-weather.mjs', ['--walk', date], nodeArgs);
    const wpPath = path.join(dir, '.cache', 'route-waypoints.json');
    let wp = null;
    try { wp = JSON.parse(fs.readFileSync(wpPath, 'utf8')).find((w) => w.date === date) || null; } catch { wp = null; }
    if (atHome && wp) {
      // The trimmed start is still close to home: never a grid ref, road or postcode for it.
      const all = JSON.parse(fs.readFileSync(wpPath, 'utf8'));
      for (const w of all) if (w.date === date) { w.startGridRef = null; w.startAt = { road: null, postcode: null, place: null, amenity: null }; w.startLat = null; w.startLng = null; }
      fs.writeFileSync(wpPath, JSON.stringify(all, null, 2));
    }

    // 5. Photos (NEURO's, cleaned), BEFORE the scaffold so it can pick a hero.
    const photos = await _photos(dir, date, v, pts, h, opts);
    if (!photos.ok) throw new Error(photos.error);
    if (photos.removedHero) notes.push(photos.removedHero);

    // 6. A new page only if none exists — never touch Nick's prose.
    let pageFile = existingPages[0] || null;
    let createdPage = false;
    if (!pageExisted) {
      manifestBackup = fs.readFileSync(manifestPath, 'utf8');
      fs.writeFileSync(manifestPath, JSON.stringify([entry], null, 2)); // scaffold has no --walk
      await _node(dir, 'scaffold-walks.mjs', ['--min-minutes', '0'], nodeArgs);
      fs.writeFileSync(manifestPath, manifestBackup);
      manifestBackup = null;
      pageFile = _pagesFor(dir, date)[0] || null;
      if (!pageFile) throw new Error('scaffold-walks did not create a page');
      await _node(dir, 'draft-writeups.mjs', ['--walk', date], nodeArgs);
      const pagePath = path.join(dir, 'src', 'content', 'walks', pageFile);
      let md = fs.readFileSync(pagePath, 'utf8');
      md = adjustFrontmatter(md, {
        home: atHome,
        // The location stays as the site's scaffold named it: the town/village
        // around the walk's (trimmed) midpoint, never a street.
        startGridRef: !atHome && wp ? wp.startGridRef : null,
        startPostcode: !atHome && wp && wp.startAt ? wp.startAt.postcode : null,
        catalogueOnly: photos.count === 0,
      });
      if (atHome) md = stripParkingSentence(md);
      fs.writeFileSync(pagePath, md);
      createdPage = true;
    }
    if (atHome) notes.push('Started or ended at home: the track is trimmed 400 m from home at both ends; no start grid ref, postcode or parking line.');

    // 7. One commit, pushed.
    const slug = pageFile.replace(/\.md$/, '');
    const paths = ['public/uploads/gpx', 'public/routes', 'public/photos', `public/uploads/images/walks/${date}`, 'src/content/walks'].filter((p) => _exists(path.join(dir, p)));
    await _git(dir, ['add', '-A', '--', ...paths]);
    const staged = await _git(dir, ['diff', '--cached', '--name-only']);
    const previewUrl = `${SITE_URL}/preview/walks/${slug}/`;
    const base = { ok: true, date, slug, pagePath: `src/content/walks/${pageFile}`, previewUrl, createdPage, homeTrimmed: atHome, photos: photos.count, notes };
    if (!staged) {
      const sha = await _git(dir, ['rev-parse', 'HEAD']);
      return { ...base, unchanged: true, sha };
    }
    let email = '';
    try { email = (await _run('git', ['config', 'user.email'], { cwd: dir })).stdout.trim(); } catch { email = ''; }
    const msg = [`Walk ${date} from NEURO (draft)`, '',
      createdPage ? `New draft page ${slug} — not public until published in the editor.` : `Updated the track, route, photos and weather for ${slug}; the page itself was left alone.`,
      `${photos.count} photo${photos.count === 1 ? '' : 's'}, metadata stripped.`, ...notes].join('\n');
    await _git(dir, ['-c', `user.name=${AUTHOR}`, '-c', `user.email=${email || FALLBACK_EMAIL}`, 'commit', '-q', '-m', msg]);
    const sha = await _git(dir, ['rev-parse', 'HEAD']);
    try {
      await _git(dir, ['push', 'origin', 'HEAD:refs/heads/main']);
    } catch (e) {
      await _resetClone(dir);
      return { ok: false, status: 502, date, error: `GitHub refused the push — nothing was published (${e.message})` };
    }
    return { ...base, sha };
  } catch (e) {
    if (manifestBackup) { try { fs.writeFileSync(manifestPath, manifestBackup); } catch { /* cache only */ } }
    await _resetClone(dir);
    return { ok: false, status: 500, date, error: e.message };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

/**
 * NEURO's photos for the walk → `public/uploads/images/walks/<date>/` and
 * `public/photos/<date>.json`. Only placed photos more than 400 m from home;
 * at most 12, spread along the (trimmed) route; cleaned of all metadata.
 * With none to send, whatever the site already holds is left alone.
 */
async function _photos(dir, date, v, pts, h, opts) {
  const view = require('./workout-view');
  const cum = cumulative(pts);
  const total = cum[cum.length - 1] || 0;
  const usable = (v.photos || [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .filter((p) => distM(p.lat, p.lon, h.lat, h.lon) > HOME_RADIUS_M)
    .map((p) => {
      const a = alongRoute(pts, cum, p.lat, p.lon);
      return { ...p, metresAlongRoute: a.metres, routeFraction: total ? a.fraction : 0 };
    })
    .filter((p) => view.photoFile(p.id, 'full'));
  const chosen = spreadPhotos(usable, MAX_PHOTOS);
  if (!chosen.length) return { ok: true, count: 0 };

  const imgRel = `uploads/images/walks/${date}`;
  const imgDir = path.join(dir, 'public', imgRel);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wwe-img-'));
  try {
    const pairs = chosen.map((p, i) => [view.photoFile(p.id, 'full'), path.join(work, `${i}.jpg`)]);
    const c = await cleanPhotos(pairs, opts);
    if (!c.ok) return c;
    fs.rmSync(imgDir, { recursive: true, force: true });
    fs.mkdirSync(imgDir, { recursive: true });
    const out = [];
    chosen.forEach((p, i) => {
      const buf = fs.readFileSync(pairs[i][1]);
      const name = `${String(i + 1).padStart(2, '0')}-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8)}.jpg`;
      fs.writeFileSync(path.join(imgDir, name), buf);
      out.push({
        src: `/${imgRel}/${name}`, time: p.takenAt || null,
        lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)),
        metresAlongRoute: p.metresAlongRoute, routeFraction: p.routeFraction,
        pinnable: p.placedBy === 'gps' || p.placedBy === 'time',
      });
    });
    fs.mkdirSync(path.join(dir, 'public', 'photos'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', 'photos', `${date}.json`), JSON.stringify({ date, count: out.length, photos: out }));
    // An existing page whose hero was one of the replaced files now points at nothing.
    let removedHero = null;
    for (const f of _pagesFor(dir, date)) {
      const hero = (/^heroImage:\s*"?([^"\n]+)"?\s*$/m.exec(fs.readFileSync(path.join(dir, 'src', 'content', 'walks', f), 'utf8')) || [])[1];
      if (hero && hero.startsWith(`/${imgRel}/`) && !out.some((o) => o.src === hero)) removedHero = `The page's heroImage (${hero}) is no longer one of the walk's photos — pick another in the editor.`;
    }
    return { ok: true, count: out.length, removedHero };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

function _resetForTests() { running = null; }
function _setRunningForTests(v) { running = v; }

module.exports = {
  HOME_RADIUS_M, MAX_PHOTOS, SITE_URL,
  trimHome, spreadPhotos, jpegMetadata, alongRoute, cumulative, toGpx, adjustFrontmatter, stripParkingSentence, distM,
  cleanPhotos, home, send, statusFor,
  keyStatus, isSshRemote, sshKey, remote,
  repoDir, _resetForTests, _setRunningForTests, _recordForTests: _record,
};
