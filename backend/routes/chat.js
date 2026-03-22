const express = require('express');
const router = express.Router();
const claude = require('../services/claude');
const db = require('../db/database');

// POST /api/chat — SSE streaming response via Claude API
router.post('/', (req, res) => {
  const { message, conversationId, location } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  const convId = conversationId || `conv_${Date.now()}`;
  claude.streamChat(convId, message, res, location || null);
});

// GET /api/chat/conversations — list recent conversations
router.get('/conversations', (req, res) => {
  const conversations = db.getRecentConversations(5);
  res.json({ conversations });
});

// GET /api/chat/history/:conversationId
router.get('/history/:conversationId', (req, res) => {
  const history = db.getConversationHistory(req.params.conversationId, 50);
  res.json({ conversationId: req.params.conversationId, messages: history });
});

// GET /api/chat/decisions — recent logged decisions
// TODO: surface in ChatPanel or a dedicated Decisions view
router.get('/decisions', (req, res) => {
  const stmt = db.getDb().prepare(
    'SELECT id, conversation_id, decision_text, created_at FROM decisions ORDER BY created_at DESC LIMIT 50'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ decisions: rows });
});

module.exports = router;
