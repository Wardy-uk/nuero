'use strict';

/**
 * Fetch GeoNames' UK file and write the populated places NEURO names journeys
 * with (services/place-naming.js). Run on the Pi:
 *   node backend/scripts/fetch-uk-places.js
 * Writes NEURO_PLACES_FILE (default backend/data/places-gb.tsv, gitignored):
 * one "name<TAB>lat<TAB>lon" line per town, village, hamlet or city district.
 * Place names © GeoNames, CC BY 4.0 (https://www.geonames.org/).
 * Needs `unzip` on PATH. Writes to a temp file and renames, so a failed run
 * never leaves a half file behind.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = 'https://download.geonames.org/export/dump/GB.zip';
const out = process.env.NEURO_PLACES_FILE || path.join(__dirname, '..', 'data', 'places-gb.tsv');

(async () => {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`GeoNames answered ${res.status}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geonames-'));
  const zip = path.join(tmpDir, 'GB.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const text = execFileSync('unzip', ['-p', zip, 'GB.txt'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const lines = [];
  for (const row of text.split('\n')) {
    const c = row.split('\t');
    // Feature class P = populated place (city, town, village, hamlet, district).
    if (c[6] !== 'P' || !c[1]) continue;
    const lat = Number(c[4]); const lon = Number(c[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    lines.push(`${c[1].replace(/\t/g, ' ')}\t${lat}\t${lon}`);
  }
  if (lines.length < 10000) throw new Error(`only ${lines.length} places parsed — refusing to replace the file`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.tmp`, `${lines.join('\n')}\n`);
  fs.renameSync(`${out}.tmp`, out);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[Places] wrote ${lines.length} UK places to ${out}`);
})().catch((e) => { console.error(`[Places] ${e.message}`); process.exit(1); });
