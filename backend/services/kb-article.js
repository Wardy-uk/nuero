'use strict';

/**
 * KB Article writer — create/update files under KB/ in the vault.
 *
 * File layout: KB/{category}/{slugified-title}.md (category optional — if
 * omitted, placed directly under KB/).
 *
 * Frontmatter: type=kb-article, title, category, tags, created, updated.
 * Body follows the KB Framework standard sections (Overview, When to use,
 * Steps, Troubleshooting, Related) — the caller can pass raw content to
 * override the template.
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function slugify(title) {
  return String(title)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .substring(0, 120);
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function articlePath(title, category) {
  const vault = VAULT_PATH();
  const segments = ['KB'];
  if (category) segments.push(category);
  segments.push(`${slugify(title)}.md`);
  const rel = segments.join('/');
  return { rel, full: path.join(vault, ...segments) };
}

function defaultTemplate({ title, category, tags }) {
  const today = todayISO();
  const fmLines = [
    '---',
    'type: kb-article',
    `title: "${title.replace(/"/g, '\\"')}"`,
  ];
  if (category) fmLines.push(`category: ${category}`);
  if (tags && tags.length) fmLines.push(`tags: [${tags.map(t => `"${t}"`).join(', ')}]`);
  fmLines.push(`created: ${today}`);
  fmLines.push(`updated: ${today}`);
  fmLines.push('confidence: draft');
  fmLines.push('---');

  const body = [
    '',
    `# ${title}`,
    '',
    '## Overview',
    '',
    '## When to use this',
    '',
    '## Prerequisites',
    '',
    '## Steps',
    '',
    '1. ',
    '',
    '## Troubleshooting',
    '',
    '## Related',
    '',
  ];

  return fmLines.join('\n') + '\n' + body.join('\n');
}

function createArticle({ title, category, content, tags = [], force = false }) {
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  if (!title) return { status: 'error', error: 'title is required' };

  const { rel, full } = articlePath(title, category);
  if (fs.existsSync(full) && !force) {
    return { status: 'error', error: `KB article already exists: ${rel}. Pass force=true to overwrite.`, path: rel };
  }

  fs.mkdirSync(path.dirname(full), { recursive: true });
  const body = content || defaultTemplate({ title, category, tags });
  fs.writeFileSync(full, body, 'utf-8');
  return { status: 'created', path: rel, changes: [`Created ${rel}`, content ? 'with provided content' : 'with default template'] };
}

function updateArticle({ title, category, content, tags }) {
  const { rel, full } = articlePath(title, category);
  if (!fs.existsSync(full)) {
    return { status: 'error', error: `KB article not found: ${rel}`, path: rel };
  }

  const raw = fs.readFileSync(full, 'utf-8');

  if (content) {
    // Full-body replacement — still bump the updated frontmatter date if a
    // frontmatter block exists in the new content; otherwise just write it.
    fs.writeFileSync(full, content, 'utf-8');
    return { status: 'updated', path: rel, changes: [`Replaced body (${content.length} chars)`] };
  }

  if (!tags || !tags.length) {
    return { status: 'error', error: 'update requires either new content or new tags' };
  }

  // Merge tags into frontmatter
  if (!raw.startsWith('---')) {
    return { status: 'error', error: `Article ${rel} has no frontmatter — can't merge tags. Pass content to rewrite instead.` };
  }
  const endIdx = raw.indexOf('---', 3);
  if (endIdx === -1) {
    return { status: 'error', error: `Malformed frontmatter in ${rel}` };
  }

  const fmSection = raw.substring(0, endIdx);
  const body = raw.substring(endIdx);
  const existingFm = obsidian.parseFrontmatter(raw);
  let newFmSection = fmSection;

  if (/\ntags:/i.test(fmSection)) {
    newFmSection = newFmSection.replace(/\ntags:.*\n/i, `\ntags: [${tags.map(t => `"${t}"`).join(', ')}]\n`);
  } else {
    newFmSection += `\ntags: [${tags.map(t => `"${t}"`).join(', ')}]`;
  }

  // Bump the updated date
  if (/\nupdated:/i.test(newFmSection)) {
    newFmSection = newFmSection.replace(/\nupdated:.*\n/i, `\nupdated: ${todayISO()}\n`);
  } else {
    newFmSection += `\nupdated: ${todayISO()}`;
  }

  fs.writeFileSync(full, newFmSection + body, 'utf-8');
  return {
    status: 'updated',
    path: rel,
    changes: [`Updated tags to [${tags.join(', ')}]`, `Bumped updated=${todayISO()}`],
  };
}

function manageKbArticle({ action, title, category, content, tags, force }) {
  switch (action) {
    case 'create': return createArticle({ title, category, content, tags, force });
    case 'update': return updateArticle({ title, category, content, tags });
    default:       return { status: 'error', error: `Unknown action: ${action}. Use create|update` };
  }
}

module.exports = { manageKbArticle };
