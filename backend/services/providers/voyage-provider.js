'use strict';

/**
 * Voyage embeddings — the one place NEURO talks to api.voyageai.com (22 Oct 2026).
 * embeddings.js used to fetch it from three places with no ledger at all; every
 * request now takes an AI-gate ticket (embeddings are input-only, priced per
 * input token) and settles on Voyage's own reported usage.
 */

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const gateCall = require('./gate-call');

/**
 * POST one embeddings request. Returns the fetch Response unchanged (callers keep
 * reading status / json / text as before). `callClass` is embeddings_index for
 * documents and embeddings_query for searches.
 */
async function post(body, { callClass, timeoutMs = 30000 } = {}) {
  const ticket = gateCall.open({
    provider: 'voyage', callClass, model: body.model,
    maxInputTokens: gateCall.estimateTokens(body.input), maxOutputTokens: 0,
  });
  let res;
  try {
    res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    gateCall.close(ticket, { ok: false, error: e.message });
    throw e;
  }
  if (!res.ok) {
    gateCall.close(ticket, { ok: false, error: `HTTP ${res.status}` });
    return res;
  }
  // Settle from Voyage's own usage without consuming the caller's body.
  res.clone().json()
    .then((d) => gateCall.close(ticket, { ok: true, model: body.model, promptTokens: d && d.usage ? d.usage.total_tokens : undefined, completionTokens: 0 }))
    .catch(() => gateCall.close(ticket, { ok: true, model: body.model }));
  return res;
}

module.exports = { post, VOYAGE_URL };
