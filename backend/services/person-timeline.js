'use strict';

/**
 * Person Timeline — chronological history of events involving a direct report.
 *
 * Merges meetings, performance reviews, development plan progress entries,
 * and action items (created + closed) into a single timeline sorted newest
 * first. Consumers render as a vertical feed.
 *
 * Event shape:
 *   { date: 'YYYY-MM-DD', type: 'meeting'|'review'|'plan'|'action', title, path?, excerpt?, meta? }
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');
const devPlan = require('./development-plan');
const actionItems = require('./action-items');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function walkDir(dir, maxDepth = 4, depth = 0, out = []) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, maxDepth, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function isWithin(dateStr, cutoff) {
  if (!dateStr) return false;
  return new Date(dateStr) >= cutoff;
}

function findMeetings(personName, cutoff) {
  const vault = VAULT_PATH();
  const meetingsDir = path.join(vault, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return [];
  const firstName = personName.split(' ')[0].toLowerCase();
  const results = [];
  for (const file of walkDir(meetingsDir)) {
    const base = path.basename(file, '.md');
    const dm = base.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dm) continue;
    if (!isWithin(dm[1], cutoff)) continue;

    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.toLowerCase().includes(firstName)) continue;

    const fm = obsidian.parseFrontmatter(content);
    const titleFromFile = base.replace(/^\d{4}-\d{2}-\d{2}\s*[–-]\s*/, '');
    const type = fm['meeting-type'] || fm.type || '';
    // Build short excerpt from first meaningful body line
    const body = content.replace(/^---[\s\S]*?---\n*/, '').trim();
    const excerpt = body.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('`')) || '';

    results.push({
      date: dm[1],
      type: 'meeting',
      title: titleFromFile,
      path: path.relative(vault, file).replace(/\\/g, '/'),
      meta: { meetingType: String(type).replace(/^"|"$/g, '') },
      excerpt: excerpt.substring(0, 200),
    });
  }
  return results;
}

function findReviews(personName, cutoff) {
  const vault = VAULT_PATH();
  const hrDir = path.join(vault, 'Documents', 'HR');
  if (!fs.existsSync(hrDir)) return [];
  const escaped = personName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s*[–-]\\s*${escaped}\\s+.*\\.md$`, 'i');

  const results = [];
  for (const file of fs.readdirSync(hrDir)) {
    const m = file.match(re);
    if (!m) continue;
    if (!isWithin(m[1], cutoff)) continue;

    const full = path.join(hrDir, file);
    let content = '';
    try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }

    // Determine type from filename
    const lower = file.toLowerCase();
    let kind = 'document';
    if (/review/i.test(file)) kind = 'review';
    else if (/coaching/i.test(file)) kind = 'coaching';
    else if (/development plan/i.test(file)) kind = 'plan';
    else if (/prep/i.test(file)) kind = 'prep';

    const title = file.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}\s*[–-]\s*/, '');
    results.push({
      date: m[1],
      type: 'review',
      title,
      path: `Documents/HR/${file}`,
      meta: { kind },
      excerpt: '',
    });
  }
  return results;
}

function findPlanProgress(personName, cutoff) {
  const plan = devPlan.readPlan(personName);
  if (plan.status !== 'ok') return [];
  const results = [];
  for (const goal of plan.goals) {
    for (const entry of goal.progress || []) {
      // entry is e.g. "2026-04-03 — Goal set."
      const m = entry.match(/^(\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+)$/);
      if (!m) continue;
      if (!isWithin(m[1], cutoff)) continue;
      results.push({
        date: m[1],
        type: 'plan',
        title: `Goal ${goal.number} — ${goal.title}`,
        path: plan.path,
        meta: { goalNumber: goal.number, complete: goal.complete },
        excerpt: m[2],
      });
    }
  }
  return results;
}

function findActionEvents(personName, cutoff) {
  // Show open actions assigned to the person (created events effectively).
  const actions = actionItems.findActionItems({
    person: personName,
    status: 'all',
    daysBack: Math.max(30, Math.ceil((Date.now() - cutoff.getTime()) / 86400000)),
  });
  const results = [];
  for (const a of actions) {
    // Use due date if available, otherwise try to extract a date from the file path
    let date = a.dueDate;
    if (!date) {
      const pm = (a.file || '').match(/(\d{4}-\d{2}-\d{2})/);
      if (pm) date = pm[1];
    }
    if (!date) continue;
    if (!isWithin(date, cutoff)) continue;
    results.push({
      date,
      type: 'action',
      title: a.text.substring(0, 140),
      path: a.file,
      meta: { done: a.done, assignee: a.assignee, dueDate: a.dueDate },
      excerpt: '',
    });
  }
  return results;
}

/**
 * Get a chronological timeline for a person.
 * @param {object} opts
 * @param {string} opts.person
 * @param {number=} opts.daysBack  default 60
 * @returns {{status:'ok'|'error', events?:Array, counts?:object, error?:string}}
 */
function getTimeline({ person, daysBack = 60 } = {}) {
  if (!person) return { status: 'error', error: 'person is required' };
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };

  // Validate person exists
  const personFile = path.join(vault, 'People', `${person}.md`);
  if (!fs.existsSync(personFile)) {
    return { status: 'error', error: `Person note not found: People/${person}.md` };
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  cutoff.setHours(0, 0, 0, 0);

  const meetings = findMeetings(person, cutoff);
  const reviews = findReviews(person, cutoff);
  const planEntries = findPlanProgress(person, cutoff);
  const actions = findActionEvents(person, cutoff);

  const events = [...meetings, ...reviews, ...planEntries, ...actions]
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    status: 'ok',
    person,
    daysBack,
    counts: {
      total: events.length,
      meetings: meetings.length,
      reviews: reviews.length,
      planEntries: planEntries.length,
      actions: actions.length,
    },
    events,
  };
}

module.exports = { getTimeline };
