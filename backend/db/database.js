const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'agent.db');

let db = null;

async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Run migrations
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.run(schema);
  save();
  console.log('[DB] Initialized');
}

function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getDb() {
  if (!db) throw new Error('Database not initialized — call init() first');
  return db;
}

// Conversation helpers
function saveMessage(conversationId, role, content) {
  getDb().run(
    'INSERT INTO conversations (conversation_id, role, content) VALUES (?, ?, ?)',
    [conversationId, role, content]
  );
  save();
}

function getConversationHistory(conversationId, limit = 20) {
  const stmt = getDb().prepare(
    `SELECT role, content, created_at FROM conversations
     WHERE conversation_id = ?
     ORDER BY created_at DESC LIMIT ?`
  );
  stmt.bind([conversationId, limit]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows.reverse();
}

// Jira cache helpers
function upsertTicket(ticket) {
  getDb().run(`
    INSERT OR REPLACE INTO jira_tickets_cache
      (ticket_key, summary, status, priority, assignee, sla_remaining_minutes, sla_name, at_risk, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    ticket.ticket_key,
    ticket.summary,
    ticket.status,
    ticket.priority,
    ticket.assignee,
    ticket.sla_remaining_minutes,
    ticket.sla_name,
    ticket.at_risk ? 1 : 0,
    ticket.raw_json || null
  ]);
  save();
}

function clearStaleTickets() {
  getDb().run('DELETE FROM jira_tickets_cache');
  save();
}

function getAllTickets() {
  const stmt = getDb().prepare(
    'SELECT * FROM jira_tickets_cache ORDER BY sla_remaining_minutes ASC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getAtRiskTickets() {
  const stmt = getDb().prepare(
    'SELECT * FROM jira_tickets_cache WHERE at_risk = 1 ORDER BY sla_remaining_minutes ASC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getQueueSummary() {
  const all = getAllTickets();
  const atRisk = all.filter(t => t.at_risk);
  const p1 = all.filter(t => {
    const p = (t.priority || '').toLowerCase();
    return p.includes('highest') || p === 'p1' || p === 'critical';
  });
  return {
    total: all.length,
    at_risk_count: atRisk.length,
    open_p1s: p1.length,
    at_risk_tickets: atRisk,
    tickets: all
  };
}

// Decision helpers
function saveDecision(conversationId, decisionText) {
  getDb().run(
    'INSERT INTO decisions (conversation_id, decision_text) VALUES (?, ?)',
    [conversationId, decisionText]
  );
  save();
}

// Agent state helpers
function setState(key, value) {
  getDb().run(
    `INSERT OR REPLACE INTO agent_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))`,
    [key, value]
  );
  save();
}

function getState(key) {
  const stmt = getDb().prepare('SELECT value FROM agent_state WHERE key = ?');
  stmt.bind([key]);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject().value;
  }
  stmt.free();
  return result;
}

// Nudge helpers
function createNudge(type, message, dateKey) {
  getDb().run(
    'INSERT INTO nudges (type, message, date_key) VALUES (?, ?, ?)',
    [type, message, dateKey]
  );
  save();
}

function getActiveNudges() {
  const stmt = getDb().prepare(
    'SELECT * FROM nudges WHERE active = 1 ORDER BY created_at DESC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getActiveNudgeByTypeAndDate(type, dateKey) {
  const stmt = getDb().prepare(
    'SELECT * FROM nudges WHERE type = ? AND date_key = ? AND active = 1'
  );
  stmt.bind([type, dateKey]);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

function completeNudge(id) {
  getDb().run(
    "UPDATE nudges SET active = 0, completed_at = datetime('now') WHERE id = ?",
    [id]
  );
  save();
}

function completeNudgeByType(type, dateKey) {
  getDb().run(
    "UPDATE nudges SET active = 0, completed_at = datetime('now') WHERE type = ? AND date_key = ? AND active = 1",
    [type, dateKey]
  );
  save();
}

function incrementNagCount(id) {
  getDb().run(
    'UPDATE nudges SET nag_count = nag_count + 1 WHERE id = ?',
    [id]
  );
  save();
}

// Todo helpers
function createTodo(text, priority, dueDate, source, msId) {
  getDb().run(
    'INSERT INTO todos (text, priority, due_date, source, ms_id) VALUES (?, ?, ?, ?, ?)',
    [text, priority || 'normal', dueDate || null, source || null, msId || null]
  );
  save();
}

function clearMsTodos() {
  getDb().run("DELETE FROM todos WHERE source LIKE 'MS %'");
  save();
}

function getActiveTodos() {
  const stmt = getDb().prepare(
    "SELECT * FROM todos WHERE done = 0 ORDER BY due_date ASC NULLS LAST, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END, created_at ASC"
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getAllTodos() {
  const stmt = getDb().prepare(
    'SELECT * FROM todos ORDER BY done ASC, created_at DESC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function completeTodo(id) {
  getDb().run(
    "UPDATE todos SET done = 1, completed_at = datetime('now') WHERE id = ?",
    [id]
  );
  save();
}

function deleteTodo(id) {
  getDb().run('DELETE FROM todos WHERE id = ?', [id]);
  save();
}

// Calendar cache helpers
function upsertCalendarEvent(event) {
  getDb().run(`
    INSERT OR REPLACE INTO calendar_cache
      (event_id, subject, start_time, end_time, is_all_day, location, organizer, show_as, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    event.id, event.subject, event.start, event.end,
    event.isAllDay ? 1 : 0, event.location, event.organizer, event.showAs
  ]);
  save();
}

function clearCalendarCache() {
  getDb().run('DELETE FROM calendar_cache');
  save();
}

function getCalendarEvents(startDate, endDate) {
  const stmt = getDb().prepare(
    'SELECT * FROM calendar_cache WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC'
  );
  stmt.bind([startDate, endDate]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Push subscription helpers
function savePushSubscription(subscription) {
  getDb().run(`
    INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
    VALUES (?, ?, ?)
  `, [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);
  save();
}

function getAllPushSubscriptions() {
  const stmt = getDb().prepare('SELECT * FROM push_subscriptions');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function removePushSubscription(endpoint) {
  getDb().run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  save();
}

module.exports = {
  init,
  getDb,
  saveMessage,
  getConversationHistory,
  upsertTicket,
  clearStaleTickets,
  getAllTickets,
  getAtRiskTickets,
  getQueueSummary,
  saveDecision,
  setState,
  getState,
  createNudge,
  getActiveNudges,
  getActiveNudgeByTypeAndDate,
  completeNudge,
  completeNudgeByType,
  incrementNagCount,
  createTodo,
  clearMsTodos,
  getActiveTodos,
  getAllTodos,
  completeTodo,
  deleteTodo,
  upsertCalendarEvent,
  clearCalendarCache,
  getCalendarEvents,
  savePushSubscription,
  getAllPushSubscriptions,
  removePushSubscription
};
