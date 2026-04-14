'use strict';

/**
 * Training Matrix vault writer.
 *
 * NEURO no longer reads NOVA's SQLite directly (daypilot.db lives on a different
 * host and the schedule now lives in n8n). Instead, n8n fetches training data
 * from NOVA (/api/public/training-export) and POSTs the payload to
 * /api/training/apply-matrix, which calls `applyMatrixToVault` below.
 *
 * Writes:
 *   - Documents/Training/Training Matrix.md (full overview)
 *   - Appends/updates "## Training" section in People/{Name}.md per user
 *
 * Expected payload shape:
 *   {
 *     categories: [{ id, name, sort_order }],
 *     items:      [{ id, category_id, section, name, tech_lead, max_score, sort_order }],
 *     scores:     [{ item_id, user_id, score, updated_at }],
 *     memberIds:  [userId, ...]                         // may be empty
 *     users:      [{ id, username, display_name, email, role }]
 *   }
 */

const fs = require('fs');
const path = require('path');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function indexUsers(users) {
  const byId = {};
  for (const u of users || []) {
    if (!u || u.id == null) continue;
    byId[u.id] = {
      id: u.id,
      username: u.username || '',
      displayName: u.display_name || u.username || `User ${u.id}`,
      email: u.email || '',
    };
  }
  return byId;
}

function buildScoreMap(scores) {
  const map = {};
  for (const s of scores || []) {
    if (!map[s.item_id]) map[s.item_id] = {};
    map[s.item_id][s.user_id] = s.score;
  }
  return map;
}

function buildMatrixMarkdown({ categories, items, scores, users, memberIds }) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    '---',
    'type: training-matrix',
    `date: ${date}`,
    'source: nova-training-export',
    '---',
    '',
    '# Training Matrix',
    `> Last synced: ${date}`,
    '',
  ];

  const includedUserIds = memberIds && memberIds.length
    ? memberIds
    : [...new Set((scores || []).map(s => s.user_id))];
  const userList = includedUserIds
    .map(id => users[id])
    .filter(Boolean)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  if (!userList.length) {
    lines.push('_No users found in memberIds or scores._');
    return lines.join('\n');
  }

  const scoreMap = buildScoreMap(scores);

  for (const cat of categories) {
    const catItems = (items || []).filter(i => i.category_id === cat.id);
    if (!catItems.length) continue;
    lines.push(`## ${cat.name}`, '');
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
  if (!vault) throw new Error('OBSIDIAN_VAULT_PATH not set');
  const dir = path.join(vault, 'Documents', 'Training');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'Training Matrix.md');
  fs.writeFileSync(out, content, 'utf-8');
  return 'Documents/Training/Training Matrix.md';
}

function buildPersonTrainingSection({ user, categories, items, scoreMap }) {
  const lines = ['## Training', `> Synced from NOVA on ${new Date().toISOString().slice(0, 10)}`, ''];
  let total = 0;
  let count = 0;
  for (const cat of categories) {
    const catItems = (items || []).filter(i => i.category_id === cat.id);
    const rows = [];
    for (const item of catItems) {
      const s = scoreMap[item.id]?.[user.id];
      if (s == null) continue;
      rows.push(`- ${item.section ? `**${item.section}** — ` : ''}${item.name}: **${s}/${item.max_score ?? 5}**`);
      total += s;
      count += 1;
    }
    if (rows.length) lines.push(`### ${cat.name}`, ...rows, '');
  }
  if (!count) return null;
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
 * Apply a training matrix payload to the vault.
 * @param {object} payload
 * @param {Array} payload.categories
 * @param {Array} payload.items
 * @param {Array} payload.scores
 * @param {Array<number>=} payload.memberIds
 * @param {Array} payload.users
 * @returns {{status:'updated'|'error', changes:string[], error?:string}}
 */
function applyMatrixToVault(payload) {
  if (!VAULT_PATH()) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not set' };
  if (!payload || typeof payload !== 'object') {
    return { status: 'error', error: 'payload must be an object' };
  }
  const { categories, items, scores, memberIds, users } = payload;
  if (!Array.isArray(categories) || !Array.isArray(items) || !Array.isArray(scores) || !Array.isArray(users)) {
    return { status: 'error', error: 'payload must include arrays: categories, items, scores, users' };
  }

  const usersById = indexUsers(users);
  if (!Object.keys(usersById).length) {
    return { status: 'error', error: 'no valid users in payload' };
  }
  const scoreMap = buildScoreMap(scores);

  const changes = [];

  const md = buildMatrixMarkdown({ categories, items, scores, users: usersById, memberIds });
  const matrixPath = writeMatrixFile(md);
  changes.push(`Wrote ${matrixPath}`);

  const targetIds = (memberIds && memberIds.length) ? memberIds : Object.keys(usersById).map(Number);
  let personUpdates = 0;
  let personSkips = 0;
  for (const uid of targetIds) {
    const user = usersById[uid];
    if (!user) continue;
    const section = buildPersonTrainingSection({ user, categories, items, scoreMap });
    if (!section) { personSkips += 1; continue; }
    const result = upsertPersonTrainingSection(user.displayName, section);
    if (result.updated) { personUpdates += 1; changes.push(`Updated ${result.path}`); }
    else if (result.skipped) personSkips += 1;
  }

  return {
    status: 'updated',
    changes,
    summary: {
      categoriesProcessed: categories.length,
      itemsProcessed: items.length,
      scoresProcessed: scores.length,
      usersTargeted: targetIds.length,
      personUpdates,
      personSkips,
    },
  };
}

module.exports = { applyMatrixToVault };
