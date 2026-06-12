// NEURO chat bridge — bounded transport seam into the existing NEURO backend.
//
// WS gap-bridge slice:
// - Keep SARA's runtime and shared-state work intact.
// - Reuse the existing NEURO backend for conversation instead of inventing a second AI.
// - Stay honest when the upstream is not configured or unavailable.
//
// CommonJS only — matches the NEURO backend convention (no ESM).

const DEFAULT_CHAT_PATH = '/api/chat';
const DEFAULT_NUDGE_PATH = '/api/nudges/stream';
const neuroConfig = require('./neuroConfig');

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getConfig(env = process.env) {
  return {
    baseUrl: trimSlash(env.NEURO_BASE_URL || 'https://nuero.nickward.co.uk'),
    pin: neuroConfig.getPin(env),
    chatPath: env.NEURO_CHAT_PATH || DEFAULT_CHAT_PATH,
    nudgesPath: env.NEURO_NUDGES_PATH || DEFAULT_NUDGE_PATH,
  };
}

function getAvailability(env = process.env) {
  const cfg = getConfig(env);
  if (!cfg.baseUrl) {
    return {
      available: false,
      reason: 'not-configured',
      detail: 'NEURO_BASE_URL is not set.',
      config: cfg,
    };
  }
  if (!cfg.pin) {
    return {
      available: false,
      reason: 'not-configured',
      detail: 'NEURO_PIN is not set.',
      config: cfg,
    };
  }
  return {
    available: true,
    reason: null,
    detail: null,
    config: cfg,
  };
}

function buildUrl(baseUrl, path) {
  return new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`).toString();
}

async function proxyChat(body, options = {}) {
  const availability = getAvailability(options.env);
  if (!availability.available) {
    const err = new Error(availability.detail);
    err.code = availability.reason;
    err.availability = availability;
    throw err;
  }

  const { config } = availability;
  return fetch(buildUrl(config.baseUrl, config.chatPath), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      'x-neuro-pin': config.pin,
    },
    body: JSON.stringify(body || {}),
    signal: options.signal,
  });
}

module.exports = {
  DEFAULT_CHAT_PATH,
  DEFAULT_NUDGE_PATH,
  buildUrl,
  getAvailability,
  getConfig,
  proxyChat,
};
