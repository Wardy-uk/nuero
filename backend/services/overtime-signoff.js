'use strict';

/**
 * Chris signs off overtime a WEEK at a time (Nick, 5 Nov 2026).
 *
 * Nick approves his team's overtime in NEURO (services/overtime-claims.js); NOVA refuses to let
 * him decide his OWN claims, so until now nobody approved them. Now Chris signs off every week:
 *
 *   Monday 09:00 (working day)      last week's approved team claims + Nick's own pending claims,
 *                                   any earlier week still unsigned flagged, the .xlsx attached.
 *   Working day before the cut-off  a reminder, only if something is still unsigned.
 *   Cut-off morning 08:00           the part-week since Monday + anything outstanding; when
 *                                   nothing is, a short "all signed off" confirmation.
 *
 * The CUT-OFF (default the 16th, moved back over weekends and bank holidays, overridable per
 * month) defines the payroll month for the whole team: a month label M runs from the day after
 * M-1's cut-off to M's cut-off. NOVA builds the file for that period.
 *
 * Chris's reply is read off the thread (the subject carries `ref OT-<id>`). A short, plain
 * "signed off / approved" signs off every claim in that email and approves Nick's own claims
 * in NOVA with CHRIS as the decider. Anything else — a question, an exception, a rejection,
 * a model that is unsure, a model that is down — comes to Nick to confirm, and nothing is
 * recorded until he does. Sign-off is stored PER CLAIM, so a late claim (approved after its
 * week went) is simply unsigned and rides in the next email.
 *
 * The payroll email cannot be prepared while any claim in the file is unsigned.
 *
 * Sending: the overtime_signoff_auto_send switch (default ON) is the standing approval of these
 * emails (intent-grants.STANDING_SWITCH_ORIGINS), on a working day 08:00–18:00; with it off they
 * wait on Actions for Nick's press.
 */

const crypto = require('crypto');
const db = require('../db/database');
const nova = require('./nova-client');
const wd = require('../../shared/working-days.cjs');

const AUTO_FLAG = 'overtime_signoff_auto_send';
const ORIGIN = 'overtime-signoff';
const CUTOFF_KEY = 'overtime_cutoff';
const DEFAULT_CUTOFF_DAY = 16;
const SEND_AT = { weekly: '09:00', reminder: '09:00', cutoff: '08:00' };
const LAST_SEND = '18:00';
const LOOKBACK_DAYS = 120; // approved, unsent claims older than this are not asked about again
const REPLY_WATCH_DAYS = 30;
const READ_TIMEOUT = 60000;
const CHRIS_NAME = () => (process.env.OVERTIME_SIGNOFF_NAME || 'Chris Middleton').trim();

const DEFAULT_DEPS = {
  now: () => Date.now(),
  holidays: () => { try { return require('./working-days').holidaySet(); } catch { return new Set(); } },
  nova: (p, o) => nova.call(p, o),
  nickEmail: () => require('./mail-identity').WORK_ADDRESS,
  chris: () => {
    const name = CHRIS_NAME();
    const hits = require('./contact-directory').fromPeopleNotes().filter((c) => c.name.toLowerCase() === name.toLowerCase());
    if (hits.length === 1) return { ok: true, name: hits[0].name, email: hits[0].email };
    return { ok: false, error: hits.length ? `more than one People note is called ${name}` : `no People note called ${name} carries an email: line` };
  },
  prepareCompose: (a) => require('./prepared-actions').prepareCompose(a),
  getAction: (id) => require('./prepared-actions').get(id),
  approve: (id, o) => require('./prepared-actions').approve(id, o),
  execute: (id) => require('./action-executor').execute(id),
  autoOn: () => { try { return require('./feature-flags').isEnabled(AUTO_FLAG); } catch { return false; } },
  replies: (q) => require('./mail-read').findReplies(q),
  judge: async (prompt) => {
    const r = await require('./ai-routing').runTask('overtime_signoff_reply', { prompt, maxTokens: 200 }, { forceCloud: true, timeout: 60000 });
    return r && r.text ? r.text : null;
  },
  push: (title, body, data) => require('./webpush').sendToAll(title, body, { type: 'overtime_signoff', url: '/?view=overtime', ...(data || {}) }),
};
const deps = (d) => ({ ...DEFAULT_DEPS, ...(d || {}) });

// ── dates (PURE) ─────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (day, n) => { const d = dateOf(day); d.setDate(d.getDate() + n); return ymd(d); };
const mondayOf = (day) => addDays(day, -((dateOf(day).getDay() + 6) % 7));
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shortDay = (day) => `${DAYS[dateOf(day).getDay()]} ${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const shortDate = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const shiftMonth = (month, n) => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + n, 1, 12); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const isWorking = (day, holidays) => wd.isWorkingDay(dateOf(day), holidays);

/** Cut-off settings: { day, overrides: { 'YYYY-MM': 'YYYY-MM-DD' } }. PURE validation. */
function validateCutoff(input = {}) {
  const day = input.day == null ? DEFAULT_CUTOFF_DAY : Number(input.day);
  if (!Number.isInteger(day) || day < 1 || day > 28) return { error: 'the cut-off day must be a whole number from 1 to 28' };
  const overrides = {};
  for (const [m, d] of Object.entries(input.overrides || {})) {
    if (!MONTH_RE.test(m)) return { error: `${m} is not a month (YYYY-MM)` };
    if (d == null || d === '') continue; // clearing an override
    if (!DAY_RE.test(String(d)) || String(d).slice(0, 7) !== m) return { error: `the ${m} override must be a date in ${m}` };
    overrides[m] = String(d);
  }
  return { day, overrides };
}

/** The cut-off date for a month label. An override wins; otherwise the day, moved back to a working day. PURE. */
function cutoffDate(month, settings, holidays) {
  const s = settings || { day: DEFAULT_CUTOFF_DAY, overrides: {} };
  if (s.overrides && s.overrides[month]) return { date: s.overrides[month], overridden: true };
  let day = `${month}-${pad(s.day)}`;
  for (let i = 0; i < 10 && !isWorking(day, holidays); i += 1) day = addDays(day, -1);
  return { date: day, overridden: false };
}

/** The payroll period behind a month label: the day after last month's cut-off to this month's. PURE. */
function periodFor(month, settings, holidays) {
  const prev = cutoffDate(shiftMonth(month, -1), settings, holidays);
  const cur = cutoffDate(month, settings, holidays);
  return { month, from: addDays(prev.date, 1), to: cur.date, overridden: cur.overridden };
}

/** Which month label a day falls in. PURE. */
function periodMonthOf(day, settings, holidays) {
  const month = day.slice(0, 7);
  return day <= cutoffDate(month, settings, holidays).date ? month : shiftMonth(month, 1);
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
}

/** Which email is due today, if any (before its time is checked). PURE. */
function dueKinds(today, settings, holidays) {
  const out = [];
  if (!isWorking(today, holidays)) return out;
  const month = periodMonthOf(today, settings, holidays);
  const cut = cutoffDate(month, settings, holidays).date;
  if (today === cut) out.push({ kind: 'cutoff', coverTo: cut, month });
  else {
    let before = addDays(cut, -1);
    for (let i = 0; i < 10 && !isWorking(before, holidays); i += 1) before = addDays(before, -1);
    if (today === before) out.push({ kind: 'reminder', coverTo: cut, month });
  }
  // The Monday email covers last week. A cut-off Monday's own email covers it instead.
  if (dateOf(today).getDay() === 1 && today !== cut) out.push({ kind: 'weekly', coverTo: addDays(today, -1), month });
  return out;
}

// ── the email (PURE) ─────────────────────────────────────────────────────────

// The governed executor refuses a draft with [anything] in it (an unfilled placeholder).
const clean = (s) => String(s || '').replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s+/g, ' ').trim();
const hours = (c) => Math.round((Number(c.minutes) || 0) / 60 * 100) / 100;
const fmtH = (h) => `${h} hour${h === 1 ? '' : 's'}`;

function claimLine(c, { withName = true } = {}) {
  const warn = c.wtr && Array.isArray(c.wtr.warnings) && c.wtr.warnings.length
    ? ` — Working Time: ${c.wtr.warnings.map((w) => clean(w.message)).join('; ')}${c.overrideReason ? ` (approved because: ${clean(c.overrideReason)})` : ''}`
    : '';
  return `- ${withName ? `${clean(c.agentName)}: ` : ''}${shortDay(c.date)} ${c.start}–${c.end}, ${fmtH(hours(c))} — ${clean(c.reason)}${c.enteredBy ? ' (added by Nick)' : ''}${warn}`;
}

/**
 * The words of one sign-off email. `team` = approved claims to sign off, `own` = Nick's own
 * pending claims, `reportWeek` = the Monday of the week the email is "about" (older weeks are
 * flagged as still waiting). PURE.
 */
function composeEmail({ kind, ref, team, own, coverTo, period, chrisFirst = 'Chris', reportWeek = null }) {
  const greeting = `Hi ${chrisFirst},`;
  const ending = ['', 'Thanks,', 'Nick'];
  if (!team.length && !own.length) {
    return {
      subject: `Overtime ${monthLabel(period.month)} — all signed off (ref OT-${ref})`,
      body: [greeting, '', `Today is the overtime cut-off for ${monthLabel(period.month)} (${shortDate(period.from)} to ${shortDate(period.to)}).`,
        'Everything for the period has been signed off, so nothing is needed from you. Payroll will get the file today.', ...ending].join('\n'),
    };
  }
  const byWeek = new Map();
  for (const c of team) { const w = mondayOf(c.date); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(c); }
  const weeks = [...byWeek.keys()].sort();
  const lines = [];
  const current = weeks.filter((w) => !reportWeek || w >= reportWeek);
  const earlier = weeks.filter((w) => reportWeek && w < reportWeek);
  const weekBlock = (w) => {
    const list = byWeek.get(w).sort((a, b) => (a.agentName + a.date + a.start).localeCompare(b.agentName + b.date + b.start));
    const end = addDays(w, 6) < coverTo ? addDays(w, 6) : coverTo;
    const total = Math.round(list.reduce((s, c) => s + hours(c), 0) * 100) / 100;
    return [`Week ${shortDate(w)} to ${shortDate(end)} — ${fmtH(total)}:`, ...list.map((c) => claimLine(c)), ''];
  };
  if (current.length) for (const w of current) lines.push(...weekBlock(w));
  if (earlier.length) {
    lines.push('Still waiting for your sign-off from earlier weeks (including any approved after their week was sent):', '');
    for (const w of earlier) lines.push(...weekBlock(w));
  }
  const people = new Map();
  for (const c of team) { const t = people.get(c.agentName) || 0; people.set(c.agentName, Math.round((t + hours(c)) * 100) / 100); }
  const totals = [...people.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, h]) => `- ${clean(n)}: ${fmtH(h)}`);
  const grand = Math.round(team.reduce((s, c) => s + hours(c), 0) * 100) / 100;

  const intro = kind === 'weekly'
    ? `Here is last week's overtime for you to sign off${earlier.length ? ', plus anything still outstanding' : ''}.`
    : kind === 'reminder'
      ? `Tomorrow is the overtime cut-off for ${monthLabel(period.month)}, and these still need your sign-off before payroll can go.`
      : `Today is the overtime cut-off for ${monthLabel(period.month)} (${shortDate(period.from)} to ${shortDate(period.to)}). These are the last items to sign off before payroll gets the file.`;
  const ownBlock = own.length ? ['My own overtime, for you to approve:', ...own.map((c) => claimLine(c, { withName: false })), ''] : [];
  const what = team.length && own.length ? 'sign off the team overtime and approve mine'
    : team.length ? 'sign off all of the above' : 'approve my overtime';
  const subjectWhat = kind === 'weekly' ? `week to ${shortDate(coverTo)}` : kind === 'reminder' ? `final sign-off for ${monthLabel(period.month)}` : `${monthLabel(period.month)} cut-off`;
  return {
    subject: `Overtime sign-off — ${subjectWhat} (ref OT-${ref})`,
    body: [greeting, '', intro, '',
      ...(team.length ? [...lines, 'Totals:', ...totals, `Total: ${fmtH(grand)}${team.length ? ' (the spreadsheet is attached)' : ''}.`, ''] : []),
      ...ownBlock,
      `If it all looks right, just reply "signed off" and that will ${what}. If anything isn't right, say which and I'll hold it.`,
      ...ending].join('\n'),
  };
}

// ── reading Chris's reply (PURE parts) ───────────────────────────────────────

const APPROVE_SHORT = /^(yes|yep|ok|okay|fine|approved|all approved|approve(d)? all|signed off|sign(ed)? off|all signed off|all good|looks good|happy|all fine|agreed|confirmed|done)\b/;
const DOUBT = /\?|\b(except|but|not|no|query|question|hold|wrong|reject|don'?t|isn'?t|aren'?t|can'?t|missing|check|why|unless|apart from|other than|however)\b/;

/** The new part of a reply, without signatures or the quoted thread. PURE. */
function replyText(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(from|sent|on .* wrote):/i.test(l) || /^-{2,}\s*original message/i.test(l) || /^_{5,}/.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** 'approve' | 'unsure' | 'doubt' without a model. PURE. */
function quickVerdict(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return 'unsure';
  if (DOUBT.test(t)) return 'doubt';
  const first = t.split(/[\n.!]/)[0].trim();
  if (t.length <= 80 && APPROVE_SHORT.test(first)) return 'approve';
  return 'unsure';
}

function judgePrompt(text, summary) {
  return [
    'Chris was asked by email to sign off overtime claims and approve Nick\'s own overtime.',
    `The email listed: ${summary}.`,
    'His reply (the new part only):', '"""', String(text).slice(0, 2000), '"""',
    'Answer with JSON only: {"verdict": "all-approved" | "partial" | "rejected" | "query" | "unclear"}.',
    'all-approved = he clearly signs off / approves EVERYTHING with no exception, condition or question.',
    'Anything else, or if you are not sure, is not all-approved.',
  ].join('\n');
}

function parseVerdict(answer) {
  const m = String(answer || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const v = JSON.parse(m[0]).verdict; return ['all-approved', 'partial', 'rejected', 'query', 'unclear'].includes(v) ? v : null; } catch { return null; }
}

// ── store ────────────────────────────────────────────────────────────────────

let ensured = false;
function ensureTables() {
  if (ensured) return;
  db.run(`CREATE TABLE IF NOT EXISTS overtime_signoff_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,
    run_date      TEXT NOT NULL,
    period_month  TEXT NOT NULL,
    cover_to      TEXT NOT NULL,
    team_ids      TEXT NOT NULL,
    own_ids       TEXT NOT NULL,
    claims_json   TEXT NOT NULL,
    action_id     TEXT,
    status        TEXT NOT NULL,
    chris_email   TEXT,
    error         TEXT,
    reply_json    TEXT,
    decided_at    TEXT,
    decided_by    TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE(kind, run_date)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS overtime_signoffs (
    claim_id    INTEGER PRIMARY KEY,
    request_id  INTEGER,
    signed_at   TEXT NOT NULL,
    signed_by   TEXT NOT NULL,
    note        TEXT
  )`);
  ensured = true;
}

function readCutoff() {
  try { const v = JSON.parse(db.getState(CUTOFF_KEY) || 'null'); const c = validateCutoff(v || {}); if (!c.error) return c; } catch { /* default */ }
  return { day: DEFAULT_CUTOFF_DAY, overrides: {} };
}

function setCutoff(input) {
  const cur = readCutoff();
  const merged = { day: input.day == null ? cur.day : input.day, overrides: { ...cur.overrides, ...(input.overrides || {}) } };
  const c = validateCutoff(merged);
  if (c.error) return { ok: false, code: 400, error: c.error };
  db.setState(CUTOFF_KEY, JSON.stringify(c));
  return { ok: true, cutoff: c };
}

function signedSet() {
  ensureTables();
  return new Set(db.all('SELECT claim_id FROM overtime_signoffs').map((r) => r.claim_id));
}

function recordSignoffs(claimIds, { requestId = null, by, note = null, now = Date.now() } = {}) {
  ensureTables();
  let n = 0;
  for (const id of claimIds) {
    if (!Number.isInteger(id) || id <= 0) continue;
    const r = db.run('INSERT OR IGNORE INTO overtime_signoffs (claim_id, request_id, signed_at, signed_by, note) VALUES (?, ?, ?, ?, ?)',
      [id, requestId, new Date(now).toISOString(), by, note]);
    if (r && r.changes) n += 1;
  }
  return n;
}

const _req = (id) => db.get('SELECT * FROM overtime_signoff_requests WHERE id = ?', [id]);
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

function shapeRequest(r) {
  const claims = parse(r.claims_json, { team: [], own: [] });
  const signed = signedSet();
  return {
    id: r.id, kind: r.kind, runDate: r.run_date, month: r.period_month, coverTo: r.cover_to, status: r.status,
    actionId: r.action_id, error: r.error, reply: parse(r.reply_json, null), decidedAt: r.decided_at, decidedBy: r.decided_by,
    team: claims.team.map((c) => ({ ...c, signed: signed.has(c.id) })),
    own: claims.own.map((c) => ({ ...c, signed: signed.has(c.id) })),
    createdAt: r.created_at,
  };
}

// ── what is outstanding ──────────────────────────────────────────────────────

const slim = (c) => ({
  id: c.id, agentName: c.agentName, agentEmail: c.agentEmail, date: c.date, start: c.start, end: c.end, minutes: c.minutes,
  reason: c.reason, enteredBy: c.enteredBy || null, overrideReason: c.overrideReason || null,
  wtr: c.wtr ? { warnings: c.wtr.warnings || [] } : null,
});

/** Approved team claims not signed off and not yet sent to payroll, and Nick's pending claims, dated ≤ coverTo. */
async function outstanding(coverTo, d) {
  const from = addDays(coverTo, -LOOKBACK_DAYS);
  const [approved, submitted] = await Promise.all([
    d.nova(`/api/neuro-bridge/overtime/claims?status=approved&from=${from}&to=${coverTo}`, { timeoutMs: READ_TIMEOUT }),
    d.nova(`/api/neuro-bridge/overtime/claims?status=submitted&from=${from}&to=${coverTo}`, { timeoutMs: READ_TIMEOUT }),
  ]);
  const me = String(d.nickEmail() || '').toLowerCase();
  const signed = signedSet();
  const team = (approved || []).filter((c) => !c.exportedMonth && !signed.has(c.id)).map(slim);
  const own = (submitted || []).filter((c) => String(c.agentEmail || '').toLowerCase() === me).map(slim);
  return { team, own };
}

// ── making and sending a request ─────────────────────────────────────────────

async function prepareRequest({ kind, today, coverTo, month }, d) {
  ensureTables();
  if (db.get('SELECT id FROM overtime_signoff_requests WHERE kind = ? AND run_date = ?', [kind, today])) return { ok: true, already: true };
  const settings = readCutoff();
  const period = periodFor(month, settings, d.holidays());
  const now = d.now();
  const base = { kind, today, month, coverTo, created: new Date(now).toISOString() };
  const store = (status, extra = {}) => {
    db.run(`INSERT OR IGNORE INTO overtime_signoff_requests (kind, run_date, period_month, cover_to, team_ids, own_ids, claims_json, action_id, status, chris_email, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, today, month, coverTo, JSON.stringify(extra.teamIds || []), JSON.stringify(extra.ownIds || []),
      JSON.stringify(extra.claims || { team: [], own: [] }), extra.actionId || null, status, extra.chris || null, extra.error || null, base.created]);
    return db.get('SELECT * FROM overtime_signoff_requests WHERE kind = ? AND run_date = ?', [kind, today]);
  };

  let out;
  try { out = await outstanding(coverTo, d); } catch (e) {
    return { ok: false, error: `NOVA could not be read: ${e.message}`, retry: true }; // no row: try again next tick
  }
  if (kind !== 'cutoff' && !out.team.length && !out.own.length) { store('nothing'); return { ok: true, nothing: true }; }

  const chris = d.chris();
  if (!chris.ok) {
    const row = store('held', { error: chris.error, claims: out, teamIds: out.team.map((c) => c.id), ownIds: out.own.map((c) => c.id) });
    await Promise.resolve(d.push('Overtime sign-off held', `The email to Chris was not prepared: ${chris.error}.`, { requestId: row.id })).catch(() => {});
    return { ok: false, error: chris.error };
  }

  // The ref goes in the subject, so it must be known first: claim the row, then fill it.
  const row = store('preparing', { claims: out, teamIds: out.team.map((c) => c.id), ownIds: out.own.map((c) => c.id), chris: chris.email });
  if (row.status !== 'preparing') return { ok: true, already: true };
  const mail = composeEmail({
    kind, ref: row.id, team: out.team, own: out.own, coverTo, period,
    chrisFirst: String(chris.name).split(/\s+/)[0], reportWeek: kind === 'weekly' ? mondayOf(coverTo) : mondayOf(today),
  });
  let attachments = null;
  if (out.team.length) {
    try {
      const f = await d.nova('/api/neuro-bridge/overtime/export/file', {
        method: 'POST', timeoutMs: READ_TIMEOUT,
        body: { title: `Overtime sign-off to ${coverTo}`, claimIds: out.team.map((c) => c.id) },
      });
      attachments = [{ name: f.filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dataBase64: f.xlsxBase64 }];
    } catch (e) {
      db.run('DELETE FROM overtime_signoff_requests WHERE id = ?', [row.id]); // nothing went out: try again next tick
      return { ok: false, error: e.message, retry: true };
    }
  }
  const r = d.prepareCompose({
    from: 'work', to: [chris.email], subject: mail.subject, body: mail.body, attachments,
    origin: ORIGIN, generatedBy: 'template (overtime-signoff.composeEmail, no model call) + NOVA claims',
    evidence: { overtimeSignoffRequest: row.id, claimIds: out.team.map((c) => c.id), ownClaimIds: out.own.map((c) => c.id) },
  });
  if (!r.ok) {
    db.run('UPDATE overtime_signoff_requests SET status = ?, error = ? WHERE id = ?', ['failed', r.error || 'not prepared', row.id]);
    return r;
  }
  db.run('UPDATE overtime_signoff_requests SET status = ?, action_id = ? WHERE id = ?', ['prepared', r.action.actionId, row.id]);
  return { ok: true, requestId: row.id, action: r.action };
}

/** PURE. Why NEURO may not send without a press, or null. */
function autoBlockedBy({ flagOn, wall, workingDay }) {
  if (!flagOn) return 'switch-off';
  if (!workingDay) return 'not-a-working-day';
  if (!wall || wall.time < '08:00' || wall.time >= LAST_SEND) return 'outside-hours';
  return null;
}

async function _sendPrepared(row, d, today, wall) {
  const action = d.getAction(row.action_id);
  if (!action) return;
  const status = action.status;
  if (['executed', 'verified'].includes(status) && row.status !== 'sent') {
    db.run('UPDATE overtime_signoff_requests SET status = ? WHERE id = ? AND status = ?', ['sent', row.id, row.status]);
    return;
  }
  if (['rejected', 'expired', 'superseded', 'failed', 'cancelled'].includes(status)) {
    db.run('UPDATE overtime_signoff_requests SET status = ?, error = ? WHERE id = ?', ['not-sent', `the email was ${status}`, row.id]);
    return;
  }
  if (status !== 'prepared') return;
  if (row.kind === 'override') return; // the payroll email: Nick presses it himself, never the switch
  const blocked = autoBlockedBy({ flagOn: !!d.autoOn(), wall, workingDay: isWorking(today, d.holidays()) });
  if (blocked) {
    if (blocked === 'switch-off' && !parse(row.reply_json, null) && !row.error) {
      db.run('UPDATE overtime_signoff_requests SET error = ? WHERE id = ?', ['waiting for your press on Actions (the auto-send switch is off)', row.id]);
      await Promise.resolve(d.push('Overtime sign-off ready', 'The email to Chris is ready on Actions — one press sends it.', { requestId: row.id })).catch(() => {});
    }
    return;
  }
  const ok = d.approve(action.actionId, { payloadHash: action.payloadHash, standingSwitch: AUTO_FLAG, approver: `the ${AUTO_FLAG} switch (Settings -> Switches)` });
  if (!ok || !ok.ok) { console.warn(`[OT sign-off] ${action.actionId} not approved by the switch: ${(ok && ok.error) || 'unknown'}`); return; }
  try { await d.execute(action.actionId); } catch (e) { console.warn(`[OT sign-off] send failed: ${e.message}`); }
  const after = d.getAction(action.actionId);
  if (after && ['executed', 'verified'].includes(after.status)) {
    db.run('UPDATE overtime_signoff_requests SET status = ?, error = NULL WHERE id = ?', ['sent', row.id]);
    await Promise.resolve(d.push('Overtime sent to Chris', `${row.kind === 'weekly' ? 'This week\'s' : row.kind === 'reminder' ? 'The final' : 'The cut-off'} overtime sign-off email went to Chris.`, { requestId: row.id })).catch(() => {});
  }
}

// ── applying an answer ───────────────────────────────────────────────────────

/** Approve (or reject) Nick's own claims in NOVA with Chris as the decider; then mark signed. */
async function _decideOwn(ids, decision, note, chris, requestId, d) {
  const done = []; const failed = [];
  for (const id of ids) {
    try {
      await d.nova(`/api/neuro-bridge/overtime/claims/${id}/decide`, {
        method: 'POST', timeoutMs: READ_TIMEOUT,
        body: {
          decision, note: note || null,
          overrideReason: decision === 'approve' ? `Approved by ${chris.name} by email (overtime sign-off OT-${requestId})` : null,
          decidedBy: { name: chris.name, email: chris.email },
        },
      });
      done.push(id);
    } catch (e) { failed.push({ id, error: e.message }); }
  }
  return { done, failed };
}

/**
 * Record an answer to a request: claims Chris signed off, Nick's own claims approved/rejected.
 * `by` is 'chris-reply' (read automatically) or 'nick' (Nick confirming what Chris said).
 */
async function applyAnswer(requestId, { sign = [], approveOwn = [], rejectOwn = [], rejectNote = null, hold = false, note = null, by }, injected) {
  const d = deps(injected);
  ensureTables();
  const row = _req(requestId);
  if (!row) return { ok: false, code: 404, error: 'no such sign-off request' };
  const claims = parse(row.claims_json, { team: [], own: [] });
  const teamIds = new Set(claims.team.map((c) => c.id));
  const ownIds = new Set(claims.own.map((c) => c.id));
  for (const id of sign) if (!teamIds.has(id) && !ownIds.has(id)) return { ok: false, code: 400, error: `claim ${id} was not in that email` };
  for (const id of [...approveOwn, ...rejectOwn]) if (!ownIds.has(id)) return { ok: false, code: 400, error: `claim ${id} is not one of your own claims in that email` };
  if (rejectOwn.length && !String(rejectNote || '').trim()) return { ok: false, code: 400, error: 'say why Chris rejected it — NOVA records the reason' };
  const chris = d.chris();
  if ((approveOwn.length || rejectOwn.length) && !chris.ok) return { ok: false, code: 409, error: chris.error };

  const now = d.now();
  const approved = approveOwn.length ? await _decideOwn(approveOwn, 'approve', null, chris, requestId, d) : { done: [], failed: [] };
  const rejected = rejectOwn.length ? await _decideOwn(rejectOwn, 'reject', String(rejectNote).slice(0, 1000), chris, requestId, d) : { done: [], failed: [] };
  const signedNow = recordSignoffs([...sign.filter((id) => teamIds.has(id)), ...approved.done], { requestId, by: by === 'nick' ? 'Nick (confirming Chris)' : CHRIS_NAME(), note, now });
  const failed = [...approved.failed, ...rejected.failed];
  const allTeamSigned = claims.team.every((c) => signedSet().has(c.id));
  const status = failed.length ? 'needs-you' : hold ? 'held' : allTeamSigned && approved.done.length + rejected.done.length === claims.own.length ? 'signed' : 'partial';
  db.run('UPDATE overtime_signoff_requests SET status = ?, decided_at = ?, decided_by = ?, error = ? WHERE id = ?',
    [status, new Date(now).toISOString(), by, failed.length ? failed.map((f) => `claim ${f.id}: ${f.error}`).join('; ') : (hold ? (note || 'held') : null), requestId]);
  return { ok: true, status, signed: signedNow, approvedOwn: approved.done, rejectedOwn: rejected.done, failed };
}

/** Nick records a sign-off Chris gave outside the email (in person, on Teams). */
function recordByHand(claimIds, note) {
  if (!Array.isArray(claimIds) || !claimIds.length || claimIds.some((i) => !Number.isInteger(i) || i <= 0)) return { ok: false, code: 400, error: 'claimIds must be a list of claim ids' };
  if (!String(note || '').trim()) return { ok: false, code: 400, error: 'say how Chris signed it off (e.g. "in our 1-2-1 on Tuesday")' };
  return { ok: true, signed: recordSignoffs(claimIds, { by: 'Nick (recorded by hand)', note: String(note).slice(0, 500) }) };
}

async function _readReplies(row, d) {
  if (!row.chris_email) return;
  const action = row.action_id ? d.getAction(row.action_id) : null;
  if (!action || !['executed', 'verified'].includes(action.status)) return;
  const reply = parse(row.reply_json, null);
  let got;
  try { got = await d.replies({ fromAddress: row.chris_email, subjectHas: `OT-${row.id})`, sinceIso: row.created_at }); } catch { return; }
  if (!got || !got.ok || !got.messages.length) return;
  const msg = got.messages[0]; // newest
  if (reply && reply.messageId === msg.id) return;
  const text = replyText(msg.text);
  const claims = parse(row.claims_json, { team: [], own: [] });
  let verdict = quickVerdict(text);
  let how = 'rule';
  if (verdict === 'unsure') {
    const summary = `${claims.team.length} team claim(s)${claims.own.length ? ` and ${claims.own.length} of Nick's own` : ''}`;
    let answer = null;
    try { answer = await d.judge(judgePrompt(text, summary)); } catch { answer = null; }
    const v = parseVerdict(answer);
    how = v ? 'model' : 'model-unavailable';
    verdict = v === 'all-approved' ? 'approve' : 'doubt';
  }
  const stored = { messageId: msg.id, at: msg.receivedAt, text: text.slice(0, 2000), verdict, how };
  db.run('UPDATE overtime_signoff_requests SET reply_json = ? WHERE id = ?', [JSON.stringify(stored), row.id]);
  if (verdict === 'approve') {
    const r = await applyAnswer(row.id, { sign: claims.team.map((c) => c.id), approveOwn: claims.own.filter((c) => !signedSet().has(c.id)).map((c) => c.id), by: 'chris-reply' }, d);
    await Promise.resolve(d.push('Chris signed off overtime',
      r.ok && r.status === 'signed' ? `Signed off ${claims.team.length} claim(s)${claims.own.length ? ` and approved your ${claims.own.length}` : ''}.` : 'His reply was read, but something could not be recorded — check Overtime.',
      { requestId: row.id })).catch(() => {});
  } else {
    db.run('UPDATE overtime_signoff_requests SET status = ? WHERE id = ?', ['needs-you', row.id]);
    await Promise.resolve(d.push('Chris replied about overtime', 'His reply needs you to confirm what he signed off. Payroll waits until you do.', { requestId: row.id })).catch(() => {});
  }
}

// ── the tick ─────────────────────────────────────────────────────────────────

async function tick(injected) {
  const d = deps(injected);
  ensureTables();
  const now = d.now();
  const wall = require('./promise-score').londonWall(now);
  const today = wall.date;
  const holidays = d.holidays();
  const settings = readCutoff();

  for (const due of dueKinds(today, settings, holidays)) {
    if (wall.time < SEND_AT[due.kind] || wall.time >= LAST_SEND) continue;
    try { await prepareRequest({ ...due, today }, d); } catch (e) { console.warn(`[OT sign-off] ${due.kind} failed: ${e.message}`); }
  }
  const watchFrom = new Date(now - REPLY_WATCH_DAYS * 86400000).toISOString();
  for (const row of db.all(`SELECT * FROM overtime_signoff_requests WHERE status IN ('prepared','sent') AND created_at >= ?`, [watchFrom])) {
    try {
      if (row.status === 'prepared') await _sendPrepared(row, d, today, wall);
      const fresh = _req(row.id);
      if (fresh.status === 'sent') await _readReplies(fresh, d);
    } catch (e) { console.warn(`[OT sign-off] request ${row.id}: ${e.message}`); }
  }
}

// ── reads for the screen and the payroll gate ────────────────────────────────

function view(injected) {
  const d = deps(injected);
  ensureTables();
  const settings = readCutoff();
  const holidays = d.holidays();
  const today = require('./promise-score').londonWall(d.now()).date;
  const month = periodMonthOf(today, settings, holidays);
  const chris = d.chris();
  return {
    ok: true,
    cutoff: settings,
    current: periodFor(month, settings, holidays),
    next: periodFor(shiftMonth(month, 1), settings, holidays),
    chris: chris.ok ? { name: chris.name, email: chris.email } : { error: chris.error },
    me: d.nickEmail(),
    autoSend: !!d.autoOn(),
    requests: db.all('SELECT * FROM overtime_signoff_requests ORDER BY id DESC LIMIT 30').map(shapeRequest),
  };
}

// ── the cut-off override (5 Nov 2026) ───────────────────────────────────────
// Payroll goes with Chris copied; the unsigned claims ride as a sign-off request on that same
// email, so his reply ("approved") is read and recorded exactly like a weekly one.

/** Open the request for an override send. `rows` are NOVA export rows (claimId, hours…). */
function openOverride(month, rows, injected) {
  const d = deps(injected);
  ensureTables();
  const chris = d.chris();
  if (!chris.ok) return { ok: false, code: 409, error: `Chris can't be copied in: ${chris.error}` };
  const team = rows.map((r) => ({
    id: r.claimId, agentName: r.agentName, agentEmail: r.agentEmail, date: r.date, start: r.start, end: r.end,
    minutes: Math.round(Number(r.hours) * 60), reason: r.reason, enteredBy: r.enteredBy || null, overrideReason: null, wtr: null,
  }));
  const now = new Date(d.now()).toISOString();
  const info = db.run(`INSERT INTO overtime_signoff_requests (kind, run_date, period_month, cover_to, team_ids, own_ids, claims_json, status, chris_email, created_at)
          VALUES ('override', ?, ?, ?, ?, '[]', ?, 'preparing', ?, ?)`,
  [now, month, periodForMonth(month, d).to, JSON.stringify(team.map((c) => c.id)), JSON.stringify({ team, own: [] }), chris.email, now]);
  return { ok: true, id: Number(info.lastInsertRowid), chrisEmail: chris.email, chrisFirst: String(chris.name).split(/\s+/)[0] };
}

function attachOverrideAction(id, actionId) {
  db.run(`UPDATE overtime_signoff_requests SET action_id = ?, status = 'prepared' WHERE id = ? AND kind = 'override'`, [actionId, id]);
}

function dropOverride(id) {
  db.run(`DELETE FROM overtime_signoff_requests WHERE id = ? AND kind = 'override' AND action_id IS NULL`, [id]);
}

/** For the payroll gate: which of these claims are NOT signed off. */
function unsigned(claimIds) {
  const s = signedSet();
  return (claimIds || []).filter((id) => !s.has(id));
}

function periodForMonth(month, injected) {
  const d = deps(injected);
  return periodFor(month, readCutoff(), d.holidays());
}

module.exports = {
  // pure
  validateCutoff, cutoffDate, periodFor, periodMonthOf, dueKinds, composeEmail, replyText, quickVerdict, parseVerdict, autoBlockedBy, monthLabel,
  // store / flow
  readCutoff, setCutoff, tick, openOverride, attachOverrideAction, dropOverride, prepareRequest, applyAnswer, recordByHand, view, unsigned, periodForMonth, recordSignoffs, ensureTables,
  AUTO_FLAG, ORIGIN,
};
