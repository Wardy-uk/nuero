'use strict';

/**
 * Lead reminders for personal dates — a cadence Nick SETS (8 Oct 2026: "deffo
 * need an anniversary nag … 10 days, 5 days and 1 day out", refined the same
 * day into graduated steps).
 *
 * The cadence is per KIND ("anniversary lead reminders: [10, 5, 1] days"),
 * transparent and editable, never logic for one date. With no cadence set for
 * a kind nothing changes and nothing sends — personal-dates itself still never
 * sends. The steps, for offsets sorted largest first:
 *
 *   first (10)   CONTEXT — on the Future Radar / Now only: "… in 10 days."
 *   middle (5)   PROMPT  — stronger words, still no push: "… in 5 days.
 *                Nothing prepared yet." / "Still open: '<prep>'."
 *   last (1)     NEEDS YOU — and the ONE push — only when no linked prep is
 *                completed. The only step where interrupting is justified.
 *
 * Completed prep (explicitly linked, or named) suppresses the prompt and the
 * push: those steps become a calm "Prep done" context line. Open prep is
 * referenced by name instead of "nothing prepared". No task is ever created.
 * The push goes once per date per year (ledger claimed before sending), from
 * NAG_HOUR local; a day the Pi missed entirely is not replayed.
 *
 * `reminderStage` is PURE and used by BOTH the Radar and the push pass, so the
 * screen and the notification cannot disagree.
 */

const NAG_HOUR = 9;
const KINDS = Object.freeze(['birthday', 'anniversary', 'other']);
const MAX_OFFSETS = 5;
const MAX_OFFSET_DAYS = 60;
const DAY_MS = 86400000;
const _utc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const daysBetween = (a, b) => Math.round((_utc(b) - _utc(a)) / DAY_MS);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (d) => `${DAYS[new Date(_utc(d)).getUTCDay()]} ${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;
const kindOf = (d) => (KINDS.includes(d && d.kind) ? d.kind : 'other');

// ── pure ────────────────────────────────────────────────────────────────────

/** Validate a cadence. Refused, never clamped. PURE. null = clear. */
function parseOffsets(v) {
  if (v === null) return { ok: true, value: null };
  if (!Array.isArray(v) || !v.length) return { ok: false, error: 'offsets must be a list of days before the date, e.g. [10, 5, 1], or null to clear' };
  if (v.length > MAX_OFFSETS) return { ok: false, error: `at most ${MAX_OFFSETS} steps` };
  const n = v.map(Number);
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > MAX_OFFSET_DAYS)) return { ok: false, error: `each step must be a whole number of days from 0 to ${MAX_OFFSET_DAYS}` };
  return { ok: true, value: [...new Set(n)].sort((a, b) => b - a) };
}

const quote = (ps) => ps.map((p) => `"${p.title}"`).join(', ');
const inWords = (away) => (away === 0 ? 'is today' : away === 1 ? 'is tomorrow' : `is in ${away} days`);

/**
 * Where a date stands on its cadence. PURE.
 *   d        { id, title, date, kind }
 *   offsets  the kind's cadence (desc) or null
 *   prep     [{ title, status }] explicit links + named prep
 * → null (outside the cadence / none set) or
 *   { stage: 'context'|'prompt'|'needs_you', step, away, line, push, prepState }
 */
function reminderStage(d, { today, offsets, prep = [] }) {
  if (!offsets || !offsets.length || !d || !d.date) return null;
  const away = daysBetween(today, d.date);
  if (away < 0 || away > offsets[0]) return null;
  // The step reached: the smallest offset that is still ≥ away.
  let idx = 0;
  for (let i = 0; i < offsets.length; i += 1) if (offsets[i] >= away) idx = i;
  const step = offsets[idx];
  const open = prep.filter((p) => p.status === 'open' || p.status === 'in-progress');
  const done = prep.filter((p) => p.status === 'completed' || p.status === 'done');
  const prepState = open.length ? 'open' : done.length ? 'done' : 'none';
  const head = `${d.title} ${inWords(away)} (${dayWords(d.date)}).`;
  const tier = offsets.length === 1 ? 'last' : idx === 0 ? 'first' : idx === offsets.length - 1 ? 'last' : 'middle';
  if (tier === 'first') {
    return { stage: 'context', step, away, prepState, push: false,
      line: prepState === 'done' ? `${head} Prep done: ${quote(done)}.` : prepState === 'open' ? `${head} Prep open: ${quote(open)}.` : head };
  }
  // Prep completed: the prompt and the push suppress themselves.
  if (prepState === 'done') return { stage: 'context', step, away, prepState, push: false, line: `${head} Prep done: ${quote(done)}.` };
  const tail = prepState === 'open' ? `Still open: ${quote(open)}.` : 'Nothing prepared yet.';
  if (tier === 'middle') return { stage: 'prompt', step, away, prepState, push: false, line: `${head} ${tail}` };
  return { stage: 'needs_you', step, away, prepState, push: true, line: `${head} ${tail}` };
}

// ── store ───────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }
const TZ = () => process.env.NEURO_TIMEZONE || 'Europe/London';
const KEY = (kind) => `kind:${kind}`;

function _local(nowMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  return { today: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

/** { anniversary: [10,5,1], … } — only kinds Nick set. */
function cadences() {
  const out = {};
  try {
    for (const r of _db().all("SELECT nag_key, offsets_json FROM personal_date_nags WHERE nag_key LIKE 'kind:%'")) {
      try { out[r.nag_key.slice(5)] = JSON.parse(r.offsets_json); } catch { /* unreadable: no cadence */ }
    }
  } catch { /* no table yet */ }
  return out;
}

/** Nick sets (or clears) the lead reminders for a kind of date. */
function setCadence({ kind, offsets } = {}, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!KINDS.includes(kind)) return { ok: false, status: 400, error: `kind must be one of ${KINDS.join(', ')}` };
  const v = parseOffsets(offsets);
  if (!v.ok) return { ...v, status: 400 };
  const db = _db();
  if (v.value === null) db.run('DELETE FROM personal_date_nags WHERE nag_key = ?', [KEY(kind)]);
  else {
    db.run(`INSERT INTO personal_date_nags (nag_key, title, offsets_json, set_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(nag_key) DO UPDATE SET offsets_json = excluded.offsets_json, set_at = excluded.set_at`,
    [KEY(kind), `${kind} lead reminders`, JSON.stringify(v.value), new Date(nowMs).toISOString()]);
  }
  require('./personal-obligations').logEvent('lead-reminders-set', {
    subjectId: KEY(kind), actor: 'nick', dedupeKey: `lead-reminders:${kind}:${nowMs}`, now: nowMs, detail: { kind, offsets: v.value },
  });
  return { ok: true, kind, offsets: v.value };
}

/** Prep known for a date: explicit links first, then personal-dates' named prep. */
function prepFor(d) {
  const out = [];
  try {
    const ids = require('./personal-obligations').prepLinkMap().bySubject.get(d.id) || [];
    const wo = require('./world-obligations');
    for (const id of ids) { const t = wo.getTask(id); if (t) out.push({ title: t.title, status: t.status }); }
  } catch { /* prep unreadable: treated as none */ }
  for (const p of d.prep || []) if (!out.some((x) => x.title === p.title)) out.push({ title: p.title, status: p.status });
  return out;
}

/** The push pass: only the NEEDS YOU step pushes, once per date per year. */
async function run({ now = Date.now(), send = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const cad = cadences();
  if (!Object.keys(cad).length) return { ok: true, due: 0, sent: 0 };
  const { today, hour } = _local(nowMs);
  if (hour < NAG_HOUR) return { ok: true, due: 0, sent: 0, waiting: `until ${NAG_HOUR}:00` };
  const pd = require('./personal-dates').read({ now: nowMs });
  const db = _db();
  const push = send || ((t, b, data) => require('./webpush').sendToAll(t, b, data));
  let due = 0; let n = 0;
  for (const d of [...(pd.active || []), ...(pd.later || [])]) {
    const st = reminderStage(d, { today, offsets: cad[kindOf(d)], prep: prepFor(d) });
    if (!st || !st.push) continue;
    due += 1;
    const sendKey = `${d.id}@needs_you`;
    const claim = db.run('INSERT OR IGNORE INTO personal_date_nag_sends (send_key, nag_key, date, offset_days, at) VALUES (?, ?, ?, ?, ?)',
      [sendKey, KEY(kindOf(d)), d.date, st.away, new Date(nowMs).toISOString()]);
    if (!claim || !claim.changes) continue;
    try {
      await push(`SAiM — ${d.title}`, st.line, { type: 'personal_date', dateId: d.id });
      n += 1;
    } catch (e) {
      db.run('DELETE FROM personal_date_nag_sends WHERE send_key = ?', [sendKey]);
      console.warn(`[LeadReminders] ${sendKey} not sent: ${e.message}`);
    }
  }
  return { ok: true, due, sent: n };
}

module.exports = { NAG_HOUR, KINDS, parseOffsets, reminderStage, cadences, setCadence, prepFor, run, kindOf };
