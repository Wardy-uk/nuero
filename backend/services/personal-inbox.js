'use strict';

/**
 * The personal inbox (12 Oct 2026) — nick@ and contact@, newest first, NO AI
 * (Nick's call: a plain list for now). SEPARATE from the work triage: its own
 * store (`personal_inbox`), its own screen. Plus saim@, watched ONLY for bounces
 * and auto-replies — a bounced hike alert must be noticed.
 *
 * ⚠⚠ Fasthosts' IMAP SEARCH answers [] to everything (measured 12 Oct), so this
 *   never searches: it FETCHes the newest WINDOW messages by sequence number.
 * ⚠ READ-ONLY by construction: loads imapflow, never a sender (pinned) —
 *   prepared-actions reads through it to prepare a reply. Bodies via BODY.PEEK,
 *   so opening never marks read; only "Mark read" sets \Seen.
 * ⚠ The store MIRRORS the window: a message gone from the mailbox leaves it;
 *   a changed UIDVALIDITY replaces the mailbox's rows.
 */

const pm = require('./personal-mail');

// Gmail moved here from the work triage (Nick, 12 Oct 2026); which Gmail mail
// shows is gmail-rule's call (see _refreshGmail) — no AI sorting.
const INBOXES = ['nick', 'contact', 'gmail'];
const WATCHED = ['saim'];
const WINDOW = 100;
const PREVIEW_CHARS = 300;
const BODY_MAX = 200 * 1024;
const ID_PREFIX = 'pmail:';
const STATUS_KEY = 'personal_inbox_status';

function _db() { return require('../db/database'); }
const isPersonalId = (id) => typeof id === 'string' && id.startsWith(ID_PREFIX);
const idFor = (mailbox, uidValidity, uid) => `${ID_PREFIX}${mailbox}:${uidValidity}:${uid}`;
function parseId(id) {
  const m = /^pmail:([a-z]+):([^:]+):(\d+)$/.exec(String(id || ''));
  return m ? { mailbox: m[1], uidValidity: m[2], uid: Number(m[3]) } : null;
}

function _withDefaults(deps) {
  return { now: () => Date.now(), imap: (cfg) => new (require('imapflow').ImapFlow)(cfg), ...(deps || {}) };
}

async function _open(key, deps) {
  const cred = pm.credentialFor(key);
  if (!cred) return { error: 'not-configured' };
  const c = deps.imap(pm.imapConfig(key, cred));
  if (typeof c.on === 'function') c.on('error', () => {});
  await c.connect();
  return { c, cred };
}
async function _close(c) { try { await c.logout(); } catch { try { c.close(); } catch { /* gone */ } } }

const _addr = (list) => (list || []).map((a) => ({ name: a.name || '', email: String(a.address || '').toLowerCase() })).filter((a) => a.email);

function textPartOf(node) { return require('./gmail-intake').textPartOf(node); }
function stripHtml(s) { return require('./gmail-intake').stripHtml(s); }

async function _readText(c, uid, bodyStructure, maxBytes) {
  const tp = textPartOf(bodyStructure);
  if (!tp) return '';
  const r = await c.download(String(uid), tp.part, { uid: true, maxBytes });
  if (!r || !r.content) return '';
  const chunks = [];
  for await (const chunk of r.content) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return require('./gmail-intake').cleanText(tp.type === 'text/html' ? stripHtml(text) : text).replace(/[ \t]+/g, ' ').trim();
}

/**
 * What a message to saim@ is. PURE. saim@ sends with Reply-To nick@, so what
 * lands here is mostly machinery: a bounce or an auto-reply. Anything else is
 * a person who replied to SAiM directly — kept and labelled, never dropped.
 */
function classifyWatched({ fromEmail = '', subject = '', headers = '', contentType = '' } = {}) {
  const h = String(headers || '').toLowerCase();
  const s = String(subject || '');
  if (/mailer-daemon|postmaster/i.test(fromEmail) || /multipart\/report/i.test(contentType) || /delivery-status/i.test(h)
    || /^(undeliver|delivery status notification|failure notice|returned mail|mail delivery (failed|subsystem))/i.test(s)) return 'bounce';
  const auto = /auto-submitted:\s*(?!no\b)\S+/.test(h) || /x-autoreply:|x-autorespond:|precedence:\s*auto_reply/.test(h);
  if (auto || /^(automatic reply|auto[-\s]?reply|out of (the )?office|autoreply)/i.test(s)) return 'auto-reply';
  return 'reply';
}

/** The Message-ID a bounce is about — the first one in its text that is not its own. PURE. */
function bouncedMessageId(raw, ownId) {
  const ids = String(raw || '').match(/message-id:\s*(<[^>\s]+>)/gi) || [];
  const own = String(ownId || '').toLowerCase();
  for (const line of ids) {
    const id = line.replace(/^message-id:\s*/i, '').toLowerCase();
    if (id !== own) return id;
  }
  return null;
}

function _why(ext) {
  try { const e = JSON.parse(ext || 'null'); return e && e.reason ? (require('./gmail-rule').REASON_WORDS[e.reason] || null) : null; } catch { return null; }
}

function _row(r) {
  if (!r) return null;
  return {
    id: r.id, mailbox: r.mailbox, from: r.from_name || r.from_email, fromEmail: r.from_email, subject: r.subject,
    received: r.received, seen: r.seen === 1, preview: r.preview || '', kind: r.kind || null,
    bounceOf: r.bounce_of || null, hikeTripId: r.hike_trip_id || null,
    why: r.mailbox === 'gmail' ? _why(r.ext_json) : null,
  };
}

/**
 * Gmail (12 Oct 2026, Nick — the review that found 97% of a month's Gmail was
 * mailing lists): Gmail's INBOX folder, judged by gmail-rule (Important is one
 * reason beside starred, people he writes to, his always-show list and
 * personal-looking Primary mail; his hide list beats all of it). Every row
 * carries the reason it was shown.
 *
 * ⚠ The cursor (gmail-intake's WATERMARK_KEY, on INBOX) starts at UIDNEXT on
 *   first connect — NOTHING old is read by the timer. History comes in only by
 *   an explicit backfill (Nick asked for the last 30 days, 12 Oct), which
 *   rewinds the cursor and lets the same pass judge it.
 * ⚠ A pass scans at most GMAIL_SCAN_MAX messages and continues from where it
 *   stopped next time — never skips ahead.
 * ⚠ Mirrored: a shown message that leaves the inbox (archived, deleted) leaves
 *   the tab. Nothing here changes the mailbox; ids stay `gmail:<X-GM-MSGID>`.
 */
const GMAIL_SCAN_MAX = 2500;
const GMAIL_HEADERS = ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted'];
const BACKFILL_MAX_DAYS = 90;

async function _refreshGmail(deps) {
  const r = await _refreshGmailInner(deps);
  // Settings → Personal email reads this to say what the last Gmail pass did.
  try {
    _db().setState(require('./gmail-intake').STATUS_KEY, JSON.stringify(r.ok
      ? { at: new Date(deps.now()).toISOString(), ok: true, fetched: r.added || 0, scanned: r.scanned || 0, ...(r.more ? { more: true } : {}), ...(r.watermarkSet ? { watermarkSet: true } : {}) }
      : { at: new Date(deps.now()).toISOString(), ok: false, why: r.why }));
  } catch { /* status only */ }
  return r;
}

const _sentPath = (list) => (list.find((m) => m.specialUse === '\\Sent' || (m.flags instanceof Set && m.flags.has('\\Sent'))) || {}).path || null;

/** Everyone Nick has written to from Gmail in the last year, cached a day. A failed read keeps the last answer. */
async function _correspondents(c, deps) {
  const gr = require('./gmail-rule');
  const cached = gr.readCorrespondents();
  if (!gr.correspondentsStale(cached, deps.now())) return new Set(cached.addresses);
  try {
    const sent = _sentPath(await c.list());
    if (!sent) return new Set(cached ? cached.addresses : []);
    const out = [];
    const lock = await c.getMailboxLock(sent);
    try {
      const uids = await c.search({ since: new Date(deps.now() - 365 * 86400000) }, { uid: true });
      for (let i = 0; uids && i < uids.length; i += 500) {
        for await (const m of c.fetch(uids.slice(i, i + 500).join(','), { uid: true, envelope: true }, { uid: true })) {
          const env = m.envelope || {};
          for (const a of [...(env.to || []), ...(env.cc || []), ...(env.bcc || [])]) if (a.address) out.push(String(a.address).toLowerCase());
        }
      }
    } finally { lock.release(); }
    gr.writeCorrespondents(out, new Date(deps.now()).toISOString());
    return new Set(out);
  } catch { return new Set(cached ? cached.addresses : []); }
}

function _readCursor() {
  try { return JSON.parse(_db().getState(require('./gmail-intake').WATERMARK_KEY) || 'null'); } catch { return null; }
}
function _writeCursor(cur) { _db().setState(require('./gmail-intake').WATERMARK_KEY, JSON.stringify(cur)); }

/** Insert one judged message (INSERT OR IGNORE — a backfill may meet rows already shown). */
async function _insertGmail(c, m, { uidValidity, reason, at }) {
  const gi = require('./gmail-intake');
  let full = m;
  if (!m.bodyStructure) {
    try { full = { ...m, ...((await c.fetchOne(String(m.uid), { uid: true, bodyStructure: true }, { uid: true })) || {}) }; } catch { /* subject-only */ }
  }
  let text = '';
  try { text = await _readText(c, m.uid, full.bodyStructure, 16 * 1024); } catch { /* subject-only is still mail */ }
  const e = gi.toTriageEmail(full, { path: 'INBOX', uidValidity });
  const r = _db().run(`INSERT OR IGNORE INTO personal_inbox (id, mailbox, uid, uid_validity, message_id, from_email, from_name, subject, received, seen, preview,
            to_json, cc_json, kind, bounce_of, ext_json, fetched_at) VALUES (?, 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  [e.id, m.uid, uidValidity, e.gmail.messageId, e.fromEmail, e.from, e.subject, e.received || at, e.isRead ? 1 : 0,
    String(text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS), JSON.stringify(e.to), JSON.stringify(e.cc), JSON.stringify({ ...e.gmail, reason }), at]);
  return r && r.changes ? e.id : null;
}

async function _refreshGmailInner(deps) {
  const gr = require('./gmail-rule');
  const db = _db();
  const at = new Date(deps.now()).toISOString();
  let c;
  const added = [];
  try {
    const o = await _open('gmail', deps);
    if (o.error) return { key: 'gmail', ok: true, skipped: o.error };
    c = o.c;
    const correspondents = await _correspondents(c, deps);
    const lock = await c.getMailboxLock('INBOX');
    let scanned = 0; let more = false;
    try {
      const box = c.mailbox || {};
      const uidValidity = String(box.uidValidity);
      const uidNext = Number(box.uidNext);
      const cur = _readCursor();
      if (!cur || cur.folder !== 'INBOX' || cur.uidValidity !== uidValidity) {
        _writeCursor({ folder: 'INBOX', uidValidity, uidNext, scannedTo: uidNext, setAt: at, ...(cur ? { previous: { folder: cur.folder || cur.path || null, uidValidity: cur.uidValidity, setAt: cur.setAt } } : {}) });
        db.run("DELETE FROM personal_inbox WHERE mailbox = 'gmail'");
        return { key: 'gmail', ok: true, added: 0, addedIds: [], watermarkSet: true };
      }
      const rules = gr.readRules();
      const own = pm.addressFor('gmail');
      const from = Number(cur.scannedTo);
      if (uidNext > from) {
        let primaryUids = [];
        try { primaryUids = (await c.search({ uid: `${from}:*`, gmraw: 'category:primary' }, { uid: true })) || []; } catch { primaryUids = []; }
        const primary = new Set(primaryUids);
        const msgs = [];
        // `n:*` returns the highest message even when it is below n — the UID filter is load-bearing.
        for await (const m of c.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, labels: true, internalDate: true, threadId: true, emailId: true, headers: GMAIL_HEADERS }, { uid: true })) {
          if (m.uid >= from) msgs.push(m);
        }
        msgs.sort((a, b) => a.uid - b.uid);
        const batch = msgs.slice(0, GMAIL_SCAN_MAX);
        more = msgs.length > GMAIL_SCAN_MAX;
        for (const m of batch) {
          scanned += 1;
          const env = m.envelope || {};
          const sender = String(((env.from && env.from[0]) || {}).address || '').toLowerCase();
          const v = gr.judge({ fromEmail: sender, labels: m.labels, flags: m.flags, headers: m.headers ? m.headers.toString('utf8') : '', primary: primary.has(m.uid) },
            { ...rules, correspondents, own });
          if (!v.show) continue;
          const id = await _insertGmail(c, m, { uidValidity, reason: v.reason, at });
          if (id) added.push(id);
        }
        const next = more ? batch.at(-1).uid + 1 : Math.max(uidNext, from);
        _writeCursor({ ...cur, uidNext, scannedTo: next, lastScanAt: at });
        if (more) console.warn(`[PersonalInbox] Gmail: ${msgs.length} messages to judge; judged ${batch.length}, the rest next pass`);
      }
      // Mirror: a shown message that left the inbox (or whose sender Nick hid) leaves.
      const rows = db.all("SELECT id, from_email, ext_json FROM personal_inbox WHERE mailbox = 'gmail'");
      const live = [];
      for (const r of rows) {
        let ext = null;
        try { ext = JSON.parse(r.ext_json || 'null'); } catch { ext = null; }
        if (!ext || ext.path !== 'INBOX' || String(ext.uidValidity) !== uidValidity || gr.senderMatches(rules.hide, r.from_email)) { db.run('DELETE FROM personal_inbox WHERE id = ?', [r.id]); continue; }
        live.push({ id: r.id, uid: Number(ext.uid) });
      }
      const present = new Map();
      for (let i = 0; i < live.length; i += 500) {
        const uids = live.slice(i, i + 500).map((x) => x.uid);
        for await (const m of c.fetch(uids.join(','), { uid: true, flags: true }, { uid: true })) if (uids.includes(m.uid)) present.set(m.uid, m);
      }
      for (const x of live) {
        const m = present.get(x.uid);
        if (!m) { db.run('DELETE FROM personal_inbox WHERE id = ?', [x.id]); continue; }
        const flags = m.flags instanceof Set ? m.flags : new Set(m.flags || []);
        db.run('UPDATE personal_inbox SET seen = ?, fetched_at = ? WHERE id = ?', [flags.has('\\Seen') ? 1 : 0, at, x.id]);
      }
    } finally { lock.release(); }
    return { key: 'gmail', ok: true, added: added.length, addedIds: added, scanned, more };
  } catch (e) {
    return { key: 'gmail', ok: false, why: pm.classifyError(e).error };
  } finally { if (c) await _close(c); }
}

/**
 * One-off: judge the last `days` of Gmail's inbox (Nick, 12 Oct 2026 — "get
 * the ones you identified as important in my inbox"). Rewinds the cursor to
 * the first message in the window, then runs the ordinary pass. Days are 1–90,
 * refused (not clamped) otherwise. Changes nothing in Gmail.
 */
async function backfillGmail(days, { deps } = {}) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > BACKFILL_MAX_DAYS) return { ok: false, error: `days must be a whole number from 1 to ${BACKFILL_MAX_DAYS}` };
  deps = _withDefaults(deps);
  if (!pm.credentialFor('gmail')) return { ok: false, error: 'no Gmail password saved' };
  const at = new Date(deps.now()).toISOString();
  const since = new Date(deps.now() - n * 86400000);
  let c;
  try {
    const o = await _open('gmail', deps);
    if (o.error) return { ok: false, error: o.error };
    c = o.c;
    const lock = await c.getMailboxLock('INBOX');
    try {
      const box = c.mailbox || {};
      const uidValidity = String(box.uidValidity);
      const uidNext = Number(box.uidNext);
      const uids = await c.search({ since }, { uid: true });
      const first = uids && uids.length ? Math.min(...uids) : uidNext;
      let cur = _readCursor();
      if (!cur || cur.folder !== 'INBOX' || cur.uidValidity !== uidValidity) {
        _db().run("DELETE FROM personal_inbox WHERE mailbox = 'gmail'");
        cur = { folder: 'INBOX', uidValidity, uidNext, scannedTo: uidNext, setAt: at };
      }
      _writeCursor({ ...cur, scannedTo: Math.min(Number(cur.scannedTo), first), backfill: { days: n, since: since.toISOString(), at, messages: uids ? uids.length : 0 } });
    } finally { lock.release(); }
  } catch (e) {
    return { ok: false, error: pm.classifyError(e).error };
  } finally { if (c) await _close(c); }
  const r = await _refreshGmail(deps);
  return r.ok ? { ok: true, days: n, scanned: r.scanned || 0, shown: r.added || 0, more: !!r.more } : { ok: false, error: r.why };
}

/**
 * "Always show" / "Stop showing" a sender (address or @domain), or clear it.
 * Hide removes that sender's rows at once. Keep pulls that sender's inbox mail
 * from the last 30 days in (a failed pull keeps the rule and says so).
 */
async function setGmailSender(sender, list, { deps } = {}) {
  const gr = require('./gmail-rule');
  const r = gr.setRule(sender, list);
  if (!r.ok) return r;
  const db = _db();
  if (list === 'hide') {
    for (const row of db.all("SELECT id, from_email FROM personal_inbox WHERE mailbox = 'gmail'")) {
      if (gr.senderMatches([r.sender], row.from_email)) db.run('DELETE FROM personal_inbox WHERE id = ?', [row.id]);
    }
    return r;
  }
  if (list !== 'keep') return r;
  deps = _withDefaults(deps);
  const at = new Date(deps.now()).toISOString();
  let c;
  const pulled = [];
  try {
    const o = await _open('gmail', deps);
    if (o.error) return { ...r, pulled: null, why: o.error };
    c = o.c;
    const lock = await c.getMailboxLock('INBOX');
    try {
      const uidValidity = String((c.mailbox || {}).uidValidity);
      const cur = _readCursor();
      if (!cur || cur.folder !== 'INBOX' || cur.uidValidity !== uidValidity) return { ...r, pulled: 0 };
      const needle = r.sender.startsWith('@') ? r.sender.slice(1) : r.sender;
      const uids = await c.search({ since: new Date(deps.now() - 30 * 86400000), from: needle }, { uid: true });
      if (uids && uids.length) {
        for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true, flags: true, internalDate: true, threadId: true, emailId: true, bodyStructure: true }, { uid: true })) {
          const env = m.envelope || {};
          const sender = String(((env.from && env.from[0]) || {}).address || '').toLowerCase();
          if (!gr.senderMatches([r.sender], sender)) continue;
          const id = await _insertGmail(c, m, { uidValidity, reason: 'keep', at });
          if (id) pulled.push(id);
        }
      }
    } finally { lock.release(); }
    return { ...r, pulled: pulled.length };
  } catch (e) {
    return { ...r, pulled: null, why: pm.classifyError(e).error };
  } finally { if (c) await _close(c); }
}

function gmailRules() {
  const gr = require('./gmail-rule');
  const c = gr.readCorrespondents();
  return { ...gr.readRules(), correspondents: c ? { count: c.addresses.length, at: c.at } : null, reasons: gr.REASON_WORDS, cursor: _readCursor() };
}

/** The stored Gmail coordinates for an id (gmail-intake reads/marks through these). */
function gmailEntry(id) {
  const r = _db().get("SELECT ext_json FROM personal_inbox WHERE id = ? AND mailbox = 'gmail'", [id]);
  if (!r || !r.ext_json) return null;
  try { return { id, gmail: JSON.parse(r.ext_json) }; } catch { return null; }
}

/** Mirror one mailbox's newest WINDOW messages. Never throws. */
async function refreshMailbox(key, { deps } = {}) {
  deps = _withDefaults(deps);
  if (key === 'gmail') return pm.credentialFor('gmail') ? _refreshGmail(deps) : { key, ok: true, skipped: 'not-configured' };
  const at = new Date(deps.now()).toISOString();
  if (!pm.credentialFor(key)) return { key, ok: true, skipped: 'not-configured' };
  let c;
  const added = [];
  try {
    const o = await _open(key, deps);
    if (o.error) return { key, ok: true, skipped: o.error };
    c = o.c;
    const lock = await c.getMailboxLock('INBOX');
    try {
      const box = c.mailbox || {};
      const uidValidity = String(box.uidValidity);
      const exists = Number(box.exists) || 0;
      const db = _db();
      const known = new Map(db.all('SELECT id FROM personal_inbox WHERE mailbox = ?', [key]).map((r) => [r.id, true]));
      const seenIds = new Set();
      if (exists > 0) {
        const watched = WATCHED.includes(key);
        const query = { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, ...(watched ? { headers: ['auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'content-type'] } : {}) };
        const msgs = [];
        for await (const m of c.fetch(`${Math.max(1, exists - WINDOW + 1)}:*`, query)) msgs.push(m);
        for (const m of msgs) {
          const id = idFor(key, uidValidity, m.uid);
          seenIds.add(id);
          const env = m.envelope || {};
          const from = (env.from && env.from[0]) || {};
          const flags = m.flags instanceof Set ? m.flags : new Set(m.flags || []);
          const seen = flags.has('\\Seen') ? 1 : 0;
          if (known.has(id)) { db.run('UPDATE personal_inbox SET seen = ?, fetched_at = ? WHERE id = ?', [seen, at, id]); continue; }
          let text = '';
          try { text = await _readText(c, m.uid, m.bodyStructure, 16 * 1024); } catch { /* subject-only is still mail */ }
          let kind = null; let bounceOf = null;
          if (watched) {
            const headers = m.headers ? m.headers.toString('utf8') : '';
            kind = classifyWatched({ fromEmail: from.address, subject: env.subject, headers, contentType: (m.bodyStructure && m.bodyStructure.type) || '' });
            if (kind === 'bounce') {
              try {
                const src = await c.fetchOne(String(m.uid), { source: { maxLength: 64 * 1024 } }, { uid: true });
                bounceOf = bouncedMessageId(src && src.source ? src.source.toString('utf8') : text, env.messageId);
              } catch { bounceOf = bouncedMessageId(text, env.messageId); }
            }
          }
          db.run(`INSERT INTO personal_inbox (id, mailbox, uid, uid_validity, message_id, from_email, from_name, subject, received, seen, preview,
                    to_json, cc_json, kind, bounce_of, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, key, m.uid, uidValidity, env.messageId || null, String(from.address || '').toLowerCase(), from.name || null, env.subject || '(No subject)',
            m.internalDate ? new Date(m.internalDate).toISOString() : (env.date ? new Date(env.date).toISOString() : at), seen,
            String(text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS), JSON.stringify(_addr(env.to)), JSON.stringify(_addr(env.cc)), kind, bounceOf, at]);
          added.push(id);
        }
      }
      // Mirror: anything no longer in the window (deleted, moved, renumbered) leaves.
      for (const id of known.keys()) if (!seenIds.has(id)) db.run('DELETE FROM personal_inbox WHERE id = ?', [id]);
    } finally { lock.release(); }
    return { key, ok: true, added: added.length, addedIds: added };
  } catch (e) {
    return { key, ok: false, why: pm.classifyError(e).error };
  } finally { if (c) await _close(c); }
}

/**
 * A bounce of a hike alert sent from saim@: note it on the walk and tell Nick
 * once (new rows only). The alert's own ledger is untouched — a bounce for one
 * recipient is not proof the others did not get it, and the Gmail copy is
 * independent.
 */
async function _noticeHikeBounces(addedIds, { deps } = {}) {
  const db = _db();
  const out = [];
  for (const id of addedIds) {
    const r = db.get("SELECT * FROM personal_inbox WHERE id = ? AND kind = 'bounce' AND bounce_of IS NOT NULL", [id]);
    if (!r) continue;
    const trip = db.get("SELECT trip_id, name FROM hike_trips WHERE lower(alert_message_id) = ? AND alert_mailbox = 'saim'", [r.bounce_of]);
    if (!trip) continue;
    db.run('UPDATE personal_inbox SET hike_trip_id = ? WHERE id = ?', [trip.trip_id, id]);
    db.run('UPDATE hike_trips SET alert_error = ? WHERE trip_id = ?', [`The alert from saim@ BOUNCED: "${String(r.subject || '').slice(0, 80)}" — the Gmail copy is separate; check it reached them.`, trip.trip_id]);
    const push = (deps && deps.push) || ((title, body, data) => require('./webpush').sendToAll(title, body, { ...data, type: 'hike_checkin' }));
    try { await push('Hike alert bounced', `The alert for ${trip.name} from saim@ bounced. Check Helen got the Gmail copy — or tell her directly.`, { url: '/?view=hike-safety', tripId: trip.trip_id }); } catch { /* the note on the walk stands */ }
    out.push(trip.trip_id);
  }
  return out;
}

/** Refresh nick@, contact@ and saim@. The durable job and the Refresh button. */
async function refresh({ deps, only = null } = {}) {
  const results = [];
  for (const key of only || [...INBOXES, ...WATCHED]) results.push(await refreshMailbox(key, { deps }));
  const saim = results.find((r) => r.key === 'saim');
  const bounced = saim && saim.addedIds ? await _noticeHikeBounces(saim.addedIds, { deps }) : [];
  // The Gmail clean-up screen's archive rules (12 Oct 2026): each pass archives
  // what those senders have in the inbox now. Never allowed to fail the refresh.
  let archived = null;
  if (!only || only.includes('gmail')) {
    try {
      const a = await ((deps && deps.applyCleanup) || ((o) => require('./gmail-cleanup').applyRules(o)))({ deps });
      if (a && (a.archived || a.error)) archived = { archived: a.archived || 0, ...(a.error ? { error: a.error } : {}), ...(a.more ? { more: true } : {}) };
    } catch (e) { archived = { error: e.message }; }
  }
  // Personal tasks out of personal mail (12 Oct 2026) — the same review-only
  // extractor the work inbox uses; it buys each email's answer once, so a pass
  // with no new mail costs nothing. Never allowed to fail the refresh.
  let tasks = null;
  if (!only || only.some((k) => INBOXES.includes(k))) {
    try {
      const rows = _db().all(`SELECT * FROM personal_inbox WHERE mailbox IN (${INBOXES.map(() => '?').join(',')})`, INBOXES);
      const own = [...INBOXES.map((k) => pm.addressFor(k)), require('./mail-identity').WORK_ADDRESS];
      const extract = (deps && deps.extractTasks) || require('./email-actions').extractFromPersonal;
      const r = await extract(rows, { own });
      tasks = { created: r.created || 0, asked: r.asked || 0, ...(r.failedBatches ? { failedBatches: r.failedBatches } : {}), ...(r.skipped ? { skipped: r.skipped } : {}) };
    } catch (e) { tasks = { error: e.message }; console.warn('[PersonalInbox] task scan failed:', e.message); }
  }
  const status = { at: new Date().toISOString(), results: results.map(({ addedIds, ...r }) => r), hikeBounces: bounced.length, ...(tasks ? { tasks } : {}), ...(archived ? { cleanup: archived } : {}) };
  _db().setState(STATUS_KEY, JSON.stringify(status));
  return status;
}

function list(mailbox, { limit = WINDOW } = {}) {
  if (![...INBOXES, ...WATCHED].includes(mailbox)) return null;
  return _db().all('SELECT * FROM personal_inbox WHERE mailbox = ? ORDER BY received DESC LIMIT ?', [mailbox, Math.max(1, Math.min(WINDOW, Number(limit) || WINDOW))]).map(_row);
}

function overview() {
  const db = _db();
  let status = null;
  try { status = JSON.parse(db.getState(STATUS_KEY) || 'null'); } catch { status = null; }
  const counts = (mb) => db.get('SELECT COUNT(*) n, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) unread FROM personal_inbox WHERE mailbox = ?', [mb]);
  return {
    mailboxes: [...INBOXES, ...WATCHED].map((key) => {
      const c = counts(key) || {};
      const s = pm.senderFor(key);
      return {
        key, address: pm.addressFor(key), configured: Boolean(pm.credentialFor(key)), watchedOnly: WATCHED.includes(key),
        count: c.n || 0, unread: c.unread || 0, sendsFrom: s ? s.from : null,
        last: status ? (status.results || []).find((r) => r.key === key) || null : null,
      };
    }),
    lastRefresh: status ? status.at : null,
    rule: 'Newest first, no AI sorting. Opening a message does not mark it read; Mark read does. Replies go from the same mailbox, prepared and sent on your click like an Inbox reply.',
  };
}

async function _withMessage(id, fn, deps) {
  deps = _withDefaults(deps);
  const p = parseId(id);
  if (!p) return { ok: false, reason: 'bad-id' };
  let c;
  try {
    const o = await _open(p.mailbox, deps);
    if (o.error) return { ok: false, reason: o.error };
    c = o.c;
    const lock = await c.getMailboxLock('INBOX');
    try {
      if (String((c.mailbox || {}).uidValidity) !== p.uidValidity) return { ok: true, exists: false };
      return await fn(c, p);
    } finally { lock.release(); }
  } catch (e) {
    return { ok: false, reason: pm.classifyError(e).kind, category: pm.classifyError(e).kind, error: pm.classifyError(e).error };
  } finally { if (c) await _close(c); }
}

/**
 * The live message — same shape as gmail-intake.readMessage, so the reply path
 * is one shape. conversationId is the message's own Message-ID: Fasthosts has
 * no thread id, and a reply is matched to it by In-Reply-To.
 */
async function readMessage(id, { deps } = {}) {
  if (require('./gmail-intake').isGmailId(id)) {
    const g = await require('./gmail-intake').readMessage(id, { deps });
    return g && g.ok && g.exists ? { ...g, mailbox: 'gmail' } : g;
  }
  return _withMessage(id, async (c, p) => {
    const m = await c.fetchOne(String(p.uid), { uid: true, envelope: true, bodyStructure: true, internalDate: true, headers: ['references'] }, { uid: true });
    if (!m || !m.envelope) return { ok: true, exists: false };
    let body = '';
    try { body = await _readText(c, m.uid, m.bodyStructure, BODY_MAX); } catch { /* headers are still the message */ }
    const env = m.envelope;
    const from = (env.from && env.from[0]) || {};
    const refs = m.headers ? String(m.headers).replace(/^references:\s*/i, '').replace(/\r?\n\s+/g, ' ').trim() : '';
    return {
      ok: true, exists: true, mailbox: p.mailbox,
      from: String(from.address || '').toLowerCase(), fromName: from.name || '',
      subject: env.subject || '', to: _addr(env.to), cc: _addr(env.cc), body,
      conversationId: env.messageId || null, internetMessageId: env.messageId || null,
      references: refs || null,
      received: m.internalDate ? new Date(m.internalDate).toISOString() : null,
    };
  }, deps);
}

async function markRead(id, { deps } = {}) {
  if (require('./gmail-intake').isGmailId(id)) {
    const g = await require('./gmail-intake').markRead(id, { deps });
    if (g.marked) _db().run('UPDATE personal_inbox SET seen = 1 WHERE id = ?', [id]);
    return g;
  }
  const r = await _withMessage(id, async (c, p) => {
    await c.messageFlagsAdd(String(p.uid), ['\\Seen'], { uid: true });
    return { ok: true };
  }, deps);
  if (r.ok && r.exists !== false) _db().run('UPDATE personal_inbox SET seen = 1 WHERE id = ?', [id]);
  return r.ok && r.exists !== false ? { marked: true } : { marked: false, reason: r.reason || 'gone' };
}

/**
 * Delete = MOVE to that mailbox's own Bin/Trash (Fasthosts "Trash", Gmail
 * "[Gmail]/Bin"), never an expunge — a mis-tap is recoverable in the mailbox.
 * Refused when the folder was renumbered since we read it (the uid would name
 * a different message). Returns { deleted, to } or { deleted:false, reason }.
 */
async function trash(id, { deps } = {}) {
  deps = _withDefaults(deps);
  const gmail = require('./gmail-intake').isGmailId(id);
  const g = gmail ? gmailEntry(id) : null;
  const p = gmail ? (g ? { mailbox: 'gmail', uid: g.gmail.uid, uidValidity: String(g.gmail.uidValidity), folder: g.gmail.path } : null) : parseId(id);
  if (!p) return { deleted: false, reason: 'not-found' };
  let c;
  try {
    const o = await _open(p.mailbox, deps);
    if (o.error) return { deleted: false, reason: o.error };
    c = o.c;
    const list = await c.list().catch(() => []);
    const bin = (list.find((m) => m.specialUse === '\\Trash') || {}).path || (gmail ? null : 'Trash');
    if (!bin) return { deleted: false, reason: 'no-trash-folder' };
    const lock = await c.getMailboxLock(p.folder || 'INBOX');
    try {
      if (String((c.mailbox || {}).uidValidity) !== p.uidValidity) return { deleted: false, reason: 'renumbered' };
      await c.messageMove(String(p.uid), bin, { uid: true });
    } finally { lock.release(); }
    _db().run('DELETE FROM personal_inbox WHERE id = ?', [id]);
    return { deleted: true, to: bin };
  } catch (e) {
    return { deleted: false, reason: pm.classifyError(e).kind, error: pm.classifyError(e).error };
  } finally { if (c) await _close(c); }
}

const BULK_MAX = 200;

/**
 * Mark read or delete MANY messages (12 Oct 2026, Nick: multi-select). One IMAP
 * connection per mailbox and one command per folder, never one per message.
 * Same rules as the single-message paths: delete MOVES to that mailbox's own
 * Bin/Trash (recoverable), and a folder renumbered since we read it is refused
 * for every message in it (a uid from an old numbering names another message).
 * Returns { ok, done, failed:[{id, reason}] } — never throws.
 */
async function bulk(action, ids, { deps } = {}) {
  if (!['read', 'delete'].includes(action)) return { ok: false, error: 'action must be read or delete' };
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'no messages chosen' };
  if (ids.length > BULK_MAX) return { ok: false, error: `at most ${BULK_MAX} at a time` };
  deps = _withDefaults(deps);
  const gi = require('./gmail-intake');
  const db = _db();
  const failed = [];
  const groups = new Map(); // mailbox -> folder -> { uidValidity, items:[{id, uid}] }
  for (const id of [...new Set(ids.map(String))]) {
    let target = null;
    if (gi.isGmailId(id)) {
      const g = gmailEntry(id);
      if (g) target = { mailbox: 'gmail', folder: g.gmail.path, uidValidity: String(g.gmail.uidValidity), uid: Number(g.gmail.uid) };
    } else {
      const p = parseId(id);
      if (p) target = { mailbox: p.mailbox, folder: 'INBOX', uidValidity: p.uidValidity, uid: p.uid };
    }
    if (!target || !Number.isFinite(target.uid)) { failed.push({ id, reason: 'not-found' }); continue; }
    if (!groups.has(target.mailbox)) groups.set(target.mailbox, new Map());
    const folders = groups.get(target.mailbox);
    const key = `${target.folder}\u0000${target.uidValidity}`;
    if (!folders.has(key)) folders.set(key, { folder: target.folder, uidValidity: target.uidValidity, items: [] });
    folders.get(key).items.push({ id, uid: target.uid });
  }
  let done = 0;
  for (const [mailbox, folders] of groups) {
    let c;
    const all = [...folders.values()].flatMap((f) => f.items);
    try {
      const o = await _open(mailbox, deps);
      if (o.error) { for (const it of all) failed.push({ id: it.id, reason: o.error }); continue; }
      c = o.c;
      let bin = null;
      if (action === 'delete') {
        const list = await c.list().catch(() => []);
        bin = (list.find((m) => m.specialUse === '\\Trash') || {}).path || (mailbox === 'gmail' ? null : 'Trash');
        if (!bin) { for (const it of all) failed.push({ id: it.id, reason: 'no-trash-folder' }); continue; }
      }
      for (const f of folders.values()) {
        const lock = await c.getMailboxLock(f.folder);
        try {
          if (String((c.mailbox || {}).uidValidity) !== f.uidValidity) { for (const it of f.items) failed.push({ id: it.id, reason: 'renumbered' }); continue; }
          const uids = f.items.map((it) => it.uid).join(',');
          if (action === 'read') await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
          else await c.messageMove(uids, bin, { uid: true });
          for (const it of f.items) {
            if (action === 'read') db.run('UPDATE personal_inbox SET seen = 1 WHERE id = ?', [it.id]);
            else db.run('DELETE FROM personal_inbox WHERE id = ?', [it.id]);
            done += 1;
          }
        } finally { lock.release(); }
      }
    } catch (e) {
      const why = pm.classifyError(e).kind || 'error';
      const settled = new Set(failed.map((x) => x.id));
      for (const it of all) if (!settled.has(it.id)) failed.push({ id: it.id, reason: why });
    } finally { if (c) await _close(c); }
  }
  return { ok: failed.length === 0, done, failed };
}

module.exports = {
  bulk, BULK_MAX,
  trash, backfillGmail, setGmailSender, gmailRules, BACKFILL_MAX_DAYS,
  INBOXES, WATCHED, WINDOW, ID_PREFIX, isPersonalId, parseId, idFor, gmailEntry,
  refresh, refreshMailbox, list, overview, readMessage, markRead,
  classifyWatched, bouncedMessageId,
};
