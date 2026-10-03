'use strict';

/**
 * The Microsoft mail transport for the governed executor (Build 6C/6F).
 *
 * Why a draft-then-send, rather than the one-call `/me/sendMail` every other
 * sender in NEURO uses: `sendMail` answers 202 with NO BODY — no message id, no
 * handle — so after a timeout there is nothing to look for, and "did it go?"
 * becomes a guess. Creating a draft first returns the message's
 * `internetMessageId` BEFORE anything is sent; the executor writes it to the
 * ledger, then asks Microsoft to send that draft. Every outcome after that —
 * accepted, refused, timed out, process killed mid-request — is verifiable by
 * finding that internetMessageId in Sent Items (or finding it still a draft).
 *
 * ⚠ Classification is the safety model:
 *   accepted   202 from /send — transport evidence only, NOT verification
 *   rejected   a definitive refusal BEFORE processing (400/401/403/404/409) —
 *              proven not sent
 *   uncertain  everything else: timeout, network error, 5xx, 429, anything odd —
 *              it MAY have gone, so it is verified, never resent
 *
 * ⚠ Nothing here logs a subject, a body or an address. Ids and status codes only.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 20000;

const DEFINITIVE_SEND_REFUSALS = new Set([400, 401, 403, 404, 409]);

function _category(status, err) {
  if (err) return err === 'timeout' ? 'timeout' : 'network';
  if (status === 401) return 'auth';
  if (status === 403) return 'scope';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return null;
}

async function _token() {
  try { return await require('./microsoft').getAccessToken(); } catch { return null; }
}

async function _req(method, urlPath, body, extraHeaders = {}) {
  const token = await _token();
  if (!token) return { status: null, error: 'no-token', category: 'auth' };
  try {
    const res = await fetch(`${GRAPH}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* empty / non-JSON */ }
    return { status: res.status, data, category: _category(res.status) };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { status: null, error: timedOut ? 'timeout' : 'network', category: _category(null, timedOut ? 'timeout' : 'network') };
  }
}

/** Create the draft. Nothing is sent. Returns { ok, id, internetMessageId } or { ok:false, category, status }. */
async function createDraft({ to, subject, body }) {
  const r = await _req('POST', '/me/messages', {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: to.map((x) => ({ emailAddress: { address: x.email, name: x.name || undefined } })),
  });
  if (r.status === 201 || (r.status >= 200 && r.status < 300)) {
    return { ok: true, id: r.data && r.data.id, internetMessageId: r.data && r.data.internetMessageId, status: r.status };
  }
  return { ok: false, status: r.status, category: r.category || 'unknown' };
}

/** Ask Microsoft to send the draft. Returns { outcome: accepted|rejected|uncertain, status, category }. */
async function sendDraft(draftId) {
  const r = await _req('POST', `/me/messages/${encodeURIComponent(draftId)}/send`);
  if (r.status === 202 || r.status === 200 || r.status === 204) return { outcome: 'accepted', status: r.status };
  if (r.status === null && r.error === 'no-token') return { outcome: 'rejected', status: null, category: 'auth' };
  if (r.status !== null && DEFINITIVE_SEND_REFUSALS.has(r.status)) return { outcome: 'rejected', status: r.status, category: r.category };
  return { outcome: 'uncertain', status: r.status, category: r.category || 'unknown' };
}

const _addr = (r) => (r && r.emailAddress && r.emailAddress.address ? String(r.emailAddress.address).toLowerCase() : null);

/**
 * Look for a message in Sent Items by its internetMessageId.
 * Returns { ok:true, messages:[...] } or { ok:false, category } — "could not
 * look" is never an empty folder.
 */
async function findSent(internetMessageId) {
  if (!internetMessageId) return { ok: false, category: 'no-handle' };
  const filter = `internetMessageId eq '${String(internetMessageId).replace(/'/g, "''")}'`;
  const select = 'id,subject,toRecipients,ccRecipients,bccRecipients,from,sentDateTime,internetMessageId,body';
  const r = await _req('GET', `/me/mailFolders/SentItems/messages?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=5`,
    undefined, { Prefer: 'outlook.body-content-type="text"' });
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.value)) return { ok: false, category: r.category || 'unavailable', status: r.status };
  return {
    ok: true,
    messages: r.data.value.map((m) => ({
      id: m.id,
      internetMessageId: m.internetMessageId || null,
      subject: m.subject || '',
      to: (m.toRecipients || []).map(_addr).filter(Boolean),
      cc: (m.ccRecipients || []).map(_addr).filter(Boolean),
      bcc: (m.bccRecipients || []).map(_addr).filter(Boolean),
      from: _addr(m.from),
      sentAt: m.sentDateTime || null,
      bodyText: m.body && typeof m.body.content === 'string' ? m.body.content : null,
    })),
  };
}

/**
 * Is the draft still a draft? 'draft' (still unsent — proof it did not go),
 * 'not-draft', 'gone' (404 — a sent draft moves and changes id), 'unavailable'.
 */
async function draftState(draftId) {
  if (!draftId) return 'unavailable';
  const r = await _req('GET', `/me/messages/${encodeURIComponent(draftId)}?$select=isDraft`);
  if (r.status === 200 && r.data) return r.data.isDraft === true ? 'draft' : 'not-draft';
  if (r.status === 404) return 'gone';
  return 'unavailable';
}

/** Remove a draft PROVEN unsent, so a stray copy cannot be sent by hand later. */
async function deleteDraft(draftId) {
  if ((await draftState(draftId)) !== 'draft') return false;
  const r = await _req('DELETE', `/me/messages/${encodeURIComponent(draftId)}`);
  return r.status === 204 || r.status === 200;
}

/**
 * Has Nick sent anything to this address since a moment? Metadata only.
 * Returns { count } or null when Sent Items could not be read.
 */
async function sentToSince(email, sinceIso) {
  try {
    const r = await require('./microsoft').fetchSentMail({ sinceIso, maxResults: 200 });
    if (!r || !Array.isArray(r.messages)) return null;
    const want = String(email || '').toLowerCase();
    const hits = r.messages.filter((m) => (m.to || []).includes(want) || (m.cc || []).includes(want));
    return { count: hits.length, complete: r.complete !== false };
  } catch { return null; }
}

async function signedInAddress() {
  try { return await require('./microsoft').getSignedInAddress(); } catch { return null; }
}

module.exports = { createDraft, sendDraft, findSent, draftState, deleteDraft, sentToSince, signedInAddress, DEFINITIVE_SEND_REFUSALS };
