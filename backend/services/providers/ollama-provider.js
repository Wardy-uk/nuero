'use strict';

/**
 * Ollama Provider — local LLM calls via Ollama HTTP API.
 * Handles both generate (single-shot) and chat (multi-turn) modes.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

/**
 * Single-shot generation (non-streaming).
 * @param {string} prompt - The full prompt
 * @param {object} options - { model, temperature, maxTokens, timeout }
 * @returns {string} The response text
 */
async function generate(prompt, options = {}) {
  const model = options.model || OLLAMA_MODEL;
  const timeout = options.timeout || 120000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens || 512,
          num_ctx: options.contextWindow || 4096,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama generate failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    // Opt-in usage reporting. The return stays a plain string because every
    // caller reads it as one; a callback adds the token counts without
    // changing the contract. Ollama omits these on some paths, hence the ?? 0.
    if (typeof options.onUsage === 'function') {
      try {
        options.onUsage({
          prompt_tokens: data.prompt_eval_count ?? 0,
          completion_tokens: data.eval_count ?? 0,
        });
      } catch { /* telemetry must never break the answer */ }
    }
    return data.response || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat completion (non-streaming).
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options
 * @returns {string} Assistant response text
 */
async function chat(systemPrompt, messages, options = {}) {
  const model = options.model || OLLAMA_MODEL;
  const timeout = options.timeout || 120000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens || 512,
          num_ctx: options.contextWindow || 4096,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama chat failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (typeof options.onUsage === 'function') {
      try {
        options.onUsage({
          prompt_tokens: data.prompt_eval_count ?? 0,
          completion_tokens: data.eval_count ?? 0,
        });
      } catch { /* telemetry must never break the answer */ }
    }
    return data.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming chat — writes SSE chunks to an Express response.
 * @param {string} systemPrompt
 * @param {Array} messages
 * @param {object} res - Express response (SSE)
 * @param {object} options
 * @returns {string} Full accumulated response text
 */
async function streamChat(systemPrompt, messages, res, options = {}) {
  const model = options.model || OLLAMA_MODEL;
  const timeout = options.timeout || 90000; // 90s max for streaming chat

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        stream: true,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens || 1024,
          num_ctx: options.contextWindow || 4096,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama stream failed: HTTP ${response.status}`);
    }

    let fullResponse = '';
    const reader = response.body;
    const decoder = new TextDecoder();

    // Node fetch returns a ReadableStream with Uint8Array chunks
    for await (const chunk of reader) {
      const text = decoder.decode(chunk, { stream: true });
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            fullResponse += parsed.message.content;
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: 'text', content: parsed.message.content })}\n\n`);
            }
          }
        } catch {}
      }
    }

    return fullResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if Ollama is reachable.
 */
async function isAvailable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function getModel() { return OLLAMA_MODEL; }
function getUrl() { return OLLAMA_URL; }

// ── The AI gate (22 Oct 2026) ────────────────────────────────────────────────
// Ollama is free, but it is ONE server on the Pi: every request still takes a
// ticket so the gate's local concurrency limit applies, and the ticket is held
// until the request (or its stream) has actually finished.
const gateCall = require('./gate-call');

function _gated(fn, { defaultClass, optionsAt, inputOf, defaultMax }) {
  return async function gated(...args) {
    const options = args[optionsAt] || {};
    const model = options.model || OLLAMA_MODEL;
    const ticket = gateCall.open({
      provider: 'ollama', callClass: options.callClass || options.taskType || defaultClass, model,
      maxInputTokens: gateCall.estimateTokens(...inputOf(args)), maxOutputTokens: options.maxTokens || defaultMax,
    });
    try {
      const out = await fn(...args);
      gateCall.close(ticket, { ok: true, model });
      return out;
    } catch (e) {
      gateCall.close(ticket, { ok: false, error: e.message });
      throw e;
    }
  };
}

/**
 * A raw /api/chat request for callers that read Ollama's own response shape
 * (routes/standup.js streams it itself). Admitted by the gate; the returned
 * Response's body releases the ticket when it ends, errors or is cancelled, and
 * a non-OK answer releases it at once.
 */
async function rawChat(body, { callClass, signal } = {}) {
  const ticket = gateCall.open({
    provider: 'ollama', callClass, model: body.model || OLLAMA_MODEL,
    maxInputTokens: gateCall.estimateTokens(body.messages), maxOutputTokens: body.options && body.options.num_predict,
  });
  let res;
  try {
    res = await fetch(`${process.env.OLLAMA_URL || OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
  } catch (e) {
    gateCall.close(ticket, { ok: false, error: e.message });
    throw e;
  }
  if (!res.ok || !res.body) {
    gateCall.close(ticket, { ok: res.ok, model: body.model, error: res.ok ? null : `HTTP ${res.status}` });
    return res;
  }
  const reader = res.body.getReader();
  let settled = false;
  const fin = (ok, error) => { if (!settled) { settled = true; gateCall.close(ticket, { ok, model: body.model, error }); } };
  const wrapped = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { fin(true); controller.close(); } else controller.enqueue(value);
      } catch (e) { fin(false, e.message); controller.error(e); }
    },
    cancel(reason) { fin(false, 'cancelled'); return reader.cancel(reason); },
  });
  return new Response(wrapped, { status: res.status, statusText: res.statusText, headers: res.headers });
}

module.exports = {
  generate: _gated(generate, { defaultClass: null, optionsAt: 1, inputOf: (a) => [a[0]], defaultMax: 512 }),
  chat: _gated(chat, { defaultClass: null, optionsAt: 2, inputOf: (a) => [a[0], a[1]], defaultMax: 512 }),
  streamChat: _gated(streamChat, { defaultClass: 'chat_stream', optionsAt: 3, inputOf: (a) => [a[0], a[1]], defaultMax: 1024 }),
  rawChat, isAvailable, getModel, getUrl,
};
