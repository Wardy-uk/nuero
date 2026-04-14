'use strict';

/**
 * Meeting Note service — create/update/append to structured meeting notes.
 *
 * File naming: Meetings/YYYY/MM/YYYY-MM-DD – {title}.md
 * Frontmatter includes type=meeting, meeting-type, people[], date.
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function slugifyTitle(title) {
  return String(title).trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
}

function meetingRelPath(date, title) {
  const [y, m] = date.split('-');
  return `Meetings/${y}/${m}/${date} – ${slugifyTitle(title)}.md`;
}

function buildFrontmatter({ date, type, people }) {
  const lines = ['---', 'type: meeting', `date: ${date}`];
  if (type) lines.push(`meeting-type: "${type}"`);
  if (people && people.length) {
    lines.push('people:');
    for (const p of people) lines.push(`  - "[[People/${p}|${p}]]"`);
  }
  lines.push('source: neuro');
  lines.push('---');
  return lines.join('\n');
}

function buildBody({ title, date, body }) {
  const parts = [
    `# ${title}`,
    ``,
    `**Date:** ${date}`,
    ``,
    `### Attendees`,
    ``,
    `### Agenda`,
    ``,
    `### Action Items`,
    ``,
    `### Key Decisions`,
    ``,
    `### Detailed Minutes`,
    ``,
  ];
  if (body) {
    parts.push(body, '');
  }
  return parts.join('\n');
}

function createMeetingNote({ title, date = todayISO(), type = '1-1', people = [], body = '' }) {
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  if (!title) return { status: 'error', error: 'title is required' };

  const rel = meetingRelPath(date, title);
  const full = path.join(vault, rel);
  if (fs.existsSync(full)) {
    return { status: 'error', error: `Meeting note already exists: ${rel}`, path: rel };
  }

  fs.mkdirSync(path.dirname(full), { recursive: true });
  const content = buildFrontmatter({ date, type, people }) + '\n\n' + buildBody({ title, date, body });
  fs.writeFileSync(full, content, 'utf-8');
  return { status: 'created', path: rel, changes: [`Created meeting note: ${rel}`] };
}

function findMeetingNote({ title, date }) {
  const vault = VAULT_PATH();
  if (date && title) {
    const rel = meetingRelPath(date, title);
    const full = path.join(vault, rel);
    if (fs.existsSync(full)) return { rel, full };
  }
  // Fall back: walk Meetings dir and find by title substring
  const meetingsDir = path.join(vault, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return null;
  const needle = String(title || '').toLowerCase();
  const stack = [meetingsDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (needle && entry.name.toLowerCase().includes(needle)) {
          return { rel: path.relative(vault, full).replace(/\\/g, '/'), full };
        }
      }
    }
  }
  return null;
}

function appendToMeetingNote({ title, date, body }) {
  if (!body) return { status: 'error', error: 'body is required for append' };
  const found = findMeetingNote({ title, date });
  if (!found) return { status: 'error', error: `Meeting note not found (title: ${title}, date: ${date})` };
  const current = fs.readFileSync(found.full, 'utf-8');
  const updated = current.replace(/\s*$/, '') + '\n\n' + body + '\n';
  fs.writeFileSync(found.full, updated, 'utf-8');
  return { status: 'updated', path: found.rel, changes: [`Appended ${body.length} chars to ${found.rel}`] };
}

function updateMeetingNote({ title, date, section, content }) {
  const found = findMeetingNote({ title, date });
  if (!found) return { status: 'error', error: `Meeting note not found` };
  if (!section || !content) return { status: 'error', error: 'section and content required for update' };

  const raw = fs.readFileSync(found.full, 'utf-8');
  // Replace section body: ### Section\n...\n(next ### or end)
  const re = new RegExp(`(###\\s+${section.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\n)([\\s\\S]*?)(?=\\n###\\s|\\n---\\s*$|$)`, 'i');
  let updated;
  if (re.test(raw)) {
    updated = raw.replace(re, `$1${content}\n`);
  } else {
    updated = raw.replace(/\s*$/, '') + `\n\n### ${section}\n${content}\n`;
  }
  fs.writeFileSync(found.full, updated, 'utf-8');
  return { status: 'updated', path: found.rel, changes: [`Updated section "${section}" in ${found.rel}`] };
}

/**
 * Entry point for manage_meeting_note MCP tool.
 */
function manageMeetingNote({ action, title, date, type, people, body, section, content }) {
  date = date || todayISO();
  switch (action) {
    case 'create': return createMeetingNote({ title, date, type, people, body });
    case 'append': return appendToMeetingNote({ title, date, body });
    case 'update': return updateMeetingNote({ title, date, section, content });
    default: return { status: 'error', error: `Unknown action: ${action}. Use create|append|update` };
  }
}

module.exports = { manageMeetingNote, createMeetingNote, appendToMeetingNote, updateMeetingNote };
