const fs = require('fs');
const path = require('path');

function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function isConfigured() {
  const vaultPath = getVaultPath();
  return vaultPath && fs.existsSync(vaultPath);
}

function todayDateString() {
  const d = new Date();
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Daily notes
function readTodayDailyNote() {
  const notePath = path.join(getVaultPath(), 'Daily notes', `${todayDateString()}.md`);
  if (!fs.existsSync(notePath)) return null;
  return fs.readFileSync(notePath, 'utf-8');
}

function writeTodayDailyNote(content) {
  const dir = path.join(getVaultPath(), 'Daily notes');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const notePath = path.join(dir, `${todayDateString()}.md`);
  fs.writeFileSync(notePath, content, 'utf-8');
  return notePath;
}

function appendToDailyNote(content) {
  const dir = path.join(getVaultPath(), 'Daily notes');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const notePath = path.join(dir, `${todayDateString()}.md`);
  const existing = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf-8') : '';
  fs.writeFileSync(notePath, existing + '\n' + content, 'utf-8');
  return notePath;
}

// Standup
function readStandup() {
  const vaultPath = getVaultPath();
  // Check multiple possible locations
  const candidates = [
    path.join(vaultPath, 'STANDUP.md'),
    path.join(vaultPath, 'Templates', 'STANDUP.md'),
    path.join(vaultPath, 'Standup.md'),
    path.join(vaultPath, 'Templates', 'Standup.md')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }
  return null;
}

function writeStandup(content) {
  const vaultPath = getVaultPath();
  // Write to first found location, or default to root
  const candidates = [
    path.join(vaultPath, 'STANDUP.md'),
    path.join(vaultPath, 'Templates', 'STANDUP.md')
  ];
  let target = candidates[0];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      target = p;
      break;
    }
  }
  fs.writeFileSync(target, content, 'utf-8');
  return target;
}

// People notes
function readPersonNote(name) {
  const notePath = path.join(getVaultPath(), 'People', `${name}.md`);
  if (!fs.existsSync(notePath)) return null;
  return fs.readFileSync(notePath, 'utf-8');
}

function listPeopleNotes() {
  const dir = path.join(getVaultPath(), 'People');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}

// Decision log
function appendDecision(decisionText) {
  const dir = path.join(getVaultPath(), 'Decision Log');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'decisions.md');
  const entry = `\n## ${todayDateString()}\n- ${decisionText}\n`;
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '# Decision Log\n';
  fs.writeFileSync(logPath, existing + entry, 'utf-8');
  return logPath;
}

// Parse frontmatter from a note
function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return {};
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return {};
  const fm = content.substring(3, endIdx).trim();
  const result = {};
  for (const line of fm.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

// Extract tags from content
function extractTags(content) {
  if (!content) return [];
  const tagRegex = /#([a-zA-Z0-9_-]+)/g;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    tags.push(match[1]);
  }
  return tags;
}

module.exports = {
  isConfigured,
  readTodayDailyNote,
  writeTodayDailyNote,
  appendToDailyNote,
  readStandup,
  writeStandup,
  readPersonNote,
  listPeopleNotes,
  appendDecision,
  parseFrontmatter,
  extractTags,
  todayDateString
};
