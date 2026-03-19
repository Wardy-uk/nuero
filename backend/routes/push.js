const express = require('express');
const router = express.Router();
const db = require('../db/database');
const webpush = require('../services/webpush');

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(500).json({ error: 'VAPID keys not configured' });
  }
  res.json({ publicKey: key });
});

// POST /api/push/subscribe
router.post('/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }
  try {
    db.savePushSubscription(subscription);
    console.log('[Push] New subscription registered');
    res.json({ ok: true });
  } catch (e) {
    console.error('[Push] Subscribe error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/push/test — send a test notification
router.post('/test', async (req, res) => {
  try {
    await webpush.sendToAll('NEURO Test', 'Push notifications are working!', { type: 'test' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Push] Test error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
