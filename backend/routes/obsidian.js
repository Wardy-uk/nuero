const express = require('express');
const router = express.Router();
const obsidianService = require('../services/obsidian');

// GET /api/obsidian/status
router.get('/status', (req, res) => {
  res.json({ configured: obsidianService.isConfigured() });
});

// GET /api/obsidian/daily
router.get('/daily', (req, res) => {
  const content = obsidianService.readTodayDailyNote();
  res.json({ date: obsidianService.todayDateString(), content });
});

// POST /api/obsidian/daily
router.post('/daily', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content is required' });
  const filePath = obsidianService.writeTodayDailyNote(content);
  res.json({ success: true, path: filePath });
});

// POST /api/obsidian/daily/append
router.post('/daily/append', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const filePath = obsidianService.appendToDailyNote(content);
  res.json({ success: true, path: filePath });
});

// GET /api/obsidian/people
router.get('/people', (req, res) => {
  const names = obsidianService.listPeopleNotes();
  res.json({ people: names });
});

// GET /api/obsidian/people/:name
router.get('/people/:name', (req, res) => {
  const content = obsidianService.readPersonNote(req.params.name);
  if (content === null) {
    return res.json({ name: req.params.name, exists: false, content: null, frontmatter: {}, tags: [] });
  }
  const frontmatter = obsidianService.parseFrontmatter(content);
  const tags = obsidianService.extractTags(content);
  res.json({ name: req.params.name, exists: true, content, frontmatter, tags });
});

module.exports = router;
