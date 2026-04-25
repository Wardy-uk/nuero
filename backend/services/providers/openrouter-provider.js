'use strict';

/**
 * OpenRouter Provider — cloud AI escalation path.
 * OpenAI-compatible API with model routing across providers.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function _key() { return process.env.OPENROUTER_API_KEY || ''; }
function _model() { return process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5-20251001'; }

function isConfigured() {
  return !!_key();
}

async function chat(systemPrompt, messages, options = {}) {
  if (!_key()) throw new Error('OpenRouter API key not configured');

  const model = options.model || _model();
  const timeout = options.timeout || 30000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_key()}`,
        'HTTP-Referer': 'https://neuro.nurtur.tech',
        'X-Title': 'NEURO',
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
      throw new Error(`OpenRouter API error: HTTP ${res.status} — ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return { text, usage };
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
  if (!_key()) throw new Error('OpenRouter API key not configured');

  const model = options.model || _model();
  const timeout = options.timeout || 60000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_key()}`,
        'HTTP-Referer': 'https://neuro.nurtur.tech',
        'X-Title': 'NEURO',
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
      throw new Error(`OpenRouter stream error: HTTP ${response.status} — ${body.substring(0, 200)}`);
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
