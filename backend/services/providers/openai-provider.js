'use strict';

/**
 * OpenAI Provider — ChatGPT API.
 * Priority 2 in the routing stack.
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// Every request below is admitted by the shared AI gate (reserve → call → settle).
const gateCall = require('./gate-call');
function _open(options, model, systemPrompt, messages, maxTokens, fallbackClass) {
  return gateCall.open({
    provider: 'openai', callClass: options.callClass || options.taskType || fallbackClass, model,
    maxInputTokens: gateCall.estimateTokens(systemPrompt, messages), maxOutputTokens: maxTokens,
  });
}

function _key() { return process.env.OPENAI_API_KEY || ''; }
function _model() { return process.env.OPENAI_MODEL || 'gpt-4o-mini'; }

function isConfigured() {
  return !!_key();
}

async function chat(systemPrompt, messages, options = {}) {
  if (!_key()) throw new Error('OpenAI API key not configured');

  const model = options.model || _model();
  const timeout = options.timeout || 30000;
  const maxTokens = options.maxTokens || 512;
  const ticket = _open(options, model, systemPrompt, messages, maxTokens);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_key()}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature: options.temperature ?? 0.5,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI API error: HTTP ${res.status} — ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    gateCall.close(ticket, gateCall.fromOpenAIUsage(data.usage, data.model || model));
    return { text, usage };
  } catch (e) {
    gateCall.close(ticket, { ok: false, error: e.message });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function generate(prompt, options = {}) {
  return chat(
    'You are a helpful, concise assistant. Respond directly without preamble.',
    [{ role: 'user', content: prompt }],
    options
  );
}

async function streamChat(systemPrompt, messages, res, options = {}) {
  if (!_key()) throw new Error('OpenAI API key not configured');

  const model = options.model || _model();
  const timeout = options.timeout || 60000;
  const maxTokens = options.maxTokens || 1024;
  const ticket = _open(options, model, systemPrompt, messages, maxTokens, 'chat_stream');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_key()}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature: options.temperature ?? 0.5,
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI stream error: HTTP ${response.status} — ${body.substring(0, 200)}`);
    }

    let fullText = '';
    let buffer = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: 'text', content })}\n\n`);
            }
          }
        } catch {}
      }
    }

    // No usage chunk is requested here, so the gate settles this one pessimistically.
    gateCall.close(ticket, { ok: true, model });
    return { fullText, usage: { total_tokens: 0 } };
  } catch (e) {
    gateCall.close(ticket, { ok: false, error: e.message });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, chat, generate, streamChat };
