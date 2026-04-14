'use strict';

/**
 * Person profile writer — create/update People/{Name}.md files.
 *
 * Actions:
 *   create       — new person note with frontmatter + standard sections
 *   update       — merge frontmatter fields into existing note
 *   add_meeting  — append a row to the "## 1-2-1 History" table
 *   add_task     — append a task line under "## Notes" (tagged for dataview)
 *
 * Notes for write-safety: this service only touches People/*.md. It refuses
 * to create a note that already exists (unless force=true), and merges
 * frontmatter conservatively (preserves unknown keys).
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function personFilePath(name) {
  return path.join(VAULT_PATH(), 'People', `${name}.md`);
}

function rel(p) { return path.relative(VAULT_PATH(), p).replace(/\\/g, '/'); }

function todayISO() { return new Date().toISOString().slice(0, 10); }

function splitFrontmatter(content) {
  if (!content || !content.startsWith('---')) return { fm: {}, fmRaw: '', body: content };
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return { fm: {}, fmRaw: '', body: content };
  const fmRaw = content.substring(3, endIdx).trim();
  const body = content.substring(endIdx + 3).replace(/^\n/, '');
  return { fm: obsidian.parseFrontmatter(content), fmRaw, body };
}

function serialiseFrontmatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v == null || v === '') continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function buildInitialNote({ name, frontmatter = {} }) {
  const fm = {
    type: 'person',
    role: frontmatter.role || '',
    team: frontmatter.team || '',
    line: frontmatter.line || '',
    manager: frontmatter.manager || '"[[People/Nick Ward|Nick Ward]]"',
    'direct-report': frontmatter['direct-report'] != null ? frontmatter['direct-report'] : true,
    cadence: frontmatter.cadence || 'fortnightly',
    'last-1-2-1': frontmatter['last-1-2-1'] || '',
    'next-1-2-1-due': frontmatter['next-1-2-1-due'] || '',
    'employment-status': frontmatter['employment-status'] || 'Permanent',
    ...frontmatter, // caller can add/override anything
  };

  const sections = [
    serialiseFrontmatter(fm),
    '',
    `# ${name}`,
    '',
    '## 1-2-1 History',
    '',
    '| Date | Type | PeopleHR Updated? | Notes |',
    '|------|------|-------------------|-------|',
    '',
    '## Notes',
    '',
    '',
  ];
  return sections.join('\n');
}

function createPerson({ name, frontmatter = {}, force = false }) {
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  if (!name) return { status: 'error', error: 'name is required' };

  const file = personFilePath(name);
  if (fs.existsSync(file) && !force) {
    return { status: 'error', error: `Person note already exists: ${rel(file)}. Pass force=true to overwrite.`, path: rel(file) };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildInitialNote({ name, frontmatter }), 'utf-8');
  return { status: 'created', path: rel(file), changes: [`Created ${rel(file)}`] };
}

function updatePerson({ name, frontmatter = {} }) {
  const file = personFilePath(name);
  if (!fs.existsSync(file)) return { status: 'error', error: `Person note not found: People/${name}.md` };

  const raw = fs.readFileSync(file, 'utf-8');
  const { fm, body } = splitFrontmatter(raw);
  const merged = { ...fm, ...frontmatter };
  const updated = serialiseFrontmatter(merged) + '\n\n' + body.replace(/^\n+/, '');
  fs.writeFileSync(file, updated, 'utf-8');
  return {
    status: 'updated',
    path: rel(file),
    changes: Object.keys(frontmatter).map(k => `${k}=${frontmatter[k]}`),
  };
}

function addMeetingRow({ name, date = todayISO(), meetingType = '1-2-1', peopleHR = '❌', notes = '' }) {
  const file = personFilePath(name);
  if (!fs.existsSync(file)) return { status: 'error', error: `Person note not found: People/${name}.md` };

  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split('\n');

  // Find "## 1-2-1 History" section and its table
  const sectionIdx = lines.findIndex(l => /^##\s+1-2-1 History/i.test(l));
  if (sectionIdx === -1) {
    return { status: 'error', error: `"## 1-2-1 History" section not found in ${rel(file)}` };
  }

  // Scan forward to find the last table row (lines starting with `|`) before the next `##`
  let lastTableLine = -1;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (lines[i].trim().startsWith('|')) lastTableLine = i;
  }
  if (lastTableLine === -1) {
    return { status: 'error', error: `No markdown table found under "## 1-2-1 History" in ${rel(file)}` };
  }

  // Sanitise cell content (no pipes)
  const clean = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const row = `| ${date} | ${clean(meetingType)} | ${peopleHR} | ${clean(notes)} |`;
  lines.splice(lastTableLine + 1, 0, row);

  fs.writeFileSync(file, lines.join('\n'), 'utf-8');

  // Also update frontmatter: last-1-2-1 and last-contact
  updatePerson({ name, frontmatter: { 'last-1-2-1': date, 'last-contact': date } });

  return { status: 'updated', path: rel(file), changes: [`Added 1:1 row for ${date}`, `Updated last-1-2-1/last-contact`] };
}

function addTaskLine({ name, task, date = todayISO(), accepted = true }) {
  const file = personFilePath(name);
  if (!fs.existsSync(file)) return { status: 'error', error: `Person note not found: People/${name}.md` };
  if (!task) return { status: 'error', error: 'task text is required' };

  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split('\n');

  // Find "## Notes" section (insert as a bullet there, so it appears in dataview)
  const notesIdx = lines.findIndex(l => /^##\s+Notes/i.test(l));
  if (notesIdx === -1) {
    // Append at end of file
    const tag = accepted ? '#accepted' : '#watch';
    const line = `- [ ] ${task} ${tag} 👤 [[People/${name}|${name}]] 📅 ${date}`;
    lines.push('', '## Notes', '', line);
  } else {
    // Insert one blank line after the header
    const tag = accepted ? '#accepted' : '#watch';
    const line = `- [ ] ${task} ${tag} 👤 [[People/${name}|${name}]] 📅 ${date}`;
    lines.splice(notesIdx + 2, 0, line);
  }

  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return { status: 'updated', path: rel(file), changes: [`Added task: "${task.substring(0, 60)}"`] };
}

function managePersonProfile({ action, person, frontmatter, date, meetingType, peopleHR, notes, task, accepted, force }) {
  if (!person) return { status: 'error', error: 'person is required' };
  switch (action) {
    case 'create':      return createPerson({ name: person, frontmatter, force });
    case 'update':      return updatePerson({ name: person, frontmatter });
    case 'add_meeting': return addMeetingRow({ name: person, date, meetingType, peopleHR, notes });
    case 'add_task':    return addTaskLine({ name: person, task, date, accepted });
    default:            return { status: 'error', error: `Unknown action: ${action}. Use create|update|add_meeting|add_task` };
  }
}

module.exports = { managePersonProfile };
