'use strict';

/**
 * Training Matrix Sync — reads NOVA's daypilot.db + users.json and writes:
 *   - Documents/Training/Training Matrix.md (full matrix overview)
 *   - Appends/updates "## Training" section in People/{Name}.md per user
 *
 * NOVA DB is sql.js in-memory; we load it read-only from disk.
 * Users are in a sibling users.json (NOVA does not store them in SQLite).
 *
 * Schema (from NOVA schema.ts):
 *   training_categories(id, name, sort_order)
 *   training_items(id, category_id, section, name, tech_lead, max_score, sort_order)
 *   training_scores(id, item_id, user_id, score, updated_at)
 *   training_members(user_id, sort_order)   -- subset opted-in to matrix
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const NOVA_DB_PATH = () => process.env.NOVA_DB_PATH || '';
const NOVA_USERS_PATH = () => process.env.NOVA_USERS_PATH ||
  (NOVA_DB_PATH() ? path.join(path.dirname(NOVA_DB_PATH()), 'users.json') : '');
const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

let SQL = null;
async function getSqlJs() {
  if (SQL) return SQL;
  SQL = await initSqlJs({});
  return SQL;
}

function loadUsers() {
  const usersPath = NOVA_USERS_PATH();
  if (!usersPath || !fs.existsSync(usersPath)) return {};
  try {
    const raw = fs.readFileSync(usersPath, 'utf-8');
    const data = JSON.parse(raw);
    const users = Array.isArray(data) ? data : (data.users || []);
    const byId = {};
    for (const u of users) {
      if (!u?.id) continue;
      byId[u.id] = {
        id: u.id,
        username: u.username || '',
        displayName: u.displayName || u.name || u.username || `User ${u.id}`,
        email: u.email || '',
      };
    }
    return byId;
  } catch (e) {
    console.warn('[TrainingSync] Failed to load users.json:', e.message);
    return {};
  }
}

async function openDb() {
  const dbPath = NOVA_DB_PATH();
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`NOVA_DB_PATH not set or file missing: ${dbPath}`);
  }
  const sqlJs = await getSqlJs();
  const buf = fs.readFileSync(dbPath);
  return new sqlJs.Database(buf);
}

function queryAll(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const [{ columns, values }] = res;
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

async function loadMatrixData() {
  const db = await openDb();
  try {
    const categories = queryAll(db, 'SELECT id, name, sort_order FROM training_categories ORDER BY sort_order, name');
    const items = queryAll(db, 'SELECT id, category_id, section, name, tech_lead, max_score, sort_order FROM training_items ORDER BY sort_order, name');
    const scores = queryAll(db, 'SELECT item_id, user_id, score, updated_at FROM training_scores');
    let members = [];
    try { members = queryAll(db, 'SELECT user_id, sort_order FROM training_members ORDER BY sort_order'); }
    catch { members = []; }
    return { categories, items, scores, members };
  } finally {
    db.close();
  }
}

function buildMatrixMarkdown({ categories, items, scores, users, memberIds }) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    '---',
    'type: training-matrix',
    `date: ${date}`,
    'source: neuro-training-sync',
    '---',
    '',
    '# Training Matrix',
    `> Last synced: ${date}`,
    '',
  ];

  const includedUserIds = memberIds.length
    ? memberIds
    : [...new Set(scores.map(s => s.user_id))];
  const userList = includedUserIds
    .map(id => users[id])
    .filter(Boolean)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  if (!userList.length) {
    lines.push('_No users found in training_members or training_scores._');
    return lines.join('\n');
  }

  // Build score lookup: scores[itemId][userId] = score
  const scoreMap = {};
  for (const s of scores) {
    if (!scoreMap[s.item_id]) scoreMap[s.item_id] = {};
    scoreMap[s.item_id][s.user_id] = s.score;
  }

  for (const cat of categories) {
    const catItems = items.filter(i => i.category_id === cat.id);
    if (!catItems.length) continue;
    lines.push(`## ${cat.name}`, '');
    // Table header
    const header = ['Item', 'Max', ...userList.map(u => u.displayName)];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const item of catItems) {
      const prefix = item.section ? `**${item.section}** — ${item.name}` : item.name;
      const row = [prefix, String(item.max_score ?? 5)];
      for (const u of userList) {
        const s = scoreMap[item.id]?.[u.id];
        row.push(s != null ? String(s) : '–');
      }
      lines.push(`| ${row.join(' | ')} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function writeMatrixFile(content) {
  const vault = VAULT_PATH();
  const dir = path.join(vault, 'Documents', 'Training');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'Training Matrix.md');
  fs.writeFileSync(out, content, 'utf-8');
  return 'Documents/Training/Training Matrix.md';
}

function buildPersonTrainingSection({ user, categories, items, scoreMap }) {
  const lines = ['## Training', `> Synced from NOVA on ${new Date().toISOString().slice(0, 10)}`, ''];
  let total = 0, count = 0;
  for (const cat of categories) {
    const catItems = items.filter(i => i.category_id === cat.id);
    const rows = [];
    for (const item of catItems) {
      const s = scoreMap[item.id]?.[user.id];
      if (s == null) continue;
      rows.push(`- ${item.section ? `**${item.section}** — ` : ''}${item.name}: **${s}/${item.max_score ?? 5}**`);
      total += s;
      count += 1;
    }
    if (rows.length) {
      lines.push(`### ${cat.name}`, ...rows, '');
    }
  }
  if (!count) return null; // No scores — skip
  const avg = (total / count).toFixed(1);
  lines.splice(2, 0, `**Average:** ${avg} across ${count} items`, '');
  return lines.join('\n');
}

function upsertPersonTrainingSection(personName, sectionContent) {
  const vault = VAULT_PATH();
  const file = path.join(vault, 'People', `${personName}.md`);
  if (!fs.existsSync(file)) return { skipped: true, reason: `No People/${personName}.md` };

  const raw = fs.readFileSync(file, 'utf-8');
  const sectionRe = /(\n## Training\s*\n[\s\S]*?)(?=\n## |\n---\s*\n|$)/;

  let updated;
  if (sectionRe.test(raw)) {
    updated = raw.replace(sectionRe, '\n' + sectionContent);
  } else {
    // Insert before "## Notes" section if present, else append
    const notesIdx = raw.indexOf('\n## Notes');
    if (notesIdx >= 0) {
      updated = raw.substring(0, notesIdx) + '\n' + sectionContent + '\n' + raw.substring(notesIdx + 1);
    } else {
      updated = raw.replace(/\s*$/, '') + '\n\n' + sectionContent + '\n';
    }
  }

  fs.writeFileSync(file, updated, 'utf-8');
  return { updated: true, path: `People/${personName}.md` };
}

/**
 * Main sync entry.
 * @param {object} opts
 * @param {('sync_all'|'sync_person')} opts.action
 * @param {string=} opts.person  Required when action=sync_person
 */
async function syncTraining({ action = 'sync_all', person } = {}) {
  if (!VAULT_PATH()) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not set' };
  if (!NOVA_DB_PATH()) return { status: 'error', error: 'NOVA_DB_PATH not set (path to daypilot.db)' };

  let data;
  try {
    data = await loadMatrixData();
  } catch (e) {
    return { status: 'error', error: `Failed to load NOVA DB: ${e.message}` };
  }

  const users = loadUsers();
  if (!Object.keys(users).length) {
    return { status: 'error', error: `No users loaded from ${NOVA_USERS_PATH()}. Set NOVA_USERS_PATH if non-default.` };
  }

  const memberIds = data.members.map(m => m.user_id);
  const scoreMap = {};
  for (const s of data.scores) {
    if (!scoreMap[s.item_id]) scoreMap[s.item_id] = {};
    scoreMap[s.item_id][s.user_id] = s.score;
  }

  const changes = [];

  if (action === 'sync_all') {
    const md = buildMatrixMarkdown({ ...data, users, memberIds });
    const matrixPath = writeMatrixFile(md);
    changes.push(`Wrote ${matrixPath}`);

    // Also update every user's People note
    const targetIds = memberIds.length ? memberIds : Object.keys(users).map(Number);
    for (const uid of targetIds) {
      const user = users[uid];
      if (!user) continue;
      const section = buildPersonTrainingSection({ user, categories: data.categories, items: data.items, scoreMap });
      if (!section) continue;
      const result = upsertPersonTrainingSection(user.displayName, section);
      if (result.updated) changes.push(`Updated ${result.path}`);
    }
    return { status: 'updated', changes };
  }

  if (action === 'sync_person') {
    if (!person) return { status: 'error', error: 'person is required for sync_person' };
    const user = Object.values(users).find(u =>
      u.displayName === person || u.username === person
    );
    if (!user) return { status: 'error', error: `User not found in users.json: ${person}` };
    const section = buildPersonTrainingSection({ user, categories: data.categories, items: data.items, scoreMap });
    if (!section) return { status: 'error', error: `No training scores for ${person}` };
    const result = upsertPersonTrainingSection(user.displayName, section);
    if (result.skipped) return { status: 'error', error: result.reason };
    return { status: 'updated', changes: [`Updated ${result.path}`] };
  }

  return { status: 'error', error: `Unknown action: ${action}` };
}

module.exports = { syncTraining };
