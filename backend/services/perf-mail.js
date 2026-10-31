'use strict';

/**
 * Work mail Nick sent from Outlook himself (31 Oct 2026) — for VANTAGE's
 * Performance Evidence.
 *
 * Nick: VANTAGE told him to "draft and publish a Support Standards & Routing
 * Guide", and he had written exactly that a month earlier — as a PDF emailed to
 * the team. The feed only saw mail NEURO sent for him, so the document did not
 * exist as far as the assessment was concerned.
 *
 * Two kinds are kept, everything else in Sent Items is ordinary correspondence
 * and is left out (it would bury the rest):
 *  - DOCUMENT: a message carrying a real file (a document, spreadsheet, deck or
 *    PDF — not a pasted image or a signature logo). Forwards count: sending a
 *    document to the people who need it is the act.
 *  - BROADCAST: a new message (not a reply) to four or more people.
 * Meeting responses, auto-replies and mail only to himself never count.
 *
 * Reads only (GET), the WORK mailbox (Graph). What leaves NEURO: the subject,
 * who it went to (names), the attachment file names, and the first part of what
 * he wrote (uniqueBody — never the thread quoted beneath). Never the files.
 * Cached in a table; itemsFor() reads the cache and never the network, and says
 * it cannot answer until a run has succeeded.
 */

const FLOOR_DAYS = 400;
const PER_RUN = 400;
const PAGE = 50;
const BROADCAST_MIN = 4;
const EXCERPT = 500;
const STATE_KEY = 'perf_mail_run';

const DOC_EXT = /\.(pdf|docx?|xlsx?|xlsm|csv|pptx?|txt|md|vsdx?|one|zip)$/i;
const SKIP_SUBJECT = /^(accepted|declined|tentative|canceled|cancelled|automatic reply|out of office|undeliverable)\b/i;
const REPLY_SUBJECT = /^\s*(re|aw|antw)\s*:/i;

let ready = false;
function db() {
  const d = require('../db/database').getDb();
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS perf_mail_items (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      day         TEXT NOT NULL,
      at          TEXT NOT NULL,
      subject     TEXT,
      recipients  TEXT,
      attachments TEXT,
      excerpt     TEXT,
      checked_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_perf_mail_day ON perf_mail_items(day);`);
    ready = true;
  }
  return d;
}

function readState() {
  try { return JSON.parse(require('../db/database').getState(STATE_KEY) || '{}') || {}; } catch { return {}; }
}
function writeState(s) { require('../db/database').setState(STATE_KEY, JSON.stringify(s)); }

/** A London date key for an instant. Pure. */
function londonDay(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Attachments that are documents, by name. Inline parts and images never. Pure. */
function documentNames(atts) {
  return (atts || [])
    .filter((a) => a && !a.isInline && a.name && DOC_EXT.test(a.name))
    .map((a) => a.name);
}

/**
 * What kind of evidence a sent message is, or null. Pure.
 * msg: { subject, to:[{name,email}], cc:[...], self:[lowercased own addresses] }
 */
function classify(msg, docNames) {
  const subject = String(msg.subject || '');
  if (SKIP_SUBJECT.test(subject)) return null;
  const self = new Set((msg.self || []).map((s) => String(s).toLowerCase()));
  const others = [...(msg.to || []), ...(msg.cc || [])].filter((r) => r && r.email && !self.has(r.email));
  if (!others.length) return null;
  if (docNames.length) return 'mail-document';
  if (others.length >= BROADCAST_MIN && !REPLY_SUBJECT.test(subject)) return 'mail-broadcast';
  return null;
}

function namesOf(rs) {
  const names = rs.map((r) => r.name || r.email);
  return names.length <= 6 ? names.join(', ') : `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`;
}

async function run(deps = {}) {
  const ms = deps.microsoft || require('./microsoft');
  const state = readState();
  const stamp = new Date().toISOString();
  const report = { ok: true, read: 0, kept: 0, failed: 0 };
  try {
    const token = await ms.getAccessToken();
    if (!token) throw new Error('Microsoft sign-in needed');
    const selfAddr = (await (ms.getSignedInAddress ? ms.getSignedInAddress() : null)) || null;
    const self = [selfAddr, 'nickw@nurtur.tech'].filter(Boolean).map((s) => String(s).toLowerCase());
    const floor = new Date(Date.now() - FLOOR_DAYS * 86400000).toISOString();
    const since = state.cursor && state.cursor > floor ? state.cursor : floor;
    const select = 'id,subject,toRecipients,ccRecipients,sentDateTime,hasAttachments,uniqueBody';
    let url = `/me/mailFolders/SentItems/messages?$filter=${encodeURIComponent(`sentDateTime gt ${since}`)}&$orderby=sentDateTime asc&$top=${PAGE}&$select=${select}`;
    const d = db();
    const up = d.prepare(`INSERT INTO perf_mail_items (id, kind, day, at, subject, recipients, attachments, excerpt, checked_at)
      VALUES (@id, @kind, @day, @at, @subject, @recipients, @attachments, @excerpt, @checked_at)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, subject=excluded.subject, recipients=excluded.recipients,
        attachments=excluded.attachments, excerpt=excluded.excerpt, checked_at=excluded.checked_at`);
    let cursor = state.cursor || null;
    let done = false;
    while (url && report.read < PER_RUN) {
      const page = await ms.graphFetch(url, token, { Prefer: 'outlook.body-content-type="text"' });
      if (!page || !Array.isArray(page.value)) throw new Error('Sent Items could not be read');
      for (const m of page.value) {
        report.read += 1;
        const who = (r) => (r && r.emailAddress ? { name: r.emailAddress.name || null, email: r.emailAddress.address ? String(r.emailAddress.address).toLowerCase() : null } : null);
        const msg = { subject: m.subject || '', to: (m.toRecipients || []).map(who).filter(Boolean), cc: (m.ccRecipients || []).map(who).filter(Boolean), self };
        let docs = [];
        if (m.hasAttachments) {
          try {
            const a = await ms.graphFetch(`/me/messages/${encodeURIComponent(m.id)}/attachments?$select=name,contentType,size,isInline`, token);
            docs = documentNames(a && a.value);
          } catch { report.failed += 1; }
        }
        const kind = classify(msg, docs);
        if (kind) {
          const others = [...msg.to, ...msg.cc].filter((r) => !self.includes(r.email));
          const text = String((m.uniqueBody && m.uniqueBody.content) || '').split(String.fromCharCode(13)).join('').replace(/\n{3,}/g, '\n\n').trim();
          up.run({ id: m.id, kind, day: londonDay(m.sentDateTime), at: m.sentDateTime, subject: msg.subject.slice(0, 200),
            recipients: namesOf(others), attachments: docs.length ? JSON.stringify(docs) : null,
            excerpt: text.slice(0, EXCERPT) || null, checked_at: stamp });
          report.kept += 1;
        }
        cursor = m.sentDateTime;
      }
      const next = page['@odata.nextLink'];
      if (!next) { done = true; break; }
      url = next.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '');
    }
    if (cursor) state.cursor = cursor;
    report.caughtUp = done;
    state.lastOk = stamp;
    state.lastError = null;
  } catch (e) {
    report.ok = false;
    report.error = e.message;
    state.lastError = { at: stamp, message: String(e.message).slice(0, 300) };
  }
  state.lastRun = stamp;
  state.last = report;
  writeState(state);
  return report;
}

function status() {
  const r = db().prepare('SELECT kind, count(*) n FROM perf_mail_items GROUP BY kind').all();
  return { ...readState(), items: Object.fromEntries(r.map((x) => [x.kind, x.n])) };
}

/** Feed items for a window — the cache only. Unread is a named gap, never []. */
function itemsFor(w) {
  const s = readState();
  if (!s.lastOk) throw new Error(s.lastError ? `Sent Items not read yet: ${s.lastError.message}` : 'Sent Items not read yet');
  return db().prepare('SELECT * FROM perf_mail_items WHERE day >= ? AND day <= ? ORDER BY at').all(w.from, w.to).map((r) => {
    const docs = r.attachments ? JSON.parse(r.attachments) : [];
    return {
      id: `mail:${r.id}`,
      source: 'mail',
      kind: r.kind,
      hint: null,
      at: r.at,
      title: r.kind === 'mail-document'
        ? `Sent ${docs.join(', ')} to ${r.recipients}`
        : `Emailed ${r.recipients}: "${r.subject}"`,
      detail: [`Subject: ${r.subject}.`, r.excerpt ? `You wrote: ${r.excerpt}` : null].filter(Boolean).join(' '),
      ref: null,
    };
  });
}

module.exports = { run, status, itemsFor, _internals: { classify, documentNames, londonDay, namesOf } };
