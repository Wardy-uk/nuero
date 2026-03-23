'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// Known team members for person detection
const TEAM_MEMBERS = [
  'Abdi Mohamed', 'Arman Shazad', 'Luke Scaife', 'Stephen Mitchell',
  'Willem Kruger', 'Nathan Rutland', 'Adele Norman-Swift', 'Heidi Power',
  'Hope Goodall', 'Maria Pappa', 'Naomi Wentworth', 'Sebastian Broome',
  'Zoe Rees', 'Isabel Busk', 'Kayleigh Russell', 'Chris Middleton',
  'Beth', 'Paul', 'Damon', 'Ricky'
];

// First names for fuzzy matching
const FIRST_NAMES = TEAM_MEMBERS.map(n => n.split(' ')[0].toLowerCase());

/**
 * Extract entities from text using pattern matching.
 * Fast, local, no API calls — runs on every capture.
 */
function extractEntities(text) {
  const entities = { people: [], tasks: [], decisions: [], mentions: [] };
  const lower = text.toLowerCase();

  // People — match known team members (full name or first name)
  for (const member of TEAM_MEMBERS) {
    const firstName = member.split(' ')[0];
    if (lower.includes(member.toLowerCase()) || lower.includes(firstName.toLowerCase())) {
      if (!entities.people.includes(firstName)) {
        entities.people.push(firstName);
      }
    }
  }

  // Tasks — lines that look like action items
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Checkbox items
    if (/^-?\s*\[\s?\]\s+/.test(trimmed)) {
      entities.tasks.push(trimmed.replace(/^-?\s*\[\s?\]\s+/, '').substring(0, 200));
    }
    // Action language
    if (/^(action|todo|task|follow.?up|reminder)[:\s]/i.test(trimmed)) {
      entities.tasks.push(trimmed.replace(/^(action|todo|task|follow.?up|reminder)[:\s]+/i, '').substring(0, 200));
    }
  }

  // Decisions — explicit markers or decision language
  const decisionPatterns = [
    /\[DECISION[:\]]\s*(.+?)(?:\n|$)/gi,
    /decided (?:to |that )(.+?)(?:\.|$)/gi,
    /decision[:\s]+(.+?)(?:\.|$)/gi,
    /agreed (?:to |that )(.+?)(?:\.|$)/gi,
  ];
  for (const pattern of decisionPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const d = match[1].trim();
      if (d.length > 5 && d.length < 300) {
        entities.decisions.push(d);
      }
    }
  }

  // Wiki-link mentions [[Note Name]]
  const wikiLinks = text.matchAll(/\[\[([^\]]+)\]\]/g);
  for (const m of wikiLinks) {
    entities.mentions.push(m[1]);
  }

  // Jira ticket references
  const tickets = text.matchAll(/\b([A-Z]{2,}-\d+)\b/g);
  for (const m of tickets) {
    if (!entities.mentions.includes(m[1])) {
      entities.mentions.push(m[1]);
    }
  }

  return entities;
}

/**
 * Process a note — extract entities and save to DB, create links.
 */
function processNote(relativePath) {
  if (!VAULT_PATH) return null;
  const fullPath = path.join(VAULT_PATH, relativePath);
  if (!fs.existsSync(fullPath)) return null;

  let content;
  try { content = fs.readFileSync(fullPath, 'utf-8'); }
  catch { return null; }

  const body = content.replace(/^---[\s\S]*?---\n*/, '');
  if (body.trim().length < 10) return null;

  const entities = extractEntities(body);

  // Clear old entities and links for this path
  db.deleteEntitiesForPath(relativePath);
  db.deleteLinksForPath(relativePath);

  // Save extracted entities
  for (const person of entities.people) {
    db.saveEntity(relativePath, 'person', person, null);
    db.saveLink(relativePath, `People/${person}.md`, person, 'mentions-person');
  }

  for (const task of entities.tasks) {
    db.saveEntity(relativePath, 'task', task, null);
  }

  for (const decision of entities.decisions) {
    db.saveEntity(relativePath, 'decision', decision, null);
  }

  for (const mention of entities.mentions) {
    db.saveEntity(relativePath, 'mention', mention, null);
    // If it looks like a vault path, create a link
    if (!mention.includes('-') || mention.includes('/')) {
      db.saveLink(relativePath, `${mention}.md`, mention, 'wiki-link');
    } else {
      db.saveLink(relativePath, null, mention, 'reference');
    }
  }

  const total = entities.people.length + entities.tasks.length + entities.decisions.length + entities.mentions.length;
  return { relativePath, entities, total };
}

/**
 * Get all notes that mention a person.
 */
function getMentionsOf(personName) {
  return db.getEntitiesByValue(personName)
    .filter(e => e.entity_type === 'person')
    .map(e => e.source_path);
}

/**
 * Get orphan notes — captured notes with no entities extracted and not linked from anywhere.
 */
function getOrphans(daysBack = 7) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const importsDir = path.join(VAULT_PATH, 'Imports');
  if (!fs.existsSync(importsDir)) return [];

  const orphans = [];

  function walk(dir, depth) {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath);
        if (stat.mtime < cutoff) continue; // older than window

        const relativePath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        const entities = db.getEntitiesForPath(relativePath);
        const backlinks = db.getBacklinks(relativePath);

        // Orphan = no entities extracted AND no backlinks AND still in Imports
        if (entities.length === 0 && backlinks.length === 0) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const body = content.replace(/^---[\s\S]*?---\n*/, '');
          orphans.push({
            path: relativePath,
            name: entry.name.replace('.md', ''),
            preview: body.substring(0, 120).trim(),
            modified: stat.mtime.toISOString()
          });
        }
      }
    }
  }

  walk(importsDir, 0);
  orphans.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return orphans;
}

/**
 * Batch process — run entity extraction on all recent notes.
 */
function processRecentNotes(daysBack = 7) {
  if (!VAULT_PATH) return { processed: 0 };
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const SKIP = new Set(['.obsidian', '.git', '.trash', 'Scripts', 'Templates']);
  let processed = 0;

  function walk(dir, depth) {
    if (depth > 4) return;
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath);
        if (stat.mtime < cutoff) continue;

        const relativePath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        const result = processNote(relativePath);
        if (result && result.total > 0) processed++;
      }
    }
  }

  walk(VAULT_PATH, 0);
  return { processed };
}

module.exports = { extractEntities, processNote, getMentionsOf, getOrphans, processRecentNotes };
