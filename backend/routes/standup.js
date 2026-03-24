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
  try { require('../services/activity').trackVaultWrite('daily'); } catch {}
  try { require('../services/activity').trackStandupDone(new Date().getHours(), true); } catch {}
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

// GET /api/standup/carry-forward — incomplete items from yesterday's Focus Today
router.get('/carry-forward', (req, res) => {
  try {
    const prev = obsidianService.readPreviousDailyNote();
    if (!prev) return res.json({ date: null, items: [] });

    const lines = prev.content.split('\n');
    let inFocus = false;
    const items = [];
    for (const line of lines) {
      if (line.startsWith('## Focus Today') || line.startsWith('## Carry')) {
        inFocus = true;
        continue;
      }
      if (line.startsWith('## ') && inFocus) { inFocus = false; continue; }
      if (inFocus && line.match(/^\s*-\s+\[\s\]/) || inFocus && line.match(/^\s*-\s+\[>\]/)) {
        const text = line.replace(/^\s*-\s+\[.\]\s*/, '').replace(/#\w+/g, '').trim();
        if (text) items.push(text);
      }
    }
    res.json({ date: prev.date, items });
  } catch (e) {
    console.error('[Standup] Carry-forward error:', e);
    res.json({ date: null, items: [] });
  }
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
    try { require('../services/activity').trackVaultWrite('daily'); } catch {}
    try { require('../services/activity').trackStandupDone(new Date().getHours(), true); } catch {}
    console.log(`[Standup] Backup ritual saved to ${filePath}`);
    res.json({ success: true, path: filePath });
  } catch (e) {
    console.error('[Standup] Backup error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/standup/eod — save end-of-day reflection to daily note
router.post('/eod', (req, res) => {
  const { win, didntGo, feeling } = req.body;
  if (!win && !didntGo && !feeling) return res.status(400).json({ error: 'At least one field required' });
  const lines = [
    `\n## EOD — ${obsidianService.todayDateString()}`,
    win ? `\n**Win:** ${win}` : '',
    didntGo ? `\n**Didn't go to plan:** ${didntGo}` : '',
    feeling ? `\n**Feeling:** ${feeling}` : '',
    ''
  ].filter(l => l !== '');
  const filePath = obsidianService.appendToDailyNote(lines.join('\n'));
  nudges.markEodDone();
  try {
    const db = require('../db/database');
    const queue = db.getQueueSummary();
    require('../services/activity').trackQueueSnapshot(
      queue.at_risk_count || 0, queue.total || 0, queue.open_p1s || 0);
  } catch {}
  res.json({ success: true, path: filePath });
});

// GET /api/standup/ritual-history?days=7 — recent standups, EODs, and journals
router.get('/ritual-history', (req, res) => {
  const days = parseInt(req.query.days || '7', 10);
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  const fs = require('fs');
  const pathMod = require('path');
  const dailyDir = pathMod.join(vaultPath, 'Daily');
  const reflectionsDir = pathMod.join(vaultPath, 'Reflections');
  const entries = [];
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('en-GB', { weekday: 'short' });
    const entry = { date: dateStr, day: dayName, standup: null, eod: null, journal: null };

    // Check daily note for standup + EOD
    const dailyFile = pathMod.join(dailyDir, `${dateStr}.md`);
    if (fs.existsSync(dailyFile)) {
      const content = fs.readFileSync(dailyFile, 'utf-8');

      // Standup / Focus Today
      const focusMatch = content.match(/## (?:Focus Today|Standup)[^\n]*\n([\s\S]*?)(?=\n##|$)/);
      if (focusMatch) {
        const lines = focusMatch[1].trim().split('\n').filter(l => l.trim()).slice(0, 5);
        entry.standup = lines.join('\n');
      }

      // EOD
      const eodMatch = content.match(/## EOD[^\n]*\n([\s\S]*?)(?=\n##|$)/);
      if (eodMatch) {
        entry.eod = eodMatch[1].trim();
      }
    }

    // Check journal
    const journalFile = pathMod.join(reflectionsDir, `${dateStr}-journal.md`);
    if (fs.existsSync(journalFile)) {
      const jContent = fs.readFileSync(journalFile, 'utf-8');
      const body = jContent.replace(/^---[\s\S]*?---\n*/, '').trim();
      entry.journal = body.substring(0, 500);
    }

    if (entry.standup || entry.eod || entry.journal) {
      entries.push(entry);
    }
  }

  res.json({ entries });
});

// POST /api/standup/weekly-review — manually trigger weekly review generation
router.post('/weekly-review', (req, res) => {
  try {
    const result = obsidianService.generateWeeklyReview();
    if (!result) return res.status(500).json({ error: 'Vault not configured' });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/standup/daily-stats — today's productivity stats for EOD
router.get('/daily-stats', (req, res) => {
  try {
    const activity = require('../services/activity');
    const db = require('../db/database');
    const summary = activity.buildDailySummary(obsidianService.todayDateString());

    // Todos completed today
    const allTodos = db.getAllTodos();
    const todayStr = obsidianService.todayDateString();
    const completedToday = allTodos.filter(t =>
      t.done && t.completed_at && t.completed_at.startsWith(todayStr)
    ).length;

    // Do-next tasks completed today
    let doNextCompleted = 0;
    try {
      const doNextAll = db.getAllDoNext();
      doNextCompleted = doNextAll.filter(t =>
        t.done && t.completed_at && t.completed_at.startsWith(todayStr)
      ).length;
    } catch {}

    // Meetings attended (inferred from vault writes of type meeting-note)
    const meetingNotes = (summary.vault_write_types || {})['meeting-note'] || 0;
    const dailyWrites = (summary.vault_write_types || {})['daily'] || 0;

    // Calendar events today (count those that have passed)
    let meetingsAttended = 0;
    try {
      const calEvents = db.getCalendarEvents(todayStr + 'T00:00:00', todayStr + 'T23:59:59');
      const now = new Date();
      meetingsAttended = calEvents.filter(e =>
        e.show_as !== 'cancelled' && !e.is_all_day && new Date(e.end_time) < now
      ).length;
    } catch {}

    res.json({
      date: todayStr,
      todosCompleted: completedToday,
      doNextCompleted,
      captures: summary.captures_count || 0,
      captureTypes: summary.capture_types || {},
      chatMessages: summary.chat_count || 0,
      vaultWrites: summary.vault_writes || 0,
      meetingNotesWritten: meetingNotes,
      meetingsAttended,
      escalationsRaised: summary.escalations_raised || 0,
      escalationsResolved: summary.escalations_resolved || 0,
      importsRouted: summary.imports_routed || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/standup/today-status — live standup/EOD status from vault
router.get('/today-status', (req, res) => {
  const dailyNote = obsidianService.readTodayDailyNote();
  const dateStr = obsidianService.todayDateString();
  let eodDone = false, standupDone = false, eodContent = null;
  if (dailyNote) {
    standupDone = dailyNote.includes('## Standup') || dailyNote.includes('## Focus Today');
    const eodMatch = dailyNote.match(/## EOD[^\n]*\n([\s\S]*?)(?=\n##|$)/);
    if (eodMatch) { eodDone = true; eodContent = eodMatch[1].trim(); }
  }
  try {
    const db = require('../db/database');
    if (db.getState(`standup_done_${dateStr}`)) standupDone = true;
    if (db.getState(`eod_done_${dateStr}`)) eodDone = true;
  } catch {}
  res.json({ date: dateStr, standupDone, eodDone, eodContent });
});

// GET /api/standup/eod-history?days=14 — EOD entries from daily notes
router.get('/eod-history', (req, res) => {
  const days = parseInt(req.query.days || '14', 10);
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  const dailyDir = require('path').join(vaultPath, 'Daily');
  const fs = require('fs');
  const pathMod = require('path');
  if (!fs.existsSync(dailyDir)) return res.json({ entries: [] });
  const entries = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const filePath = pathMod.join(dailyDir, `${dateStr}.md`);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const eodMatch = content.match(/## EOD[^\n]*\n([\s\S]*?)(?=\n##|$)/);
    if (!eodMatch) continue;
    const eodText = eodMatch[1].trim();
    if (!eodText) continue;
    const winMatch = eodText.match(/\*\*Win:\*\*\s*(.+)/);
    const didntGoMatch = eodText.match(/\*\*Didn't go to plan:\*\*\s*(.+)/);
    const feelingMatch = eodText.match(/\*\*Feeling:\*\*\s*(.+)/);
    entries.push({
      date: dateStr,
      win: winMatch ? winMatch[1].trim() : null,
      didntGo: didntGoMatch ? didntGoMatch[1].trim() : null,
      feeling: feelingMatch ? feelingMatch[1].trim() : null,
    });
  }
  res.json({ entries });
});

// POST /api/standup/interactive — Claude-guided standup session
router.post('/interactive', async (req, res) => {
  const { messages = [], phase = 'start' } = req.body;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build context block
    const today = new Date();
    const todayStr = obsidianService.todayDateString();
    const dow = today.toLocaleDateString('en-GB', { weekday: 'long' });
    const isMonday = today.getDay() === 1;

    // Gather context
    let carryOvers = [];
    try {
      const prev = obsidianService.readPreviousDailyNote();
      if (prev) {
        const lines = prev.content.split('\n');
        let inFocus = false;
        for (const line of lines) {
          if (line.startsWith('## Focus Today') || line.startsWith('## Carry')) { inFocus = true; continue; }
          if (line.startsWith('## ') && inFocus) break;
          if (inFocus && (line.match(/^\s*-\s+\[\s\]/) || line.match(/^\s*-\s+\[>\]/))) {
            const text = line.replace(/^\s*-\s+\[.\]\s*/, '').replace(/#\w+/g, '').trim();
            if (text) carryOvers.push(text);
          }
        }
      }
    } catch {}

    let queueContext = '';
    try {
      const db = require('../db/database');
      const queue = db.getQueueSummary();
      if (queue.total > 0) {
        queueContext = `Queue: ${queue.total} open tickets, ${queue.at_risk_count} at risk, ${queue.open_p1s} P1s.`;
        if (queue.at_risk_tickets.length > 0) {
          queueContext += ` At risk: ${queue.at_risk_tickets.slice(0, 3).map(t => t.ticket_key + ' ' + t.summary).join('; ')}.`;
        }
      }
    } catch {}

    let planContext = '';
    try {
      const plan = obsidianService.parseNinetyDayPlan();
      if (plan) {
        planContext = `90-day plan: Day ${plan.currentDay} of ${plan.totalDays}. ${plan.totalDone}/${plan.totalTasks} tasks done.`;
        if (plan.todayTasks.length > 0) {
          planContext += ` Today's tasks: ${plan.todayTasks.map(t => t.text).join('; ')}.`;
        }
        if (plan.overdueTasks.length > 0) {
          planContext += ` ${plan.overdueTasks.length} overdue tasks.`;
        }
      }
    } catch {}

    let calendarContext = '';
    try {
      const events = await obsidianService.fetchCalendarEvents(todayStr, todayStr);
      if (events && events.length > 0) {
        const upcoming = events.filter(e => e.showAs !== 'cancelled');
        if (upcoming.length > 0) {
          calendarContext = `Today's calendar: ${upcoming.map(e => {
            const time = e.start ? e.start.substring(11, 16) : '';
            return time ? `${time} ${e.subject}` : e.subject;
          }).join(', ')}.`;
        }
      }
    } catch {}

    // System prompt for the guided standup
    const systemPrompt = `You are NEURO running Nick's morning standup ritual. Nick is Head of Technical Support at Nurtur Limited.

Your job: guide Nick through a focused standup in 3-4 short exchanges, then write his daily note.

TODAY: ${dow} ${todayStr}${isMonday ? ' (Monday — ask about the week ahead, not just today)' : ''}

CONTEXT:
${queueContext || 'Queue data unavailable.'}
${planContext || ''}
${calendarContext || ''}
${carryOvers.length > 0 ? `Carry-overs from yesterday: ${carryOvers.join('; ')}` : 'No carry-overs.'}

STANDUP FLOW — follow this exactly:

Phase 1 (start): Give a brief, sharp morning brief (2-3 lines max — queue status, any at-risk, one key thing from the plan). Then ask ONE question: "What's your main focus today?"

Phase 2 (after focus answer): Ask: "Any blockers or things that need escalating?"

Phase 3 (after blockers answer): ${isMonday ? 'Ask: "How are you going into the week — anything to flag energy or capacity-wise?"' : 'Ask: "Anything else before I write this up?"'}

Phase 4 (finalise): Say "Writing your daily note now..." then output the daily note in this EXACT format between the markers:

===DAILY_NOTE_START===
---
type: daily
date: ${todayStr}
---
# Daily Note — ${dow} ${todayStr}

## Focus Today
[checkbox list of focus items Nick mentioned, each as: - [ ] item text]

## Carry-Overs
${carryOvers.length > 0 ? carryOvers.map(c => `- [ ] ${c}`).join('\n') : '- None'}

## Blockers
[blockers Nick mentioned, or: - None]

## Queue Watch
${queueContext || '- No queue data'}

## Notes
[any other notes from the conversation]
===DAILY_NOTE_END===

Then end with one short line — something brief and human. No fluff.

RULES:
- One question at a time. Never ask two things in one message.
- Keep your messages short — 3 lines max except the daily note.
- Don't repeat what Nick just said back to him.
- Don't add unnecessary affirmations ("Great!", "Perfect!").
- The daily note markers must appear EXACTLY as shown — the app parses them.
- After writing the daily note, do not ask any more questions.`;

    // Build message history
    const claudeMessages = messages.map(m => ({ role: m.role, content: m.content }));

    // If starting, add the trigger
    if (phase === 'start' || claudeMessages.length === 0) {
      claudeMessages.push({ role: 'user', content: 'Start my standup.' });
    }

    let fullResponse = '';
    let usedOllama = false;

    // Try Ollama streaming first
    try {
      const ollamaMessages = [
        { role: 'system', content: systemPrompt },
        ...claudeMessages
      ];

      const ollamaRes = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
          messages: ollamaMessages,
          stream: true,
          options: { temperature: 0.7, num_ctx: 2048, num_predict: 512 }
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (!ollamaRes.ok) throw new Error(`Ollama ${ollamaRes.status}`);

      usedOllama = true;
      const reader = ollamaRes.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n').filter(l => l.trim())) {
          try {
            const data = JSON.parse(line);
            if (data.message?.content) {
              fullResponse += data.message.content;
              res.write(`data: ${JSON.stringify({ type: 'text', content: data.message.content })}\n\n`);
            }
          } catch {}
        }
      }

      console.log('[Standup] Response via Ollama');
    } catch (ollamaErr) {
      console.warn('[Standup] Ollama failed, falling back to Claude:', ollamaErr.message);
    }

    // Claude fallback — full streaming
    if (!usedOllama) {
      const stream = client.messages.stream({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: claudeMessages
      });

      stream.on('text', (text) => {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      });

      stream.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
        res.end();
      });

      res.on('close', () => stream.abort());

      await new Promise((resolve) => stream.on('end', resolve));
    }

    // Check if daily note is present in the response
    const noteMatch = fullResponse.match(/===DAILY_NOTE_START===\n([\s\S]*?)\n===DAILY_NOTE_END===/);
    if (noteMatch) {
      try {
        const noteContent = noteMatch[1].trim();
        obsidianService.writeTodayDailyNote(noteContent);
        nudges.markStandupDone();
        console.log(`[Standup] Interactive standup complete — daily note written (via ${usedOllama ? 'Ollama' : 'Claude'})`);
        try { require('../services/activity').trackStandupDone(new Date().getHours(), true); } catch {}
        try { require('../services/activity').trackVaultWrite('daily'); } catch {}
        res.write(`data: ${JSON.stringify({ type: 'done', noteSaved: true })}\n\n`);
      } catch (e) {
        console.error('[Standup] Failed to write daily note:', e.message);
        res.write(`data: ${JSON.stringify({ type: 'done', noteSaved: false, noteError: e.message })}\n\n`);
      }
    } else {
      res.write(`data: ${JSON.stringify({ type: 'done', noteSaved: false })}\n\n`);
    }

    res.end();
  } catch (err) {
    console.error('[Standup] Interactive error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    res.end();
  }
});

module.exports = router;
