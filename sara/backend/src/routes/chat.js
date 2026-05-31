const express = require('express');
const neuroChat = require('../integrations/neuroChat');

const router = express.Router();

router.get('/', (_req, res) => {
  const availability = neuroChat.getAvailability();
  res.status(availability.available ? 200 : 503).json({
    upstream: 'neuro',
    available: availability.available,
    reason: availability.reason,
    detail: availability.detail,
    configured: availability.available,
    chatPath: availability.config.chatPath,
    nudgesPath: availability.config.nudgesPath,
  });
});

router.post('/', async (req, res) => {
  try {
    const upstream = await neuroChat.proxyChat(req.body);
    const contentType = upstream.headers.get('content-type');

    res.status(upstream.status);
    if (contentType) res.setHeader('content-type', contentType);
    res.setHeader('x-sara-chat-upstream', 'neuro');

    if (contentType && contentType.includes('text/event-stream')) {
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');

      if (!upstream.body) {
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }

    const text = await upstream.text();
    res.send(text);
  } catch (error) {
    const availability = error.availability || neuroChat.getAvailability();
    const status = error.code === 'not-configured' ? 503 : 502;
    res.status(status).json({
      upstream: 'neuro',
      available: false,
      reason: error.code || 'upstream-unreachable',
      detail: error.message,
      configured: availability.available,
    });
  }
});

module.exports = router;
