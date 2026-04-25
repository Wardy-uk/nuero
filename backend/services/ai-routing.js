'use strict';

/**
 * AI Routing Policy — Phase 5: Pi local + OpenRouter cloud split.
 *
 * Light tasks (Pi 5 Ollama): focus_enhancement, drilldown_framing, action_suggestion
 * Heavy tasks (OpenRouter):  chat_stream, chat_sync, standup_interactive, eod_interactive
 * Background tasks (Pi 4):   email_triage, import_classification, journal_prompts, transcript_processing
 *
 * Priority queue still applies for local Ollama requests.
 */

const ollamaProvider = require('./providers/ollama-provider');
const openrouterProvider = require('./providers/openrouter-provider');
const pi4Worker = require('./pi4-worker-client');

// ── Config ──
const AI_MODE = process.env.AI_MODE || 'ollama-only';
const OPENROUTER_ENABLED = process.env.OPENROUTER_ENABLED === 'true';
const OPENROUTER_DAILY_CALL_LIMIT = parseInt(process.env.OPENROUTER_DAILY_CALL_LIMIT) || 100;
const OPENROUTER_DAILY_TOKEN_LIMIT = parseInt(process.env.OPENROUTER_DAILY_TOKEN_LIMIT) || 100000;
const OPENROUTER_MAX_ESCALATIONS_PER_HOUR = parseInt(process.env.OPENROUTER_MAX_ESCALATIONS_PER_HOUR) || 20;

const OPENROUTER_ALLOWED_TASKS = (process.env.OPENROUTER_ALLOWED_TASKS || 'all')
  .split(',').map(s => s.trim()).filter(Boolean);
const OPENROUTER_CRITICAL_TYPES = (process.env.OPENROUTER_CRITICAL_ONLY_TYPES || 'escalation_reasoning,sla_ambiguity,cross_context_synthesis,transcript_processing')
  .split(',').map(s => s.trim()).filter(Boolean);


// ── Model-per-task routing ──
const LIGHTWEIGHT_MODEL = 'qwen2.5:1.5b';
const HEAVY_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

// Tasks that should go to OpenRouter when available (heavy/interactive)
const CLOUD_PREFERRED_TASKS = new Set([
  'chat_stream',
  'chat_sync',
  'standup_interactive',
  'eod_interactive',
]);

// Local model selection for tasks that stay on Pi
const TASK_MODELS = {
  focus_enhancement: LIGHTWEIGHT_MODEL,
  drilldown_framing: LIGHTWEIGHT_MODEL,
  action_suggestion: LIGHTWEIGHT_MODEL,
  chat_stream: 'qwen2.5:1.5b',
  chat_sync: 'qwen2.5:1.5b',
  standup_interactive: 'gemma3:4b',
  eod_interactive: 'gemma3:4b',
};

// ── Background tasks → Pi 4 worker ──
const BACKGROUND_TASKS = new Set([
  'email_triage',
  'import_classification',
  'journal_prompts',
  'transcript_processing',
]);

// ── Priority queue (simple semaphore) ──
let _ollamaInUse = false;
const _highQueue = [];
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

function _isOpenRouterAllowed(taskType) {
  _resetIfNewDay();
  if (AI_MODE === 'off' || AI_MODE === 'ollama-only') return false;
  if (!OPENROUTER_ENABLED || !openrouterProvider.isConfigured()) return false;
  if (AI_MODE === 'critical-only' && !OPENROUTER_CRITICAL_TYPES.includes(taskType)) return false;
  if (AI_MODE === 'hybrid' && OPENROUTER_ALLOWED_TASKS[0] !== 'all' && !OPENROUTER_ALLOWED_TASKS.includes(taskType)) return false;
  if (_usage.calls >= OPENROUTER_DAILY_CALL_LIMIT) { _usage.lastFallbackReason = 'Daily call limit'; return false; }
  if (_usage.tokens >= OPENROUTER_DAILY_TOKEN_LIMIT) { _usage.lastFallbackReason = 'Daily token limit'; return false; }
  const hk = _currentHourKey();
  if ((_usage.hourlyEscalations.get(hk) || 0) >= OPENROUTER_MAX_ESCALATIONS_PER_HOUR) { _usage.lastFallbackReason = 'Hourly limit'; return false; }
  return true;
}

function _recordOpenRouterUsage(usage) {
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
 *   2. Cloud-preferred tasks → OpenRouter (if allowed + under budget), Ollama fallback
 *   3. Light tasks → Local Ollama via priority queue
 *   4. Safe no-op
 */
async function runTask(taskType, payload, options = {}) {
  _resetIfNewDay();
  const { forceLocal = false, forceCloud = false, confidence = 1.0 } = options;

  if (AI_MODE === 'off') {
    return { text: '', provider: 'none', fallback: false, reason: 'AI mode is off' };
  }

  // ── Route background tasks to Pi 4 worker ──
  if (BACKGROUND_TASKS.has(taskType) && !forceLocal) {
    if (!pi4Worker.isEnabled()) {
      console.log(`[AIRouting] ${taskType}: skipped (Pi 4 worker not enabled)`);
      return { text: '', provider: 'none', fallback: true, reason: 'Pi 4 worker not enabled' };
    }
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
    return { text: '', provider: 'none', fallback: true, reason: 'Pi 4 worker unavailable' };
  }

  // ── Cloud-preferred tasks: try OpenRouter first, fall back to local ──
  const preferCloud = CLOUD_PREFERRED_TASKS.has(taskType);

  if ((preferCloud || forceCloud) && !forceLocal && _isOpenRouterAllowed(taskType)) {
    try {
      const result = await _runOpenRouter(taskType, payload, options);
      if (result.text && result.text.trim().length > 0) {
        _recordOpenRouterUsage(result.usage);
        return { text: result.text, provider: 'openrouter', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenRouter failed for ${taskType}: ${err.message}`);
      _usage.lastFallbackReason = `OpenRouter error: ${err.message.substring(0, 100)}`;
    }
  }

  // ── Local Ollama (primary for light tasks, fallback for heavy) ──
  const model = TASK_MODELS[taskType] || HEAVY_MODEL;
  const payloadWithModel = { ...payload, model };
  const priority = _getTaskPriority(taskType);

  if (!forceCloud) {
    try {
      const text = await _queueOllamaRequest(priority, () =>
        _runOllama(taskType, payloadWithModel, options)
      );
      if (text && text.trim().length > 0) {
        return { text, provider: 'ollama', fallback: preferCloud, model };
      }
    } catch (err) {
      console.warn(`[AIRouting] Ollama failed for ${taskType}: ${err.message}`);
    }
  }

  // ── Last resort: try OpenRouter if we haven't yet ──
  if (!preferCloud && !forceLocal && _isOpenRouterAllowed(taskType)) {
    try {
      const result = await _runOpenRouter(taskType, payload, options);
      if (result.text && result.text.trim().length > 0) {
        _recordOpenRouterUsage(result.usage);
        return { text: result.text, provider: 'openrouter', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenRouter escalation failed for ${taskType}: ${err.message}`);
    }
  }

  return { text: '', provider: 'none', fallback: true, reason: 'All providers failed or disabled' };
}

/**
 * Streaming chat — OpenRouter-primary for heavy tasks, Ollama fallback.
 */
async function runStreamingChat(systemPrompt, messages, res, options = {}) {
  _resetIfNewDay();
  const taskType = options.taskType || 'chat_stream';
  const forceCloud = options.forceCloud || false;
  const model = TASK_MODELS[taskType] || HEAVY_MODEL;

  // Cloud-primary: try OpenRouter FIRST for chat
  if (_isOpenRouterAllowed(taskType)) {
    try {
      const result = await openrouterProvider.streamChat(systemPrompt, messages, res, options);
      if (result.fullText) {
        _recordOpenRouterUsage(result.usage);
        return { text: result.fullText, provider: 'openrouter', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenRouter stream failed: ${err.message}`);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'text', content: '*[Cloud unavailable, using local model...]*\n\n' })}\n\n`);
      }
    }
  }

  // Fallback: try Ollama locally
  if (!forceCloud) {
    try {
      const text = await ollamaProvider.streamChat(systemPrompt, messages, res, { ...options, model });
      if (text && text.trim().length > 0) {
        return { text, provider: 'ollama', fallback: true };
      }
    } catch (err) {
      console.warn(`[AIRouting] Ollama stream failed: ${err.message}`);
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

async function _runOpenRouter(taskType, payload, options) {
  if (payload.messages) {
    return openrouterProvider.chat(payload.systemPrompt || '', payload.messages, {
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      timeout: options.timeout,
    });
  }
  return openrouterProvider.generate(payload.prompt || '', {
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
    openrouter: {
      enabled: OPENROUTER_ENABLED,
      configured: openrouterProvider.isConfigured(),
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      callsToday: _usage.calls,
      tokensToday: _usage.tokens,
      dailyCallLimit: OPENROUTER_DAILY_CALL_LIMIT,
      dailyTokenLimit: OPENROUTER_DAILY_TOKEN_LIMIT,
      throttled: _usage.calls >= OPENROUTER_DAILY_CALL_LIMIT || _usage.tokens >= OPENROUTER_DAILY_TOKEN_LIMIT,
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
    cloudPreferredTasks: [...CLOUD_PREFERRED_TASKS],
    backgroundTasks: [...BACKGROUND_TASKS],
  };
}

async function checkOllama() {
  return ollamaProvider.isAvailable();
}

module.exports = { runTask, runStreamingChat, getStatus, checkOllama, AI_MODE };
