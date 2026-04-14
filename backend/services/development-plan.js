'use strict';

/**
 * Development Plan service — read/update a direct report's development plan.
 *
 * Plan files live at: Documents/HR/{Person} - Development Plan.md
 *
 * Plan structure:
 *   ### Goal N — Title
 *   **What:** ...
 *   **Why it matters:** ...
 *   **How we'll measure it:** ...
 *   **Target date:** 30 May 2026
 *   **Progress:**
 *   - YYYY-MM-DD — Note
 *   - YYYY-MM-DD — Note
 *
 * update_progress appends a new bullet to Goal N's Progress list.
 * complete_goal marks Goal N with ✅ in the title and appends a completion line.
 * add_goal inserts a new Goal block before the first "---" separator after goals.
 */

const fs = require('fs');
const path = require('path');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function planFilePath(personName) {
  return path.join(VAULT_PATH(), 'Documents', 'HR', `${personName} - Development Plan.md`);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse goals out of plan content.
 * Returns array: [{ number, title, complete, targetDate, progress: [...], startLine, endLine }]
 */
function parseGoals(content) {
  const lines = content.split('\n');
  const goals = [];
  let current = null;
  let inProgress = false;

  const goalRe = /^###\s+Goal\s+(\d+)\s*(✅)?\s*[—-]\s*(.+?)\s*$/i;
  const targetRe = /^\*\*Target date:\*\*\s*(.+?)\s*$/i;
  const progressHeaderRe = /^\*\*Progress:\*\*\s*$/i;
  const progressItemRe = /^\s*-\s*(.+?)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const gm = line.match(goalRe);
    if (gm) {
      if (current) { current.endLine = i - 1; goals.push(current); }
      current = {
        number: parseInt(gm[1], 10),
        title: gm[3].trim(),
        complete: !!gm[2],
        targetDate: null,
        progress: [],
        startLine: i,
        endLine: lines.length - 1,
        progressStartLine: -1,
        progressEndLine: -1,
      };
      inProgress = false;
      continue;
    }

    if (!current) continue;

    // End-of-goal: horizontal rule or next heading at same/higher level
    if (/^---\s*$/.test(line) || /^##\s/.test(line)) {
      current.endLine = i - 1;
      goals.push(current);
      current = null;
      inProgress = false;
      continue;
    }

    const tm = line.match(targetRe);
    if (tm) current.targetDate = tm[1].trim();

    if (progressHeaderRe.test(line)) {
      inProgress = true;
      current.progressStartLine = i;
      current.progressEndLine = i;
      continue;
    }

    if (inProgress) {
      const pm = line.match(progressItemRe);
      if (pm) {
        current.progress.push(pm[1].trim());
        current.progressEndLine = i;
      } else if (line.trim() === '') {
        // Blank line — could still be within progress block if more items follow
        continue;
      } else {
        inProgress = false;
      }
    }
  }

  if (current) goals.push(current);
  return goals;
}

function readPlan(personName) {
  const file = planFilePath(personName);
  if (!fs.existsSync(file)) {
    return { status: 'error', error: `No development plan found for ${personName}. Expected: ${path.relative(VAULT_PATH(), file).replace(/\\/g, '/')}` };
  }
  const content = fs.readFileSync(file, 'utf-8');
  const goals = parseGoals(content);
  return {
    status: 'ok',
    path: path.relative(VAULT_PATH(), file).replace(/\\/g, '/'),
    goals: goals.map(g => ({
      number: g.number,
      title: g.title,
      complete: g.complete,
      targetDate: g.targetDate,
      progress: g.progress,
    })),
  };
}

function updateProgress(personName, goalNumber, progressNote, date = todayISO()) {
  const file = planFilePath(personName);
  if (!fs.existsSync(file)) return { status: 'error', error: `No development plan for ${personName}` };

  const content = fs.readFileSync(file, 'utf-8');
  const goals = parseGoals(content);
  const goal = goals.find(g => g.number === goalNumber);
  if (!goal) return { status: 'error', error: `Goal ${goalNumber} not found (found ${goals.length} goals)` };

  const lines = content.split('\n');
  const entry = `- ${date} — ${progressNote}`;

  if (goal.progressEndLine >= 0) {
    lines.splice(goal.progressEndLine + 1, 0, entry);
  } else {
    // No progress block yet — append one before end-of-goal
    lines.splice(goal.endLine + 1, 0, '**Progress:**', entry);
  }

  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return {
    status: 'updated',
    path: path.relative(VAULT_PATH(), file).replace(/\\/g, '/'),
    changes: [`Appended progress to Goal ${goalNumber}: "${progressNote}"`],
  };
}

function completeGoal(personName, goalNumber, date = todayISO()) {
  const file = planFilePath(personName);
  if (!fs.existsSync(file)) return { status: 'error', error: `No development plan for ${personName}` };

  const content = fs.readFileSync(file, 'utf-8');
  const goals = parseGoals(content);
  const goal = goals.find(g => g.number === goalNumber);
  if (!goal) return { status: 'error', error: `Goal ${goalNumber} not found` };
  if (goal.complete) return { status: 'updated', changes: [`Goal ${goalNumber} already complete`] };

  const lines = content.split('\n');
  // Add ✅ to title
  lines[goal.startLine] = lines[goal.startLine].replace(
    /^(###\s+Goal\s+\d+)\s*[—-]\s*(.+)$/i,
    `$1 ✅ — $2`
  );

  // Append completion to progress
  const entry = `- ${date} — Goal completed.`;
  if (goal.progressEndLine >= 0) {
    lines.splice(goal.progressEndLine + 1, 0, entry);
  } else {
    lines.splice(goal.endLine + 1, 0, '**Progress:**', entry);
  }

  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return {
    status: 'updated',
    path: path.relative(VAULT_PATH(), file).replace(/\\/g, '/'),
    changes: [`Marked Goal ${goalNumber} complete`],
  };
}

function addGoal(personName, newGoal, date = todayISO()) {
  const file = planFilePath(personName);
  if (!fs.existsSync(file)) return { status: 'error', error: `No development plan for ${personName}` };
  if (!newGoal?.title || !newGoal?.targetDate) {
    return { status: 'error', error: 'newGoal must have { title, targetDate }' };
  }

  const content = fs.readFileSync(file, 'utf-8');
  const goals = parseGoals(content);
  const nextNumber = (goals.reduce((m, g) => Math.max(m, g.number), 0)) + 1;

  const block = [
    ``,
    `### Goal ${nextNumber} — ${newGoal.title}`,
    `**What:** ${newGoal.what || 'TBD'}`,
    `**Why it matters:** ${newGoal.why || 'TBD'}`,
    `**How we'll measure it:** ${newGoal.measure || 'TBD'}`,
    `**Target date:** ${newGoal.targetDate}`,
    `**Progress:**`,
    `- ${date} — Goal set.`,
    ``,
  ];

  const lines = content.split('\n');
  let insertAt;
  if (goals.length > 0) {
    const lastGoal = goals[goals.length - 1];
    insertAt = lastGoal.endLine + 1;
  } else {
    // Insert before first --- separator or at end
    const sepIdx = lines.findIndex((l, i) => i > 10 && /^---\s*$/.test(l));
    insertAt = sepIdx > 0 ? sepIdx : lines.length;
  }

  lines.splice(insertAt, 0, ...block);
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return {
    status: 'updated',
    path: path.relative(VAULT_PATH(), file).replace(/\\/g, '/'),
    changes: [`Added Goal ${nextNumber}: "${newGoal.title}"`],
  };
}

module.exports = { readPlan, updateProgress, completeGoal, addGoal, parseGoals, planFilePath };
