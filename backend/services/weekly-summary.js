'use strict';

/**
 * Weekly summary generator — aggregates a full week's activity into a
 * Chris-friendly markdown brief.
 *
 * Pulls from:
 *   - Meetings in the week range (Meetings/YYYY/MM/YYYY-MM-DD ...)
 *   - Performance reviews in Documents/HR
 *   - Development plan progress entries (date-in-range)
 *   - Action items with due date in range (completed + outstanding)
 *
 * The week is Monday → Sunday. If weekStarting is omitted, defaults to
 * the Monday of the current week (Europe/London).
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');
const devPlan = require('./development-plan');
const actionItems = require('./action-items');
const teamHealth = require('./team-health');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function mondayOfWeek(refDate = new Date()) {
  const d = new Date(refDate);
  const dow = d.getDay(); // 0=Sun, 1=Mon
  const diff = (dow === 0 ? -6 : 1 - dow);
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function iso(d) { return d.toISOString().slice(0, 10); }

function walkDir(dir, maxDepth = 5, depth = 0, out = []) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, maxDepth, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function collectMeetings(start, end) {
  const vault = VAULT_PATH();
  const meetingsDir = path.join(vault, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return [];
  const startISO = iso(start), endISO = iso(end);
  const out = [];
  for (const file of walkDir(meetingsDir)) {
    const base = path.basename(file, '.md');
    const m = base.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    if (m[1] < startISO || m[1] > endISO) continue;
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const fm = obsidian.parseFrontmatter(content);
    const titleFromFile = base.replace(/^\d{4}-\d{2}-\d{2}\s*[–-]\s*/, '');
    out.push({
      date: m[1],
      title: titleFromFile,
      path: path.relative(vault, file).replace(/\\/g, '/'),
      type: String(fm['meeting-type'] || fm.type || '').replace(/^"|"$/g, ''),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function collectReviews(start, end) {
  const vault = VAULT_PATH();
  const hrDir = path.join(vault, 'Documents', 'HR');
  if (!fs.existsSync(hrDir)) return [];
  const startISO = iso(start), endISO = iso(end);
  const out = [];
  for (const file of fs.readdirSync(hrDir)) {
    if (!file.endsWith('.md')) continue;
    const m = file.match(/^(\d{4}-\d{2}-\d{2})\s*[–-]\s*(.+?)\.md$/);
    if (!m) continue;
    if (m[1] < startISO || m[1] > endISO) continue;
    out.push({ date: m[1], title: m[2], path: `Documents/HR/${file}` });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function collectPlanProgress(start, end) {
  const vault = VAULT_PATH();
  const hrDir = path.join(vault, 'Documents', 'HR');
  if (!fs.existsSync(hrDir)) return [];
  const startISO = iso(start), endISO = iso(end);
  const out = [];

  for (const file of fs.readdirSync(hrDir)) {
    const m = file.match(/^(.+?)\s*-\s*Development Plan\.md$/);
    if (!m) continue;
    const person = m[1];
    const plan = devPlan.readPlan(person);
    if (plan.status !== 'ok') continue;
    for (const goal of plan.goals) {
      for (const entry of goal.progress || []) {
        const pm = entry.match(/^(\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+)$/);
        if (!pm) continue;
        if (pm[1] < startISO || pm[1] > endISO) continue;
        out.push({ date: pm[1], person, goalNumber: goal.number, goalTitle: goal.title, note: pm[2] });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function collectActionsInRange(start, end) {
  const startISO = iso(start), endISO = iso(end);
  const all = actionItems.findActionItems({ status: 'all', daysBack: 30 });
  const inRange = all.filter(a => a.dueDate && a.dueDate >= startISO && a.dueDate <= endISO);
  const completed = inRange.filter(a => a.done);
  const outstanding = inRange.filter(a => !a.done);
  return { inRange, completed, outstanding };
}

function buildSummaryMarkdown({ weekStart, weekEnd, meetings, reviews, planProgress, actions, highIssues }) {
  const lines = [];
  lines.push(`# Weekly Summary — ${iso(weekStart)} to ${iso(weekEnd)}`);
  lines.push('');
  lines.push(`_For Chris Middleton. Prepared ${iso(new Date())}._`);
  lines.push('');

  lines.push('## Headline Numbers');
  lines.push(`- Meetings: **${meetings.length}**`);
  lines.push(`- Performance reviews: **${reviews.length}**`);
  lines.push(`- Development plan updates: **${planProgress.length}**`);
  lines.push(`- Action items (week window) — completed: **${actions.completed.length}**, outstanding: **${actions.outstanding.length}**`);
  lines.push(`- High-severity team health issues right now: **${highIssues}**`);
  lines.push('');

  if (meetings.length) {
    lines.push('## Meetings This Week');
    for (const m of meetings) {
      const t = m.type ? ` _(${m.type})_` : '';
      lines.push(`- **${m.date}** — [[${m.path.replace(/\.md$/, '')}|${m.title}]]${t}`);
    }
    lines.push('');
  }

  if (reviews.length) {
    lines.push('## Performance Reviews / HR Documents');
    for (const r of reviews) {
      lines.push(`- **${r.date}** — [[${r.path.replace(/\.md$/, '')}|${r.title}]]`);
    }
    lines.push('');
  }

  if (planProgress.length) {
    lines.push('## Development Plan Progress');
    const byPerson = {};
    for (const p of planProgress) {
      (byPerson[p.person] ||= []).push(p);
    }
    for (const [person, entries] of Object.entries(byPerson)) {
      lines.push(`### ${person}`);
      for (const e of entries) {
        lines.push(`- ${e.date} — Goal ${e.goalNumber} (${e.goalTitle}): ${e.note}`);
      }
    }
    lines.push('');
  }

  if (actions.completed.length) {
    lines.push('## Actions Completed');
    for (const a of actions.completed.slice(0, 20)) {
      lines.push(`- [x] ${a.text.substring(0, 120)}${a.assignee ? ` _(${a.assignee})_` : ''}`);
    }
    lines.push('');
  }
  if (actions.outstanding.length) {
    lines.push('## Actions Still Open');
    for (const a of actions.outstanding.slice(0, 20)) {
      lines.push(`- [ ] ${a.text.substring(0, 120)}${a.assignee ? ` _(${a.assignee})_` : ''}${a.dueDate ? ` 📅 ${a.dueDate}` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function summarizeWeek({ weekStarting } = {}) {
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };

  let start;
  if (weekStarting) {
    start = new Date(weekStarting);
    if (isNaN(start.getTime())) return { status: 'error', error: `Invalid weekStarting: ${weekStarting}` };
    start.setHours(0, 0, 0, 0);
  } else {
    start = mondayOfWeek();
  }
  const end = addDays(start, 6);
  end.setHours(23, 59, 59, 999);

  const meetings = collectMeetings(start, end);
  const reviews = collectReviews(start, end);
  const planProgress = collectPlanProgress(start, end);
  const actions = collectActionsInRange(start, end);

  // High issues snapshot (from team-health at default 'high' severity)
  let highIssues = 0;
  try {
    const snap = teamHealth.teamHealthSnapshot({ severity: 'high' });
    if (snap.status === 'ok') highIssues = snap.filteredCount || 0;
  } catch {}

  const markdown = buildSummaryMarkdown({
    weekStart: start, weekEnd: end,
    meetings, reviews, planProgress, actions, highIssues,
  });

  return {
    status: 'ok',
    weekStart: iso(start),
    weekEnd: iso(end),
    counts: {
      meetings: meetings.length,
      reviews: reviews.length,
      planProgress: planProgress.length,
      actionsCompleted: actions.completed.length,
      actionsOutstanding: actions.outstanding.length,
      highSeverityIssues: highIssues,
    },
    markdown,
  };
}

module.exports = { summarizeWeek };
