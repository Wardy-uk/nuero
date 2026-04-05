'use strict';

/**
 * Person Detail API — aggregated view of everything NEURO knows about a person.
 *
 * GET /api/person/:name — vault note + mentions + meetings + decisions + tasks
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// IMPORTANT: static routes MUST come before /:name (Express matches in order)

// GET /api/person/list
router.get('/list', (req, res) => {
  try {
    const peopleDir = path.join(VAULT_PATH, 'People');
    if (!fs.existsSync(peopleDir)) return res.json({ people: [] });
    const people = fs.readdirSync(peopleDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => f.replace('.md', ''))
      .sort();
    res.json({ people });
  } catch (e) {
    res.json({ people: [] });
  }
});

// GET /api/person/:name
router.get('/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const t0 = Date.now();

  try {
    const result = {
      name,
      vaultNote: null,
      meetings: [],
      decisions: [],
      tasks: [],
      mentions: [],
      dailyMentions: [],
    };

    // 1. Read People note
    const peopleDir = path.join(VAULT_PATH, 'People');
    const noteFile = _findPersonFile(peopleDir, name);
    if (noteFile) {
      const content = fs.readFileSync(path.join(peopleDir, noteFile), 'utf-8');
      const fm = _parseFrontmatter(content);
      let body = content;
      if (body.startsWith('---')) {
        const fmEnd = body.indexOf('---', 3);
        if (fmEnd !== -1) body = body.substring(fmEnd + 3);
      }
      // Strip code blocks
      const parts = body.split('```');
      body = parts.filter((_, i) => i % 2 === 0).join('');

      result.vaultNote = {
        file: noteFile,
        frontmatter: fm,
        sections: _parseSections(body),
      };
    }

    // 2. Find linked meetings
    const meetingsDir = path.join(VAULT_PATH, 'Meetings');
    if (fs.existsSync(meetingsDir)) {
      const firstName = name.split(' ')[0];
      _walkDir(meetingsDir, 2).forEach(file => {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.toLowerCase().includes(firstName.toLowerCase()) ||
            content.toLowerCase().includes(name.toLowerCase())) {
          const relativePath = path.relative(VAULT_PATH, file).replace(/\\/g, '/');
          const fileName = path.basename(file, '.md');
          // Extract date from filename
          const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})/);
          const fm = _parseFrontmatter(content);
          result.meetings.push({
            path: relativePath,
            title: fm.title || fileName.replace(/^\d{4}-\d{2}-\d{2}\s*[-–]\s*/, ''),
            date: dateMatch ? dateMatch[1] : fm.date || null,
          });
        }
      });
      result.meetings.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      result.meetings = result.meetings.slice(0, 10);
    }

    // 3. Find decisions mentioning this person
    try {
      const obsidian = require('../services/obsidian');
      const decisions = obsidian.getRecentDecisions(90);
      if (decisions) {
        const firstName = name.split(' ')[0].toLowerCase();
        result.decisions = decisions
          .filter(d => d.text?.toLowerCase().includes(firstName) || d.text?.toLowerCase().includes(name.toLowerCase()))
          .slice(0, 10)
          .map(d => ({ date: d.date, text: d.text }));
      }
    } catch {}

    // 4. Find tasks mentioning this person
    try {
      const vaultCache = require('../services/vault-cache');
      const todos = vaultCache.getTodos();
      const firstName = name.split(' ')[0].toLowerCase();
      if (todos?.active) {
        result.tasks = todos.active
          .filter(t => t.text?.toLowerCase().includes(firstName) || t.text?.toLowerCase().includes(name.toLowerCase()))
          .slice(0, 10)
          .map(t => ({ text: t.text, source: t.source, due_date: t.due_date, status: t.status }));
      }
    } catch {}

    // 5. Entity mentions from DB
    try {
      const entities = require('../services/entities');
      const mentions = entities.getMentionsOf(name);
      if (mentions) {
        result.mentions = mentions
          .filter(p => !p.startsWith('People/'))
          .slice(0, 10)
          .map(p => ({
            path: p,
            title: path.basename(p, '.md'),
          }));
      }
    } catch {}

    // 6. Recent daily note mentions
    try {
      const dailyDir = path.join(VAULT_PATH, 'Daily');
      if (fs.existsSync(dailyDir)) {
        const files = fs.readdirSync(dailyDir)
          .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
          .sort().reverse().slice(0, 14);
        const firstName = name.split(' ')[0];
        for (const file of files) {
          const content = fs.readFileSync(path.join(dailyDir, file), 'utf-8');
          if (firstName.length > 2 && content.toLowerCase().includes(firstName.toLowerCase())) {
            const lines = content.split('\n')
              .filter(l => l.toLowerCase().includes(firstName.toLowerCase()) && l.trim().length > 5)
              .slice(0, 3)
              .map(l => l.trim().substring(0, 100));
            if (lines.length > 0) {
              result.dailyMentions.push({
                date: file.replace('.md', ''),
                lines,
              });
            }
          }
        }
      }
    } catch {}

    // 7. HR documents
    result.hrDocs = [];
    try {
      const hrDir = path.join(VAULT_PATH, 'Documents', 'HR');
      if (fs.existsSync(hrDir)) {
        const firstName = name.split(' ')[0];
        fs.readdirSync(hrDir).filter(f => f.endsWith('.md')).forEach(file => {
          if (file.toLowerCase().includes(firstName.toLowerCase()) ||
              file.toLowerCase().includes(name.toLowerCase())) {
            result.hrDocs.push({
              path: `Documents/HR/${file}`,
              title: file.replace('.md', ''),
            });
          }
        });
      }
    } catch {}

    console.log(`[PersonDetail] ${name}: ${Date.now() - t0}ms`);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _findPersonFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const exact = files.find(f => f.replace('.md', '').toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const partial = files.find(f => {
    const fname = f.replace('.md', '').toLowerCase();
    return name.split(' ').some(p => p.length > 2 && fname.includes(p.toLowerCase()));
  });
  return partial || null;
}

function _parseFrontmatter(content) {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('---', 3);
  if (end === -1) return {};
  const fm = content.substring(3, end);
  const result = {};
  fm.split('\n').forEach(line => {
    const m = line.match(/^(\S[\w-]*):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return result;
}

function _parseSections(body) {
  const sections = [];
  let current = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { title: line.replace(/^##\s*/, '').trim(), lines: [] };
    } else if (current && line.trim()) {
      current.lines.push(line.trim());
    }
  }
  if (current) sections.push(current);
  return sections.filter(s => s.lines.length > 0).map(s => ({
    title: s.title,
    content: s.lines.slice(0, 10).join('\n'),
    lineCount: s.lines.length,
  }));
}

function _walkDir(dir, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(..._walkDir(full, maxDepth, depth + 1));
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

// GET /api/person/summary/all — lightweight per-person tasks + decisions for cards
router.get('/summary/all', (req, res) => {
  try {
    const t0 = Date.now();
    const peopleDir = path.join(VAULT_PATH, 'People');
    if (!fs.existsSync(peopleDir)) return res.json({ people: {} });

    const files = fs.readdirSync(peopleDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
    const names = files.map(f => f.replace('.md', ''));

    // Get all tasks and decisions once
    let allTasks = [];
    try {
      const vaultCache = require('../services/vault-cache');
      const todos = vaultCache.getTodos();
      allTasks = (todos?.active || []).filter(t => t.status !== 'done');
    } catch {}

    let allDecisions = [];
    try {
      const obsidian = require('../services/obsidian');
      allDecisions = obsidian.getRecentDecisions(30) || [];
    } catch {}

    // Build per-person summary
    const people = {};
    for (const name of names) {
      const firstName = name.split(' ')[0].toLowerCase();
      const fullName = name.toLowerCase();

      const tasks = allTasks
        .filter(t => t.text?.toLowerCase().includes(firstName) || t.text?.toLowerCase().includes(fullName))
        .slice(0, 3)
        .map(t => ({ text: t.text.substring(0, 80), source: t.source, due_date: t.due_date }));

      const decisions = allDecisions
        .filter(d => d.text?.toLowerCase().includes(firstName) || d.text?.toLowerCase().includes(fullName))
        .slice(0, 3)
        .map(d => ({ date: d.date, text: d.text.substring(0, 80) }));

      if (tasks.length > 0 || decisions.length > 0) {
        people[name] = { tasks, decisions };
      }
    }

    console.log(`[PersonSummary] Built for ${Object.keys(people).length} people in ${Date.now() - t0}ms`);
    res.json({ people });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
