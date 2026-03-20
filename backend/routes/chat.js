const express = require('express');
const router = express.Router();
const claude = require('../services/claude');
const db = require('../db/database');

// POST /api/chat — SSE streaming response via Claude API
router.post('/', (req, res) => {
  const { message, conversationId } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const convId = conversationId || `conv_${Date.now()}`;
  claude.streamChat(convId, message, res);
});

// GET /api/chat/history/:conversationId
router.get('/history/:conversationId', (req, res) => {
  const history = db.getConversationHistory(req.params.conversationId, 50);
  res.json({ conversationId: req.params.conversationId, messages: history });
});

module.exports = router;
