'use strict';

/**
 * 1:1 Meeting Prep generator — produces a prep document for a direct report
 * and saves it to Meetings/YYYY/MM/YYYY-MM-DD – 1-1 {Name} Prep.md
 *
 * Pulls from:
 *   - People/{Name}.md (frontmatter + notes)
 *   - Latest Documents/HR/{date} – {Name} {Review Type}.md
 *   - Documents/HR/{Name} - Development Plan.md
 *   - Open action items assigned to or mentioning the person
 *   - Recent meetings mentioning the person (last 30 days)
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');
const devPlan = require('./development-plan');
const actionItems = require('./action-items');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function ymFromDate(dateStr) {
  const [y, m] = dateStr.split('-');
  return { year: y, month: m };
}

function prepRelativePath(personName, date) {
  const { year, month } = ymFromDate(date);
  return `Meetings/${year}/${month}/${date} – 1-1 ${personName} Prep.md`;
}

function prepFullPath(personName, date) {
  return path.join(VAULT_PATH(), prepRelativePath(personName, date));
}

function findLatestReview(personName) {
  const hrDir = path.join(VAULT_PATH(), 'Documents', 'HR');
  if (!fs.existsSync(hrDir)) return null;
  const escaped = personName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s*[–-]\\s*${escaped}\\s+.*Review.*\\.md$`, 'i');
  const matches = fs.readdirSync(hrDir)
    .filter(f => re.test(f))
    .map(f => ({ file: f, date: f.match(/^(\d{4}-\d{2}-\d{2})/)[1] }))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!matches.length) return null;
  const latest = matches[0];
  const fullPath = path.join(hrDir, latest.file);
  let content = '';
  try { content = fs.readFileSync(fullPath, 'utf-8'); } catch {}
  return {
    file: latest.file,
    date: latest.date,
    path: `Documents/HR/${latest.file}`,
    content,
  };
}

function walkMeetings(dir, maxDepth = 3, depth = 0, out = []) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMeetings(full, maxDepth, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function findRecentMeetings(personName, daysBack = 30) {
  const meetingsDir = path.join(VAULT_PATH(), 'Meetings');
  if (!fs.existsSync(meetingsDir)) return [];
  const firstName = personName.split(' ')[0].toLowerCase();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const files = walkMeetings(meetingsDir, 4);
  const results = [];
  for (const file of files) {
    const base = path.basename(file, '.md');
    const dm = base.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dm) continue;
    if (new Date(dm[1]) < cutoff) continue;
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.toLowerCase().includes(firstName)) continue;
    results.push({
      path: path.relative(VAULT_PATH(), file).replace(/\\/g, '/'),
      title: base.replace(/^\d{4}-\d{2}-\d{2}\s*[–-]\s*/, ''),
      date: dm[1],
    });
  }
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

function extractReviewSnapshot(reviewContent) {
  if (!reviewContent) return null;
  // Grab the "## Stats Snapshot" section if present — it's the most useful block.
  const m = reviewContent.match(/##\s+Stats Snapshot\s*\n([\s\S]+?)(?:\n##\s|\n---\s|$)/);
  if (m) return m[1].trim();
  // Fallback: first 500 chars of body
  const body = reviewContent.replace(/^---[\s\S]*?---\n*/, '').trim();
  return body.substring(0, 800);
}

function extractPersonNotes(content) {
  if (!content) return '';
  const m = content.match(/##\s+Notes\s*\n([\s\S]+?)(?:\n##\s|\n---\s|$)/);
  return m ? m[1].trim() : '';
}

function renderPrepMarkdown({ person, date, personNote, review, plan, actions, meetings }) {
  const fm = personNote?.frontmatter || {};
  const sections = [];

  sections.push(
    `---`,
    `type: meeting-prep`,
    `date: ${date}`,
    `meeting-type: "1-1"`,
    `person: "[[People/${person}|${person}]]"`,
    `generated-by: neuro`,
    `---`,
    ``,
    `# 1:1 Prep: ${person} (${date})`,
    ``,
  );

  // Frontmatter summary
  const fmLines = [];
  if (fm.role) fmLines.push(`- **Role:** ${fm.role}`);
  if (fm.team) fmLines.push(`- **Team:** ${fm.team}${fm.line ? ` (${fm.line})` : ''}`);
  if (fm.cadence) fmLines.push(`- **1:1 cadence:** ${fm.cadence}`);
  if (fm['last-1-2-1']) fmLines.push(`- **Last 1:1:** ${fm['last-1-2-1']}`);
  if (fm.status) fmLines.push(`- **Status:** ${fm.status}`);
  if (fmLines.length) {
    sections.push(`## Context`, ...fmLines, ``);
  }

  // Latest review snapshot
  if (review) {
    sections.push(`## Latest Performance Review (${review.date})`);
    sections.push(`> [[${review.path.replace(/\.md$/, '')}|Open full review]]`);
    sections.push(``);
    const snap = extractReviewSnapshot(review.content);
    if (snap) sections.push(snap, ``);
  }

  // Dev plan goals
  if (plan?.goals?.length) {
    sections.push(`## Development Plan Goals`);
    for (const g of plan.goals) {
      const status = g.complete ? '✅' : '🎯';
      sections.push(`${status} **Goal ${g.number} — ${g.title}** (target: ${g.targetDate || 'no date'})`);
      if (g.progress?.length) {
        const latest = g.progress[g.progress.length - 1];
        sections.push(`  - Latest: ${latest}`);
      }
    }
    sections.push(``);
  }

  // Open actions for this person
  if (actions?.length) {
    sections.push(`## Open Action Items (${actions.length})`);
    for (const a of actions.slice(0, 15)) {
      const due = a.dueDate ? ` 📅 ${a.dueDate}` : '';
      sections.push(`- [ ] ${a.text}${due} _(${a.file})_`);
    }
    sections.push(``);
  }

  // Recent meetings
  if (meetings?.length) {
    sections.push(`## Recent Meetings (last 30 days)`);
    for (const m of meetings.slice(0, 10)) {
      sections.push(`- ${m.date} — [[${m.path.replace(/\.md$/, '')}|${m.title}]]`);
    }
    sections.push(``);
  }

  // Notes from person file
  const notes = extractPersonNotes(personNote?.raw);
  if (notes) {
    sections.push(`## Notes from Person File`, notes, ``);
  }

  // Empty agenda for Nick to fill in
  sections.push(
    `## Agenda`,
    `- [ ] `,
    ``,
    `## Key Decisions`,
    `- `,
    ``,
    `## Action Items From This 1:1`,
    `- [ ] `,
    ``,
  );

  return sections.join('\n');
}

/**
 * Generate and save a 1:1 prep document.
 * @param {object} opts
 * @param {string} opts.person  Person name (must match People/{name}.md)
 * @param {string=} opts.date  ISO date (default today)
 * @param {boolean=} opts.force  Overwrite existing prep file
 * @returns {object}
 */
async function generatePrep({ person, date = todayISO(), force = false } = {}) {
  if (!person) return { status: 'error', error: 'person is required' };
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };

  // Verify person exists
  const personFile = path.join(vault, 'People', `${person}.md`);
  if (!fs.existsSync(personFile)) {
    return { status: 'error', error: `Person note not found: People/${person}.md` };
  }

  // Check for existing prep file
  const outPath = prepFullPath(person, date);
  const outRel = prepRelativePath(person, date);
  if (fs.existsSync(outPath) && !force) {
    return {
      status: 'error',
      error: `Prep file already exists: ${outRel}. Pass force=true to overwrite.`,
      path: outRel,
    };
  }

  // Gather context
  const rawPerson = fs.readFileSync(personFile, 'utf-8');
  const personNote = {
    raw: rawPerson,
    frontmatter: obsidian.parseFrontmatter ? obsidian.parseFrontmatter(rawPerson) : {},
  };

  const review = findLatestReview(person);
  const planResult = devPlan.readPlan(person);
  const plan = planResult.status === 'ok' ? planResult : null;
  const actions = actionItems.findActionItems({ person, status: 'open', daysBack: 90 });
  const meetings = findRecentMeetings(person, 30);

  const md = renderPrepMarkdown({ person, date, personNote, review, plan, actions, meetings });

  // Ensure dir exists
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, md, 'utf-8');

  const changes = [`Wrote prep file: ${outRel}`];
  if (review) changes.push(`Included review: ${review.file}`);
  if (plan) changes.push(`Included ${plan.goals.length} dev plan goals`);
  if (actions.length) changes.push(`Included ${actions.length} open actions`);
  if (meetings.length) changes.push(`Included ${meetings.length} recent meetings`);

  return {
    status: force && fs.existsSync(outPath) ? 'updated' : 'created',
    path: outRel,
    changes,
    sections: {
      hasReview: !!review,
      hasPlan: !!plan,
      actionCount: actions.length,
      meetingCount: meetings.length,
    },
  };
}

module.exports = { generatePrep, findLatestReview, findRecentMeetings, prepRelativePath };
