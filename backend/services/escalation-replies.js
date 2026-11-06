'use strict';

/**
 * Replies to an escalation EMAIL (6 Nov 2026).
 *
 * "Escalate by email…" on the Escalations page sends a governed compose_email
 * that carries `evidence.ticket`. Until now nothing looked for the answer: a
 * reply from Chris landed in the work inbox like any other mail and the ticket
 * row never knew. Nick's brief: the Escalations page must NOT become a second
 * inbox, but it must show that there has been a reply.
 *
 * So this is a SIGNAL, never a reader:
 *  - A reply is mail in the work triage store on the escalation email's thread
 *    (same Graph conversationId), received after the escalation was sent, from
 *    anyone but Nick. Read off the triage pass — no extra mailbox reads per
 *    page view.
 *  - It is recorded with sender, time and the triage email id ONLY. No body.
 *  - "Seen" has ONE meaning for both places: the reply's triage card has been
 *    dealt with (any dismissal — done, replied, not relevant, filed in Outlook),
 *    or Nick has sent anything on that thread after it arrived (answered from
 *    Outlook). There is no "mark read" on the Escalations page.
 *  - Recorded replies are kept in agent_state, because the triage store compacts
 *    and prunes dismissed entries; a pruned entry was dismissed, so it is seen.
 *  - No push: the email already arrived in the inbox, and triage pushes it if
 *    it is urgent. A second notification for one email is the duplicate this
 *    codebase keeps removing.
 */

const STORE_KEY = 'escalation_email_replies';
const THREAD_KEY = 'escalation_email_threads';
const SENT_STATUSES = ['executed', 'verified', 'execution_uncertain', 'approved', 'executing'];
const LOOKBACK_DAYS = 120;     // escalations older than this stop being looked at
const RESOLVE_PER_PASS = 10;   // Sent Items lookups to find a thread, per pass

function lc(s) { return String(s || '').trim().toLowerCase(); }
function readJson(db, key, fallback) {
  try { const raw = db.getState(key); return raw ? JSON.parse(raw) : fallback; } catch { return null; }
}

/** Sent escalation emails: [{ actionId, ticket, sentAt, imid }]. */
function sentEscalations(dbh) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const rows = dbh.prepare(
    `SELECT pa.action_id, pa.status, pa.executed_at, pa.approved_at, pa.created_at, pa.evidence_json,
            (SELECT internet_message_id FROM action_attempts aa WHERE aa.action_id = pa.action_id
               AND aa.internet_message_id IS NOT NULL ORDER BY aa.attempt DESC LIMIT 1) AS imid
       FROM prepared_actions pa
      WHERE pa.action_type = 'compose_email' AND pa.created_at >= ?
        AND json_extract(pa.evidence_json, '$.ticket') IS NOT NULL`
  ).all(since);
  const out = [];
  for (const r of rows) {
    if (!SENT_STATUSES.includes(r.status)) continue;
    let ev = {};
    try { ev = JSON.parse(r.evidence_json || '{}'); } catch { continue; }
    const ticket = String(ev.ticket || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(ticket)) continue;
    out.push({ actionId: r.action_id, ticket, sentAt: r.executed_at || r.approved_at || r.created_at, imid: r.imid || null });
  }
  return out;
}

/**
 * PURE. Fold this pass into the stored replies.
 *  threads: [{ ticket, actionId, conversationId, sentAt }]
 *  entries: the work triage store (open and compacted dismissed entries)
 *  sent:    Sent Items messages [{ conversationId, sentAt }] or null (unread)
 *  stored:  { [emailId]: reply }
 * Returns { replies, added, seen }.
 */
function fold({ threads = [], entries = [], sent = null, stored = {}, self = [], now = new Date().toISOString() }) {
  const selfSet = new Set(self.map(lc).filter(Boolean));
  const byConv = new Map();
  for (const t of threads) {
    if (!t.conversationId) continue;
    const prev = byConv.get(t.conversationId);
    // Two escalations on one thread: the earliest send owns it.
    if (!prev || Date.parse(t.sentAt) < Date.parse(prev.sentAt)) byConv.set(t.conversationId, t);
  }
  const replies = { ...stored };
  const byId = new Map(entries.map((e) => [e.id, e]));
  let added = 0;
  for (const e of entries) {
    if (!e || !e.id || replies[e.id] || !e.conversationId) continue;
    const t = byConv.get(e.conversationId);
    if (!t) continue;
    if (selfSet.has(lc(e.fromEmail))) continue;
    const got = Date.parse(e.received);
    if (!Number.isFinite(got) || got <= Date.parse(t.sentAt)) continue;
    replies[e.id] = {
      emailId: e.id, ticket: t.ticket, actionId: t.actionId, conversationId: e.conversationId,
      from: e.from || e.fromEmail || null, fromEmail: lc(e.fromEmail) || null,
      at: e.received, recordedAt: now, seenAt: e.dismissed ? (e.dismissedAt || now) : null,
      seenBy: e.dismissed ? 'inbox' : null,
    };
    added++;
  }
  // Last thing Nick sent on each thread (only when Sent Items was read).
  const lastSent = new Map();
  for (const m of sent || []) {
    const ts = Date.parse(m && m.sentAt);
    if (!m || !m.conversationId || !Number.isFinite(ts)) continue;
    if (!lastSent.has(m.conversationId) || lastSent.get(m.conversationId) < ts) lastSent.set(m.conversationId, ts);
  }
  let seen = 0;
  for (const r of Object.values(replies)) {
    if (r.seenAt) continue;
    const e = byId.get(r.emailId);
    // Gone from the store = pruned, and only dismissed entries are pruned.
    if (!e || e.dismissed) { r.seenAt = (e && e.dismissedAt) || now; r.seenBy = 'inbox'; seen++; continue; }
    const ts = lastSent.get(r.conversationId);
    if (Number.isFinite(ts) && ts > Date.parse(r.at)) { r.seenAt = new Date(ts).toISOString(); r.seenBy = 'you-replied'; seen++; }
  }
  return { replies, added, seen };
}

/**
 * Run after a triage pass. Never throws; never fails triage.
 * deps: { db, mail, entries, sent, self }
 */
async function sync({ entries, sent = null, deps = {} } = {}) {
  try {
    const db = deps.db || require('../db/database');
    const dbh = deps.dbh || db.getDb();
    const mail = deps.mail || require('./action-mail');
    const sends = sentEscalations(dbh);
    if (!sends.length) return { ok: true, threads: 0, added: 0, seen: 0 };

    let threads = readJson(db, THREAD_KEY, {});
    if (threads === null) return { ok: false, reason: 'thread store unreadable' };
    let resolved = 0;
    for (const s of sends) {
      if (threads[s.actionId]?.conversationId || !s.imid || resolved >= RESOLVE_PER_PASS) continue;
      resolved++;
      try {
        const r = await mail.findSent(s.imid);
        const m = r && r.ok ? r.messages.find((x) => x.conversationId) : null;
        if (m) threads[s.actionId] = { ticket: s.ticket, conversationId: m.conversationId, sentAt: m.sentAt || s.sentAt };
      } catch (e) { console.warn('[EscalationReplies] thread lookup failed:', e.message); }
    }
    if (resolved) db.setState(THREAD_KEY, JSON.stringify(threads));

    const stored = readJson(db, STORE_KEY, {});
    if (stored === null) return { ok: false, reason: 'reply store unreadable' };
    const self = deps.self || [process.env.MS_OWN_ADDRESS || 'nickw@nurtur.tech'];
    const live = new Set(sends.map((s) => s.actionId));
    const list = Object.entries(threads).filter(([id]) => live.has(id)).map(([actionId, t]) => ({ actionId, ...t }));
    const all = entries || require('./email-triage').getStoredTriage();
    const r = fold({ threads: list, entries: all, sent, stored, self });
    if (r.added || r.seen) {
      db.setState(STORE_KEY, JSON.stringify(r.replies));
      console.log(`[EscalationReplies] ${r.added} new repl${r.added === 1 ? 'y' : 'ies'} to escalation emails, ${r.seen} now seen`);
    }
    return { ok: true, threads: list.length, added: r.added, seen: r.seen };
  } catch (e) {
    console.warn('[EscalationReplies] sync failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

/** PURE. Replies → { KEY: { count, unseen, latest } }, latest = newest reply. */
function summarise(replies = {}) {
  const out = {};
  for (const r of Object.values(replies)) {
    if (!r || !r.ticket) continue;
    const s = out[r.ticket] || (out[r.ticket] = { count: 0, unseen: 0, latest: null, replies: [] });
    s.count++;
    if (!r.seenAt) s.unseen++;
    const row = { emailId: r.emailId, from: r.from, at: r.at, seen: !!r.seenAt, seenBy: r.seenBy || null };
    s.replies.push(row);
    if (!s.latest || Date.parse(r.at) > Date.parse(s.latest.at)) s.latest = row;
  }
  for (const s of Object.values(out)) s.replies.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out;
}

/** By ticket, for the Escalations page. null = could not read. */
function byTicket(deps = {}) {
  const db = deps.db || require('../db/database');
  const stored = readJson(db, STORE_KEY, {});
  return stored === null ? null : summarise(stored);
}

/** emailId → ticket, for the inbox chip. Empty on any read failure. */
function ticketByEmail(deps = {}) {
  const db = deps.db || require('../db/database');
  const stored = readJson(db, STORE_KEY, {}) || {};
  const out = {};
  for (const r of Object.values(stored)) if (r && r.emailId && r.ticket) out[r.emailId] = r.ticket;
  return out;
}

module.exports = { sync, fold, summarise, byTicket, ticketByEmail, sentEscalations, STORE_KEY, THREAD_KEY };
