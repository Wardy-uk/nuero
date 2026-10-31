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
// Reading the documents (31 Oct 2026, Nick: "1 first with 2 as a backup").
// 1: pull the text out (doc-text.js), no model. 2: only when that comes back
// with almost nothing (a scanned PDF), Claude reads the PDF and describes it.
const DOC_TEXT = 1500;        // characters of a document carried into the item
const THIN_TEXT = 300;        // under this, extraction is "insufficient"
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const DOCS_PER_RUN = 15;      // messages read per pass
const AI_PER_RUN = 2;         // model reads per pass (shared hourly cloud limit)

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
    const cols = d.prepare('PRAGMA table_info(perf_mail_items)').all().map((c) => c.name);
    // What each attached document says (JSON [{name, how, text|why}]); NULL = not read yet.
    if (!cols.includes('doc_text')) d.exec('ALTER TABLE perf_mail_items ADD COLUMN doc_text TEXT');
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

const AI_SYSTEM = 'You describe a work document for a performance-evidence record. Say in 2-4 plain sentences what the document is and what it sets out or establishes (rules, a process, findings, a plan). Facts only, no praise, no judgement. If it cannot be read, say so in one sentence.';

/** Claude reads a PDF whose text could not be pulled out. Returns text or null. */
async function aiRead(name, buf, deps) {
  const aiRouting = deps.aiRouting || require('./ai-routing');
  const provider = deps.provider || require('./providers/anthropic-provider');
  if (!aiRouting.isCloudAllowed('perf_doc_read') || !provider.isConfigured()) return null;
  const r = await provider.vision(AI_SYSTEM, { pdfBase64: buf.toString('base64'), prompt: `The attachment is "${name}". Describe it.` },
    { model: process.env.PERF_DOC_MODEL || 'claude-opus-5', effort: 'low', maxTokens: 1000, callClass: 'perf_doc_read' });
  try { aiRouting.recordUsage(r.usage, { provider: 'anthropic', model: r.model, taskType: 'perf_doc_read' }); } catch { /* bookkeeping only */ }
  return String(r.text || '').trim().slice(0, DOC_TEXT) || null;
}

/**
 * Read the attached documents of kept messages not read yet. At most
 * DOCS_PER_RUN messages and AI_PER_RUN model reads a pass. A message whose
 * files could not be fetched stays unread and is tried again.
 */
async function readDocs(deps = {}) {
  const ms = deps.microsoft || require('./microsoft');
  const extract = deps.extract || require('./doc-text').extract;
  const maxPages = deps.maxPages || require('./providers/anthropic-provider').DOC_MAX_PAGES || 20;
  const report = { read: 0, files: 0, text: 0, ai: 0, unreadable: 0, failed: 0 };
  const token = await ms.getAccessToken();
  if (!token) return { ...report, error: 'Microsoft sign-in needed' };
  const d = db();
  const rows = d.prepare("SELECT id FROM perf_mail_items WHERE kind = 'mail-document' AND doc_text IS NULL ORDER BY at DESC LIMIT ?").all(deps.perRun || DOCS_PER_RUN);
  const save = d.prepare('UPDATE perf_mail_items SET doc_text = ? WHERE id = ?');
  let aiLeft = deps.aiPerRun !== undefined ? deps.aiPerRun : AI_PER_RUN;
  for (const row of rows) {
    try {
      const list = await ms.graphFetch(`/me/messages/${encodeURIComponent(row.id)}/attachments?$select=id,name,size,isInline`, token);
      if (!list || !Array.isArray(list.value)) throw new Error('attachments could not be listed');
      const out = [];
      for (const a of list.value.filter((x) => !x.isInline && x.name && DOC_EXT.test(x.name))) {
        report.files += 1;
        if (a.size > MAX_DOC_BYTES) { out.push({ name: a.name, how: 'none', why: 'too big to read' }); report.unreadable += 1; continue; }
        const full = await ms.graphFetch(`/me/messages/${encodeURIComponent(row.id)}/attachments/${encodeURIComponent(a.id)}`, token);
        if (!full || !full.contentBytes) { out.push({ name: a.name, how: 'none', why: 'not a file' }); report.unreadable += 1; continue; }
        const buf = Buffer.from(full.contentBytes, 'base64');
        const x = await extract(a.name, buf);
        if (x.ok && x.text.length >= THIN_TEXT) {
          out.push({ name: a.name, how: 'text', text: x.text.slice(0, DOC_TEXT) });
          report.text += 1;
          continue;
        }
        // Option 2: Claude reads the PDF itself. Only a PDF, only up to the page cap.
        const pdfOk = /\.pdf$/i.test(a.name) && (!x.pages || x.pages <= maxPages);
        if (pdfOk && aiLeft <= 0) throw Object.assign(new Error('model reads used up this pass'), { retry: true });
        if (pdfOk) {
          aiLeft -= 1;
          const said = await aiRead(a.name, buf, deps).catch(() => null);
          if (said) { out.push({ name: a.name, how: 'ai', text: said }); report.ai += 1; continue; }
        }
        out.push({ name: a.name, how: 'none', why: x.ok ? 'almost no text in it' : x.why });
        report.unreadable += 1;
      }
      save.run(JSON.stringify(out), row.id);
      report.read += 1;
    } catch (e) {
      if (e.retry) break;
      report.failed += 1;
    }
  }
  return report;
}

function status() {
  const r = db().prepare('SELECT kind, count(*) n FROM perf_mail_items GROUP BY kind').all();
  return { ...readState(), items: Object.fromEntries(r.map((x) => [x.kind, x.n])) };
}

/** The documents' own words, a line per file. Pure. */
function docLines(json) {
  let docs = [];
  try { docs = JSON.parse(json || '[]') || []; } catch { return []; }
  return docs.map((x) => (x.how === 'text' ? `Attachment "${x.name}" begins: ${x.text}`
    : x.how === 'ai' ? `Attachment "${x.name}" (read by AI): ${x.text}`
      : `Attachment "${x.name}" could not be read (${x.why}).`));
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
      detail: [`Subject: ${r.subject}.`, r.excerpt ? `You wrote: ${r.excerpt}` : null, ...docLines(r.doc_text)].filter(Boolean).join(' '),
      ref: null,
    };
  });
}

module.exports = { run, readDocs, status, itemsFor, _internals: { docLines, classify, documentNames, londonDay, namesOf } };
