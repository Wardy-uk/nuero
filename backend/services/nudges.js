const db = require('../db/database');
const obsidian = require('./obsidian');
const webpush = require('./webpush');

// SSE clients listening for nudges
const clients = new Set();

// Snooze tracking — in-memory, resets on restart
const snoozedUntil = {}; // { 'standup': timestamp, 'todo': timestamp }
const SNOOZE_DURATION = 30 * 60 * 1000; // 30 minutes

function snoozeNudge(type) {
  snoozedUntil[type] = Date.now() + SNOOZE_DURATION;
  console.log(`[Nudge] ${type} snoozed for 30 minutes`);
  broadcast({ type: 'nudge_snoozed', nudge_type: type, until: snoozedUntil[type] });
}

function isSnoozed(type) {
  return snoozedUntil[type] && Date.now() < snoozedUntil[type];
}

function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

// Nudge messages escalate with nag count
const STANDUP_MESSAGES = [
  "It's 9am. Time to do your standup. What did you do yesterday, what's the plan today, and what's blocking you?",
  "Standup still not done. Open the Standup tab and get it written — it takes 3 minutes.",
  "Nick. Standup. Now. Your team needs to know where you're at. Stop avoiding it.",
  "This is the fourth time I've asked. What's the actual blocker here? Open standup and write three bullet points.",
  "Still no standup. I'm going to keep asking. You know the drill — visibility is phase 1."
];

const TODO_MESSAGES = [
  "You have overdue todos that need attention. Check your todo list and knock something off.",
  "Todos are still sitting there. Pick one, do it, tick it off.",
  "Your todo list isn't getting shorter by itself. What's the actual blocker on the top item?",
  "Still have outstanding todos. This is the avoidance pattern — you know what to do.",
  "Todos. Still open. Let's go."
];

function getNagMessage(type, nagCount) {
  const messages = type === 'standup' ? STANDUP_MESSAGES : TODO_MESSAGES;
  const idx = Math.min(nagCount, messages.length - 1);
  return messages[idx];
}

// Check if standup/daily ritual has been done today
// The ritual may happen in Obsidian directly — check if today's note exists and has real content
function isStandupDone() {
  const dailyNote = obsidian.readTodayDailyNote();
  if (!dailyNote) return false;

  // Check for a populated Focus Today section (has actual task items, not just the heading)
  if (dailyNote.includes('## Focus Today')) {
    const lines = dailyNote.split('\n');
    let inFocus = false;
    for (const line of lines) {
      if (line.startsWith('## Focus Today')) { inFocus = true; continue; }
      if (line.startsWith('## ') && inFocus) break;
      // If there's at least one checkbox item, the ritual is done
      if (inFocus && line.match(/^\s*-\s+\[.\]/)) return true;
    }
  }

  // Also accept explicit ## Standup section (added by the app)
  if (dailyNote.includes('## Standup')) return true;

  return false;
}

// Check if there are overdue/pending todos (from vault)
function hasPendingTodos() {
  try {
    const { active } = obsidian.parseVaultTodos();
    const today = new Date(new Date().toDateString());
    const overdue = active.filter(t => t.due_date && new Date(t.due_date) <= today);
    return overdue.length > 0;
  } catch (e) {
    return false;
  }
}

// Called by cron — creates the initial nudge at 9am
function triggerStandupNudge() {
  const dateKey = todayKey();
  const existing = db.getActiveNudgeByTypeAndDate('standup', dateKey);

  if (existing) {
    // Already nudging — don't create a new one
    return;
  }

  if (isStandupDone()) {
    return; // Already done today
  }

  const msg = STANDUP_MESSAGES[0];
  db.createNudge('standup', msg, dateKey);
  console.log('[Nudge] Standup nudge created for', dateKey);
  broadcast({ type: 'nudge', nudge_type: 'standup', message: msg, nag_count: 0 });
  webpush.sendToAll('NEURO — Standup', msg, { type: 'standup', url: '/standup' }).catch(() => {});
}

function triggerTodoNudge() {
  const dateKey = todayKey();
  const existing = db.getActiveNudgeByTypeAndDate('todo', dateKey);

  if (existing) return;
  if (!hasPendingTodos()) return;

  const msg = TODO_MESSAGES[0];
  db.createNudge('todo', msg, dateKey);
  console.log('[Nudge] Todo nudge created for', dateKey);
  broadcast({ type: 'nudge', nudge_type: 'todo', message: msg, nag_count: 0 });
  webpush.sendToAll('NEURO — Todos', msg, { type: 'todo', url: '/todos' }).catch(() => {});
}

// Called every 15 min — escalates existing nudges
function nagCheck() {
  const nudges = db.getActiveNudges();

  for (const nudge of nudges) {
    // Check if standup was completed since last check
    if (nudge.type === 'standup' && isStandupDone()) {
      db.completeNudge(nudge.id);
      broadcast({ type: 'nudge_cleared', nudge_type: 'standup' });
      console.log('[Nudge] Standup completed — nudge cleared');
      continue;
    }

    // Check if all overdue todos are done
    if (nudge.type === 'todo' && !hasPendingTodos()) {
      db.completeNudge(nudge.id);
      broadcast({ type: 'nudge_cleared', nudge_type: 'todo' });
      console.log('[Nudge] No overdue todos — nudge cleared');
      continue;
    }

    // Skip escalation if snoozed
    if (isSnoozed(nudge.type)) {
      continue;
    }

    // Escalate
    const newCount = (nudge.nag_count || 0) + 1;
    db.incrementNagCount(nudge.id);
    const msg = getNagMessage(nudge.type, newCount);
    console.log(`[Nudge] Nag #${newCount} for ${nudge.type}: ${msg}`);
    broadcast({ type: 'nudge', nudge_type: nudge.type, message: msg, nag_count: newCount });
    const title = nudge.type === 'standup' ? 'NEURO — Standup' : 'NEURO — Todos';
    const url = nudge.type === 'standup' ? '/standup' : '/todos';
    webpush.sendToAll(title, msg, { type: nudge.type, url }).catch(() => {});
  }
}

// Called on startup — fires nudges if server starts after 9am on a weekday
function startupCheck() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const hour = now.getHours();

  // Only on weekdays, after 9am, before 5pm
  if (day >= 1 && day <= 5 && hour >= 9 && hour < 17) {
    console.log('[Nudge] Startup check — after 9am on weekday, triggering nudges');
    triggerStandupNudge();
    triggerTodoNudge();
  }
}

// Mark standup as done (called when user saves standup to daily note)
function markStandupDone() {
  db.completeNudgeByType('standup', todayKey());
  broadcast({ type: 'nudge_cleared', nudge_type: 'standup' });
}

module.exports = {
  addClient,
  broadcast,
  triggerStandupNudge,
  triggerTodoNudge,
  nagCheck,
  markStandupDone,
  startupCheck,
  snoozeNudge
};
