const express = require('express');
const router = express.Router();

const neuroSnapshot = require('../integrations/neuroSnapshot');
const neuroChat = require('../integrations/neuroChat');
const neuroConfig = require('../integrations/neuroConfig');

async function checkPin(baseUrl, pin) {
  const res = await fetch(neuroChat.buildUrl(baseUrl, '/api/auth/check'), {
    headers: pin ? { 'x-neuro-pin': pin } : {},
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

router.get('/', (_req, res) => {
  const availability = neuroChat.getAvailability();
  res.json({
    available: availability.available,
    source: neuroConfig.hasOverride() ? 'session' : process.env.NEURO_PIN ? 'env' : 'none',
    configured: Boolean(neuroConfig.getPin()),
    detail: availability.detail,
  });
});

router.post('/', async (req, res) => {
  const pin = String(req.body?.pin || '').trim();
  if (!pin) return res.status(400).json({ ok: false, error: 'pin is required' });

  const availability = neuroChat.getAvailability({ ...process.env, NEURO_PIN: pin });
  if (!availability.config.baseUrl) {
    return res.status(400).json({ ok: false, error: 'NEURO_BASE_URL is not configured' });
  }

  try {
    const check = await checkPin(availability.config.baseUrl, pin);
    if (check.required && !check.authenticated) {
      return res.status(401).json({ ok: false, error: 'PIN rejected by NEURO' });
    }

    neuroConfig.setPin(pin);
    await neuroSnapshot.refresh().catch(() => {});
    return res.json({ ok: true, source: 'session' });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.delete('/', async (_req, res) => {
  neuroConfig.clearPin();
  await neuroSnapshot.refresh().catch(() => {});
  res.json({ ok: true, source: 'none' });
});

module.exports = router;
