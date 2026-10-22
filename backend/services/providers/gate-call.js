'use strict';

/**
 * The provider side of the AI gate (22 Oct 2026). Every network request to a
 * model — cloud, embedding, TTS or local — is bracketed by open() and close():
 *
 *   const t = open({ provider, callClass, model, fallbackModels, maxInputTokens, maxOutputTokens });
 *   try { …request…; close(t, { ok: true, model, promptTokens, completionTokens, costUsd }); }
 *   catch (e) { close(t, { ok: false, error: e.message }); throw e; }
 *
 * ONE ticket per network request, so a five-round tool loop is five tickets and
 * a retry is a second ticket — nothing is billed twice or skipped.
 *
 * `callClass` is the caller's name for the work (ai-routing passes its taskType).
 * A request that does not name one is still admitted in shadow mode, and the
 * shared profile counts it under `unknown-class`.
 */

const gate = require('../ai-gate');
const { REGISTRY } = require('../ai-gate-classes');

/** PURE. A deliberately generous token estimate (≈3.5 chars/token) for the input bound. */
function estimateTokens(...parts) {
  let chars = 0;
  for (const p of parts) {
    if (p == null) continue;
    chars += typeof p === 'string' ? p.length : JSON.stringify(p).length;
  }
  return Math.ceil(chars / 3.5);
}

function open(spec) {
  const t = gate.reserve({ app: 'neuro', ...spec, provider: String(spec.provider || '').toLowerCase() }, REGISTRY);
  if (!t.admitted) throw new gate.GateRefused(t);
  return t;
}

function close(ticket, usage = {}) {
  try { return gate.settle(ticket, usage); } catch { return { ok: false }; }
}

/** OpenAI-shaped usage ({prompt_tokens, completion_tokens, cost}) → gate usage. */
function fromOpenAIUsage(u, model) {
  if (!u) return { ok: true, model };
  return { ok: true, model, promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, costUsd: u.cost != null ? u.cost : undefined };
}

module.exports = { open, close, estimateTokens, fromOpenAIUsage };
