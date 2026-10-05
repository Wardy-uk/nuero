const express = require('express');
const router = express.Router();
const emailTriage = require('../services/email-triage');
const microsoft = require('../services/microsoft');
const aiRouting = require('../services/ai-routing');
const sentReplies = require('../services/sent-replies');
const { evaluateEmail } = require('../services/email-priority');

function trimText(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function buildFallbackSummary(message, triageItem) {
  const subject = message?.subject || triageItem?.subject || 'Email';
  const preview = trimText(message?.preview || triageItem?.preview || message?.body || '', 240);
  const reason = triageItem?.reason || evaluateEmail({ ...message, preview }).reasons?.join(' · ') || '';
  return trimText(`${subject}. ${reason ? `${reason}. ` : ''}${preview}`, 320);
}

function buildFallbackSuggestedReply(message, triageItem) {
  const firstName = String(message?.from || triageItem?.from || 'there').split(' ')[0].replace(/[^A-Za-z'-]/g, '') || 'there';
  const reason = triageItem?.reason || '';
  if (/urgent|escalation|complaint|outage|legal|sla|customer distress/i.test(reason)) {
    return `Hi ${firstName},\n\nI’ve seen this and I’m picking it up now. I’ll review the detail and come back with the next step shortly.\n\nNick`;
  }
  if (/needs decision|reply requested|direct report|leadership sender/i.test(reason)) {
    return `Hi ${firstName},\n\nThanks — I’ve seen this. I’m reviewing it now and will come back to you with a clear answer shortly.\n\nNick`;
  }
  return `Hi ${firstName},\n\nThanks for this. I’ve seen it and I’ll come back to you shortly.\n\nNick`;
}

// Reply goes to the sender; reply-all adds everyone else on the thread, minus
// Nick himself. The composer shows both so nothing is sent blind.
//
// `threadKnown` is the honest half. Only the LIVE Graph message carries a
// `recipients` block — the 290 cached triage entries hold `fromEmail` but no
// participants at all. So when Graph is degraded, Reply still works and
// reply-all quietly comes back EMPTY, which the composer rendered as "no other
// participants" rather than "I could not find out". A one-to-one email and an
// unreachable thread looked identical, and the difference is who gets left off
// a reply. Say which one it is.
async function buildReplyDefaults(merged) {
  const sender = merged.fromEmail
    ? [{ name: merged.from || merged.fromEmail, email: merged.fromEmail }]
    : [];
  const me = (await microsoft.getSignedInAddress() || '').toLowerCase();
  const others = [
    ...(merged.recipients?.to || []),
    ...(merged.recipients?.cc || []),
  ].filter((r) => {
    const email = (r.email || '').toLowerCase();
    return email && email !== me && email !== (merged.fromEmail || '').toLowerCase();
  });

  // Dedupe — the same person often appears on both to and cc.
  const seen = new Set();
  const replyAllCc = others.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { to: sender, cc: [], replyAllCc, threadKnown: Boolean(merged.recipients) };
}

// Merge the cached triage entry with the live Graph message. Returns null when
// the email exists in neither.
async function loadEmail(emailId) {
  const triage = emailTriage.getTriageByCategory();
  const all = [...triage.urgent, ...triage.reply, ...triage.delegate, ...triage.fyi, ...triage.ignore];
  const triageItem = all.find((item) => item.id === emailId) || null;
  const message = await microsoft.fetchEmailById(emailId);
  if (!message && !triageItem) return null;
  // `live` false means this is the cached triage record only — Graph (and the
  // bridge behind it) could not be reached. The record still renders; what it
  // cannot carry is the thread.
  return { triageItem, live: Boolean(message), merged: { ...(triageItem || {}), ...(message || {}), id: emailId } };
}

// GET /api/email/replies — replies Nick has sent from triage (#69).
//
// Its own top-level path rather than under /triage, so it can never be read as
// an email id — that is exactly how GET /triage/feedback answered "Email not
// found" for a whole deploy (#70). `total` is returned beside the capped list
// so no count on screen is the limit.
router.get('/replies', (req, res) => {
  try {
    res.json({ ok: true, ...sentReplies.list({ limit: req.query.limit, offset: req.query.offset }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/email/triage — get classified inbox
router.get('/triage', async (req, res) => {
  try {
    const data = emailTriage.getTriageByCategory();
    const mail = microsoft.getMailAccessStatus();
    const empty = !data.urgent.length && !data.reply.length && !data.action.length && !data.fyi.length && !data.delegate.length && !data.ignore.length;
    const available = !(empty && mail.degraded);
    res.json({
      ok: true,
      available,
      detail: available ? null : (mail.lastTokenError || 'Mail access is degraded.'),
      // The panel says how long informational mail survives. Served rather than
      // written into the component, or the screen states a window the sweep is
      // not actually using the day either one changes.
      fyiAgeOutDays: emailTriage._internals.AGE_OUT_DAYS,
      ...data
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/email/triage/feedback — how the classifier is scoring against Nick's
// verdict (#70). Only counts emails he has actually judged; one still sitting in
// triage is not evidence, and counting it would make the score improve purely
// because he hasn't got to it.
//
// MUST stay above `/triage/:emailId` — Express matches in registration order, so
// declaring it after meant "feedback" was read as an email id and the route
// answered `{"ok":false,"error":"Email not found"}`. Caught only because it was
// hit against the deployed backend rather than assumed to work.
router.get('/triage/feedback', (req, res) => {
  try {
    res.json(emailTriage.getDismissFeedback());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/triage/muted — what is muted: whole senders ("Mute sender") and single subjects from a sender ("Not relevant").
//
// A rule the panel cannot show is a rule Nick cannot revoke, and a first-click
// mute with no way back is the shape of this that would actually be dangerous.
router.get('/triage/muted', (req, res) => {
  try {
    res.json({ ok: true, senders: emailTriage.listMutedSenders(), subjects: emailTriage.listMutedSubjects() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/muted-subjects/unmute — un-mute one subject. Keywords: unmute subject, email subject rule. Body: key (from the muted list).
// A POST with the key in the body, not a DELETE with it in the path: the key
// carries a subject line, which can hold slashes and anything else.
router.post('/triage/muted-subjects/unmute', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { key } = req.body;
    const result = emailTriage.unmuteSubject(typeof key === 'string' ? key : null);
    if (!result.ok) return res.status(404).json({ ok: false, error: result.reason });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/email/triage/muted/:address — un-mute a sender.
//
// Deliberately does not resurrect the mail it filed away: this says "show me
// this sender from now on", not "put a fortnight of newsletters back".
router.delete('/triage/muted/:address', (req, res) => {
  try {
    const result = emailTriage.unmuteSender(decodeURIComponent(req.params.address));
    if (!result.ok) return res.status(404).json({ ok: false, error: result.reason });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/purge-fyi — clear informational mail older than the
// age-out window, now.
//
// The rule runs on every scheduled triage pass; this is the manual press, and
// `dryRun` is the preview behind it — so the confirmation quotes a real number
// rather than an estimate. Registered ABOVE `/triage/:emailId` on principle:
// every parameterised POST here carries a second segment, so nothing swallows
// it TODAY (measured, not assumed), but this router has shipped a literal path
// read as an email id twice already.
router.post('/triage/purge-fyi', (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const days = req.body?.days === undefined ? undefined : Number(req.body.days);
    if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
      return res.status(400).json({ ok: false, error: 'days must be a positive number' });
    }
    res.json(emailTriage.purgeAgedInformational({ dryRun, ...(days === undefined ? {} : { days }) }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/clear-fyi — clear the whole FYI section.
//
// `dryRun` is what the confirmation quotes, so the number Nick agrees to is the
// number that actually goes. It clears only what that section renders — ACTION,
// DELEGATE and anything promoted are out of reach of this button entirely.
router.post('/triage/clear-fyi', (req, res) => {
  try {
    res.json(emailTriage.clearFyiSection({ dryRun: req.body?.dryRun === true }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/email/triage/:emailId — fetch email detail, summary, and suggested reply
router.get('/triage/:emailId', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const loaded = await loadEmail(emailId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'Email not found' });
    const { merged, triageItem, live } = loaded;
    const mail = microsoft.getMailAccessStatus();

    res.json({
      ok: true,
      live,
      // Why it is degraded, in the order the user can act on: Graph's own token
      // error first, then the bridge that was supposed to cover for it.
      detail: live ? null : (
        mail.lastTokenError
        || (mail.bridgeMailDetail === 'unsupported'
          ? 'Live fetch failed and the NOVA bridge does not serve message detail.'
          : mail.bridgeMailDetailError)
        || 'Live fetch failed — showing the cached copy.'
      ),
      email: {
        id: merged.id,
        subject: merged.subject || 'Email',
        from: merged.from || merged.fromEmail || 'Unknown sender',
        fromEmail: merged.fromEmail || '',
        to: merged.to || [],
        cc: merged.cc || [],
        received: merged.received || null,
        isRead: Boolean(merged.isRead),
        importance: merged.importance || 'normal',
        reason: merged.reason || '',
        webLink: merged.webLink || null,
        summary: buildFallbackSummary(merged, triageItem),
        suggestedReply: buildFallbackSuggestedReply(merged, triageItem),
        preview: merged.preview || '',
        body: merged.body || merged.preview || '',
        replyDefaults: await buildReplyDefaults(merged),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/:emailId/summary — AI summary, falls back to the
// deterministic one when AI is off or unreachable
router.post('/triage/:emailId/summary', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const loaded = await loadEmail(emailId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'Email not found' });
    const { merged, triageItem } = loaded;

    const prompt = `Summarise this email for a busy Head of Technical Support. Give 2-3 short bullet points: what it is about, what (if anything) is being asked of him, and any deadline. No preamble, no sign-off.

From: ${merged.from || 'Unknown'}
Subject: ${merged.subject || '(no subject)'}

${trimText(merged.body || merged.preview || '', 4000)}`;

    let text = '';
    let provider = 'fallback';
    try {
      const result = await aiRouting.runTask('email_summary', { prompt, maxTokens: 250 });
      if (result?.text?.trim()) {
        text = result.text.trim();
        provider = result.provider;
      }
    } catch (e) {
      console.warn('[EmailTriage] Summary AI failed:', e.message);
    }

    res.json({ ok: true, summary: text || buildFallbackSummary(merged, triageItem), provider });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/:emailId/draft — AI-drafted reply, falls back to the
// canned suggestion
router.post('/triage/:emailId/draft', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const loaded = await loadEmail(emailId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'Email not found' });
    const { merged, triageItem } = loaded;
    const steer = trimText(req.body?.instruction || '', 400);

    const prompt = `Draft a reply to this email as Nick Ward, Head of Technical Support at Nurtur. Be direct, warm and concise — British English, no corporate padding. Sign off "Nick". Output only the reply body, no subject line and no commentary.${steer ? `\n\nNick's steer for this reply: ${steer}` : ''}

From: ${merged.from || 'Unknown'}
Subject: ${merged.subject || '(no subject)'}

${trimText(merged.body || merged.preview || '', 4000)}`;

    let text = '';
    let provider = 'fallback';
    try {
      const result = await aiRouting.runTask('email_draft', { prompt, maxTokens: 500 });
      if (result?.text?.trim()) {
        text = result.text.trim();
        provider = result.provider;
      }
    } catch (e) {
      console.warn('[EmailTriage] Draft AI failed:', e.message);
    }

    res.json({ ok: true, draft: text || buildFallbackSuggestedReply(merged, triageItem), provider });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ⚠ Build 8: until 3 Oct 2026 this route SENT the reply directly, on the PIN
// alone, to whatever `to`/`cc` the caller supplied — and the remote MCP
// gateway classed it as an ordinary action, so a machine client could send
// email as Nick with no approval at all. It now only prepares; the send is
// action-executor's, after human-proof approval, verified in Sent Items. The
// sent-reply record (#69) and the triage dismissal ('replied', #70) moved to
// the executor, so they describe a send that happened, not one requested.
//
// POST /api/email/triage/:emailId/reply — PREPARE a reply (prepare reply, draft reply, compose): binds the exact recipients and words as a governed action for Nick to approve with his approval code. Sends NOTHING. Body: { body, to?, cc?, replyAll? }
router.post('/triage/:emailId/reply', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ ok: false, sent: false, error: 'Reply body is empty' });

    const to = Array.isArray(req.body?.to) ? req.body.to : null;
    if (to && to.length === 0) {
      return res.status(400).json({ ok: false, sent: false, error: 'Add at least one recipient' });
    }

    const r = await require('../services/prepared-actions').prepareReply({
      emailId,
      body,
      mode: req.body?.replyAll ? 'replyAll' : 'reply',
      to,
      cc: Array.isArray(req.body?.cc) ? req.body.cc : null,
      origin: 'composer',
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, sent: false, error: r.error, action: r.action || null });
    res.json({
      ok: true,
      sent: false,
      prepared: true,
      action: r.action,
      notice: 'Prepared — nothing has been sent. Approve this exact reply with your approval code to send it.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, sent: false, error: e.message });
  }
});

// POST /api/email/triage/run — trigger a fresh triage cycle.
// Forced: Nick pressed "Run Triage", and answering that with a cached result
// because the mail happens to be unchanged is a button that appears broken.
router.post('/triage/run', async (req, res) => {
  try {
    const result = await emailTriage.runTriage({ force: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/dismiss/:emailId — dismiss an email from triage.
// Body { markRead: true } also marks it read in Outlook, so clearing it here
// clears it everywhere. The dismiss always lands even if the Graph write does
// not — a missing Mail.ReadWrite scope shouldn't strand the item in triage.
router.post('/triage/dismiss/:emailId', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    let markedRead = null;
    let readError = null;

    if (req.body?.markRead) {
      const result = await microsoft.markEmailRead(emailId);
      markedRead = result.marked;
      if (!result.marked) {
        readError = result.reason === 'scope'
          ? 'Dismissed here, but Outlook still shows it unread — Mail.ReadWrite not granted yet.'
          : result.reason === 'auth'
            ? 'Dismissed here, but not signed in to Microsoft so it is still unread in Outlook.'
            : `Dismissed here, but marking it read in Outlook failed (${result.reason}).`;
      }
    }

    // #70 — the reason is the whole point of having two buttons.
    // `not-relevant` also mutes the sender (4 Sep 2026), and the result of THAT
    // is returned so the panel can say so — a mute is a bigger statement than a
    // dismissal and one that silently refused would be indistinguishable from
    // one that worked.
    // Who we are signed in as, so a "Not relevant" on Nick's own mail cannot
    // mute him to himself. Read from the MSAL cache (local, no network) and
    // never allowed to fail the dismissal — the mute proceeds without it, and
    // the panel's list is what makes that recoverable.
    let selfAddress = null;
    try { selfAddress = await microsoft.getSignedInAddress(); } catch { /* proceed */ }

    // `mute`: 'subject' (default for not-relevant) or 'sender' (the Mute sender button).
    const result = emailTriage.dismissEmail(emailId, req.body?.reason, { selfAddress, mute: req.body?.mute || null });
    res.json({ ok: true, markedRead, readError, muted: result?.muted || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/promote/:emailId — "this should have been an action".
//
// The mirror of dismissing as `not-relevant`, and pointedly NOT a dismissal:
// the email moves into the ACTION group and stays in the list. A literal path
// segment, and safe here because it cannot be read as `/triage/:emailId` —
// that route is declared further down, and Express matches in registration
// order (#70, where "feedback" was parsed as an email id).
router.post('/triage/promote/:emailId', (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const result = emailTriage.promoteEmail(emailId);
    // A promotion that moved nothing says so rather than returning a success
    // the panel would render as a change.
    if (!result.ok) return res.status(404).json({ ok: false, error: result.reason });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/clear — clear all cached triage data and re-scan
router.post('/triage/clear', async (req, res) => {
  try {
    emailTriage.clearDismissed();
    const db = require('../db/database');
    db.setState('email_triage', '[]');
    db.setState('email_triage_time', '0');
    console.log('[EmailTriage] All triage data cleared');
    // Forced — we just emptied the blob, so the unchanged-input check must not
    // look at the mail, agree with itself and leave the panel blank.
    const result = await emailTriage.runTriage({ force: true });
    res.json({ ok: true, cleared: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
