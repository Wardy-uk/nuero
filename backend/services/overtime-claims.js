'use strict';

/**
 * Overtime claims from NOVA — Nick's half (29 Oct 2026). NOT services/overtime.js, which is the
 * older hand-entered five-step log (PIP competency 1) that Weekly Risk reads; it is untouched.
 * Spec: vault
 * Projects/NOVA/NOVA - Overtime Claims (spec).md; Nick, same day: "the approval & reporting
 * should be in NEURO".
 *
 * Agents claim in NOVA. Everything here is a call over the NOVA bridge (NEURO → NOVA,
 * never the other way): the waiting claims, the live activity + Working Time check, the
 * decision (NOVA re-checks and FREEZES what it found onto the claim), the 48-hour opt-outs,
 * and the month's payroll export.
 *
 * Payroll: NOVA builds the month (JSON + .xlsx). NEURO prepares ONE governed compose_email
 * to payroll with the file attached, and Nick's press sends it. NOVA marks those claims
 * sent only once the send is VERIFIED (read back in Sent Items) — `reconcile()` does that,
 * from the screen and on a timer. A failed or unknown send marks nothing.
 */

const nova = require('./nova-client');

function _db() { return require('../db/database'); }
function _pa() { return require('./prepared-actions'); }

const PAYROLL_EMAIL = () => (process.env.OVERTIME_PAYROLL_EMAIL || 'payroll@nurtur.tech').trim();
// The name recorded on a decision in NOVA. NOVA's /perf-activity matches on it.
const DECIDER = () => ({
  name: (process.env.OVERTIME_DECIDER_NAME || 'Nick Ward').trim(),
  email: require('./mail-identity').WORK_ADDRESS,
});
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const READ_TIMEOUT = 60000; // the activity check asks Jira about every ticket in the window

let ensured = false;
function ensureTable() {
  if (ensured) return;
  _db().run(`CREATE TABLE IF NOT EXISTS overtime_payroll_sends (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    month         TEXT NOT NULL,
    action_id     TEXT NOT NULL UNIQUE,
    claim_ids     TEXT NOT NULL,
    total_hours   REAL NOT NULL,
    prepared_at   TEXT NOT NULL,
    marked_at     TEXT,
    mark_error    TEXT
  )`);
  ensured = true;
}

const bad = (error, code = 400) => ({ ok: false, code, error });
// A bridge route NOVA does not have falls through to NOVA's app auth and answers 401 (or 404),
// which read as "Not authenticated" — the wrong cause. Say what it means.
const novaFail = (e) => {
  if ((e.status === 401 && e.message === 'Not authenticated') || (e.status === 404 && /failed \(404\)/.test(e.message))) {
    return { ok: false, code: 502, error: 'NOVA has no overtime bridge yet — deploy NOVA v1.1.764 or later on AAPP01.' };
  }
  return { ok: false, code: e.status && e.status < 500 ? e.status : 502, error: e.message };
};

// ── Reads ──

async function claims({ status, month } = {}) {
  if (status && !['submitted', 'approved', 'rejected', 'withdrawn'].includes(status)) return bad('unknown status');
  if (month && !MONTH_RE.test(month)) return bad('month must be YYYY-MM');
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (month) q.set('month', month);
  try { return { ok: true, claims: await nova.call(`/api/neuro-bridge/overtime/claims?${q}`) }; } catch (e) { return novaFail(e); }
}

async function check(id) {
  if (!Number.isInteger(id) || id <= 0) return bad('bad claim id');
  try { return { ok: true, check: await nova.call(`/api/neuro-bridge/overtime/claims/${id}/check`, { timeoutMs: READ_TIMEOUT }) }; } catch (e) { return novaFail(e); }
}

// ── Decide ──

async function decide(id, { decision, note, overrideReason } = {}) {
  if (!Number.isInteger(id) || id <= 0) return bad('bad claim id');
  if (decision !== 'approve' && decision !== 'reject') return bad('decision must be approve or reject');
  if (decision === 'reject' && !(note && String(note).trim())) return bad('a rejection needs a reason the agent will see');
  try {
    const claim = await nova.call(`/api/neuro-bridge/overtime/claims/${id}/decide`, {
      method: 'POST', timeoutMs: READ_TIMEOUT,
      body: { decision, note: note ? String(note).slice(0, 1000) : null, overrideReason: overrideReason ? String(overrideReason).slice(0, 1000) : null, decidedBy: DECIDER() },
    });
    return { ok: true, claim };
  } catch (e) { return novaFail(e); }
}

// ── Manual line (30 Oct 2026) ──
// Work nobody claimed, usually missed from last month. Nick's call: a REAL claim in NOVA,
// approved at once by him, with NOVA's activity + Working Time check frozen onto it like any
// decision (past a warning he gives a reason). It goes into the next payroll file, flagged as
// worked in an earlier month and added by him.

async function agents() {
  try { return { ok: true, agents: await nova.call('/api/neuro-bridge/overtime/agents') }; } catch (e) { return novaFail(e); }
}

async function addManual({ agentEmail, date, start, end, reason, overrideReason } = {}) {
  if (!agentEmail || !String(agentEmail).includes('@')) return bad('choose the agent');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return bad('date must be YYYY-MM-DD');
  if (!/^\d{2}:\d{2}$/.test(String(start || '')) || !/^\d{2}:\d{2}$/.test(String(end || ''))) return bad('from and to must be HH:MM');
  if (!String(reason || '').trim()) return bad('a reason is required');
  try {
    const claim = await nova.call('/api/neuro-bridge/overtime/claims/manual', {
      method: 'POST', timeoutMs: READ_TIMEOUT,
      body: {
        agentEmail: String(agentEmail).trim(), date, start, end, reason: String(reason).slice(0, 1000),
        overrideReason: overrideReason ? String(overrideReason).slice(0, 1000) : null, decidedBy: DECIDER(),
      },
    });
    return { ok: true, claim };
  } catch (e) { return novaFail(e); }
}

// ── Opt-outs ──

async function optOuts() {
  try { return { ok: true, optOuts: await nova.call('/api/neuro-bridge/overtime/optouts') }; } catch (e) { return novaFail(e); }
}

async function recordOptOut({ agentEmail, agentName, optedOutOn, documentRef } = {}) {
  try {
    await nova.call('/api/neuro-bridge/overtime/optouts', { method: 'POST', body: { agentEmail, agentName, optedOutOn, documentRef, recordedBy: DECIDER().name } });
    return { ok: true };
  } catch (e) { return novaFail(e); }
}

async function withdrawOptOut(id, withdrawnOn) {
  if (!Number.isInteger(id) || id <= 0) return bad('bad opt-out id');
  try {
    await nova.call(`/api/neuro-bridge/overtime/optouts/${id}/withdraw`, { method: 'POST', body: { withdrawnOn } });
    return { ok: true };
  } catch (e) { return novaFail(e); }
}

// ── Payroll ──

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The email Nick sends. PURE. */
function payrollEmail(exp, { additional = false } = {}) {
  const label = monthLabel(exp.month);
  const lines = exp.totals.map((t) => `- ${t.agentName}: ${t.hours} hours (${t.claims} claim${t.claims === 1 ? '' : 's'})`);
  const late = exp.rows.filter((r) => r.lateFromEarlierMonth).length;
  const body = [
    'Hi,',
    '',
    `Please find attached the approved paid overtime for ${label}${additional ? ' (claims approved since the last file)' : ''}.`,
    '',
    ...lines,
    '',
    `Total: ${exp.totalHours} hours.`,
    ...(late ? ['', `${late} of these claims ${late === 1 ? 'is' : 'are'} for work in an earlier month, approved after that month was sent; the file marks ${late === 1 ? 'it' : 'them'}.`] : []),
    '',
    'Each claim is listed in the attachment with the date, times, reason and approval date.',
    '',
    'Thanks,',
    'Nick',
  ].join('\n');
  return { subject: `Overtime – ${label}${additional ? ' (additional)' : ''}`, body };
}

function _sendsFor(month) {
  ensureTable();
  return _db().all('SELECT * FROM overtime_payroll_sends WHERE month = ? ORDER BY id', [month]);
}

function _statusOf(actionId) {
  try { const a = _pa().get(actionId); return a ? a.status : null; } catch { return null; }
}

const LIVE = new Set(['prepared', 'approved', 'executing', 'execution_uncertain', 'executed']);

/** The month: NOVA's export, the sends already made, and whether one is in flight. */
async function payrollMonth(month) {
  if (!MONTH_RE.test(month)) return bad('month must be YYYY-MM');
  await reconcile().catch(() => {});
  let exp;
  try { exp = await nova.call(`/api/neuro-bridge/overtime/export?month=${month}`, { timeoutMs: READ_TIMEOUT }); } catch (e) { return novaFail(e); }
  const sends = _sendsFor(month).map((s) => ({
    id: s.id, actionId: s.action_id, claims: JSON.parse(s.claim_ids).length, totalHours: s.total_hours,
    preparedAt: s.prepared_at, markedAt: s.marked_at, markError: s.mark_error, status: _statusOf(s.action_id),
  }));
  const inFlight = sends.find((s) => !s.markedAt && LIVE.has(s.status)) || null;
  const { xlsxBase64, ...rest } = exp;
  return { ok: true, export: rest, hasFile: !!xlsxBase64, sends, inFlight, to: PAYROLL_EMAIL() };
}

/**
 * Prepare the payroll email for the month's unsent approved claims. One live send per month:
 * a second press while one is in flight hands back that one. Nothing is sent here — the
 * screen spends a one-use grant on the returned action.
 */
async function preparePayroll(month) {
  if (!MONTH_RE.test(month)) return bad('month must be YYYY-MM');
  ensureTable();
  await reconcile().catch(() => {});
  const live = _sendsFor(month).find((s) => !s.marked_at && LIVE.has(_statusOf(s.action_id)));
  if (live) {
    const action = _pa().get(live.action_id);
    if (action && action.status === 'prepared') return { ok: true, already: true, action };
    return bad('the payroll email for this month is already being sent — wait for it to be confirmed', 409);
  }
  let exp;
  try { exp = await nova.call(`/api/neuro-bridge/overtime/export?month=${month}`, { timeoutMs: READ_TIMEOUT }); } catch (e) { return novaFail(e); }
  if (!exp.rows.length) return bad('there are no approved, unsent claims for this month', 409);
  const additional = _sendsFor(month).some((s) => s.marked_at);
  const mail = payrollEmail(exp, { additional });
  const r = _pa().prepareCompose({
    from: 'work', to: [PAYROLL_EMAIL()], subject: mail.subject, body: mail.body,
    attachments: [{ name: exp.filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dataBase64: exp.xlsxBase64 }],
    origin: 'overtime-payroll', generatedBy: 'template (overtime.payrollEmail, no model call) + NOVA export',
    evidence: { overtimeMonth: month, claimIds: exp.claimIds },
  });
  if (!r.ok) return r;
  _db().run(`INSERT INTO overtime_payroll_sends (month, action_id, claim_ids, total_hours, prepared_at) VALUES (?, ?, ?, ?, ?)`,
    [month, r.action.actionId, JSON.stringify(exp.claimIds), exp.totalHours, new Date().toISOString()]);
  return { ok: true, action: r.action };
}

/**
 * Mark sent claims in NOVA once their email is VERIFIED. Idempotent: NOVA only moves
 * approved, unexported claims, and a marked row is never asked again.
 */
async function reconcile() {
  ensureTable();
  const rows = _db().all('SELECT * FROM overtime_payroll_sends WHERE marked_at IS NULL');
  let marked = 0;
  for (const s of rows) {
    if (_statusOf(s.action_id) !== 'verified') continue;
    try {
      await nova.call('/api/neuro-bridge/overtime/export/mark', { method: 'POST', body: { month: s.month, claimIds: JSON.parse(s.claim_ids) } });
      _db().run('UPDATE overtime_payroll_sends SET marked_at = ?, mark_error = NULL WHERE id = ?', [new Date().toISOString(), s.id]);
      marked += 1;
    } catch (e) {
      _db().run('UPDATE overtime_payroll_sends SET mark_error = ? WHERE id = ?', [String(e.message).slice(0, 300), s.id]);
    }
  }
  return { marked };
}

/**
 * Email Nick (and only Nick) a [TEST] copy of the month's payroll email with the real file.
 * Not the payroll send: no prepared action, nothing recorded, NOVA marks nothing, payroll
 * receives nothing. email-sender.sendMail refuses any address but Nick's own.
 */
async function testPayroll(month) {
  if (!MONTH_RE.test(month)) return bad('month must be YYYY-MM');
  let exp;
  try { exp = await nova.call(`/api/neuro-bridge/overtime/export?month=${month}`, { timeoutMs: READ_TIMEOUT }); } catch (e) { return novaFail(e); }
  if (!exp.rows.length) return bad('there are no approved, unsent claims for this month', 409);
  const additional = _sendsFor(month).some((s) => s.marked_at);
  const mail = payrollEmail(exp, { additional });
  const sender = require('./email-sender');
  const r = await sender.sendMail({
    to: [{ email: sender.OWN_ADDRESS }],
    subject: `[TEST] ${mail.subject}`,
    body: [`TEST COPY — sent only to you. ${PAYROLL_EMAIL()} has NOT received this, and no claim has been marked sent.`, '', mail.body].join('\n'),
    attachments: [{ name: exp.filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dataBase64: exp.xlsxBase64 }],
  });
  if (!r.sent) return bad(`the test email was not sent (${r.reason})`, 502);
  return { ok: true, to: sender.OWN_ADDRESS, claims: exp.rows.length };
}

/** The xlsx for a download, straight from NOVA. */
async function payrollFile(month) {
  if (!MONTH_RE.test(month)) return bad('month must be YYYY-MM');
  try {
    const exp = await nova.call(`/api/neuro-bridge/overtime/export?month=${month}`, { timeoutMs: READ_TIMEOUT });
    return { ok: true, filename: exp.filename, buf: Buffer.from(exp.xlsxBase64, 'base64') };
  } catch (e) { return novaFail(e); }
}

module.exports = {
  claims, check, decide, agents, addManual, optOuts, recordOptOut, withdrawOptOut,
  payrollMonth, preparePayroll, testPayroll, reconcile, payrollFile, payrollEmail, monthLabel, ensureTable,
};
