'use strict';

/**
 * Medical records — test results, diagnoses and prescriptions, as the NHS app
 * shows them (8 Oct 2026).
 *
 * Two ways in, ONE store and ONE set of rules:
 *   1. A screenshot (or a scroll of several) from the NHS app, read by a vision
 *      model into a PROPOSAL. Nothing is written until Nick confirms it.
 *   2. Records someone else already parsed — ChatGPT reading the same
 *      screenshot and posting the result over the MCP gateway. That path writes,
 *      because posting IS the instruction; every row says who entered it.
 * Both end at `upsert()`, so a record entered either way is judged by the same
 * validation and folds by the same key.
 *
 * ── The rules this file turns on ────────────────────────────────────────────
 * ⚠ TRANSCRIBE, NEVER INTERPRET. A value is stored as the text the record shows
 *   ("<0.5", "4.2"), with a number beside it ONLY when the text is a plain
 *   number — "<0.5" is not 0.5, and a chart that plotted it as 0.5 would draw a
 *   measurement nobody took.
 * ⚠ A FLAG IS WHAT THE RECORD SAYS, NEVER DERIVED. A value outside the printed
 *   reference range is NOT marked high here: the NHS app (and the lab) decide
 *   abnormal against their own rules — age, sex, the analyser — and NEURO
 *   re-judging it would put a clinical opinion in a record that only ever held
 *   transcriptions. Pinned by a test.
 * ⚠ A SCREENSHOT IS NEVER KEPT. Not on disk, not in the DB, not in a log, not
 *   echoed back. It lives in memory for one request (VESTA's photo rule).
 * ⚠ NOT IN THE VAULT, NOT IN THE INDEX. Records live in `medical_records` only:
 *   nothing here writes a note, so nothing is embedded (which would send it to
 *   Voyage), entity-extracted or published to Notion.
 * ⚠ "I could not read it" is NEVER an empty list. An unreadable model answer
 *   refuses; an empty array is a real answer ("no records on this screen") and
 *   is told apart by `ok`.
 * ⚠ The same record twice FOLDS; the same record with different content is a
 *   REVISION that keeps what it replaced (`previous_json`) — results do get
 *   re-issued ("pending" → a value), and a silent overwrite loses the earlier
 *   reading.
 *
 * PURE where it judges (`normaliseRecord`, `dedupeKey`, `parseProposal`,
 * `parseValue`, `parseDate`), so the rules pin without a database, a model or
 * a clock.
 *
 * CommonJS — NEURO backend convention.
 */

const KINDS = Object.freeze(['test_result', 'diagnosis', 'prescription']);
const FLAGS = Object.freeze(['high', 'low', 'abnormal', 'normal', 'critical']);
const STATUSES = Object.freeze({
  test_result: ['final', 'pending', 'amended'],
  diagnosis: ['active', 'resolved', 'past'],
  prescription: ['current', 'repeat', 'acute', 'past', 'stopped'],
});

const MAX_BATCH = 200;
const MAX_IMAGES = 8;
// Anthropic's per-image ceiling is 5MB; a phone screenshot is well under it.
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const CONTENT_FIELDS = ['kind', 'name', 'date', 'value', 'unit', 'referenceRange', 'flag', 'status',
  'panel', 'code', 'dose', 'directions', 'quantity', 'notes', 'source'];

// ── Pure helpers ─────────────────────────────────────────────────────────────

function _str(v, max = 500) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A date as the record states it, at the precision it states it. PURE.
 * Accepts YYYY-MM-DD, YYYY-MM or YYYY (a diagnosis is often just a year) and
 * the UK day-first forms the NHS app prints ("12 March 2026", "12/03/2026").
 * ⚠ Never rolls an impossible date over (31 Feb is refused, not 3 March), and
 * never accepts a date in the future — a result dated next month is a misread.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];

function parseDate(input, today = new Date()) {
  const raw = _str(input, 40);
  if (!raw) return { ok: true, date: null, precision: null };
  let y; let m = null; let d = null;
  let match;
  if ((match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/))) [, y, m, d] = match;
  else if ((match = raw.match(/^(\d{4})-(\d{2})$/))) [, y, m] = match;
  else if ((match = raw.match(/^(\d{4})$/))) [, y] = match;
  else if ((match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [, d, m, y] = match;
  else if ((match = raw.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+),? (\d{4})$/i))) {
    const idx = MONTHS.findIndex((mn) => mn.startsWith(match[2].toLowerCase().slice(0, 3)));
    if (idx === -1) return { ok: false, why: `"${raw}" is not a date I can read` };
    d = match[1]; m = String(idx + 1); y = match[3];
  } else if ((match = raw.match(/^([a-z]+) (\d{4})$/i))) {
    const idx = MONTHS.findIndex((mn) => mn.startsWith(match[1].toLowerCase().slice(0, 3)));
    if (idx === -1) return { ok: false, why: `"${raw}" is not a date I can read` };
    m = String(idx + 1); y = match[2];
  } else {
    return { ok: false, why: `"${raw}" is not a date I can read` };
  }
  const yy = Number(y); const mm = m === null ? null : Number(m); const dd = d === null ? null : Number(d);
  if (yy < 1900) return { ok: false, why: `"${raw}" is too far back to be right` };
  if (mm !== null && (mm < 1 || mm > 12)) return { ok: false, why: `"${raw}" has no such month` };
  if (dd !== null) {
    const probe = new Date(Date.UTC(yy, mm - 1, dd));
    if (probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) {
      return { ok: false, why: `"${raw}" is not a real date` };
    }
  }
  const pad = (n) => String(n).padStart(2, '0');
  const date = dd !== null ? `${yy}-${pad(mm)}-${pad(dd)}` : mm !== null ? `${yy}-${pad(mm)}` : `${yy}`;
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  if (date > todayKey.slice(0, date.length)) return { ok: false, why: `"${raw}" is in the future` };
  return { ok: true, date, precision: dd !== null ? 'day' : mm !== null ? 'month' : 'year' };
}

/**
 * The value as shown, and a number ONLY when the text is a plain number. PURE.
 * "<0.5", ">90", "Negative" and "4.2 - 5.1" all keep their text and get no
 * number.
 */
function parseValue(input) {
  const text = _str(input, 200);
  if (!text) return { text: null, num: null };
  const plain = text.replace(/,/g, '');
  const num = /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : null;
  return { text, num };
}

/**
 * One record in, one validated record (or a refusal with a reason) out. PURE.
 */
function normaliseRecord(input, { today = new Date() } = {}) {
  if (!input || typeof input !== 'object') return { ok: false, why: 'not a record' };
  const kind = _str(input.kind, 40);
  const k = kind && kind.toLowerCase().replace(/[\s-]+/g, '_');
  if (!KINDS.includes(k)) {
    return { ok: false, why: `kind must be one of ${KINDS.join(', ')}${kind ? ` (got "${kind}")` : ''}` };
  }
  const name = _str(input.name, 200);
  if (!name) return { ok: false, why: 'a record needs a name (the test, condition or medicine)' };

  const dt = parseDate(input.date, today);
  if (!dt.ok) return { ok: false, why: dt.why };
  if (k !== 'diagnosis' && !dt.date) {
    return { ok: false, why: `a ${k.replace('_', ' ')} needs the date it is from` };
  }

  const val = parseValue(input.value);
  if (k === 'test_result' && !val.text) {
    return { ok: false, why: 'a test result needs its value as shown (or "pending")' };
  }

  // ⚠ Unrecognised flag or status is REFUSED, not dropped to null: null means
  // "the record did not say", and a misspelt "Hihg" quietly becoming that is a
  // stated abnormal result filed as unremarkable.
  let flag = _str(input.flag, 20);
  if (flag) {
    flag = flag.toLowerCase();
    if (!FLAGS.includes(flag)) return { ok: false, why: `flag must be one of ${FLAGS.join(', ')} or omitted (got "${input.flag}")` };
  }
  let status = _str(input.status, 20);
  if (status) {
    status = status.toLowerCase();
    if (!STATUSES[k].includes(status)) {
      return { ok: false, why: `status for a ${k.replace('_', ' ')} must be one of ${STATUSES[k].join(', ')} or omitted (got "${input.status}")` };
    }
  }

  const rec = {
    kind: k,
    name,
    nameKey: nameKey(name),
    date: dt.date,
    datePrecision: dt.precision,
    value: k === 'test_result' ? val.text : _str(input.value, 200),
    valueNum: k === 'test_result' ? val.num : null,
    unit: _str(input.unit, 40),
    referenceRange: _str(input.referenceRange ?? input.reference_range ?? input.range, 80),
    flag: flag || null,
    status: status || null,
    panel: _str(input.panel, 120),
    code: _str(input.code, 40),
    dose: _str(input.dose, 120),
    directions: _str(input.directions, 300),
    quantity: _str(input.quantity, 80),
    notes: _str(input.notes, 1000),
    source: _str(input.source, 60) || 'nhs-app',
  };
  if (!rec.nameKey) return { ok: false, why: 'a record needs a name made of letters or numbers' };
  return { ok: true, record: rec };
}

/**
 * What makes two records the SAME record. PURE.
 * A test on a day, a medicine issued on a day, a condition (with its date when
 * the record gives one). A medicine re-issued next month is a new row — the
 * issue history IS the prescription record.
 */
function dedupeKey(rec) {
  return [rec.kind, rec.nameKey, rec.date || ''].join('|');
}

function contentOf(rec) {
  const out = {};
  for (const f of CONTENT_FIELDS) out[f] = rec[f] ?? null;
  return out;
}

// ── The model's answer ───────────────────────────────────────────────────────

/**
 * The vision model's JSON, turned into proposed records. PURE.
 * Each entry is normalised; an entry that fails is kept as REFUSED with its
 * reason rather than dropped, so Nick sees what the model read and why it will
 * not go in.
 */
function parseProposal(text, { today = new Date() } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, why: 'the model returned nothing' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end < start) return { ok: false, why: 'could not read the answer the model produced' };
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    return { ok: false, why: `could not read the answer the model produced (${e.message.slice(0, 60)})` };
  }
  if (!parsed || !Array.isArray(parsed.records)) return { ok: false, why: 'the model did not return a list of records' };

  const proposed = [];
  const refused = [];
  const seen = new Set();
  parsed.records.forEach((entry, i) => {
    const n = normaliseRecord(entry, { today });
    if (!n.ok) { refused.push({ index: i, read: entry, why: n.why }); return; }
    // Overlapping screenshots of one scroll show the same row twice.
    const key = dedupeKey(n.record);
    if (seen.has(key)) return;
    seen.add(key);
    proposed.push(n.record);
  });
  return {
    ok: true,
    proposed,
    refused,
    screen: _str(parsed.screen, 200),
    unreadable: Array.isArray(parsed.unreadable) ? parsed.unreadable.map((u) => _str(u, 200)).filter(Boolean).slice(0, 20) : [],
  };
}

const SYSTEM = [
  'You transcribe screenshots of the NHS App (England) into structured records.',
  'You are a careful copy typist, not a clinician: copy exactly what is shown and never interpret, explain, diagnose or advise.',
].join(' ');

function buildPrompt(count) {
  return [
    count > 1
      ? `These ${count} screenshots are from the NHS App, probably one scrolling screen; rows may repeat where they overlap.`
      : 'This screenshot is from the NHS App.',
    'Transcribe every test result, diagnosis (problem / condition) and prescription (medicine) shown.',
    '',
    'Rules:',
    '- Copy names, values, units and ranges EXACTLY as printed. Keep qualifiers like "<0.5" in the value.',
    '- flag: only if the screen itself says so (e.g. "High", "Low", "Abnormal", "Normal"). Never work it out from the range.',
    '- date: the date shown for that item, as YYYY-MM-DD (or YYYY-MM / YYYY if that is all it shows). If a date applies to a group of rows, use it for each.',
    '- If a value or date is cut off or unreadable, leave that record out and describe it in "unreadable" instead of guessing.',
    '- Do not include anything that is not a test result, diagnosis or prescription (no navigation, adverts or GP practice details).',
    '',
    'Answer with JSON only, in this shape:',
    '{',
    '  "screen": "what this screen is, e.g. Test results: Full blood count",',
    '  "records": [',
    '    {"kind": "test_result", "name": "Haemoglobin", "date": "2026-03-12", "value": "145", "unit": "g/L", "referenceRange": "130 - 180", "flag": null, "panel": "Full blood count", "status": "final"},',
    '    {"kind": "diagnosis", "name": "Asthma", "date": "2014", "status": "active", "code": null},',
    '    {"kind": "prescription", "name": "Sertraline 50mg tablets", "date": "2026-09-01", "dose": "50mg", "directions": "One to be taken each day", "quantity": "28 tablet", "status": "repeat"}',
    '  ],',
    '  "unreadable": ["row 3 value cut off"]',
    '}',
    '',
    'kind is one of test_result, diagnosis, prescription. If there are no such records, return "records": [].',
  ].join('\n');
}

// ── Storage ──────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function _rowToRecord(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    date: r.record_date,
    datePrecision: r.date_precision,
    value: r.value_text,
    valueNum: r.value_num,
    unit: r.unit,
    referenceRange: r.reference_range,
    flag: r.flag,
    status: r.status,
    panel: r.panel,
    code: r.code,
    dose: r.dose,
    directions: r.directions,
    quantity: r.quantity,
    notes: r.notes,
    source: r.source,
    enteredVia: r.entered_via,
    enteredBy: r.entered_by,
    revisions: r.previous_json ? JSON.parse(r.previous_json).length : 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Store records. Validates every one; a refused record is reported with its
 * index and reason and does not stop the rest (a batch from ChatGPT with one
 * misread row should still land the other twenty).
 *
 * @param {object[]} inputs
 * @param {{via: 'screenshot'|'structured', by: string}} provenance
 */
function upsert(inputs, { via = 'structured', by = 'nick', today = new Date() } = {}) {
  if (!Array.isArray(inputs)) return { ok: false, why: 'records must be a list' };
  if (!inputs.length) return { ok: false, why: 'no records to save' };
  if (inputs.length > MAX_BATCH) return { ok: false, why: `at most ${MAX_BATCH} records at a time (got ${inputs.length})` };

  const db = _db();
  const results = [];
  const counts = { created: 0, unchanged: 0, revised: 0, refused: 0 };
  db.batchSaves(() => {
    inputs.forEach((input, index) => {
      const n = normaliseRecord(input, { today });
      if (!n.ok) { counts.refused++; results.push({ index, outcome: 'refused', why: n.why }); return; }
      const rec = n.record;
      const key = dedupeKey(rec);
      const content = contentOf(rec);
      const existing = db.get('SELECT * FROM medical_records WHERE dedupe_key = ?', [key]);
      if (!existing) {
        const info = db.run(
          `INSERT INTO medical_records (dedupe_key, kind, name, name_key, record_date, date_precision,
             value_text, value_num, unit, reference_range, flag, status, panel, code, dose, directions,
             quantity, notes, source, content_json, entered_via, entered_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [key, rec.kind, rec.name, rec.nameKey, rec.date, rec.datePrecision, rec.value, rec.valueNum,
            rec.unit, rec.referenceRange, rec.flag, rec.status, rec.panel, rec.code, rec.dose,
            rec.directions, rec.quantity, rec.notes, rec.source, JSON.stringify(content), via, by]
        );
        counts.created++;
        results.push({ index, outcome: 'created', id: Number(info.lastInsertRowid), key });
        return;
      }
      if (existing.content_json === JSON.stringify(content)) {
        counts.unchanged++;
        results.push({ index, outcome: 'unchanged', id: existing.id, key });
        return;
      }
      const previous = existing.previous_json ? JSON.parse(existing.previous_json) : [];
      previous.push({ content: JSON.parse(existing.content_json), enteredVia: existing.entered_via,
        enteredBy: existing.entered_by, replacedAt: new Date().toISOString() });
      db.run(
        `UPDATE medical_records SET name = ?, record_date = ?, date_precision = ?, value_text = ?, value_num = ?,
           unit = ?, reference_range = ?, flag = ?, status = ?, panel = ?, code = ?, dose = ?, directions = ?,
           quantity = ?, notes = ?, source = ?, content_json = ?, previous_json = ?, entered_via = ?,
           entered_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [rec.name, rec.date, rec.datePrecision, rec.value, rec.valueNum, rec.unit, rec.referenceRange,
          rec.flag, rec.status, rec.panel, rec.code, rec.dose, rec.directions, rec.quantity, rec.notes,
          rec.source, JSON.stringify(content), JSON.stringify(previous), via, by, existing.id]
      );
      counts.revised++;
      results.push({ index, outcome: 'revised', id: existing.id, key });
    });
  });
  return { ok: true, ...counts, results };
}

/**
 * Read records. Newest first within a kind. `name` is a whole-name match on the
 * normalised key, so asking for "HbA1c" never returns "HbA1c (IFCC)" by accident.
 */
function list({ kind = null, name = null, from = null, to = null, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (name) { where.push('name_key = ?'); params.push(nameKey(name)); }
  if (from) { where.push("COALESCE(record_date, '') >= ?"); params.push(from); }
  if (to) { where.push("COALESCE(record_date, '') <= ?"); params.push(to); }
  const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
  const rows = _db().all(
    `SELECT * FROM medical_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY kind, COALESCE(record_date, '') DESC, name LIMIT ?`,
    [...params, lim]
  );
  const total = _db().get(
    `SELECT COUNT(*) AS n FROM medical_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params
  ).n;
  return { records: rows.map(_rowToRecord), total, shown: rows.length };
}

function summary() {
  const rows = _db().all(
    `SELECT kind, COUNT(*) AS n, MAX(record_date) AS latest FROM medical_records GROUP BY kind`, []
  );
  const out = {};
  for (const k of KINDS) out[k] = { count: 0, latest: null };
  for (const r of rows) out[r.kind] = { count: r.n, latest: r.latest };
  return out;
}

/** Every reading of one test, oldest first — the shape a trend wants. */
function testHistory(name) {
  const rows = _db().all(
    `SELECT * FROM medical_records WHERE kind = 'test_result' AND name_key = ?
     ORDER BY record_date ASC`, [nameKey(name)]
  );
  return rows.map(_rowToRecord);
}

function get(id) {
  return _rowToRecord(_db().get('SELECT * FROM medical_records WHERE id = ?', [Number(id)]));
}

function remove(id) {
  const info = _db().run('DELETE FROM medical_records WHERE id = ?', [Number(id)]);
  return info.changes > 0;
}

// ── The vision call ──────────────────────────────────────────────────────────

/**
 * Screenshots in, a PROPOSAL out. Writes nothing, keeps no image.
 *
 * @param {{images: {imageBase64: string, mediaType: string}[]}} input
 */
async function proposeFromScreenshots({ images } = {}, deps = {}) {
  if (!Array.isArray(images) || !images.length) return { ok: false, why: 'no screenshots arrived' };
  if (images.length > MAX_IMAGES) return { ok: false, why: `at most ${MAX_IMAGES} screenshots at a time` };
  const clean = [];
  for (const [i, img] of images.entries()) {
    const mediaType = String(img && img.mediaType || '');
    let data = String(img && img.imageBase64 || '');
    // A data: URL is the commonest way to send this wrongly; strip it rather
    // than 400 at the provider.
    const m = data.match(/^data:([^;]+);base64,(.*)$/);
    if (m) data = m[2];
    if (!MEDIA_TYPES.has(mediaType)) return { ok: false, why: `screenshot ${i + 1} is not a kind of picture I can read` };
    if (!data) return { ok: false, why: `screenshot ${i + 1} is empty` };
    if (Math.floor(data.length * 3 / 4) > MAX_IMAGE_BYTES) return { ok: false, why: `screenshot ${i + 1} is too big` };
    clean.push({ imageBase64: data, mediaType });
  }

  const aiRouting = deps.aiRouting || require('./ai-routing');
  const provider = deps.provider || require('./providers/anthropic-provider');
  if (!aiRouting.isCloudAllowed('medical_scan')) {
    return { ok: false, why: 'Cloud AI is not allowed right now (AI mode or today’s budget), so I can’t read screenshots.' };
  }
  if (!provider.isConfigured()) return { ok: false, why: 'No vision model is configured, so I can’t read screenshots.' };

  let result;
  try {
    result = await provider.vision(SYSTEM, { images: clean, prompt: buildPrompt(clean.length) }, {
      model: process.env.MEDICAL_VISION_MODEL || 'claude-opus-5',
      effort: 'medium',
      maxTokens: 8000,
    });
  } catch (e) {
    // The provider's message can name a model or key state; logged, not echoed.
    console.warn('[Medical] Vision call failed:', e.message);
    return { ok: false, why: e.refusal ? 'The model declined to read that screenshot.' : 'I couldn’t read those screenshots just now.' };
  }
  try {
    aiRouting.recordUsage(result.usage, { provider: 'anthropic', model: result.model, taskType: 'medical_scan' });
  } catch { /* bookkeeping never fails the answer */ }

  const parsed = parseProposal(result.text, { today: deps.today || new Date() });
  if (!parsed.ok) return { ok: false, why: parsed.why };
  return { ok: true, ...parsed };
}

module.exports = {
  // pure
  parseDate,
  parseValue,
  normaliseRecord,
  dedupeKey,
  nameKey,
  parseProposal,
  buildPrompt,
  // stateful
  upsert,
  list,
  summary,
  testHistory,
  get,
  remove,
  proposeFromScreenshots,
  // constants
  KINDS,
  FLAGS,
  STATUSES,
  MAX_BATCH,
  MAX_IMAGES,
};
