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

const INBOXES = ['nick', 'contact'];
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
  return tp.type === 'text/html' ? stripHtml(text) : text.trim();
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

function _row(r) {
  if (!r) return null;
  return {
    id: r.id, mailbox: r.mailbox, from: r.from_name || r.from_email, fromEmail: r.from_email, subject: r.subject,
    received: r.received, seen: r.seen === 1, preview: r.preview || '', kind: r.kind || null,
    bounceOf: r.bounce_of || null, hikeTripId: r.hike_trip_id || null,
  };
}

/** Mirror one mailbox's newest WINDOW messages. Never throws. */
async function refreshMailbox(key, { deps } = {}) {
  deps = _withDefaults(deps);
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
  const status = { at: new Date().toISOString(), results: results.map(({ addedIds, ...r }) => r), hikeBounces: bounced.length };
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
  const r = await _withMessage(id, async (c, p) => {
    await c.messageFlagsAdd(String(p.uid), ['\\Seen'], { uid: true });
    return { ok: true };
  }, deps);
  if (r.ok && r.exists !== false) _db().run('UPDATE personal_inbox SET seen = 1 WHERE id = ?', [id]);
  return r.ok && r.exists !== false ? { marked: true } : { marked: false, reason: r.reason || 'gone' };
}

module.exports = {
  INBOXES, WATCHED, WINDOW, ID_PREFIX, isPersonalId, parseId, idFor,
  refresh, refreshMailbox, list, overview, readMessage, markRead,
  classifyWatched, bouncedMessageId,
};
