const express = require('express');
const router = express.Router();
const claude = require('../services/claude');
const db = require('../db/database');

// POST /api/chat — SSE streaming response via Claude API
router.post('/', (req, res) => {
  const { message, conversationId, location } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  const convId = conversationId || `conv_${Date.now()}`;
  // Attended = Nick's own chat window: a PIN caller that is not a machine
  // (the authority guard sets req.apiClient for the API token AND any declared
  // X-Neuro-Machine-Client). Only then may chat show one-click actions.
  claude.streamChat(convId, message, res, location || null, { attended: !req.apiClient });
});

// POST /api/chat/sync — non-streaming chat (works through reverse proxies)
router.post('/sync', async (req, res) => {
  console.log('[Chat/Sync] Request received');
  const { message, conversationId, location } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  const convId = conversationId || `conv_${Date.now()}`;

  try {
    console.log('[Chat/Sync] Calling syncChat...');
    const response = await claude.syncChat(convId, message, location || null);
    console.log('[Chat/Sync] Response ready, sending JSON');
    res.json(response);
  } catch (e) {
    console.error('[Chat/Sync] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
  const rows = db.getDb().prepare(
    'SELECT id, conversation_id, decision_text, created_at FROM decisions ORDER BY created_at DESC LIMIT 50'
  ).all();
  res.json({ decisions: rows });
});

module.exports = router;
