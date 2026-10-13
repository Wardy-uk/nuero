'use strict';

/**
 * /api/personal-inbox — nick@ and contact@ newest first (no AI), plus saim@
 * bounces and auto-replies. Separate from the work triage. A reply PREPARES a
 * governed reply_email from the same mailbox (sent on Nick's click, like the
 * Inbox composer); nothing here sends.
 */

const express = require('express');
const inbox = require('../services/personal-inbox');

const router = express.Router();

// GET /api/personal-inbox — the mailboxes (nick@, contact@, saim@ watched), counts and unread, and the last refresh. Keywords: personal email inbox, nick@nickward.co.uk, contact@.
router.get('/', (req, res) => {
  res.json({ ok: true, ...inbox.overview() });
});

// GET /api/personal-inbox/mail/:mailbox — one mailbox's messages, newest first. Keywords: personal inbox list.
router.get('/mail/:mailbox', (req, res) => {
  const items = inbox.list(req.params.mailbox, { limit: req.query.limit });
  if (!items) return res.status(404).json({ ok: false, error: 'no such mailbox' });
  res.json({ ok: true, mailbox: req.params.mailbox, items });
});

// POST /api/personal-inbox/refresh — read the personal mailboxes now (it also runs every 5 minutes). Sends nothing.
router.post('/refresh', async (req, res) => {
  try { res.json({ ok: true, ...(await inbox.refresh()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/personal-inbox/message/:id — one message, read live from its mailbox (opening never marks it read), with the address a reply would go from.
router.get('/message/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const m = await inbox.readMessage(id);
    if (!m || !m.ok) return res.status(503).json({ ok: false, error: (m && m.error) || 'could not read the mailbox' });
    if (!m.exists) return res.status(404).json({ ok: false, error: 'that message is no longer in the mailbox' });
    const s = require('../services/mail-identity').forAction({ actionType: 'reply_email', target: { mailbox: m.mailbox } });
    res.json({ ok: true, message: { id, ...m }, sendsFrom: s ? { address: s.address, from: s.from, via: s.via } : null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/message/:id/read — mark it read in the mailbox.
router.post('/message/:id/read', async (req, res) => {
  try {
    const r = await inbox.markRead(req.params.id);
    res.status(r.marked ? 200 : 502).json({ ok: r.marked, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/message/:id/delete — move it to that mailbox's Bin/Trash (recoverable there). Nick only.
router.post('/message/:id/delete', async (req, res) => {
  try {
    const r = await inbox.trash(req.params.id);
    res.status(r.deleted ? 200 : r.reason === 'not-found' ? 404 : 502).json({ ok: r.deleted, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/personal-inbox/gmail/rules — the Gmail tab's rule: always-show and hidden senders, how many people Nick writes to, the reasons a message can be shown, and the cursor. Keywords: gmail rules, keep sender, hide sender, important.
router.get('/gmail/rules', (req, res) => {
  res.json({ ok: true, ...inbox.gmailRules() });
});

// POST /api/personal-inbox/gmail/rules — always show (keep), stop showing (hide) or clear a Gmail sender (a full address or @domain). Keep also pulls that sender's last 30 days in. Changes nothing in Gmail. Body: { sender, list: 'keep' | 'hide' | null }
router.post('/gmail/rules', async (req, res) => {
  try {
    const { sender, list } = req.body && typeof req.body === 'object' ? req.body : {};
    const r = await inbox.setGmailSender(sender, list === undefined ? null : list);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/gmail/backfill — judge the last N days of the Gmail inbox by the Gmail tab's rule (one-off; the timer only reads new mail). Changes nothing in Gmail. Body: { days } (1–90, refused otherwise)
router.post('/gmail/backfill', async (req, res) => {
  try {
    const { days } = req.body && typeof req.body === 'object' ? req.body : {};
    const r = await inbox.backfillGmail(days);
    res.status(r.ok ? 200 : (/days must/.test(r.error || '') ? 400 : 502)).json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/bulk — mark read or delete several messages at once (delete moves them to that mailbox's Bin, recoverable there). Nick only. Keywords: multi-select, bulk, mark all read. Body: { action: 'read' | 'delete', ids }
router.post('/bulk', async (req, res) => {
  try {
    const { action, ids } = req.body && typeof req.body === 'object' ? req.body : {};
    const r = await inbox.bulk(action, ids);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/personal-inbox/gmail/cleanup — the Gmail clean-up screen: senders in the last 30 days by volume with how many were opened and whether they offer an unsubscribe, plus the decisions already made. Scans first if never scanned. Keywords: gmail cleanup, unsubscribe, archive sender, newsletters.
router.get('/gmail/cleanup', async (req, res) => {
  try {
    const gc = require('../services/gmail-cleanup');
    let v = gc.view();
    let scanError = null;
    if (!v.scannedAt) { const s = await gc.scan(); if (!s.ok) scanError = s.error; v = gc.view(); }
    res.json({ ok: true, ...v, ...(scanError ? { scanError } : {}) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/gmail/cleanup/scan — re-read the last 30 days of the Gmail inbox (headers only) for the clean-up screen. Changes nothing.
router.post('/gmail/cleanup/scan', async (req, res) => {
  try {
    const gc = require('../services/gmail-cleanup');
    const s = await gc.scan();
    if (!s.ok) return res.status(502).json(s);
    res.json({ ok: true, ...gc.view() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/gmail/cleanup/bulk — the same decision for several Gmail senders at once (archive / keep / unsubscribe / clear); one archive pass covers them all. Nick only. Keywords: multi-select, bulk unsubscribe. Body: { senders, action }
router.post('/gmail/cleanup/bulk', async (req, res) => {
  try {
    const { senders, action } = req.body && typeof req.body === 'object' ? req.body : {};
    const r = await require('../services/gmail-cleanup').decideMany(senders, action);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/gmail/cleanup — decide a Gmail sender: archive (it skips the inbox from now on, existing mail too; nothing deleted), keep, unsubscribe (the sender's own one-click unsubscribe, or the link to open; also archives), or clear. Nick only. Body: { sender, action: 'archive' | 'keep' | 'unsubscribe' | 'clear' }
router.post('/gmail/cleanup', async (req, res) => {
  try {
    const { sender, action } = req.body && typeof req.body === 'object' ? req.body : {};
    if (!['archive', 'keep', 'unsubscribe', 'clear'].includes(action)) return res.status(400).json({ ok: false, error: 'action must be archive, keep, unsubscribe or clear' });
    const r = await require('../services/gmail-cleanup').decide(sender, action);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/personal-inbox/compose/options — the addresses a new email can come from (work, nick@, contact@, Gmail) and, for the recipients given, which one NEURO suggests and why. Query: to (comma-separated)
router.get('/compose/options', (req, res) => {
  const mi = require('../services/mail-identity');
  const pm = require('../services/personal-mail');
  const options = [{ key: 'work', address: mi.WORK_ADDRESS, via: 'Microsoft (Outlook)', ready: true }];
  for (const key of ['nick', 'contact', 'gmail']) {
    const address = pm.addressFor(key);
    if (address) options.push({ key, address, via: pm.PROVIDERS[pm.box(key).provider].label, ready: Boolean(pm.credentialFor(key)) });
  }
  const to = String(req.query.to || '').split(',').map((s) => s.trim()).filter(Boolean);
  const suggestion = to.length ? mi.decide({ kind: 'compose', recipients: to, lookups: mi.defaultLookups() }) : null;
  res.json({ ok: true, options, suggestion: suggestion ? { mailbox: suggestion.mailbox || null, ask: !!suggestion.ask, why: suggestion.why, recipients: (suggestion.recipients || []).map((r) => ({ address: r.address, sphere: r.sphere, why: r.why })) } : null });
});

// POST /api/personal-inbox/compose — prepare a NEW email from the chosen address (governed compose_email; nothing is sent here — it goes on Nick's click). Body: { from, to, cc, subject, body }
router.post('/compose', (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { from, to, cc, subject, body } = b;
    const r = require('../services/prepared-actions').prepareCompose({ from, to, cc, subject, body, origin: 'composer' });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json({ ok: true, prepared: true, action: r.action });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/message/:id/reply — prepare a reply from the SAME mailbox (governed reply_email; nothing is sent here). Body: { body, replyAll }
router.post('/message/:id/reply', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { replyAll } = body;
    const text = String(body.body || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'the reply is empty' });
    const r = await require('../services/prepared-actions').prepareReply({
      emailId: req.params.id, body: text, mode: replyAll ? 'replyAll' : 'reply', origin: 'composer',
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, action: r.action || null });
    res.json({ ok: true, prepared: true, action: r.action });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Personal triage (13 Oct 2026): the work Inbox's screen and verdicts ──────
//
// Same shapes as /api/email/triage so the one shared card (EmailCard.jsx)
// renders both. Separate store (personal-triage.js), separate mute rules,
// separate feedback; saim@ is not part of it. Literal paths are registered
// before /triage/:id — this codebase has shipped a literal read as an id.

const triage = require('../services/personal-triage');
const aiRouting = require('../services/ai-routing');

const trimText = (v, max = 280) => {
  const t = String(v || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
};
const asText = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).filter(Boolean);
const inTriage = (id) => {
  const p = inbox.parseId(id);
  const box = p ? p.mailbox : (require('../services/gmail-intake').isGmailId(id) ? 'gmail' : null);
  return triage.INBOXES.includes(box) ? box : null;
};

// The live message (BODY.PEEK — opening never marks it read), else the stored copy.
async function loadPersonal(id) {
  const row = require('../db/database').get('SELECT * FROM personal_inbox WHERE id = ?', [id]);
  let live = null;
  try { const m = await inbox.readMessage(id); if (m && m.ok && m.exists) live = m; } catch { live = null; }
  if (!live && !row) return null;
  const entry = row ? triage.entryOf(row) : null;
  return {
    live: Boolean(live), entry,
    merged: live
      ? { id, subject: live.subject, from: live.fromName || live.from, fromEmail: live.from, to: live.to || [], cc: live.cc || [], body: live.body || '', received: live.received, mailbox: live.mailbox || (entry && entry.mailbox) }
      : { id, subject: entry.subject, from: entry.from, fromEmail: entry.fromEmail, to: [], cc: [], body: entry.preview, received: entry.received, mailbox: entry.mailbox },
  };
}

// GET /api/personal-inbox/triage — the personal inbox sorted like the work Inbox (Action, Delegate, FYI, not yet sorted), never including work mail. Query: mailbox (all | nick | contact | gmail). Keywords: personal triage, sorted personal email.
router.get('/triage', (req, res) => {
  const data = triage.byLane({ mailbox: String(req.query.mailbox || 'all') });
  if (!data) return res.status(404).json({ ok: false, error: 'no such mailbox' });
  res.json({ ok: true, ...data });
});

// GET /api/personal-inbox/triage/muted — personal muted senders and subjects (separate from the work Inbox's).
router.get('/triage/muted', (req, res) => {
  res.json({ ok: true, ...triage.listMuted() });
});

// POST /api/personal-inbox/triage/muted/unmute — un-mute a personal sender (address) or subject (key). Nick only. Body: { address } or { key }
router.post('/triage/muted/unmute', (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const r = typeof b.key === 'string' ? triage.unmuteSubject(b.key) : triage.unmuteSender(b.address);
  res.status(r.ok ? 200 : 404).json(r.ok ? r : { ok: false, error: r.reason });
});

// POST /api/personal-inbox/triage/clear-fyi — clear the personal FYI section (nothing owed is touched). Nick only. Body: { mailbox, dryRun }
router.post('/triage/clear-fyi', (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const r = triage.clearFyi({ mailbox: String(b.mailbox || 'all'), dryRun: b.dryRun === true });
  res.status(r.ok ? 200 : 404).json(r);
});

// GET /api/personal-inbox/replies — replies sent from the personal mailboxes (never work replies).
router.get('/replies', (req, res) => {
  res.json({ ok: true, ...require('../services/sent-replies').list({ limit: req.query.limit, offset: req.query.offset, scope: 'personal' }) });
});

// POST /api/personal-inbox/triage/dismiss/:id — Done / Read & dismiss / Subject not relevant / Mute sender on a personal email. Nick only. Body: { reason: done|not-relevant, markRead, mute: subject|sender }
router.post('/triage/dismiss/:id', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { reason, markRead, mute } = b;
    const r = await triage.dismiss(req.params.id, { reason: reason || 'done', markRead: markRead === true, mute: mute === 'sender' ? 'sender' : null });
    res.status(r.ok ? 200 : 404).json(r.ok ? r : { ok: false, error: r.reason });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/triage/promote/:id — "Needs action": move a personal email to Action and keep it there. Nick only.
router.post('/triage/promote/:id', (req, res) => {
  const r = triage.promote(req.params.id);
  res.status(r.ok ? 200 : (r.reason === 'already dismissed' ? 409 : 404)).json(r.ok ? r : { ok: false, error: r.reason });
});

// GET /api/personal-inbox/triage/:id — one personal email in the work card's shape: body, recipients, reply defaults and the address a reply goes from. Opening never marks it read.
router.get('/triage/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const box = inTriage(id);
    if (!box) return res.status(404).json({ ok: false, error: 'not a personal-inbox email' });
    const loaded = await loadPersonal(id);
    if (!loaded) return res.status(404).json({ ok: false, error: 'that message is no longer in the mailbox' });
    const { merged, entry, live } = loaded;
    const own = new Set(['nick', 'contact', 'gmail', 'saim'].map((k) => require('../services/personal-mail').addressFor(k)).filter(Boolean).map((a) => a.toLowerCase()));
    const sender = String(merged.fromEmail || '').toLowerCase();
    const seen = new Set();
    const replyAllCc = [...merged.to, ...merged.cc].filter((r) => {
      const e = String(r.email || '').toLowerCase();
      if (!e || own.has(e) || e === sender || seen.has(e)) return false;
      seen.add(e); return true;
    });
    const s = require('../services/mail-identity').forAction({ actionType: 'reply_email', target: { mailbox: box } });
    res.json({
      ok: true, live,
      detail: live ? null : 'Could not read the mailbox — showing the stored copy.',
      email: {
        id, subject: merged.subject || '(no subject)', from: merged.from || merged.fromEmail || 'Unknown sender', fromEmail: merged.fromEmail || '',
        to: asText(merged.to), cc: asText(merged.cc), received: merged.received || null,
        reason: entry ? entry.reason : '', preview: entry ? entry.preview : '', body: merged.body || '',
        webLink: null, source: box,
        replyDefaults: { to: sender ? [{ name: merged.from || sender, email: sender }] : [], cc: [], replyAllCc, threadKnown: live },
        sendsFrom: s ? { address: s.address, via: s.via } : null,
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/triage/:id/summary — AI summary of a personal email (falls back to its preview). Nick only.
router.post('/triage/:id/summary', async (req, res) => {
  try {
    const id = req.params.id;
    if (!inTriage(id)) return res.status(404).json({ ok: false, error: 'not a personal-inbox email' });
    const loaded = await loadPersonal(id);
    if (!loaded) return res.status(404).json({ ok: false, error: 'that message is no longer in the mailbox' });
    const { merged } = loaded;
    const prompt = `Summarise this PERSONAL email for Nick (home, family, money, life admin — not work). Give 2-3 short bullet points: what it is about, what (if anything) he needs to do, and any date or amount. No preamble.

From: ${merged.from || 'Unknown'}
Subject: ${merged.subject || '(no subject)'}

${trimText(merged.body, 4000)}`;
    let text = ''; let provider = 'fallback';
    try {
      const r = await aiRouting.runTask('email_summary', { prompt, maxTokens: 250 });
      if (r && r.text && r.text.trim()) { text = r.text.trim(); provider = r.provider; }
    } catch (e) { console.warn('[PersonalTriage] summary failed:', e.message); }
    res.json({ ok: true, summary: text || trimText(`${merged.subject || 'Email'}. ${merged.body}`, 320), provider });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/triage/:id/draft — AI-drafted reply to a personal email (shown for Nick to edit; sends nothing). Nick only. Body: { instruction }
router.post('/triage/:id/draft', async (req, res) => {
  try {
    const id = req.params.id;
    if (!inTriage(id)) return res.status(404).json({ ok: false, error: 'not a personal-inbox email' });
    const loaded = await loadPersonal(id);
    if (!loaded) return res.status(404).json({ ok: false, error: 'that message is no longer in the mailbox' });
    const { merged } = loaded;
    const steer = trimText(req.body && req.body.instruction, 400);
    const prompt = `Draft a reply to this PERSONAL email as Nick Ward (not as Head of Technical Support — this is his own mail). Friendly, plain, British English, short. Sign off "Nick". Output only the reply body.${steer ? `\n\nNick's steer for this reply: ${steer}` : ''}

From: ${merged.from || 'Unknown'}
Subject: ${merged.subject || '(no subject)'}

${trimText(merged.body, 4000)}`;
    let text = ''; let provider = 'fallback';
    try {
      const r = await aiRouting.runTask('email_draft', { prompt, maxTokens: 500 });
      if (r && r.text && r.text.trim()) { text = r.text.trim(); provider = r.provider; }
    } catch (e) { console.warn('[PersonalTriage] draft failed:', e.message); }
    const first = String(merged.from || 'there').split(' ')[0].replace(/[^A-Za-z'-]/g, '') || 'there';
    res.json({ ok: true, draft: text || `Hi ${first},\n\nThanks for this — I'll come back to you shortly.\n\nNick`, provider });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/personal-inbox/triage/:id/reply — prepare a reply from the SAME personal mailbox with the recipients chosen on the card (governed reply_email; nothing is sent here — it goes on Nick's click). Nick only. Body: { body, to, cc }
router.post('/triage/:id/reply', async (req, res) => {
  try {
    const id = req.params.id;
    if (!inTriage(id)) return res.status(400).json({ ok: false, error: 'replies from here go only from nick@, contact@ or Gmail' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { to, cc } = b;
    const text = String(b.body || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'the reply is empty' });
    if (Array.isArray(to) && to.length === 0) return res.status(400).json({ ok: false, error: 'add at least one recipient' });
    const r = await require('../services/prepared-actions').prepareReply({
      emailId: id, body: text, mode: 'reply', to: Array.isArray(to) ? to : null, cc: Array.isArray(cc) ? cc : null, origin: 'composer',
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, action: r.action || null });
    res.json({ ok: true, prepared: true, action: r.action });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
