'use strict';

/**
 * The PUBLIC half of UAT volunteers (26 Oct 2026): the link in an invite.
 *
 * ⚠ Mounted at /api/u and exempt from the PIN in services/api-auth.js — with
 * Tailscale Funnel ON that is the public internet. The token in the path is
 * the whole credential: one person, one session. It can record that person's
 * Confirm or Decline and nothing else, and the page names nobody else.
 *
 * ⚠ GET never records anything. Microsoft Safe Links (and other scanners) open
 * every link in an email to check it, so a link that answered on open would be
 * answered by the scanner. The page shows two buttons that POST.
 */

const express = require('express');
const uat = require('../services/uat-volunteers');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '2kb' }));

// A crude global ceiling: behind Funnel every caller is 127.0.0.1, so a
// per-address limit would be a global one anyway.
const LIMIT = 60;
let windowStart = 0;
let count = 0;
function limited() {
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; count = 0; }
  count += 1;
  return count > LIMIT;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;color:#1d2330}
main{max-width:520px;margin:0 auto;padding:32px 16px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;margin:8px 0}
.row{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
button{font-size:16px;padding:12px 20px;border-radius:8px;border:0;cursor:pointer;flex:1;min-width:140px}
.yes{background:#1f7a4d;color:#fff}.no{background:#e7e9ee;color:#1d2330}
.sel{outline:3px solid #1d2330}.muted{color:#5b6475;font-size:14px}
</style></head><body><main><div class="card">${inner}</div></main></body></html>`;
}

function details(v) {
  const s = v.session;
  const time = s.end ? `${s.start}–${s.end}` : s.start;
  return `<p><strong>${esc(s.dayWords)}, ${esc(time)}</strong> (UK time)</p>
${s.feature ? `<p>${esc(s.feature)}</p>` : ''}
${s.location ? `<p class="muted">${esc(s.location)}${s.online ? ` · ${esc(s.online)}` : ''}</p>` : ''}`;
}

function render(v, token, { just = null, preselect = null } = {}) {
  if (!v || !v.ok && v.state === 'unknown') {
    return page('Link not recognised', '<h1>This link is not recognised</h1><p>It may have been mistyped. Please speak to Nick.</p>');
  }
  const head = `<h1>UAT session</h1>${details(v)}`;
  if (v.state === 'withdrawn') return page('UAT', `${head}<p>You no longer need to reply to this — thank you.</p>`);
  if (v.state === 'declined-replaced') return page('UAT', `${head}<p>Thanks, ${esc(v.first)} — Nick has asked someone else. If you can make it after all, please speak to him.</p>`);
  if (v.state === 'closed' || !v.canAnswer) {
    const was = v.answer === 'confirmed' ? 'You are down as attending.' : v.answer === 'declined' ? 'You are down as not attending.' : '';
    return page('UAT', `${head}<p>Replies have closed. ${esc(was)} If anything has changed, please speak to Nick.</p>`);
  }
  const said = just === 'confirmed' ? `<p><strong>Thanks, ${esc(v.first)} — you're confirmed.</strong></p>`
    : just === 'declined' ? `<p><strong>Thanks, ${esc(v.first)} — Nick will ask someone else.</strong></p>`
      : v.answer === 'confirmed' ? '<p>You have confirmed. You can change your answer below.</p>'
        : v.answer === 'declined' ? '<p>You have declined. You can change your answer below.</p>'
          : `<p>Hi ${esc(v.first)} — can you make it?</p>`;
  const action = `/api/u/${encodeURIComponent(token)}`;
  const yesSel = preselect === 'confirm' ? ' sel' : '';
  const noSel = preselect === 'decline' ? ' sel' : '';
  const form = just ? '' : `<form method="post" action="${esc(action)}" class="row">
<button class="yes${yesSel}" name="answer" value="confirm" type="submit">Confirm — I'll be there</button>
<button class="no${noSel}" name="answer" value="decline" type="submit">Decline — I can't make it</button></form>`;
  const by = v.deadline ? `<p class="muted">If there's no reply by ${esc(v.deadline)}, Nick will take it that you can make it.</p>` : '';
  return page('UAT session', `${head}${said}${form}${by}`);
}

function headers(res) {
  res.set({
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
  });
}

// GET /api/u/:token — the invite link: shows the session and Confirm / Decline buttons. Records nothing.
router.get('/:token', (req, res) => {
  headers(res);
  if (limited()) return res.status(429).type('html').send(page('Busy', '<p>Please try again in a minute.</p>'));
  let v;
  try { v = uat.lookup(req.params.token); } catch { v = null; }
  const pre = ['confirm', 'decline'].includes(req.query.a) ? req.query.a : null;
  return res.status(v && v.ok ? 200 : 404).type('html').send(render(v || { ok: false, state: 'unknown' }, req.params.token, { preselect: pre }));
});

// POST /api/u/:token — the person's own Confirm or Decline (form field `answer`).
router.post('/:token', async (req, res) => {
  headers(res);
  if (limited()) return res.status(429).type('html').send(page('Busy', '<p>Please try again in a minute.</p>'));
  const answer = req.body && req.body.answer;
  let r;
  try { r = await uat.respond(req.params.token, answer); } catch (e) {
    console.warn('[UAT] respond failed:', e.message);
    return res.status(500).type('html').send(page('Not saved', '<h1>Your answer was not saved</h1><p>Please try again, or tell Nick.</p>'));
  }
  if (!r.ok && r.state === 'unknown') return res.status(404).type('html').send(render(r, req.params.token));
  if (!r.ok && r.code === 400) return res.status(400).type('html').send(page('UAT', '<p>Please press Confirm or Decline.</p>'));
  return res.status(r.ok ? 200 : 409).type('html').send(render(r, req.params.token, { just: r.ok ? r.recorded : null }));
});

module.exports = router;
module.exports._internals = { render, esc };
