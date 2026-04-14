'use strict';

/**
 * Knowledge Gap finder — identifies missing KB articles by cross-referencing:
 *   - Development plan goals containing "KB", "KBA", "knowledge base", "write article"
 *   - Meeting notes / action items mentioning "KBA", "write KBA", "write KB", "KB article"
 *   - Existing KB articles (if KB/ directory exists)
 *
 * Returns a deduplicated list of suggested topics with provenance so Nick
 * can prioritise which articles to write.
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');
const devPlan = require('./development-plan');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

const KB_PATTERNS = [
  /\bKBA[\s:-]+([^\n.]{5,120})/gi,
  /\bKB article[\s:-]+([^\n.]{5,120})/gi,
  /\bwrite (?:a )?KB[\s:-]+([^\n.]{5,120})/gi,
  /\bknowledge base[\s:-]+([^\n.]{5,120})/gi,
  /\bKBA[\s-]+([A-Z][A-Za-z0-9 ]{3,60})/g,
];

function walkDir(dir, maxDepth = 5, depth = 0, out = []) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, maxDepth, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function extractPhrases(text) {
  const hits = [];
  for (const re of KB_PATTERNS) {
    const safeRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = safeRe.exec(text)) !== null) {
      const phrase = (m[1] || '').trim().replace(/[)"\],.:;]+$/, '');
      if (phrase.length >= 3) hits.push(phrase);
    }
  }
  return hits;
}

function findInDevPlans() {
  const vault = VAULT_PATH();
  const hrDir = path.join(vault, 'Documents', 'HR');
  if (!fs.existsSync(hrDir)) return [];
  const out = [];
  for (const file of fs.readdirSync(hrDir)) {
    const m = file.match(/^(.+?)\s*-\s*Development Plan\.md$/);
    if (!m) continue;
    const person = m[1];
    const plan = devPlan.readPlan(person);
    if (plan.status !== 'ok') continue;
    for (const goal of plan.goals) {
      const blob = `${goal.title}\n${goal.progress?.join('\n') || ''}`;
      if (/\bKB[A]?\b|\bknowledge base\b|\bwrite.{0,15}article\b/i.test(blob)) {
        out.push({
          topic: goal.title,
          source: 'dev_plan',
          person,
          file: `Documents/HR/${file}`,
          complete: !!goal.complete,
          targetDate: goal.targetDate,
        });
      }
    }
  }
  return out;
}

function findInMeetings(daysBack) {
  const vault = VAULT_PATH();
  const meetingsDir = path.join(vault, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const out = [];
  for (const file of walkDir(meetingsDir)) {
    const base = path.basename(file, '.md');
    const dm = base.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dm || dm[1] < cutoffISO) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const phrases = extractPhrases(content);
    for (const phrase of phrases) {
      out.push({
        topic: phrase,
        source: 'meeting',
        file: path.relative(vault, file).replace(/\\/g, '/'),
        date: dm[1],
      });
    }
  }
  return out;
}

function findInProjects(daysBack) {
  const vault = VAULT_PATH();
  const projectsDir = path.join(vault, 'Projects');
  if (!fs.existsSync(projectsDir)) return [];
  const out = [];
  for (const file of walkDir(projectsDir, 3)) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const phrases = extractPhrases(content);
    for (const phrase of phrases) {
      out.push({ topic: phrase, source: 'project', file: path.relative(vault, file).replace(/\\/g, '/') });
    }
  }
  return out;
}

function existingKbArticles() {
  const vault = VAULT_PATH();
  const kbDir = path.join(vault, 'KB');
  if (!fs.existsSync(kbDir)) return [];
  return walkDir(kbDir).map(f => path.relative(vault, f).replace(/\\/g, '/'));
}

function dedupe(list, topicFilter) {
  const map = new Map();
  for (const item of list) {
    if (topicFilter && !item.topic.toLowerCase().includes(topicFilter.toLowerCase())) continue;
    const key = item.topic.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 80);
    if (!map.has(key)) {
      map.set(key, { topic: item.topic, sources: [], count: 0 });
    }
    const entry = map.get(key);
    entry.count += 1;
    entry.sources.push({ source: item.source, file: item.file, person: item.person, date: item.date });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function findKnowledgeGaps({ topic, daysBack = 90 } = {}) {
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };

  const planHits = findInDevPlans();
  const meetingHits = findInMeetings(daysBack);
  const projectHits = findInProjects(daysBack);

  const all = [...planHits, ...meetingHits, ...projectHits];
  const suggestions = dedupe(all, topic);
  const existing = existingKbArticles();

  return {
    status: 'ok',
    daysBack,
    topicFilter: topic || null,
    counts: {
      planMentions: planHits.length,
      meetingMentions: meetingHits.length,
      projectMentions: projectHits.length,
      uniqueTopics: suggestions.length,
      existingKbArticles: existing.length,
    },
    suggestions: suggestions.slice(0, 30),
    existingArticles: existing.slice(0, 50),
  };
}

module.exports = { findKnowledgeGaps };
