const express = require('express');
const router = express.Router();
const obsidianService = require('../services/obsidian');
const nudges = require('../services/nudges');

// GET /api/standup
router.get('/', (req, res) => {
  const content = obsidianService.readStandup();
  res.json({ content });
});

// POST /api/standup
router.post('/', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content is required' });
  const filePath = obsidianService.writeStandup(content);
  res.json({ success: true, path: filePath });
});

// POST /api/standup/save-to-daily — saves standup to today's daily note
router.post('/save-to-daily', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const header = `\n## Standup — ${obsidianService.todayDateString()}\n`;
  const filePath = obsidianService.appendToDailyNote(header + content);
  nudges.markStandupDone();
  res.json({ success: true, path: filePath });
});

module.exports = router;
