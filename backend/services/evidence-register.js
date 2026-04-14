'use strict';

/**
 * Evidence Register service — add/update entries in the 90-Day Plan
 * Evidence Register markdown file.
 *
 * File: Projects/90 Day Plan/Evidence Register.md
 *
 * Structure:
 *   ## Outcome N — Title
 *   | Evidence | Location | Checkpoint |
 *   |---|---|---|
 *   | entry... | ... | Day 15 + Day 30 |
 *
 * Actions:
 *   add    — append a new row to the outcome table
 *   update — find row by evidence-name substring, update location/checkpoint
 *   list   — parse and return all outcomes with their entries (no write)
 */

const fs = require('fs');
const path = require('path');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';
const REGISTER_REL = 'Projects/90 Day Plan/Evidence Register.md';

function registerFilePath() {
  return path.join(VAULT_PATH(), REGISTER_REL);
}

function clean(s) { return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function parseRegister() {
  const file = registerFilePath();
  if (!fs.existsSync(file)) {
    return { status: 'error', error: `Evidence Register not found at ${REGISTER_REL}` };
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split('\n');
  const outcomes = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^##\s+(Outcome\s+\d+.*?)$/i);
    if (m) {
      if (current) outcomes.push(current);
      current = { title: m[1].trim(), startLine: i, headerLine: -1, separatorLine: -1, lastRowLine: -1, rows: [] };
      continue;
    }
    if (!current) continue;
    if (/^##\s/.test(line) || /^---\s*$/.test(line)) {
      if (current.headerLine !== -1) {
        // only terminate if we had at least seen a table
        outcomes.push(current);
        current = null;
        continue;
      }
    }

    if (line.trim().startsWith('|')) {
      // Identify header/separator/data
      if (current.headerLine === -1 && /evidence/i.test(line)) {
        current.headerLine = i;
      } else if (current.separatorLine === -1 && current.headerLine !== -1 && /^\|[\s:-]+\|/.test(line.trim())) {
        current.separatorLine = i;
      } else if (current.separatorLine !== -1) {
        current.lastRowLine = i;
        // Parse row cells
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (cells.length >= 3) {
          current.rows.push({ evidence: cells[0], location: cells[1], checkpoint: cells[2], lineNumber: i });
        }
      }
    }
  }
  if (current) outcomes.push(current);

  return { status: 'ok', path: REGISTER_REL, outcomes, raw, lines };
}

function matchOutcome(outcomes, outcomeRef) {
  if (!outcomeRef) return null;
  const ref = String(outcomeRef).toLowerCase();
  // Match by number ("1", "outcome 1") or by title substring
  const numMatch = ref.match(/(\d+)/);
  if (numMatch) {
    const num = numMatch[1];
    const byNum = outcomes.find(o => o.title.toLowerCase().includes(`outcome ${num}`));
    if (byNum) return byNum;
  }
  return outcomes.find(o => o.title.toLowerCase().includes(ref));
}

function addEvidence({ outcome, evidence, location, checkpoint }) {
  const parsed = parseRegister();
  if (parsed.status !== 'ok') return parsed;

  const target = matchOutcome(parsed.outcomes, outcome);
  if (!target) {
    return { status: 'error', error: `Outcome not found: "${outcome}". Available: ${parsed.outcomes.map(o => o.title).join(' | ')}` };
  }
  if (target.lastRowLine === -1 && target.separatorLine === -1) {
    return { status: 'error', error: `No evidence table found under "${target.title}"` };
  }

  const insertAt = (target.lastRowLine !== -1 ? target.lastRowLine : target.separatorLine) + 1;
  const row = `| ${clean(evidence)} | ${clean(location || 'TBD')} | ${clean(checkpoint || 'TBD')} |`;
  parsed.lines.splice(insertAt, 0, row);

  // Update the "Updated:" line near the top if it exists
  const updatedIdx = parsed.lines.findIndex(l => /^>\s*Updated:/i.test(l));
  if (updatedIdx !== -1) {
    parsed.lines[updatedIdx] = `> Updated: ${new Date().toISOString().slice(0, 10)}`;
  }

  fs.writeFileSync(registerFilePath(), parsed.lines.join('\n'), 'utf-8');
  return {
    status: 'updated',
    path: REGISTER_REL,
    outcome: target.title,
    changes: [`Added evidence to "${target.title}"`, `Row: ${row.substring(0, 120)}`],
  };
}

function updateEvidence({ outcome, evidence, location, checkpoint }) {
  const parsed = parseRegister();
  if (parsed.status !== 'ok') return parsed;

  const target = matchOutcome(parsed.outcomes, outcome);
  if (!target) return { status: 'error', error: `Outcome not found: "${outcome}"` };

  const needle = String(evidence).toLowerCase();
  const row = target.rows.find(r => r.evidence.toLowerCase().includes(needle));
  if (!row) return { status: 'error', error: `No evidence row matching "${evidence}" under "${target.title}"` };

  // Rebuild the row line with new values
  const newEvidence = row.evidence; // keep name as-is
  const newLocation = location != null ? location : row.location;
  const newCheckpoint = checkpoint != null ? checkpoint : row.checkpoint;
  parsed.lines[row.lineNumber] = `| ${clean(newEvidence)} | ${clean(newLocation)} | ${clean(newCheckpoint)} |`;

  const updatedIdx = parsed.lines.findIndex(l => /^>\s*Updated:/i.test(l));
  if (updatedIdx !== -1) {
    parsed.lines[updatedIdx] = `> Updated: ${new Date().toISOString().slice(0, 10)}`;
  }

  fs.writeFileSync(registerFilePath(), parsed.lines.join('\n'), 'utf-8');
  return {
    status: 'updated',
    path: REGISTER_REL,
    outcome: target.title,
    changes: [`Updated row "${newEvidence.substring(0, 80)}"`],
  };
}

function listEvidence() {
  const parsed = parseRegister();
  if (parsed.status !== 'ok') return parsed;
  return {
    status: 'ok',
    path: REGISTER_REL,
    outcomes: parsed.outcomes.map(o => ({
      title: o.title,
      rowCount: o.rows.length,
      rows: o.rows.map(r => ({ evidence: r.evidence, location: r.location, checkpoint: r.checkpoint })),
    })),
  };
}

function manageEvidence({ action, outcome, evidence, location, checkpoint }) {
  switch (action) {
    case 'add':    return addEvidence({ outcome, evidence, location, checkpoint });
    case 'update': return updateEvidence({ outcome, evidence, location, checkpoint });
    case 'list':   return listEvidence();
    default:       return { status: 'error', error: `Unknown action: ${action}. Use add|update|list` };
  }
}

module.exports = { manageEvidence, parseRegister, listEvidence };
