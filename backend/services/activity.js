'use strict';

const db = require('../db/database');

// ── Event logging ──────────────────────────────────────────────────────────

function trackTabOpen(tabName) {
  db.logActivity('tab_open', { tab: tabName });
}

function trackStandupDone(hour) {
  db.logActivity('standup_done', { hour });
}

function trackNudgeSnooze(nudgeType) {
  db.logActivity('nudge_snoozed', { type: nudgeType });
}

function trackCapture(captureType) {
  db.logActivity('capture', { type: captureType });
}

function trackChatMessage(messageText) {
  // Extract keywords only — do not store message content
  const topics = extractTopics(messageText);
  if (topics.length > 0) {
    db.logActivity('chat_message', { topics });
  }
}

function trackEodDone() {
  db.logActivity('eod_done', {});
}

// Extract meaningful topic keywords from a chat message
// Mirrors extractSearchTerms in claude.js — same stop word list
function extractTopics(message) {
  const STOP_WORDS = new Set([
    'what', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'was', 'were',
    'did', 'do', 'does', 'can', 'could', 'would', 'should', 'have', 'has',
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'my', 'me', 'i', 'you', 'we', 'it', 'this', 'that', 'about',
    'tell', 'show', 'find', 'get', 'give', 'help', 'please', 'need', 'want',
    'know', 'think', 'look', 'see', 'any', 'some', 'all', 'from', 'into',
    'just', 'then', 'than', 'they', 'them', 'been', 'will', 'more', 'also',
    'neuro', 'nick', 'today', 'week', 'day', 'time', 'work', 'make', 'like'
  ]);

  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 5);
}

// ── Nightly rollup ─────────────────────────────────────────────────────────

// Build daily summary from activity log for a given date
function buildDailySummary(dateKey) {
  const events = db.getActivityForDate(dateKey);

  const summary = {
    date: dateKey,
    standup_done: false,
    standup_hour: null,
    standup_snooze_count: 0,
    todo_snooze_count: 0,
    eod_done: false,
    captures_count: 0,
    chat_count: 0,
    chat_topics: [],
    tabs_opened: {}
  };

  const topicFreq = {};

  for (const event of events) {
    let data = {};
    try { data = JSON.parse(event.event_data || '{}'); } catch {}

    switch (event.event_type) {
      case 'standup_done':
        summary.standup_done = true;
        summary.standup_hour = data.hour || event.hour;
        break;
      case 'nudge_snoozed':
        if (data.type === 'standup') summary.standup_snooze_count++;
        else if (data.type === 'todo') summary.todo_snooze_count++;
        break;
      case 'capture':
        summary.captures_count++;
        break;
      case 'chat_message':
        summary.chat_count++;
        for (const topic of (data.topics || [])) {
          topicFreq[topic] = (topicFreq[topic] || 0) + 1;
        }
        break;
      case 'eod_done':
        summary.eod_done = true;
        break;
      case 'tab_open':
        if (data.tab) {
          summary.tabs_opened[data.tab] = (summary.tabs_opened[data.tab] || 0) + 1;
        }
        break;
    }
  }

  // Top 5 topics by frequency
  summary.chat_topics = Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);

  return summary;
}

// Run the nightly rollup — builds summary for yesterday
function runNightlyRollup() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateKey = yesterday.toISOString().split('T')[0];

  console.log(`[Activity] Running nightly rollup for ${dateKey}`);
  const summary = buildDailySummary(dateKey);
  db.saveDailySummary(dateKey, summary);
  console.log(`[Activity] Summary saved: standup=${summary.standup_done}, snoozes=${summary.standup_snooze_count + summary.todo_snooze_count}, chats=${summary.chat_count}`);
  return summary;
}

// Get a human-readable patterns block for Claude context injection
function getPatternsContextBlock(daysBack = 7) {
  const summaries = db.getDailySummaries(daysBack);
  if (summaries.length === 0) return null;

  // Also include today's live activity (not yet summarised)
  const todayKey = new Date().toISOString().split('T')[0];
  const todayLive = buildDailySummary(todayKey);

  const lines = [];

  // Today's live summary first
  const todayParts = [];
  if (todayLive.standup_done) {
    todayParts.push(`standup done at ${todayLive.standup_hour}:00`);
  } else {
    todayParts.push('standup NOT done');
  }
  if (todayLive.standup_snooze_count > 0) todayParts.push(`standup snoozed ${todayLive.standup_snooze_count}x`);
  if (todayLive.todo_snooze_count > 0) todayParts.push(`todo snoozed ${todayLive.todo_snooze_count}x`);
  if (todayLive.captures_count > 0) todayParts.push(`${todayLive.captures_count} capture${todayLive.captures_count !== 1 ? 's' : ''}`);
  if (todayLive.chat_count > 0) todayParts.push(`${todayLive.chat_count} chat messages`);
  if (todayLive.eod_done) todayParts.push('EOD done');
  if (Object.keys(todayLive.tabs_opened).length > 0) {
    const tabs = Object.entries(todayLive.tabs_opened)
      .sort((a, b) => b[1] - a[1])
      .map(([tab, count]) => `${tab}(${count})`)
      .join(', ');
    todayParts.push(`tabs: ${tabs}`);
  }
  lines.push(`Today (${todayKey}): ${todayParts.join(', ') || 'no activity logged yet'}`);

  // Past days
  for (const row of summaries.slice(0, 6)) {
    if (row.date_key === todayKey) continue; // already covered above
    const parts = [];
    if (row.standup_done) {
      parts.push(`standup ${row.standup_hour !== null ? row.standup_hour + ':00' : 'done'}`);
    } else {
      parts.push('standup SKIPPED');
    }
    if ((row.standup_snooze_count || 0) > 0) parts.push(`snoozed standup ${row.standup_snooze_count}x`);
    if ((row.todo_snooze_count || 0) > 0) parts.push(`snoozed todos ${row.todo_snooze_count}x`);
    if ((row.captures_count || 0) > 0) parts.push(`${row.captures_count} captures`);
    if ((row.chat_count || 0) > 0) parts.push(`${row.chat_count} chats`);
    if (row.eod_done) parts.push('EOD ✓');

    let topicsStr = '';
    try {
      const topics = JSON.parse(row.chat_topics || '[]');
      if (topics.length > 0) topicsStr = ` [topics: ${topics.join(', ')}]`;
    } catch {}

    lines.push(`${row.date_key}: ${parts.join(', ')}${topicsStr}`);
  }

  return `## Your Recent Patterns (last ${daysBack} days)\n${lines.join('\n')}`;
}

module.exports = {
  trackTabOpen,
  trackStandupDone,
  trackNudgeSnooze,
  trackCapture,
  trackChatMessage,
  trackEodDone,
  buildDailySummary,
  runNightlyRollup,
  getPatternsContextBlock
};
