'use strict';

/**
 * OpenAI Provider — cloud AI escalation path.
 * Only called when routing policy permits and budget allows.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function isConfigured() {
  return !!OPENAI_API_KEY;
}

/**
 * Chat completion (non-streaming).
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options - { model, temperature, maxTokens, timeout }
 * @returns {{ text: string, usage: { prompt_tokens, completion_tokens, total_tokens } }}
 */
async function chat(systemPrompt, messages, options = {}) {
  if (!OPENAI_API_KEY) throw new Error('OpenAI API key not configured');

  const model = options.model || OPENAI_MODEL;
  const timeout = options.timeout || 30000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature: options.temperature ?? 0.5,
        max_tokens: options.maxTokens || 512,
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

    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single-shot generation via chat API (convenience wrapper).
 */
async function generate(prompt, options = {}) {
  const result = await chat(
    'You are a helpful, concise assistant. Respond directly without preamble.',
    [{ role: 'user', content: prompt }],
    options
  );
  return result;
}

/**
 * Streaming chat — writes SSE chunks to an Express response.
 * @returns {{ fullText: string, usage: { prompt_tokens, completion_tokens, total_tokens } }}
 */
async function streamChat(systemPrompt, messages, res, options = {}) {
  if (!OPENAI_API_KEY) throw new Error('OpenAI API key not configured');

  const model = options.model || OPENAI_MODEL;
  const timeout = options.timeout || 60000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature: options.temperature ?? 0.5,
        max_tokens: options.maxTokens || 1024,
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

    for await (const chunk of response.body) {
      buffer += chunk.toString();
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

    return { fullText, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, chat, generate, streamChat };
