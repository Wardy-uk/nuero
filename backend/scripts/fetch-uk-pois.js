'use strict';

/**
 * Download the named places a car can stop at — shops, car parks, fuel, pubs,
 * venues, offices, retail parks — for ALL of Great Britain from OpenStreetMap,
 * into a small SQLite file on the Pi that services/place-naming.js reads.
 *
 *   node backend/scripts/fetch-uk-pois.js            (resumes if interrupted)
 *
 * ⚠ It downloads the WHOLE COUNTRY, tile by tile, so nothing about where Nick
 * goes is ever sent anywhere: the per-stop lookup happens on the Pi.
 * Polite to the public Overpass servers: one request at a time, a pause between
 * tiles, back-off when busy, a tile split in four when it is too big (London).
 * Builds into <file>.tmp with a progress file beside it and swaps in at the end,
 * so a half-finished run never replaces a good file.
 * Data © OpenStreetMap contributors, ODbL.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const OUT = process.env.NEURO_POIS_DB || path.join(__dirname, '..', 'data', 'pois-gb.db');
const TMP = `${OUT}.tmp`;
const PROGRESS = `${OUT}.progress.json`;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const GB = { s: 49.8, w: -8.7, n: 60.9, e: 1.9 };
const STEP = 0.5;
const PAUSE_MS = 3000;
const UA = 'NEURO-personal/1.0 (single-user home system; bulk GB download)';
const KEYS = ['shop', 'amenity', 'leisure', 'tourism', 'office', 'landuse', 'building'];
const SKIP_AMENITY = new Set(['parcel_locker', 'atm', 'post_box', 'bicycle_parking', 'telephone', 'vending_machine', 'waste_basket',
  'recycling', 'bench', 'shelter', 'toilets', 'drinking_water', 'waste_disposal', 'grit_bin', 'hunting_stand', 'post_depot']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function query(b) {
  const box = `${b.s},${b.w},${b.n},${b.e}`;
  return `[out:json][timeout:240][maxsize:536870912][bbox:${box}];(`
    + 'nwr["shop"]["name"];nwr["amenity"]["name"];nwr["leisure"]["name"];nwr["tourism"]["name"];'
    + 'nwr["office"]["name"];nwr["landuse"="retail"]["name"];nwr["building"]["name"];'
    + ');out tags center bb;';
}

async function fetchTile(b, attempt = 0) {
  const url = ENDPOINTS[attempt % ENDPOINTS.length];
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query(b))}`, signal: AbortSignal.timeout(300000) });
    const text = await res.text();
    if (res.status === 429 || res.status === 504 || /too busy|timeout|rate_limited/i.test(text.slice(0, 2000)) && !text.startsWith('{')) throw new Error(`busy (${res.status})`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = JSON.parse(text);
    if (json.remark && /runtime error|out of memory|timed out/i.test(json.remark)) { const e = new Error(json.remark); e.tooBig = true; throw e; }
    return json.elements || [];
  } catch (e) {
    if (e.tooBig || /maxsize|memory/i.test(e.message)) throw Object.assign(e, { tooBig: true });
    if (attempt >= 6) throw e;
    const wait = Math.min(120000, 10000 * 2 ** attempt);
    console.log(`[POIs] ${e.message} — retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    return fetchTile(b, attempt + 1);
  }
}

function rowsFrom(elements) {
  const out = [];
  for (const el of elements) {
    const t = el.tags || {};
    if (!t.name) continue;
    const key = KEYS.find((k) => t[k]);
    if (!key) continue;
    if (key === 'amenity' && SKIP_AMENITY.has(t.amenity)) continue;
    const b = el.bounds;
    const lat = Number.isFinite(el.lat) ? el.lat : el.center ? el.center.lat : b ? (b.minlat + b.maxlat) / 2 : null;
    const lon = Number.isFinite(el.lon) ? el.lon : el.center ? el.center.lon : b ? (b.minlon + b.maxlon) / 2 : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push([`${el.type[0]}${el.id}`, String(t.name).slice(0, 120), t.brand ? String(t.brand).slice(0, 80) : null, `${key}=${t[key]}`.slice(0, 60),
      lat, lon, b ? b.minlat : null, b ? b.maxlat : null, b ? b.minlon : null, b ? b.maxlon : null]);
  }
  return out;
}

async function doTile(db, insert, b, depth = 0) {
  try {
    const rows = rowsFrom(await fetchTile(b));
    db.transaction(() => { for (const r of rows) insert.run(r); })();
    return rows.length;
  } catch (e) {
    if (!e.tooBig || depth >= 3) throw e;
    const mLat = (b.s + b.n) / 2; const mLon = (b.w + b.e) / 2;
    console.log(`[POIs] tile ${b.s},${b.w} too big — splitting`);
    let n = 0;
    for (const q of [{ s: b.s, w: b.w, n: mLat, e: mLon }, { s: b.s, w: mLon, n: mLat, e: b.e }, { s: mLat, w: b.w, n: b.n, e: mLon }, { s: mLat, w: mLon, n: b.n, e: b.e }]) {
      n += await doTile(db, insert, q, depth + 1);
      await sleep(PAUSE_MS);
    }
    return n;
  }
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let done = new Set();
  try { done = new Set(JSON.parse(fs.readFileSync(PROGRESS, 'utf8')).done || []); } catch { /* fresh run */ }
  if (!done.size && fs.existsSync(TMP)) fs.rmSync(TMP);
  const db = new Database(TMP);
  db.exec(`CREATE TABLE IF NOT EXISTS poi (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, kind TEXT NOT NULL,
    lat REAL NOT NULL, lon REAL NOT NULL, minlat REAL, maxlat REAL, minlon REAL, maxlon REAL);`);
  const insert = db.prepare('INSERT OR REPLACE INTO poi VALUES (?,?,?,?,?,?,?,?,?,?)');
  const tiles = [];
  for (let s = GB.s; s < GB.n; s += STEP) for (let w = GB.w; w < GB.e; w += STEP) tiles.push({ s: +s.toFixed(2), w: +w.toFixed(2), n: +(s + STEP).toFixed(2), e: +(w + STEP).toFixed(2) });
  let i = 0;
  for (const t of tiles) {
    i++;
    const key = `${t.s},${t.w}`;
    if (done.has(key)) continue;
    const n = await doTile(db, insert, t);
    done.add(key);
    fs.writeFileSync(PROGRESS, JSON.stringify({ done: [...done] }));
    if (n) console.log(`[POIs] tile ${i}/${tiles.length} ${key}: ${n}`);
    await sleep(n ? PAUSE_MS : 500);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_poi_latlon ON poi(lat, lon);');
  const total = db.prepare('SELECT COUNT(*) AS n FROM poi').get().n;
  db.close();
  if (total < 100000) throw new Error(`only ${total} places — refusing to replace the file`);
  fs.renameSync(TMP, OUT);
  fs.rmSync(PROGRESS, { force: true });
  console.log(`[POIs] wrote ${total} named places to ${OUT}`);
})().catch((e) => { console.error(`[POIs] stopped: ${e.message} (re-run to resume)`); process.exit(1); });
