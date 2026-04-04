'use strict';

/**
 * AI Routing Policy — decides which provider to use for each task.
 *
 * Modes:
 *   off          — no AI, deterministic rules only
 *   ollama-only  — local Ollama only, never call cloud
 *   hybrid       — Ollama default, escalate to OpenAI when justified
 *   critical-only — OpenAI only for explicitly critical task types
 *
 * Cost controls:
 *   Daily call limit, daily token limit, hourly escalation cap.
 *   If limits exceeded → immediate fallback to Ollama or deterministic.
 *
 * Failover chain:
 *   1. Deterministic (if sufficient)
 *   2. Ollama (if enabled)
 *   3. OpenAI (if enabled + allowed + under budget)
 *   4. Safe no-op / deterministic fallback
 */

const ollamaProvider = require('./providers/ollama-provider');
const openaiProvider = require('./providers/openai-provider');

// ── Config (from env, with safe defaults) ──
const AI_MODE = process.env.AI_MODE || 'ollama-only';
const OPENAI_ENABLED = process.env.OPENAI_ENABLED === 'true';
const OPENAI_DAILY_CALL_LIMIT = parseInt(process.env.OPENAI_DAILY_CALL_LIMIT) || 50;
const OPENAI_DAILY_TOKEN_LIMIT = parseInt(process.env.OPENAI_DAILY_TOKEN_LIMIT) || 50000;
const OPENAI_MAX_ESCALATIONS_PER_HOUR = parseInt(process.env.OPENAI_MAX_ESCALATIONS_PER_HOUR) || 10;

// Allowed task types for OpenAI (comma-separated env or all)
const OPENAI_ALLOWED_TASKS = (process.env.OPENAI_ALLOWED_TASKS || 'all')
  .split(',').map(s => s.trim()).filter(Boolean);

// Critical-only types (used when mode=critical-only)
const OPENAI_CRITICAL_TYPES = (process.env.OPENAI_CRITICAL_ONLY_TYPES || 'escalation_reasoning,sla_ambiguity,cross_context_synthesis')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── Usage tracking (in-memory, resets daily) ──
let _usage = {
  date: _todayStr(),
  calls: 0,
  tokens: 0,
  hourlyEscalations: new Map(), // hour → count
  lastFallbackReason: null,
};

function _todayStr() {
  return new Date().toISOString().split('T')[0];
}

function _resetIfNewDay() {
  const today = _todayStr();
  if (_usage.date !== today) {
    _usage = {
      date: today,
      calls: 0,
      tokens: 0,
      hourlyEscalations: new Map(),
      lastFallbackReason: null,
    };
  }
}

function _currentHourKey() {
  return new Date().getHours().toString();
}

// ── Policy checks ──

function _isOpenAIAllowed(taskType) {
  _resetIfNewDay();

  // Mode check
  if (AI_MODE === 'off' || AI_MODE === 'ollama-only') return false;
  if (!OPENAI_ENABLED) return false;
  if (!openaiProvider.isConfigured()) return false;

  // Critical-only mode: only critical types allowed
  if (AI_MODE === 'critical-only') {
    if (!OPENAI_CRITICAL_TYPES.includes(taskType)) return false;
  }

  // Hybrid mode: check if task type is allowed
  if (AI_MODE === 'hybrid') {
    if (OPENAI_ALLOWED_TASKS[0] !== 'all' && !OPENAI_ALLOWED_TASKS.includes(taskType)) return false;
  }

  // Budget checks
  if (_usage.calls >= OPENAI_DAILY_CALL_LIMIT) {
    _usage.lastFallbackReason = `Daily call limit reached (${OPENAI_DAILY_CALL_LIMIT})`;
    return false;
  }
  if (_usage.tokens >= OPENAI_DAILY_TOKEN_LIMIT) {
    _usage.lastFallbackReason = `Daily token limit reached (${OPENAI_DAILY_TOKEN_LIMIT})`;
    return false;
  }

  // Hourly escalation cap
  const hourKey = _currentHourKey();
  const hourCount = _usage.hourlyEscalations.get(hourKey) || 0;
  if (hourCount >= OPENAI_MAX_ESCALATIONS_PER_HOUR) {
    _usage.lastFallbackReason = `Hourly escalation limit reached (${OPENAI_MAX_ESCALATIONS_PER_HOUR}/hr)`;
    return false;
  }

  return true;
}

function _recordOpenAIUsage(usage) {
  _resetIfNewDay();
  _usage.calls++;
  _usage.tokens += usage?.total_tokens || 0;

  const hourKey = _currentHourKey();
  _usage.hourlyEscalations.set(hourKey, (_usage.hourlyEscalations.get(hourKey) || 0) + 1);
}


// ═══════════════════════════════════════════════════════
// Main API — runTask
// ═══════════════════════════════════════════════════════

/**
 * Run an AI task through the routing policy.
 *
 * @param {string} taskType - e.g. 'shortlist_reasoning', 'observation_synthesis', 'chat_stream'
 * @param {object} payload - { prompt, systemPrompt, messages, ... } — task-specific
 * @param {object} options - { forceLocal, forceCloud, confidence, res (for streaming) }
 * @returns {{ text: string, provider: 'ollama'|'openai'|'none', fallback: boolean }}
 */
async function runTask(taskType, payload, options = {}) {
  _resetIfNewDay();

  const { forceLocal = false, forceCloud = false, confidence = 1.0 } = options;

  // Mode=off → no AI at all
  if (AI_MODE === 'off') {
    return { text: '', provider: 'none', fallback: false, reason: 'AI mode is off' };
  }

  // Determine if OpenAI escalation is justified
  const shouldEscalate = !forceLocal && (
    forceCloud ||
    (confidence < 0.5 && _isOpenAIAllowed(taskType))
  );

  // ── Try Ollama first (unless forced to cloud) ──
  if (!forceCloud || !_isOpenAIAllowed(taskType)) {
    try {
      const text = await _runOllama(taskType, payload, options);
      if (text && text.trim().length > 0) {
        return { text, provider: 'ollama', fallback: false };
      }
      // Empty response — try escalation
    } catch (err) {
      console.warn(`[AIRouting] Ollama failed for ${taskType}: ${err.message}`);
      // Fall through to OpenAI if allowed
    }
  }

  // ── Try OpenAI escalation ──
  if (shouldEscalate || (forceCloud && _isOpenAIAllowed(taskType))) {
    try {
      const result = await _runOpenAI(taskType, payload, options);
      if (result.text && result.text.trim().length > 0) {
        _recordOpenAIUsage(result.usage);
        console.log(`[AIRouting] OpenAI used for ${taskType} (${result.usage?.total_tokens || '?'} tokens)`);
        return { text: result.text, provider: 'openai', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenAI failed for ${taskType}: ${err.message}`);
      _usage.lastFallbackReason = `OpenAI error: ${err.message.substring(0, 100)}`;
    }

    // ── OpenAI failed — try Ollama as fallback ──
    if (!forceCloud) {
      try {
        const text = await _runOllama(taskType, payload, options);
        if (text && text.trim().length > 0) {
          return { text, provider: 'ollama', fallback: true };
        }
      } catch {}
    }
  }

  // ── Both failed — safe no-op ──
  return { text: '', provider: 'none', fallback: true, reason: 'All providers failed or disabled' };
}

/**
 * Run a streaming chat task (for interactive conversations).
 * Returns the full response text. Writes SSE chunks to res.
 */
async function runStreamingChat(systemPrompt, messages, res, options = {}) {
  _resetIfNewDay();

  const taskType = options.taskType || 'chat_stream';
  const forceCloud = options.forceCloud || false;

  // ── Try Ollama streaming first ──
  if (!forceCloud) {
    try {
      const text = await ollamaProvider.streamChat(systemPrompt, messages, res, options);
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

  // ── Try OpenAI streaming ──
  if (_isOpenAIAllowed(taskType)) {
    try {
      const result = await openaiProvider.streamChat(systemPrompt, messages, res, options);
      if (result.fullText) {
        _recordOpenAIUsage(result.usage);
        return { text: result.fullText, provider: 'openai', fallback: !forceCloud };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenAI stream failed: ${err.message}`);
      _usage.lastFallbackReason = `OpenAI stream error: ${err.message.substring(0, 100)}`;
    }
  }

  // ── Both failed ──
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
// Status / Admin
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
    },
    allowedTasks: OPENAI_ALLOWED_TASKS,
    criticalTypes: OPENAI_CRITICAL_TYPES,
  };
}

/**
 * Check Ollama availability (async).
 */
async function checkOllama() {
  return ollamaProvider.isAvailable();
}

module.exports = {
  runTask,
  runStreamingChat,
  getStatus,
  checkOllama,
  AI_MODE,
};
