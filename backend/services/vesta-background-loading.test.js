'use strict';
/**
 * Regression, 17 Oct 2026 (build e6f406d): the wall went almost black at night.
 * Root cause: the night overlay (45–75%) and a 0.3 brightness on darkened photos
 * left ~13–22/255 behind the panels. These pin the fix — night stays visibly
 * photographic — and the loading rules that keep a failed request from ever
 * leaving the screen dark.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const VESTA = path.join(__dirname, '..', '..', 'vesta');

async function load() {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(VESTA, 'src', 'backgrounds.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// A minimal Cache Storage and fetch, enough to drive cachedUrl.
function fakeWorld(responses) {
  const store = new Map();
  const deleted = [];
  const resp = (status, type, body = 'x') => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
    clone() { return resp(status, type, body); },
    blob: async () => ({ type, body }),
  });
  global.caches = {
    delete: async (n) => { deleted.push(n); return true; },
    open: async () => ({
      match: async (k) => store.get(k) || undefined,
      put: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); return true; },
    }),
  };
  global.fetch = async (src) => { const r = responses[src]; return r ? resp(r[0], r[1]) : resp(404, 'text/html'); };
  global.URL.createObjectURL = (b) => `blob:${b.type}:${b.body}`;
  return { store, deleted, resp };
}

test('a real image is cached and handed back; the old v1 cache is dropped', async () => {
  const b = await load();
  const w = fakeWorld({ '/backgrounds/night-clear.v1.jpg': [200, 'image/jpeg'] });
  const url = await b.cachedUrl('/backgrounds/night-clear.v1.jpg');
  assert.ok(url.startsWith('blob:image/jpeg'));
  assert.ok(w.store.has('/backgrounds/night-clear.v1.jpg'));
  assert.ok(w.deleted.includes('vesta-backgrounds-v1'), 'anything the old cache held is discarded');
});

test('an error page is never cached or shown as a photograph', async () => {
  const b = await load();
  const w = fakeWorld({});
  const url = await b.cachedUrl('/backgrounds/missing.v1.jpg');
  assert.equal(url, '/backgrounds/missing.v1.jpg', 'falls back to the plain URL, which then fails to decode and is not shown');
  assert.equal(w.store.size, 0, 'the 404 page is not stored');
});

test('a poisoned cache entry (HTML stored as a photo) is thrown out and refetched', async () => {
  const b = await load();
  const w = fakeWorld({ '/backgrounds/day-rain.v1.jpg': [200, 'image/jpeg'] });
  w.store.set('/backgrounds/day-rain.v1.jpg', w.resp(200, 'text/html'));
  const url = await b.cachedUrl('/backgrounds/day-rain.v1.jpg');
  assert.ok(url.startsWith('blob:image/jpeg'), 'the real image, not the stored page');
});

test('decodeImage resolves where there is no Image (server render) and the fallback photo exists', async () => {
  const b = await load();
  assert.equal(await b.decodeImage('/x.jpg'), '/x.jpg');
  assert.ok(fs.existsSync(path.join(VESTA, 'public', b.FALLBACK_SRC)), 'the known-working fallback is bundled');
  assert.deepEqual({ ...b.backgroundReport }, { id: null, state: 'none' });
  const fb = b.imageBySrc(b.FALLBACK_SRC);
  assert.ok(fb && fb.credit && fb.licence, 'the fallback carries its own credit, shown when it stands in');
});

test('night stays visibly photographic: no overlay or filter that leaves it black', () => {
  const css = fs.readFileSync(path.join(VESTA, 'src', 'views', 'WallCinema.css'), 'utf8');
  // The LAST rule wins; read the night rules as finally declared.
  const last = (re) => { const all = [...css.matchAll(re)]; return all.length ? all[all.length - 1][1] : null; };
  const dim = Number(last(/\.cine__photo--night \{ filter: brightness\(([\d.]+)\)/g));
  assert.ok(dim >= 0.55, `darkened photos at night keep at least 55% brightness (was 0.3), got ${dim}`);
  const scrim = last(/\.cine--night \.cine__scrim \{ background: ([^;]+);/g);
  const alphas = [...scrim.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].map((m) => Number(m[1]));
  assert.ok(Math.max(...alphas) <= 0.55, `the night overlay never exceeds 55% (was 75%), got ${Math.max(...alphas)}`);
  // Effective brightness behind the panels for the darkest night case stays well clear of black.
  const darkestPhoto = 111 * dim; // overcast day photo, darkened for night
  const centre = 1 - alphas[Math.floor(alphas.length / 2)];
  assert.ok(darkestPhoto * centre >= 35, `≥35/255 behind the panels at night, got ${(darkestPhoto * centre).toFixed(1)}`);
});
