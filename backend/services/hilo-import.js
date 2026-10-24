/**
 * HiLo blood pressure, straight from HiLo's own PDF report (15 Oct 2026).
 *
 * Before this: HiLo → BPExtract → Apple Health → NEURO. Now: HiLo's monthly
 * report is shared to NEURO (an iOS Shortcut posts the PDF to
 * POST /api/health/hilo/import), NEURO stores every reading, and the NEURO iOS
 * app writes the ones Apple Health does not hold yet back into Health
 * (GET /api/health/hilo/to-health, then .../to-health/ack). So NEURO is fed
 * first and Health becomes a copy.
 *
 * The report (Aktiia SA "Monthly Report", measured on the October 2026 file):
 * a table of `D Month, YY  HH:MM  SBP  DBP  HR` rows in two columns per page.
 * ⚠ The PDF's text STREAM is not in reading order — page 2's right-hand column
 * has its dates emitted after the rest of the page — so rows are rebuilt from
 * each cell's POSITION, never from the order the text arrives in.
 * ⚠ Times are Europe/London WALL CLOCK. Checked against Apple Health's copy of
 * the same readings: "1 October 09:08" is stored as 08:08 UTC. So an imported
 * reading lands on the exact minute Health's copy does, and health_samples'
 * UNIQUE(metric, recorded_at) folds the two into one row — that IS the dedupe.
 * ⚠ The report also carries Nick's name, email, date of birth, height and
 * weight. None of it is read or stored.
 * ⚠ The report marks some rows (cuff calibration, cuff measurement, on-demand
 * phone measurement) with an ICON, not text. The icons are not read, so every
 * reading is stored as a HiLo reading; that is said rather than guessed.
 *
 * Split like pi-health: `parseItems` and `toUtc` are PURE; `readPdf` and
 * `importReport` touch the PDF library and the database.
 */

const SOURCE = 'hilo-report';
const TIMEZONE = 'Europe/London';
const HOUR = 3600000;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

const DATE_RE = /^(\d{1,2}) ([A-Za-z]+), (\d{2}|\d{4})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const NUM_RE = /^\d{2,3}$/;

// Plausibility bounds. A value outside them is a misread cell, not a reading,
// and is refused rather than stored (and counted, never dropped silently).
const BOUNDS = { sys: [60, 260], dia: [30, 160], hr: [25, 220] };

// ── time ────────────────────────────────────────────────────────────────────

function _local(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * Europe/London wall-clock "YYYY-MM-DDTHH:MM" → every UTC instant it names.
 * PURE. Usually one; two in the autumn hour the clock repeats; none for the
 * spring hour it skips (or an impossible date).
 */
function toUtcCandidates(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return [];
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const out = [];
  for (const ms of [guess - 2 * HOUR, guess - HOUR, guess, guess + HOUR]) {
    if (_local(ms) === local) out.push(ms);
  }
  return out;
}

// ── parsing ─────────────────────────────────────────────────────────────────

function _date(str) {
  const m = DATE_RE.exec(String(str).trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Text items → readings. PURE.
 *
 * `pages` is an array of pages, each an array of { str, x, y }. A reading is a
 * TIME cell; its date is the nearest date cell on the same line to its left,
 * and its three numbers are the next three numeric cells to its right on that
 * line. Matching by line and column is what survives the out-of-order stream.
 *
 * Returns { readings, rejected } where every reading is
 * { local: "YYYY-MM-DDTHH:MM", sys, dia, hr } in report order, and a rejected
 * row says why.
 */
function parseItems(pages) {
  const readings = [];
  const rejected = [];
  const LINE = 2.5; // points: cells on one printed line share y to within this

  for (const items of pages || []) {
    const cells = (items || [])
      .map((it) => ({ str: String(it.str || '').trim(), x: Number(it.x), y: Number(it.y) }))
      .filter((c) => c.str && Number.isFinite(c.x) && Number.isFinite(c.y));
    const dates = cells.filter((c) => _date(c.str));
    const times = cells.filter((c) => TIME_RE.test(c.str));
    const nums = cells.filter((c) => NUM_RE.test(c.str));

    // No ordering here: toUtc sorts by wall-clock time, which is report order.
    for (const t of times) {
      const date = dates
        .filter((d) => Math.abs(d.y - t.y) <= LINE && d.x < t.x && t.x - d.x < 90)
        .sort((a, b) => b.x - a.x)[0];
      if (!date) continue; // a time with no date beside it is not a table row
      const row = nums
        .filter((n) => Math.abs(n.y - t.y) <= LINE && n.x > t.x && n.x - t.x < 75)
        .sort((a, b) => a.x - b.x)
        .slice(0, 3)
        .map((n) => Number(n.str));
      const day = _date(date.str);
      const local = `${day}T${t.str}`;
      if (row.length < 3) { rejected.push({ local, reason: 'fewer than three numbers on the line' }); continue; }
      const [sys, dia, hr] = row;
      const bad = (v, [lo, hi]) => !(v >= lo && v <= hi);
      if (bad(sys, BOUNDS.sys) || bad(dia, BOUNDS.dia) || bad(hr, BOUNDS.hr) || sys <= dia) {
        rejected.push({ local, reason: `implausible ${sys}/${dia} HR ${hr}` });
        continue;
      }
      readings.push({ local, sys, dia, hr });
    }
  }
  return { readings, rejected };
}

/**
 * Wall-clock readings → UTC. PURE.
 *
 * The repeated autumn hour is resolved by ORDER: readings are chronological,
 * so of two instants the one not earlier than the previous reading wins. A
 * minute that does not exist (the skipped spring hour) is rejected.
 */
function toUtc(readings) {
  const out = [];
  const rejected = [];
  let prev = -Infinity;
  const sorted = [...readings].sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
  for (const r of sorted) {
    const c = toUtcCandidates(r.local);
    if (!c.length) { rejected.push({ local: r.local, reason: 'not a real Europe/London time' }); continue; }
    const ms = c.find((m) => m >= prev) ?? c[c.length - 1];
    prev = ms;
    out.push({ ...r, at: new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ':00' });
  }
  return { readings: out, rejected };
}

// ── the PDF ─────────────────────────────────────────────────────────────────

/** PDF bytes → pages of positioned text items. Throws on a file that is not a PDF. */
async function readPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] })));
  }
  await doc.destroy();
  return pages;
}

function _isHiloReport(pages) {
  const text = pages.flat().map((i) => i.str).join(' ');
  return /Aktiia|hilo\.com/i.test(text) && /SBP/.test(text);
}

// ── storage ─────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

/**
 * Store a parsed report. Returns counts; never throws on a single row.
 *
 * Each reading goes into health_samples as two rows (systolic, diastolic) and
 * into hilo_readings (the ledger that also drives the write-back to Health).
 * - new:        NEURO had no reading at that minute — stored, and queued for Health.
 * - alreadyHad: Health's copy (via BPExtract) is already there with the same values.
 * - conflicts:  a different value is already stored at that minute; the stored
 *               one is KEPT and the disagreement reported, never overwritten.
 */
function storeReadings(readings, { now = new Date() } = {}) {
  const db = _db();
  const result = { new: 0, alreadyHad: 0, conflicts: [], first: null, last: null };
  const stamp = now.toISOString();

  for (const r of readings) {
    const existing = {
      sys: db.get('SELECT value, source FROM health_samples WHERE metric = ? AND recorded_at = ?', ['blood_pressure_systolic', r.at]),
      dia: db.get('SELECT value, source FROM health_samples WHERE metric = ? AND recorded_at = ?', ['blood_pressure_diastolic', r.at]),
    };
    const inHealth = !!((existing.sys && existing.sys.source === 'apple-health') ||
                        (existing.dia && existing.dia.source === 'apple-health'));

    if (existing.sys || existing.dia) {
      const same = (!existing.sys || Number(existing.sys.value) === r.sys) &&
                   (!existing.dia || Number(existing.dia.value) === r.dia);
      if (same) result.alreadyHad++;
      else result.conflicts.push({ at: r.at, stored: `${existing.sys?.value ?? '?'}/${existing.dia?.value ?? '?'}`, report: `${r.sys}/${r.dia}` });
      // Fill a missing half (a reading half-stored is worse than either).
      if (!existing.sys) db.insertHealthSample('blood_pressure_systolic', r.sys, r.at, SOURCE);
      if (!existing.dia) db.insertHealthSample('blood_pressure_diastolic', r.dia, r.at, SOURCE);
    } else {
      db.insertHealthSample('blood_pressure_systolic', r.sys, r.at, SOURCE);
      db.insertHealthSample('blood_pressure_diastolic', r.dia, r.at, SOURCE);
      result.new++;
    }

    db.run(
      `INSERT INTO hilo_readings (recorded_at, systolic, diastolic, heart_rate, health_state, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(recorded_at) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [r.at, r.sys, r.dia, r.hr, inHealth ? 'present' : 'pending', stamp, stamp]
    );
    if (!result.first || r.at < result.first) result.first = r.at;
    if (!result.last || r.at > result.last) result.last = r.at;
  }
  return result;
}

/**
 * The whole import: PDF bytes → stored readings → daily rollup refreshed.
 * Refuses a file that is not a HiLo report rather than storing nothing and
 * calling it a success.
 */
async function importReport(buffer, { now = new Date() } = {}) {
  let pages;
  try { pages = await readPdf(buffer); } catch (e) {
    return { ok: false, reason: 'not-a-pdf', message: `That file could not be read as a PDF (${e.message}).` };
  }
  if (!_isHiloReport(pages)) {
    return { ok: false, reason: 'not-a-hilo-report', message: 'That PDF is not a HiLo blood pressure report.' };
  }
  const parsed = parseItems(pages);
  const timed = toUtc(parsed.readings);
  const rejected = [...parsed.rejected, ...timed.rejected];
  if (!timed.readings.length) {
    return { ok: false, reason: 'no-readings', message: 'No readings could be read from that report.', rejected };
  }
  const stored = storeReadings(timed.readings, { now });

  // The daily rollup reads health_samples; refresh the days this report covers
  // so My Health and the BP goal see them now rather than at the next hourly pass.
  let rollup = null;
  try {
    const days = Math.min(400, Math.ceil((now - new Date(stored.first.replace(' ', 'T') + 'Z')) / 86400000) + 2);
    rollup = require('./health-daily').syncRange({ days, now });
  } catch (e) {
    rollup = { ok: false, error: e.message };
  }

  return {
    ok: true,
    read: timed.readings.length,
    new: stored.new,
    alreadyHad: stored.alreadyHad,
    conflicts: stored.conflicts,
    rejected,
    from: stored.first,
    to: stored.last,
    rollup: rollup && { ok: rollup.ok, written: rollup.written },
    note: 'Cuff calibrations and on-demand readings are marked in the report with icons NEURO does not read, so every reading is stored as a HiLo reading.',
  };
}

// ── write-back to Apple Health ──────────────────────────────────────────────

/** Readings Apple Health does not hold yet, oldest first. */
function pendingForHealth({ limit = 500 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
  const rows = _db().all(
    `SELECT recorded_at, systolic, diastolic FROM hilo_readings
     WHERE health_state = 'pending' ORDER BY recorded_at ASC LIMIT ?`, [n]);
  return rows.map((r) => ({
    at: r.recorded_at.replace(' ', 'T') + 'Z',
    systolic: r.systolic,
    diastolic: r.diastolic,
    // Apple Health's own dedupe key: writing the same id twice replaces, never doubles.
    syncId: `hilo:${r.recorded_at.replace(' ', 'T')}Z`,
  }));
}

/**
 * The phone reports what it did. `written`: NEURO put it in Health.
 * `present`: Health already had a reading at that minute (BPExtract), so
 * nothing was written. Anything else in the ack is ignored.
 */
function ackHealth({ written = [], present = [] } = {}, { now = new Date() } = {}) {
  const db = _db();
  const stamp = now.toISOString();
  const norm = (iso) => {
    const s = String(iso || '');
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/.test(s) ? s.slice(0, 16).replace('T', ' ') + ':00' : null;
  };
  let changed = 0;
  for (const [list, state] of [[written, 'written'], [present, 'present']]) {
    for (const iso of Array.isArray(list) ? list : []) {
      const at = norm(iso);
      if (!at) continue;
      const r = db.run(
        `UPDATE hilo_readings SET health_state = ?, health_at = ? WHERE recorded_at = ? AND health_state = 'pending'`,
        [state, stamp, at]);
      changed += r.changes || 0;
    }
  }
  return { ok: true, changed };
}

function status() {
  const db = _db();
  const counts = Object.fromEntries(db.all(
    'SELECT health_state, COUNT(*) AS n FROM hilo_readings GROUP BY health_state').map((r) => [r.health_state, r.n]));
  const last = db.get('SELECT MAX(last_seen_at) AS imported, MAX(recorded_at) AS newest FROM hilo_readings');
  return {
    readings: Object.values(counts).reduce((a, b) => a + b, 0),
    health: { pending: counts.pending || 0, written: counts.written || 0, present: counts.present || 0 },
    lastImportAt: last?.imported || null,
    newestReading: last?.newest || null,
  };
}

const RECENT_MAX_MINUTES = 1440;

/**
 * HiLo readings NEURO holds from the last `minutes` (24 Oct 2026). Read by the
 * Hume calibration script so a reading HiLo already took can be the reference
 * instead of being retyped. Junk `minutes` is REFUSED, never clamped.
 *
 * ⚠ Only as fresh as the last report shared to NEURO: `lastImportAt` and
 * `newestReading` say how stale the store is, so an empty window can be told
 * apart from "nothing imported lately".
 */
function recent({ minutes, now = new Date() } = {}) {
  const m = Number(minutes);
  if (!Number.isInteger(m) || m < 1 || m > RECENT_MAX_MINUTES) {
    const e = new Error(`minutes must be a whole number 1-${RECENT_MAX_MINUTES}`);
    e.status = 400;
    throw e;
  }
  // recorded_at is 'YYYY-MM-DD HH:MM:00' UTC, so a string compare in that form is exact.
  const since = new Date(now.getTime() - m * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = _db().all(
    `SELECT recorded_at, systolic, diastolic, heart_rate, first_seen_at FROM hilo_readings
     WHERE recorded_at >= ? ORDER BY recorded_at DESC`, [since]);
  const s = status();
  return {
    source: SOURCE,
    windowMinutes: m,
    now: now.toISOString(),
    readings: rows.map((r) => ({
      at: r.recorded_at.replace(' ', 'T') + 'Z',
      systolic: r.systolic, diastolic: r.diastolic, heartRate: r.heart_rate,
      importedAt: r.first_seen_at,
    })),
    newestReading: s.newestReading ? s.newestReading.replace(' ', 'T') + 'Z' : null,
    lastImportAt: s.lastImportAt,
  };
}

module.exports = {
  SOURCE, parseItems, toUtc, toUtcCandidates, readPdf, importReport, storeReadings,
  pendingForHealth, ackHealth, status, recent, _isHiloReport,
};
