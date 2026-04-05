'use strict';

/**
 * AI Routing Policy — Phase 4B: Pi split + priority queue + model-per-task.
 *
 * Pi 5 handles: focus_enhancement, drilldown_framing, chat_stream (interactive)
 * Pi 4 handles: email_triage, import_classification, journal_prompts, transcript_processing
 *
 * Model routing on Pi 5:
 *   - qwen2.5:1.5b for lightweight tasks (focus, framing)
 *   - qwen2.5:7b for heavy tasks (chat)
 *
 * Priority queue: HIGH (focus, chat) runs before LOW (background fallback).
 * Only one local Ollama request at a time.
 */

const ollamaProvider = require('./providers/ollama-provider');
const openaiProvider = require('./providers/openai-provider');
const pi4Worker = require('./pi4-worker-client');

// ── Config ──
const AI_MODE = process.env.AI_MODE || 'ollama-only';
const OPENAI_ENABLED = process.env.OPENAI_ENABLED === 'true';
const OPENAI_DAILY_CALL_LIMIT = parseInt(process.env.OPENAI_DAILY_CALL_LIMIT) || 50;
const OPENAI_DAILY_TOKEN_LIMIT = parseInt(process.env.OPENAI_DAILY_TOKEN_LIMIT) || 50000;
const OPENAI_MAX_ESCALATIONS_PER_HOUR = parseInt(process.env.OPENAI_MAX_ESCALATIONS_PER_HOUR) || 10;

const OPENAI_ALLOWED_TASKS = (process.env.OPENAI_ALLOWED_TASKS || 'all')
  .split(',').map(s => s.trim()).filter(Boolean);
const OPENAI_CRITICAL_TYPES = (process.env.OPENAI_CRITICAL_ONLY_TYPES || 'escalation_reasoning,sla_ambiguity,cross_context_synthesis')
  .split(',').map(s => s.trim()).filter(Boolean);


// ── Model-per-task routing (Pi 5 only) ──
const LIGHTWEIGHT_MODEL = 'qwen2.5:1.5b';
const HEAVY_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

const TASK_MODELS = {
  focus_enhancement: LIGHTWEIGHT_MODEL,
  drilldown_framing: LIGHTWEIGHT_MODEL,
  action_suggestion: LIGHTWEIGHT_MODEL,
  chat_stream: LIGHTWEIGHT_MODEL,       // TODO: switch to gemma3:4b when available
  standup_interactive: LIGHTWEIGHT_MODEL, // TODO: switch to gemma3:4b when available
  eod_interactive: LIGHTWEIGHT_MODEL,     // TODO: switch to gemma3:4b when available
};

// ── Background tasks → Pi 4 worker ──
const BACKGROUND_TASKS = new Set([
  'email_triage',
  'import_classification',
  'journal_prompts',
  'transcript_processing',
]);

// ── Priority queue (simple semaphore) ──
// Only one local Ollama request at a time. HIGH preempts LOW.
let _ollamaInUse = false;
const _highQueue = []; // { resolve, reject, fn }
const _lowQueue = [];

async function _queueOllamaRequest(priority, fn) {
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, fn };
    if (priority === 'high') {
      _highQueue.push(entry);
    } else {
      _lowQueue.push(entry);
    }
    _processQueue();
  });
}

async function _processQueue() {
  if (_ollamaInUse) return;

  // HIGH priority first
  const entry = _highQueue.shift() || _lowQueue.shift();
  if (!entry) return;

  _ollamaInUse = true;
  try {
    const result = await entry.fn();
    entry.resolve(result);
  } catch (e) {
    entry.reject(e);
  } finally {
    _ollamaInUse = false;
    // Process next in queue
    setImmediate(_processQueue);
  }
}

function _getTaskPriority(taskType) {
  if (taskType === 'focus_enhancement' || taskType === 'chat_stream' ||
      taskType === 'drilldown_framing' || taskType === 'standup_interactive' ||
      taskType === 'eod_interactive') {
    return 'high';
  }
  return 'low';
}


// ── Usage tracking ──
let _usage = { date: _todayStr(), calls: 0, tokens: 0, hourlyEscalations: new Map(), lastFallbackReason: null };

function _todayStr() { return new Date().toISOString().split('T')[0]; }
function _resetIfNewDay() {
  const today = _todayStr();
  if (_usage.date !== today) {
    _usage = { date: today, calls: 0, tokens: 0, hourlyEscalations: new Map(), lastFallbackReason: null };
  }
}
function _currentHourKey() { return new Date().getHours().toString(); }

function _isOpenAIAllowed(taskType) {
  _resetIfNewDay();
  if (AI_MODE === 'off' || AI_MODE === 'ollama-only') return false;
  if (!OPENAI_ENABLED || !openaiProvider.isConfigured()) return false;
  if (AI_MODE === 'critical-only' && !OPENAI_CRITICAL_TYPES.includes(taskType)) return false;
  if (AI_MODE === 'hybrid' && OPENAI_ALLOWED_TASKS[0] !== 'all' && !OPENAI_ALLOWED_TASKS.includes(taskType)) return false;
  if (_usage.calls >= OPENAI_DAILY_CALL_LIMIT) { _usage.lastFallbackReason = 'Daily call limit'; return false; }
  if (_usage.tokens >= OPENAI_DAILY_TOKEN_LIMIT) { _usage.lastFallbackReason = 'Daily token limit'; return false; }
  const hk = _currentHourKey();
  if ((_usage.hourlyEscalations.get(hk) || 0) >= OPENAI_MAX_ESCALATIONS_PER_HOUR) { _usage.lastFallbackReason = 'Hourly limit'; return false; }
  return true;
}

function _recordOpenAIUsage(usage) {
  _resetIfNewDay();
  _usage.calls++;
  _usage.tokens += usage?.total_tokens || 0;
  const hk = _currentHourKey();
  _usage.hourlyEscalations.set(hk, (_usage.hourlyEscalations.get(hk) || 0) + 1);
}


// ═══════════════════════════════════════════════════════
// Main API
// ═══════════════════════════════════════════════════════

/**
 * Run an AI task through the routing policy.
 *
 * Routing order:
 *   1. Background tasks → Pi 4 worker (if enabled)
 *   2. Local Ollama via priority queue (model selected by task type)
 *   3. OpenAI (if allowed + under budget)
 *   4. Safe no-op
 */
async function runTask(taskType, payload, options = {}) {
  _resetIfNewDay();
  const { forceLocal = false, forceCloud = false, confidence = 1.0 } = options;

  if (AI_MODE === 'off') {
    return { text: '', provider: 'none', fallback: false, reason: 'AI mode is off' };
  }

  // ── Route background tasks to Pi 4 worker ──
  if (BACKGROUND_TASKS.has(taskType) && !forceLocal && pi4Worker.isEnabled()) {
    try {
      const workerResult = await pi4Worker.runTask(taskType, payload);
      if (workerResult.ok && workerResult.result) {
        console.log(`[AIRouting] ${taskType}: Pi 4 worker (${workerResult.duration}ms)`);
        return { text: workerResult.result, provider: workerResult.provider, fallback: false };
      }
      console.warn(`[AIRouting] Pi 4 worker failed for ${taskType}: ${workerResult.error}`);
    } catch (e) {
      console.warn(`[AIRouting] Pi 4 worker unreachable for ${taskType}: ${e.message}`);
    }
    // Fall through to local Ollama
  }

  // ── Select model for this task ──
  const model = TASK_MODELS[taskType] || HEAVY_MODEL;
  const payloadWithModel = { ...payload, model };
  const priority = _getTaskPriority(taskType);

  // ── Try local Ollama via priority queue ──
  if (!forceCloud) {
    try {
      const text = await _queueOllamaRequest(priority, () =>
        _runOllama(taskType, payloadWithModel, options)
      );
      if (text && text.trim().length > 0) {
        return { text, provider: 'ollama', fallback: BACKGROUND_TASKS.has(taskType), model };
      }
    } catch (err) {
      console.warn(`[AIRouting] Ollama failed for ${taskType}: ${err.message}`);
    }
  }

  // ── Try OpenAI escalation ──
  const shouldEscalate = !forceLocal && (forceCloud || (confidence < 0.5 && _isOpenAIAllowed(taskType)));
  if (shouldEscalate || (forceCloud && _isOpenAIAllowed(taskType))) {
    try {
      const result = await _runOpenAI(taskType, payload, options);
      if (result.text && result.text.trim().length > 0) {
        _recordOpenAIUsage(result.usage);
        return { text: result.text, provider: 'openai', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenAI failed for ${taskType}: ${err.message}`);
      _usage.lastFallbackReason = `OpenAI error: ${err.message.substring(0, 100)}`;
    }
  }

  return { text: '', provider: 'none', fallback: true, reason: 'All providers failed or disabled' };
}

/**
 * Streaming chat (always local Pi 5, never Pi 4).
 */
async function runStreamingChat(systemPrompt, messages, res, options = {}) {
  _resetIfNewDay();
  const taskType = options.taskType || 'chat_stream';
  const forceCloud = options.forceCloud || false;
  const model = TASK_MODELS[taskType] || HEAVY_MODEL;

  if (!forceCloud) {
    try {
      const text = await ollamaProvider.streamChat(systemPrompt, messages, res, { ...options, model });
      if (text && text.trim().length > 0) {
        return { text, provider: 'ollama', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] Ollama stream failed: ${err.message}`);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'text', content: '*[Local model unavailable, trying cloud...]*\n\n' })}\n\n`);
      }
    }
  }

  if (_isOpenAIAllowed(taskType)) {
    try {
      const result = await openaiProvider.streamChat(systemPrompt, messages, res, options);
      if (result.fullText) {
        _recordOpenAIUsage(result.usage);
        return { text: result.fullText, provider: 'openai', fallback: !forceCloud };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenAI stream failed: ${err.message}`);
    }
  }

  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ type: 'text', content: '*[AI unavailable — try again later]*\n' })}\n\n`);
  }
  return { text: '', provider: 'none', fallback: true };
}


// ── Internal runners ──

async function _runOllama(taskType, payload, options) {
  if (payload.messages) {
    return ollamaProvider.chat(payload.systemPrompt || '', payload.messages, {
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      timeout: options.timeout,
    });
  }
  return ollamaProvider.generate(payload.prompt || '', {
    model: payload.model,
    temperature: payload.temperature,
    maxTokens: payload.maxTokens,
    timeout: options.timeout,
  });
}

async function _runOpenAI(taskType, payload, options) {
  if (payload.messages) {
    return openaiProvider.chat(payload.systemPrompt || '', payload.messages, {
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      timeout: options.timeout,
    });
  }
  return openaiProvider.generate(payload.prompt || '', {
    model: payload.model,
    temperature: payload.temperature,
    maxTokens: payload.maxTokens,
    timeout: options.timeout,
  });
}


// ═══════════════════════════════════════════════════════
// Status
// ═══════════════════════════════════════════════════════

function getStatus() {
  _resetIfNewDay();
  return {
    mode: AI_MODE,
    openai: {
      enabled: OPENAI_ENABLED,
      configured: openaiProvider.isConfigured(),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      callsToday: _usage.calls,
      tokensToday: _usage.tokens,
      dailyCallLimit: OPENAI_DAILY_CALL_LIMIT,
      dailyTokenLimit: OPENAI_DAILY_TOKEN_LIMIT,
      throttled: _usage.calls >= OPENAI_DAILY_CALL_LIMIT || _usage.tokens >= OPENAI_DAILY_TOKEN_LIMIT,
      lastFallbackReason: _usage.lastFallbackReason,
    },
    ollama: {
      url: ollamaProvider.getUrl(),
      model: ollamaProvider.getModel(),
      lightweightModel: LIGHTWEIGHT_MODEL,
      queueDepth: _highQueue.length + _lowQueue.length,
      inUse: _ollamaInUse,
    },
    pi4Worker: pi4Worker.getStatus(),
    taskModels: TASK_MODELS,
    backgroundTasks: [...BACKGROUND_TASKS],
  };
}

async function checkOllama() {
  return ollamaProvider.isAvailable();
}

module.exports = { runTask, runStreamingChat, getStatus, checkOllama, AI_MODE };
