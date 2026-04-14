'use strict';

/**
 * Checkpoint progress comparator.
 *
 * Reads the 90 Day Plan Checkpoints table + the Evidence Register, and for
 * a given checkpoint returns:
 *   - deliverables declared in the plan
 *   - evidence entries in the register tagged for that checkpoint
 *   - naive completion % based on whether each deliverable has at least
 *     one matching evidence row (substring match)
 *
 * Checkpoint references accepted: "day-15", "day-30", "Day 15", "day15", etc.
 */

const fs = require('fs');
const path = require('path');
const evidence = require('./evidence-register');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';
const PLAN_REL = 'Projects/90 Day Plan/90 Day Plan.md';

function planFilePath() {
  return path.join(VAULT_PATH(), PLAN_REL);
}

function normaliseCheckpoint(ref) {
  const m = String(ref || '').match(/(\d+)/);
  return m ? `Day ${m[1]}` : null;
}

function parsePlanCheckpoints() {
  const file = planFilePath();
  if (!fs.existsSync(file)) {
    return { status: 'error', error: `90 Day Plan not found at ${PLAN_REL}` };
  }
  const lines = fs.readFileSync(file, 'utf-8').split('\n');

  // Find the "## Checkpoints" section table
  const headerIdx = lines.findIndex(l => /^##\s+Checkpoints/i.test(l));
  if (headerIdx === -1) return { status: 'error', error: 'No "## Checkpoints" section in plan' };

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    if (/^\|\s*[-:]/.test(line.trim())) continue; // separator
    // Parse cells
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    // Skip header row
    if (/checkpoint/i.test(cells[0]) && /date/i.test(cells[1] || '')) continue;
    rows.push({
      checkpoint: cells[0].replace(/\*\*/g, '').trim(),   // e.g. "Day 15"
      date: cells[1] || '',
      deliverables: cells[2] || '',
      status: cells[3] || '',
    });
  }

  return { status: 'ok', path: PLAN_REL, rows };
}

function splitDeliverables(raw) {
  // Plan entries are comma-separated phrases like:
  // "Baseline metrics, all 1-to-1s done, cross-functional intros, quick wins named"
  return String(raw || '')
    .split(/,|;/)
    .map(s => s.trim())
    .filter(Boolean);
}

function compareCheckpoint({ checkpoint }) {
  const target = normaliseCheckpoint(checkpoint);
  if (!target) return { status: 'error', error: `Invalid checkpoint: "${checkpoint}". Use day-15, day-30, day-45, day-60, day-90` };

  const plan = parsePlanCheckpoints();
  if (plan.status !== 'ok') return plan;

  const planRow = plan.rows.find(r => r.checkpoint.toLowerCase() === target.toLowerCase());
  if (!planRow) {
    return { status: 'error', error: `Checkpoint "${target}" not found in plan. Available: ${plan.rows.map(r => r.checkpoint).join(', ')}` };
  }

  const deliverables = splitDeliverables(planRow.deliverables);

  // Pull evidence entries whose Checkpoint column mentions this day
  const parsed = evidence.parseRegister();
  if (parsed.status !== 'ok') return parsed;

  const matched = [];
  for (const outcome of parsed.outcomes) {
    for (const row of outcome.rows) {
      if (row.checkpoint.toLowerCase().includes(target.toLowerCase())) {
        matched.push({ ...row, outcome: outcome.title });
      }
    }
  }

  // Naive completion: for each deliverable phrase, check if any evidence row
  // mentions any of its content words (>3 chars).
  const completion = deliverables.map(d => {
    const needleWords = d.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const hits = matched.filter(m => {
      const blob = `${m.evidence} ${m.location}`.toLowerCase();
      return needleWords.some(w => blob.includes(w));
    });
    return { deliverable: d, covered: hits.length > 0, evidenceCount: hits.length };
  });
  const covered = completion.filter(c => c.covered).length;
  const pct = deliverables.length ? Math.round((covered / deliverables.length) * 100) : 0;

  return {
    status: 'ok',
    checkpoint: target,
    plan: {
      date: planRow.date,
      status: planRow.status,
      deliverables,
      path: PLAN_REL,
    },
    evidence: {
      count: matched.length,
      entries: matched,
      path: 'Projects/90 Day Plan/Evidence Register.md',
    },
    analysis: {
      deliverables: completion,
      covered,
      total: deliverables.length,
      completionPct: pct,
      gaps: completion.filter(c => !c.covered).map(c => c.deliverable),
    },
  };
}

module.exports = { compareCheckpoint, parsePlanCheckpoints };
