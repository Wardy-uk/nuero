'use strict';

/**
 * AI Settings API — view and update AI configuration at runtime.
 *
 * GET  /api/ai/settings  — current AI config + status
 * POST /api/ai/settings  — update runtime AI settings
 *
 * Some settings (API keys) require server restart.
 * Others (mode, limits) can be changed at runtime via agent_state.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const aiRouting = require('../services/ai-routing');

// Settings that can be changed at runtime (stored in agent_state)
const RUNTIME_SETTINGS = {
  ai_mode: { key: 'ai_mode', env: 'AI_MODE', default: 'ollama-only', options: ['off', 'ollama-only', 'hybrid', 'critical-only'] },
  openai_enabled: { key: 'openai_enabled', env: 'OPENAI_ENABLED', default: 'false', type: 'boolean' },
  openai_api_key: { key: 'openai_api_key', env: 'OPENAI_API_KEY', default: '', type: 'secret' },
  openai_model: { key: 'openai_model', env: 'OPENAI_MODEL', default: 'gpt-4o-mini' },
  openai_daily_call_limit: { key: 'openai_daily_call_limit', env: 'OPENAI_DAILY_CALL_LIMIT', default: '50', type: 'number' },
  openai_daily_token_limit: { key: 'openai_daily_token_limit', env: 'OPENAI_DAILY_TOKEN_LIMIT', default: '50000', type: 'number' },
  openai_max_escalations_per_hour: { key: 'openai_max_escalations_per_hour', env: 'OPENAI_MAX_ESCALATIONS_PER_HOUR', default: '10', type: 'number' },
  sara_mode: { key: 'sara_mode', env: 'SARA_MODE', default: 'suggest', options: ['suggest', 'off'] },
  pi4_worker_enabled: { key: 'pi4_worker_enabled', env: 'PI4_WORKER_ENABLED', default: 'false', type: 'boolean' },
  pi4_worker_url: { key: 'pi4_worker_url', env: 'PI4_WORKER_URL', default: 'http://100.69.158.50:3002' },
};

function _getSettingValue(setting) {
  // Runtime override from agent_state takes priority, then env, then default
  const stored = db.getState(`ai_setting_${setting.key}`);
  if (stored !== null && stored !== undefined) return stored;
  return process.env[setting.env] || setting.default;
}

// GET /api/ai/settings
router.get('/', (req, res) => {
  const settings = {};
  for (const [key, def] of Object.entries(RUNTIME_SETTINGS)) {
    const value = _getSettingValue(def);
    settings[key] = {
      value: def.type === 'secret' ? (value ? '••••••' + value.slice(-4) : '') : value,
      hasValue: !!value,
      options: def.options || null,
      type: def.type || 'string',
      requiresRestart: def.type === 'secret', // API keys need restart
    };
  }

  // Add live status
  const status = aiRouting.getStatus();

  res.json({
    settings,
    status: {
      mode: status.mode,
      ollamaModel: status.ollama?.model,
      ollamaLightModel: status.ollama?.lightweightModel,
      ollamaQueueDepth: status.ollama?.queueDepth,
      ollamaInUse: status.ollama?.inUse,
      openaiCallsToday: status.openai?.callsToday,
      openaiTokensToday: status.openai?.tokensToday,
      openaiThrottled: status.openai?.throttled,
      openaiLastFallback: status.openai?.lastFallbackReason,
      pi4Enabled: status.pi4Worker?.enabled,
      pi4Healthy: status.pi4Worker?.lastHealthy,
      backgroundTasks: status.backgroundTasks,
      taskModels: status.taskModels,
    },
  });
});

// POST /api/ai/settings
router.post('/', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Expected object with setting key/value pairs' });
  }

  const applied = {};
  const errors = {};

  for (const [key, value] of Object.entries(updates)) {
    const def = RUNTIME_SETTINGS[key];
    if (!def) {
      errors[key] = 'Unknown setting';
      continue;
    }

    // Validate options
    if (def.options && !def.options.includes(value)) {
      errors[key] = `Must be one of: ${def.options.join(', ')}`;
      continue;
    }

    // Store in agent_state
    db.setState(`ai_setting_${def.key}`, String(value));

    // Also update env var for current process (immediate effect for non-restart settings)
    if (def.type !== 'secret') {
      process.env[def.env] = String(value);
    } else if (value && value !== '••••••') {
      // For secrets, update env directly (takes effect immediately for new connections)
      process.env[def.env] = String(value);
    }

    applied[key] = def.type === 'secret' ? '(updated)' : value;
  }

  console.log('[AI Settings] Updated:', Object.keys(applied).join(', '));

  res.json({ ok: true, applied, errors: Object.keys(errors).length > 0 ? errors : undefined });
});

module.exports = router;
