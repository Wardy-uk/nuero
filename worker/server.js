'use strict';

/**
 * NEURO Worker — Background AI processor for Pi 4.
 *
 * Handles non-interactive AI tasks delegated from Pi 5:
 *   - email_triage
 *   - import_classification
 *   - journal_prompts
 *   - transcript_processing
 *
 * This is a worker, not a peer. It:
 *   - does not own state
 *   - does not make decisions
 *   - only processes AI tasks requested by Pi 5
 */

const express = require('express');

const WORKER_PORT = process.env.WORKER_PORT || 3002;
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

const app = express();
app.use(express.json({ limit: '5mb' }));

// Auth middleware
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (WORKER_SECRET && req.headers['x-worker-secret'] !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Health check ──
app.get('/health', async (req, res) => {
  let ollamaOk = false;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    ollamaOk = r.ok;
  } catch {}

  res.json({
    worker: 'neuro-pi4',
    ok: true,
    ollama: { url: OLLAMA_URL, model: OLLAMA_MODEL, reachable: ollamaOk },
    uptime: process.uptime(),
  });
});

// ── Supported tasks (hardcoded, explicit) ──
const SUPPORTED_TASKS = new Set([
  'email_triage',
  'import_classification',
  'journal_prompts',
  'transcript_processing',
]);

// ── Run task ──
app.post('/run-task', async (req, res) => {
  const { task, payload } = req.body;
  if (!task || !SUPPORTED_TASKS.has(task)) {
    return res.status(400).json({ error: `Unsupported task: ${task}`, supported: [...SUPPORTED_TASKS] });
  }
  if (!payload) {
    return res.status(400).json({ error: 'payload required' });
  }

  const t0 = Date.now();
  const model = payload.model || OLLAMA_MODEL;
  const timeout = payload.timeout || 120000;

  try {
    let text;
    if (payload.messages) {
      text = await ollamaChat(payload.systemPrompt || '', payload.messages, model, {
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        timeout,
      });
    } else if (payload.prompt) {
      text = await ollamaGenerate(payload.prompt, model, {
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        timeout,
      });
    } else {
      return res.status(400).json({ error: 'payload must include prompt or messages' });
    }

    const duration = Date.now() - t0;
    console.log(`[Worker] ${task}: ${duration}ms via ${model} (${text.length} chars)`);

    res.json({
      ok: true,
      provider: 'ollama',
      model,
      duration,
      result: text,
    });
  } catch (e) {
    console.error(`[Worker] ${task} failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Ollama helpers ──
async function ollamaGenerate(prompt, model, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 120000);

  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.3,
          num_predict: options.maxTokens || 512,
          num_ctx: 4096,
        },
      }),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
    const data = await r.json();
    return data.response || '';
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaChat(systemPrompt, messages, model, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 120000);

  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: false,
        options: {
          temperature: options.temperature ?? 0.3,
          num_predict: options.maxTokens || 512,
          num_ctx: 4096,
        },
      }),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
    const data = await r.json();
    return data.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

app.listen(WORKER_PORT, '0.0.0.0', () => {
  console.log(`[Worker] NEURO Pi 4 worker running on 0.0.0.0:${WORKER_PORT}`);
  console.log(`[Worker] Ollama: ${OLLAMA_URL} model: ${OLLAMA_MODEL}`);
  console.log(`[Worker] Supported tasks: ${[...SUPPORTED_TASKS].join(', ')}`);
});
