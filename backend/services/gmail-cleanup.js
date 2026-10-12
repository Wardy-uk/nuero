'use strict';

/**
 * Gmail clean-up (12 Oct 2026, Nick). Measured first: 1,693 mails in 30 days,
 * 80% mailing lists, 1% opened. This is the screen that stops it AT SOURCE —
 * one row per sender, ranked by volume, with how many he opened, and three
 * decisions:
 *
 *   Archive     — a RULE: that sender skips the inbox. Every personal-inbox pass
 *                 archives its existing AND new mail. Archive = remove Gmail's
 *                 Inbox label (X-GM-LABELS); nothing is deleted, all of it stays
 *                 in All Mail. Undo stops future archiving and moves nothing back.
 *   Unsubscribe — the sender's OWN unsubscribe: an RFC 8058 one-click POST when
 *                 the mail offers one, otherwise the link is handed to Nick to
 *                 open himself. Either way the archive rule is set too, because
 *                 senders keep mailing for days after an unsubscribe.
 *   Keep        — decided; it leaves the clean-up list for good.
 *
 * ⚠ A NEURO rule only runs while the Pi does; with the Pi down mail simply lands
 *   in the inbox as before (nothing lost). A Gmail filter is the permanent
 *   version and NEURO cannot create one over IMAP — said on the screen.
 * ⚠ The unsubscribe URL comes from a stranger's email header, so it is only ever
 *   POSTed to over https, to a public hostname, never following redirects, with
 *   a 10s timeout — anything else is handed to Nick instead (no SSRF into the
 *   house). Each POST is in the external-writes ledger (gmail.unsubscribe).
 * ⚠ Rules key on the EXACT sender address (LinkedIn mails from several; each is
 *   its own row and its own decision).
 */

const pm = require('./personal-mail');

const RULES_KEY = 'gmail_cleanup_rules';
const SCAN_KEY = 'gmail_cleanup_scan';
const SCAN_DAYS = 30;
const ARCHIVE_PER_PASS = 2000;
const ACTIONS = ['archive', 'keep', 'unsubscribed'];

function _db() { return require('../db/database'); }
function _json(key) { try { return JSON.parse(_db().getState(key) || 'null'); } catch { return null; } }

function normAddr(s) {
  const v = String(s || '').trim().toLowerCase();
  return /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? v : null;
}

/**
 * List-Unsubscribe → what can be done. PURE.
 * One-click needs BOTH an https URL and `List-Unsubscribe-Post:
 * List-Unsubscribe=One-Click` (RFC 8058); without the second header a GET or
 * POST to the URL may need a human on a web page.
 */
function parseUnsubscribe(listUnsub, listUnsubPost) {
  const parts = (String(listUnsub || '').match(/<[^>]+>/g) || []).map((p) => p.slice(1, -1).trim());
  const https = parts.find((p) => /^https:\/\//i.test(p)) || null;
  const mailto = parts.find((p) => /^mailto:/i.test(p)) || null;
  const oneClick = https && /list-unsubscribe\s*=\s*one-click/i.test(String(listUnsubPost || '')) ? https : null;
  return { oneClick, link: https || mailto || null, kind: oneClick ? 'one-click' : https ? 'web' : mailto ? 'mailto' : null };
}

/** Group fetched messages by sender. PURE. */
function groupSenders(messages) {
  const by = new Map();
  for (const m of messages || []) {
    const addr = normAddr(m.fromEmail);
    if (!addr) continue;
    const cur = by.get(addr) || { sender: addr, name: m.fromName || '', count: 0, opened: 0, lastAt: null, lastSubject: '', unsubscribe: null };
    cur.count += 1;
    if (m.seen) cur.opened += 1;
    if (!cur.lastAt || (m.date && m.date > cur.lastAt)) {
      cur.lastAt = m.date || cur.lastAt; cur.lastSubject = m.subject || '';
      if (m.fromName) cur.name = m.fromName;
    }
    const u = parseUnsubscribe(m.listUnsubscribe, m.listUnsubscribePost);
    // The best offer any message from this sender makes.
    if (u.kind && (!cur.unsubscribe || (u.kind === 'one-click' && cur.unsubscribe.kind !== 'one-click'))) cur.unsubscribe = u;
    by.set(addr, cur);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender));
}

function readRules() {
  const r = _json(RULES_KEY);
  return r && r.senders && typeof r.senders === 'object' ? r : { senders: {} };
}
function _writeRules(r) { _db().setState(RULES_KEY, JSON.stringify(r)); }

/** Set or clear one sender's decision. Refuses what is not an address or an action. */
function setRule(sender, action, extra = {}) {
  const s = normAddr(sender);
  if (!s) return { ok: false, error: 'not an email address' };
  if (action !== null && !ACTIONS.includes(action)) return { ok: false, error: `action must be ${ACTIONS.join(', ')} or clear` };
  const r = readRules();
  if (action === null) delete r.senders[s];
  else r.senders[s] = { action, at: new Date().toISOString(), ...extra };
  _writeRules(r);
  return { ok: true, sender: s, action };
}

function _withDefaults(deps) {
  return { now: () => Date.now(), imap: (cfg) => new (require('imapflow').ImapFlow)(cfg), ...(deps || {}) };
}

async function _open(deps) {
  const cred = pm.credentialFor('gmail');
  if (!cred) return { error: 'not-configured' };
  const c = deps.imap(pm.imapConfig('gmail', cred));
  if (typeof c.on === 'function') c.on('error', () => {});
  await c.connect();
  return { c };
}
async function _close(c) { try { await c.logout(); } catch { try { c.close(); } catch { /* gone */ } } }

/** Read the last SCAN_DAYS of the Gmail inbox, headers only, and store the per-sender table. */
async function scan({ deps, days = SCAN_DAYS } = {}) {
  deps = _withDefaults(deps);
  let c;
  try {
    const o = await _open(deps);
    if (o.error) return { ok: false, error: o.error };
    c = o.c;
    const lock = await c.getMailboxLock('INBOX');
    const messages = [];
    try {
      const uids = await c.search({ since: new Date(deps.now() - days * 86400000) }, { uid: true });
      for (let i = 0; uids && i < uids.length; i += 500) {
        const chunk = uids.slice(i, i + 500);
        for await (const m of c.fetch(chunk.join(','), { uid: true, envelope: true, flags: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true })) {
          const env = m.envelope || {};
          const from = (env.from && env.from[0]) || {};
          const h = m.headers ? m.headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') : '';
          const pick = (name) => { const mm = h.match(new RegExp(`^${name}:\\s*(.*)$`, 'im')); return mm ? mm[1].trim() : ''; };
          const flags = m.flags instanceof Set ? m.flags : new Set(m.flags || []);
          messages.push({
            fromEmail: from.address, fromName: from.name || '', subject: env.subject || '',
            date: env.date ? new Date(env.date).toISOString() : null, seen: flags.has('\\Seen'),
            listUnsubscribe: pick('list-unsubscribe'), listUnsubscribePost: pick('list-unsubscribe-post'),
          });
        }
      }
    } finally { lock.release(); }
    const result = { at: new Date(deps.now()).toISOString(), days, total: messages.length, senders: groupSenders(messages) };
    _db().setState(SCAN_KEY, JSON.stringify(result));
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: pm.classifyError(e).error };
  } finally { if (c) await _close(c); }
}

/** The screen: undecided senders by volume, and the decided ones with their rule. */
function view() {
  const s = _json(SCAN_KEY);
  const rules = readRules().senders;
  const all = (s && s.senders) || [];
  return {
    scannedAt: s ? s.at : null, days: s ? s.days : SCAN_DAYS, total: s ? s.total : null,
    senders: all.filter((x) => !rules[x.sender]),
    decided: Object.entries(rules).map(([sender, r]) => ({ sender, ...r, ...(all.find((x) => x.sender === sender) ? { count: all.find((x) => x.sender === sender).count, name: all.find((x) => x.sender === sender).name } : {}) }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))),
    note: 'Archive skips the inbox for that sender from now on (existing mail too) — nothing is deleted, it stays in All Mail. NEURO applies it every 5 minutes while the Pi is running; a Gmail filter is the permanent version.',
  };
}

/** Archive one sender's inbox mail in an open connection (INBOX locked by the caller). */
async function _archiveSender(c, sender, cap) {
  const uids = await c.search({ from: sender }, { uid: true });
  if (!uids || !uids.length) return 0;
  const mine = [];
  for (let i = 0; i < uids.length && mine.length < cap; i += 500) {
    for await (const m of c.fetch(uids.slice(i, i + 500).join(','), { uid: true, envelope: true }, { uid: true })) {
      const from = ((m.envelope || {}).from || [])[0] || {};
      if (String(from.address || '').toLowerCase() === sender) mine.push(m.uid);
    }
  }
  const take = mine.slice(0, cap);
  for (let i = 0; i < take.length; i += 500) {
    await c.messageFlagsRemove(take.slice(i, i + 500).join(','), ['\\Inbox'], { uid: true, useLabels: true });
  }
  return take.length;
}

/**
 * Archive every sender with an archive / unsubscribed rule. Run by each
 * personal-inbox pass and straight after a decision. `only` limits it to one
 * sender. Never throws.
 */
async function applyRules({ deps, only = null } = {}) {
  const rules = readRules().senders;
  const onlySet = only == null ? null : new Set([].concat(only));
  const senders = Object.entries(rules).filter(([s, r]) => (r.action === 'archive' || r.action === 'unsubscribed') && (!onlySet || onlySet.has(s))).map(([s]) => s);
  if (!senders.length) return { ok: true, archived: 0, senders: 0 };
  deps = _withDefaults(deps);
  let c; let archived = 0; let budget = ARCHIVE_PER_PASS;
  try {
    const o = await _open(deps);
    if (o.error) return { ok: false, error: o.error };
    c = o.c;
    const lock = await c.getMailboxLock('INBOX');
    try {
      for (const s of senders) {
        if (budget <= 0) break;
        const n = await _archiveSender(c, s, budget);
        archived += n; budget -= n;
      }
    } finally { lock.release(); }
    return { ok: true, archived, senders: senders.length, ...(budget <= 0 ? { more: true } : {}) };
  } catch (e) {
    return { ok: false, error: pm.classifyError(e).error, archived };
  } finally { if (c) await _close(c); }
}

/** A URL from a stranger's header we will POST to: https, public host, no credentials. */
async function safeTarget(url, { lookup } = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, why: 'not a URL' }; }
  if (u.protocol !== 'https:') return { ok: false, why: 'not https' };
  if (u.username || u.password) return { ok: false, why: 'credentials in the URL' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.ts\.net)$/i.test(host)) return { ok: false, why: 'not a public host' };
  const resolve = lookup || ((h) => require('dns').promises.lookup(h, { all: true }));
  let addrs;
  try { addrs = /^[\d.]+$|:/.test(host) ? [{ address: host }] : await resolve(host); } catch { return { ok: false, why: 'host does not resolve' }; }
  const priv = (a) => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || /^(::1|fc|fd|fe80)/i.test(a);
  if (!addrs.length || addrs.some((a) => priv(a.address))) return { ok: false, why: 'resolves to a private address' };
  return { ok: true };
}

/**
 * Unsubscribe from one sender. One-click when offered (POSTed, ledgered);
 * otherwise the link is returned for Nick to open. Sets the archive rule either way.
 */
async function unsubscribe(sender, { deps, fetchImpl, lookup, apply = true } = {}) {
  const archiveNow = (s) => (apply ? applyRules({ deps, only: s }) : Promise.resolve({ ok: true, archived: 0 }));
  const s = normAddr(sender);
  if (!s) return { ok: false, error: 'not an email address' };
  const row = ((_json(SCAN_KEY) || {}).senders || []).find((x) => x.sender === s);
  const u = row && row.unsubscribe;
  if (!u || !u.kind) return { ok: false, error: 'this sender offers no unsubscribe — use Archive' };
  if (u.kind !== 'one-click') {
    setRule(s, 'unsubscribed', { unsubscribe: { method: u.kind, status: 'opened-by-nick' } });
    const archive = await archiveNow(s);
    return { ok: true, sender: s, method: u.kind, link: u.link, archived: archive.archived || 0, note: 'Open the link to finish unsubscribing; their mail now skips your inbox.' };
  }
  const safe = await safeTarget(u.oneClick, { lookup });
  if (!safe.ok) {
    setRule(s, 'unsubscribed', { unsubscribe: { method: 'web', status: 'opened-by-nick' } });
    const archive = await archiveNow(s);
    return { ok: true, sender: s, method: 'web', link: u.oneClick, archived: archive.archived || 0, note: `NEURO will not call that link itself (${safe.why}) — open it to finish; their mail now skips your inbox.` };
  }
  const ext = require('./external-writes');
  const claim = ext.begin({ writer: 'gmail.unsubscribe', key: `gmail-unsub:${s}`, target: s, request: { url: u.oneClick }, initiatedBy: 'nick' });
  let status = 'unknown';
  if (!claim.ok && claim.duplicate) status = 'already';
  else if (!claim.ok) return { ok: false, error: claim.why };
  else {
    const f = fetchImpl || fetch;
    try {
      const res = await f(u.oneClick, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click', signal: AbortSignal.timeout(10000) });
      if (res.status >= 200 && res.status < 400) { ext.settle(claim.entry.id, { status: 'confirmed', result: { http: res.status }, readback: 'sender accepted the one-click request' }); status = 'sent'; } else { const e = new Error(`HTTP ${res.status}`); ext.settle(claim.entry.id, { status: ext.classifyError(e), result: { http: res.status } }); status = `refused (HTTP ${res.status})`; }
    } catch (e) {
      ext.settle(claim.entry.id, { status: 'uncertain', result: { error: String(e.message || e).slice(0, 200) } });
      status = 'no answer';
    }
  }
  setRule(s, 'unsubscribed', { unsubscribe: { method: 'one-click', status } });
  const archive = await archiveNow(s);
  return { ok: true, sender: s, method: 'one-click', status, archived: archive.archived || 0, ...(status !== 'sent' && status !== 'already' ? { link: u.oneClick, note: 'The sender did not confirm — open the link to make sure. Their mail now skips your inbox either way.' } : {}) };
}

/** A decision from the screen. */
async function decide(sender, action, { deps, fetchImpl, lookup } = {}) {
  if (action === 'unsubscribe') return unsubscribe(sender, { deps, fetchImpl, lookup });
  const r = setRule(sender, action === 'clear' ? null : action);
  if (!r.ok) return r;
  if (action === 'archive') { const a = await applyRules({ deps, only: r.sender }); return { ...r, archived: a.archived || 0, ...(a.ok ? {} : { error: a.error }) }; }
  return r;
}

const BULK_MAX = 100;

/**
 * The same decision for many senders (12 Oct 2026, Nick: multi-select). Each is
 * decided exactly as one would be; then ONE archive pass covers all of them, so
 * twenty senders open Gmail once, not twenty times. Unsubscribe on a sender that
 * offers none is reported, never silently turned into something else.
 */
async function decideMany(senders, action, { deps, fetchImpl, lookup } = {}) {
  if (!['archive', 'keep', 'unsubscribe', 'clear'].includes(action)) return { ok: false, error: 'action must be archive, keep, unsubscribe or clear' };
  if (!Array.isArray(senders) || !senders.length) return { ok: false, error: 'no senders chosen' };
  if (senders.length > BULK_MAX) return { ok: false, error: `at most ${BULK_MAX} at a time` };
  const done = []; const failed = []; const links = [];
  for (const raw of [...new Set(senders.map((x) => String(x || '').toLowerCase()))]) {
    let r;
    if (action === 'unsubscribe') r = await unsubscribe(raw, { deps, fetchImpl, lookup, apply: false });
    else r = setRule(raw, action === 'clear' ? null : action);
    if (!r.ok) { failed.push({ sender: raw, reason: r.error }); continue; }
    done.push(r.sender);
    if (r.link) links.push({ sender: r.sender, link: r.link, method: r.method });
  }
  let archived = 0; let archiveError = null;
  if ((action === 'archive' || action === 'unsubscribe') && done.length) {
    const a = await applyRules({ deps, only: done });
    archived = a.archived || 0; if (!a.ok) archiveError = a.error;
  }
  return { ok: failed.length === 0, action, done, failed, links, archived, ...(archiveError ? { archiveError } : {}) };
}

module.exports = {
  decideMany, BULK_MAX,
  RULES_KEY, SCAN_KEY, ACTIONS, ARCHIVE_PER_PASS,
  parseUnsubscribe, groupSenders, safeTarget, normAddr,
  readRules, setRule, scan, view, applyRules, unsubscribe, decide,
};
