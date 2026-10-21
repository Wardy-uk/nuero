'use strict';

/**
 * The SAiM cutover (21 Oct 2026): ONE canonical SAiM at https://sara.nickward.co.uk.
 * The retired Alt/legacy hostnames get saim/retired-alt/ — a permanent redirect
 * that first neutralises any stale service worker. These tests run the real files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const R = path.join(ROOT, 'saim', 'retired-alt');
const APP = path.join(ROOT, 'saim', 'app');
const CANON = 'https://sara.nickward.co.uk';

// ── _redirects, with Netlify's semantics: first match wins, :splat, query carried on a 3xx ──

function rules() {
  return fs.readFileSync(path.join(R, '_redirects'), 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [from, to, code] = l.split(/\s+/); return { from, to, status: Number(code.replace('!', '')), force: code.endsWith('!') }; });
}
function resolve(pathname, search = '') {
  for (const r of rules()) {
    const splat = r.from.endsWith('/*') ? (pathname.startsWith(r.from.slice(0, -1)) ? pathname.slice(r.from.length - 1) : null) : (pathname === r.from ? '' : null);
    if (splat === null) continue;
    const to = r.to.replace(':splat', splat);
    return r.status >= 300 && r.status < 400 ? { status: r.status, location: `${to}${search}` } : { status: r.status, serve: to };
  }
  return { status: 404 };
}

test('every page on a retired host is a permanent redirect to the same path and query on sara', () => {
  assert.deepEqual(resolve('/'), { status: 301, location: `${CANON}/` });
  assert.deepEqual(resolve('/review', '?tab=now'), { status: 301, location: `${CANON}/review?tab=now` });
  assert.deepEqual(resolve('/index.html'), { status: 301, location: `${CANON}/index.html` });
  assert.deepEqual(resolve('/assets/index-abc.js'), { status: 301, location: `${CANON}/assets/index-abc.js` });
  const catchAll = rules().find((r) => r.from === '/*');
  assert.equal(catchAll.force, true, 'forced, so an existing file cannot shadow it');
  assert.equal(new URL(catchAll.to.replace(':splat', '')).host, 'sara.nickward.co.uk');
});

test('/sw.js is NEVER redirected — it stays a same-origin 200, or a stale worker survives', () => {
  assert.deepEqual(resolve('/sw.js'), { status: 200, serve: '/sw.js' });
  assert.deepEqual(resolve('/service-worker.js'), { status: 200, serve: '/sw.js' });
  const order = rules().map((r) => r.from);
  assert.ok(order.indexOf('/sw.js') < order.indexOf('/*'), 'the exception comes before the catch-all');
  const headers = fs.readFileSync(path.join(R, '_headers'), 'utf8');
  assert.match(headers, /\/sw\.js\s+Cache-Control: no-cache, no-store, must-revalidate\s+Clear-Site-Data: "cache", "storage"/);
});

// ── the kill-switch, executed in a fake service-worker global ──

test('the kill-switch worker clears every cache, unregisters itself, reloads each tab — and intercepts nothing', async () => {
  const src = fs.readFileSync(path.join(R, 'sw.js'), 'utf8');
  const listeners = {};
  const deleted = []; const navigated = []; let unregistered = false; let skipped = false;
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => { skipped = true; },
    registration: { unregister: async () => { unregistered = true; return true; } },
    clients: { matchAll: async () => [{ url: 'https://saim-alt.nickward.co.uk/?tab=now', navigate: (u) => navigated.push(u) }] },
  };
  const caches = { keys: async () => ['workbox-precache-v2', 'saim-runtime'], delete: async (k) => { deleted.push(k); return true; } };
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', src)(self, caches);
  assert.equal(listeners.fetch, undefined, 'no fetch handler: it serves nothing');
  listeners.install();
  assert.equal(skipped, true);
  let done;
  listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.deepEqual(deleted.sort(), ['saim-runtime', 'workbox-precache-v2']);
  assert.equal(unregistered, true);
  assert.deepEqual(navigated, ['https://saim-alt.nickward.co.uk/?tab=now'], 'reloaded in place — the reload meets the 301');
});

// ── the fallback page, executed in a fake window ──

test('the fallback page unregisters workers, clears caches and replaces to sara with path, query and hash', async () => {
  const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const replaced = []; let unreg = 0; const del = [];
  const window = { caches: { keys: async () => ['a'], delete: async (k) => del.push(k) } };
  const location = { pathname: '/review', search: '?tab=now', hash: '#t', replace: (u) => replaced.push(u) };
  const navigator = { serviceWorker: { getRegistrations: async () => [{ unregister: async () => { unreg += 1; } }] } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'location', 'navigator', 'caches', 'setTimeout', script)(window, location, navigator, window.caches, () => {});
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(unreg, 1);
  assert.deepEqual(del, ['a']);
  assert.deepEqual(replaced, [`${CANON}/review?tab=now#t`]);
});

// ── the repo: Alt cannot be deployed as a product again; the canonical build is untouched ──

test('every Alt/legacy build command is guarded; the canonical build is not', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).scripts;
  for (const name of ['build:alt', 'dev:alt', 'build:alt2', 'dev:alt2', 'build:alt3', 'dev:alt2-manifest', 'build:legacy']) {
    assert.match(scripts[name], /^node scripts\/retired-build\.cjs \S+ && /, name);
  }
  assert.equal(scripts.build, 'vite build', 'sara’s build is unchanged');
  assert.equal(scripts.dev, 'vite');
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.js'), 'utf8'), /alt|retired/i);
  assert.match(fs.readFileSync(path.join(APP, 'netlify.toml'), 'utf8'), /command = "npm run build"/);
});

test('the guard refuses without SAIM_BUILD_RETIRED=1 and lets a deliberate rebuild through', () => {
  const guard = path.join(APP, 'scripts', 'retired-build.cjs');
  const env = { ...process.env }; delete env.SAIM_BUILD_RETIRED;
  assert.throws(() => execFileSync(process.execPath, [guard, 'alt-v3'], { env, stdio: 'pipe' }), (e) => e.status === 1 && /RETIRED/.test(String(e.stderr)));
  execFileSync(process.execPath, [guard, 'alt-v3'], { env: { ...env, SAIM_BUILD_RETIRED: '1' }, stdio: 'pipe' });
});

test('every Alt config, env file and source tree says it is retired; nothing was deleted', () => {
  for (const f of ['vite.config.alt.js', 'vite.config.alt2.js', 'vite.config.alt3.js', 'vite.config.alt2-manifest.js']) {
    assert.match(fs.readFileSync(path.join(APP, f), 'utf8'), /^\/\/ ⛔ RETIRED \(21 Oct 2026\)/, f);
  }
  for (const f of ['.env.alt', '.env.alt2', '.env.alt2-manifest', '.env.alt3', '.env.legacy']) {
    assert.match(fs.readFileSync(path.join(APP, f), 'utf8'), /^# ⛔ RETIRED \(21 Oct 2026\)/, f);
  }
  for (const d of ['alt', 'alt-v2', 'alt-v2-manifest', 'alt-v3']) {
    assert.ok(fs.existsSync(path.join(APP, d, 'RETIRED.md')), `${d}/RETIRED.md`);
    assert.ok(fs.readdirSync(path.join(APP, d)).length > 1, `${d} source kept for rollback`);
  }
  const readme = fs.readFileSync(path.join(R, 'README.md'), 'utf8');
  for (const id of ['2f83b58d-8636-444f-82ac-cb1751072a1e', '6e7e4e32-e982-4f9e-8eff-616d865b170d', 'ada5c60b-b68e-423e-a08b-f41ebc9a1033']) assert.ok(readme.includes(id), id);
});
