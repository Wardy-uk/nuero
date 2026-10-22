'use strict';

/**
 * Spoken audio from OpenRouter's audio model — the network half of services/tts.js
 * (22 Oct 2026). Moved here so provider hosts live only under providers/, and so
 * every request takes an AI-gate ticket. Before this, TTS had no budget check and
 * no ledger row at all; its cost was only console-logged.
 *
 * ⚠ The request sends NO max_tokens (a bound on audio tokens could cut speech off
 * mid-sentence), so the gate records it as `unbounded-output` in shadow mode
 * rather than inventing a ceiling it does not have. That is a decision for Nick.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const gateCall = require('./gate-call');

/** POST an audio request; returns the raw SSE text. Settles the ticket on the stream's own usage. */
async function requestAudio(body, { timeout = 60000, callClass = 'tts_speak' } = {}) {
  const ticket = gateCall.open({
    provider: 'openrouter', callClass, model: body.model,
    maxInputTokens: gateCall.estimateTokens(body.messages), maxOutputTokens: body.max_tokens,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://neuro.nurtur.tech',
        'X-Title': 'NEURO',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const raw = await res.text();
    gateCall.close(ticket, gateCall.fromOpenAIUsage(usageOf(raw), body.model));
    return raw;
  } catch (e) {
    gateCall.close(ticket, { ok: false, error: e.message });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** PURE. The usage object from an SSE body (the last one reported), or null. */
function usageOf(raw) {
  let usage = null;
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try { const evt = JSON.parse(line.slice(6).trim()); if (evt && evt.usage) usage = evt.usage; } catch { /* not JSON */ }
  }
  return usage;
}

module.exports = { requestAudio, usageOf };
