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

// GET /api/standup/ritual-state — checks if standup is done today from vault
router.get('/ritual-state', (req, res) => {
  const dailyNote = obsidianService.readTodayDailyNote();

  let standupDoneToday = false;

  if (dailyNote) {
    // Check for populated Focus Today section
    if (dailyNote.includes('## Focus Today')) {
      const lines = dailyNote.split('\n');
      let inFocus = false;
      for (const line of lines) {
        if (line.startsWith('## Focus Today')) { inFocus = true; continue; }
        if (line.startsWith('## ') && inFocus) break;
        if (inFocus && line.match(/^\s*-\s+\[.\]/)) { standupDoneToday = true; break; }
      }
    }
    // Also accept explicit Standup section
    if (dailyNote.includes('## Standup')) standupDoneToday = true;
  }

  res.json({
    lastRun: null,
    lastRitual: null,
    standupDoneToday
  });
});

// POST /api/standup/backup — creates a lightweight Ritual 5 daily note
router.post('/backup', (req, res) => {
  try {
    const { focusItems } = req.body;
    if (!focusItems || !Array.isArray(focusItems) || focusItems.length === 0) {
      return res.status(400).json({ error: 'focusItems array required (max 3)' });
    }

    const items = focusItems.slice(0, 3);
    const today = obsidianService.todayDateString();
    const d = new Date();
    const dayName = d.toLocaleDateString('en-GB', { weekday: 'long' });
    const dayNum = d.getDate();
    const monthName = d.toLocaleDateString('en-GB', { month: 'long' });
    const year = d.getFullYear();
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;

    const jan1 = new Date(year, 0, 1);
    const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    const weekStr = `${year}-W${String(weekNum).padStart(2, '0')}`;

    const framing = isWeekend
      ? `${dayName}. Light day.`
      : `Missed the standup — catching up via NEURO backup.`;

    const focusSection = items.map(item => `- [ ] ${item} #accepted`).join('\n');

    let carrySection = '';
    const prev = obsidianService.readPreviousDailyNote();
    if (prev) {
      const lines = prev.content.split('\n');
      let inCarry = false;
      const carries = [];
      for (const line of lines) {
        if (line.startsWith('## Carry') || line.startsWith('## Focus Today')) {
          inCarry = true;
          continue;
        }
        if (line.startsWith('## ') && inCarry) break;
        if (inCarry && line.match(/^\s*-\s+\[\s\]/)) {
          carries.push(line.trim());
        }
      }
      if (carries.length > 0) {
        carrySection = carries.join('\n');
      }
    }

    const content = `---
type: daily
date: ${today}
week: ${weekStr}
---
# Daily Note — ${isWeekend ? 'Weekend' : 'Backup'} — ${dayName} ${dayNum} ${monthName} ${year}

> ${framing}

## Focus Today
${focusSection}

## Carry-Overs
${carrySection || '- None'}

## On the Radar
-

## Notes / Ideas
-
`;

    const filePath = obsidianService.writeTodayDailyNote(content);
    nudges.markStandupDone();
    console.log(`[Standup] Backup ritual saved to ${filePath}`);
    res.json({ success: true, path: filePath });
  } catch (e) {
    console.error('[Standup] Backup error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
