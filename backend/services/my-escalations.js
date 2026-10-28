'use strict';

/**
 * How many tickets Nick escalated in a week, for the SOAP and Weekly Risk
 * reports (28 Oct 2026). Two kinds, kept apart because they are different acts:
 *
 *   raised in Jira — NOVA's escalation log, type `manual`, escalated_by Nick.
 *     Read from NOVA rather than NEURO's own ledger because an escalation
 *     raised in NOVA's screen is just as much his, and both routes log there.
 *   by email — an "Escalate by email…" email from NEURO's Escalations screen
 *     (a governed compose_email carrying evidence.ticket) that was sent.
 *
 * A source that could not be read is `count: null` with the reason — never 0,
 * which would print as "no escalations" in a report Chris reads. The total is
 * null whenever either half is.
 */

const NICK = /^nick ward$/i;
const SENT = new Set(['approved', 'executing', 'executed', 'execution_uncertain', 'verified']);

/** An instant's Europe/London calendar day, YYYY-MM-DD. */
function londonDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

/** PURE: NOVA log rows → Nick's manual escalations in [from, to]. */
function jiraIn(rows = [], from, to) {
  const hits = rows.filter((e) => e?.escalation_type === 'manual' && NICK.test(String(e.escalated_by || '').trim()))
    .filter((e) => { const d = londonDay(e.created_at); return d && d >= from && d <= to; });
  return { count: hits.length, tickets: [...new Set(hits.map((e) => e.ticket_key).filter(Boolean))] };
}

/** PURE: prepared_actions rows → escalation emails sent in [from, to]. */
function emailIn(rows = [], from, to) {
  const hits = [];
  for (const r of rows) {
    if (!SENT.has(r?.status)) continue;
    let ev = null;
    try { ev = JSON.parse(r.evidence_json || 'null'); } catch { ev = null; }
    const ticket = String(ev?.ticket || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(ticket)) continue;
    const d = londonDay(r.executed_at || r.approved_at || r.created_at);
    if (d && d >= from && d <= to) hits.push(ticket);
  }
  return { count: hits.length, tickets: [...new Set(hits)] };
}

/** PURE: the two halves → the report figure. */
function combine(jira, email) {
  const known = jira.count != null && email.count != null;
  return {
    jira, email,
    total: known ? jira.count + email.count : null,
    tickets: known ? new Set([...jira.tickets, ...email.tickets]).size : null,
  };
}

/** Nick's escalations between two London dates (inclusive, YYYY-MM-DD). */
async function weekCounts({ from, to, deps = {} } = {}) {
  const shift = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  let jira;
  try {
    const nova = deps.nova || require('./nova-client');
    if (!nova.isConfigured()) jira = { count: null, tickets: [], error: 'NOVA bridge not configured' };
    else {
      // Days back from today far enough to cover the week, plus a margin.
      const days = Math.min(400, Math.max(14, Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 2));
      jira = jiraIn(await nova.listEscalations({ days, type: 'manual' }) || [], from, to);
    }
  } catch (e) { jira = { count: null, tickets: [], error: e.message }; }

  let email;
  try {
    const db = deps.db || require('../db/database').getDb();
    // Prepared up to a week before and sent in the week still counts; the date
    // that decides is the send (emailIn). created_at is an ISO string.
    const rows = db.prepare(
      `SELECT status, created_at, approved_at, executed_at, evidence_json FROM prepared_actions
        WHERE action_type = 'compose_email' AND created_at >= ? AND created_at < ?
          AND json_extract(evidence_json, '$.ticket') IS NOT NULL`
    ).all(shift(from, -7), shift(to, 2));
    email = emailIn(rows, from, to);
  } catch (e) { email = { count: null, tickets: [], error: e.message }; }

  return { from, to, ...combine(jira, email) };
}

/** One sentence for a report, saying what could not be read. */
function line(c) {
  if (!c) return 'Escalations: not read.';
  const part = (h, word) => (h.count == null ? `${word} — could not be read (${h.error || 'unknown'})` : `${h.count} ${word}`);
  const head = c.total == null ? 'Escalations I raised' : `**${c.total}** escalation${c.total === 1 ? '' : 's'} raised by me`;
  return `${head}: ${part(c.jira, 'raised in Jira')}, ${part(c.email, 'by email')}${c.tickets != null && c.tickets !== c.total ? ` (${c.tickets} ticket${c.tickets === 1 ? '' : 's'})` : ''}.`;
}

module.exports = { weekCounts, jiraIn, emailIn, combine, line, londonDay };
