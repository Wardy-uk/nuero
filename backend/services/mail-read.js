'use strict';

/**
 * READ-ONLY Microsoft mail lookups that PREPARING an action needs (Build 8).
 *
 * prepared-actions.js is pinned (since Build 5) to import NO sender: preparing
 * a reply must be able to read the message it answers — its thread, its
 * sender, who else was on it — without the module that can send. So the reads
 * live here, and this file makes GET requests ONLY. A source scan in
 * build8-outbound.test.js pins that: no POST, PATCH or DELETE, and no import
 * of anything that sends.
 *
 * "Could not look" is never "gone": a 404 is `exists:false`; anything else that
 * is not a 200 is `ok:false`.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 20000;

const _addr = (r) => (r && r.emailAddress && r.emailAddress.address ? String(r.emailAddress.address).toLowerCase() : null);

async function _get(urlPath, extraHeaders = {}) {
  let token = null;
  try { token = await require('./microsoft').getAccessToken(); } catch { token = null; }
  if (!token) return { status: null, category: 'auth' };
  try {
    const res = await fetch(`${GRAPH}${urlPath}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, data };
  } catch (e) {
    return { status: null, category: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network' };
  }
}

/**
 * The message a reply answers. { ok:true, exists:true, ... } | { ok:true, exists:false }
 * (404 — it is gone) | { ok:false, category } (could not look).
 */
async function readMessage(emailId) {
  if (!emailId) return { ok: true, exists: false };
  const r = await _get(`/me/messages/${encodeURIComponent(emailId)}?$select=id,conversationId,from,subject,internetMessageId,toRecipients,ccRecipients,receivedDateTime`);
  if (r.status === 404) return { ok: true, exists: false };
  if (r.status !== 200 || !r.data) return { ok: false, category: r.category || 'unavailable', status: r.status };
  return {
    ok: true,
    exists: true,
    id: r.data.id,
    conversationId: r.data.conversationId || null,
    from: _addr(r.data.from),
    fromName: (r.data.from && r.data.from.emailAddress && r.data.from.emailAddress.name) || null,
    subject: r.data.subject || '',
    internetMessageId: r.data.internetMessageId || null,
    to: (r.data.toRecipients || []).map(_addr).filter(Boolean),
    cc: (r.data.ccRecipients || []).map(_addr).filter(Boolean),
    receivedAt: r.data.receivedDateTime || null,
  };
}

async function signedInAddress() {
  try { return await require('./microsoft').getSignedInAddress(); } catch { return null; }
}

/**
 * Replies in the Inbox from one address whose subject contains a marker, newest first, with
 * the NEW part of each (uniqueBody, as text). For reading Chris's overtime sign-off (5 Nov 2026).
 * { ok:true, messages:[{ id, subject, receivedAt, text }] } | { ok:false, category }.
 */
async function findReplies({ fromAddress, subjectHas, sinceIso } = {}) {
  const from = String(fromAddress || '').toLowerCase();
  if (!from || !subjectHas) return { ok: true, messages: [] };
  const since = sinceIso && !Number.isNaN(Date.parse(sinceIso)) ? new Date(sinceIso).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
  const r = await _get(`/me/mailFolders/Inbox/messages?$filter=${filter}&$orderby=receivedDateTime desc&$top=100&$select=id,subject,from,receivedDateTime,uniqueBody`,
    { Prefer: 'outlook.body-content-type="text"' });
  if (r.status !== 200 || !r.data) return { ok: false, category: r.category || 'unavailable', status: r.status };
  const marker = String(subjectHas).toLowerCase();
  const messages = (r.data.value || [])
    .filter((m) => _addr(m.from) === from && String(m.subject || '').toLowerCase().includes(marker))
    .map((m) => ({ id: m.id, subject: m.subject || '', receivedAt: m.receivedDateTime || null, text: String((m.uniqueBody && m.uniqueBody.content) || '').trim() }));
  return { ok: true, messages };
}

module.exports = { readMessage, signedInAddress, findReplies };


