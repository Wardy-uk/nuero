#!/usr/bin/env node
'use strict';

/**
 * Carry every decision Nick has already made onto the RECORDING it was about, and
 * retire the pending rows that are re-raises of one.
 *
 * Why it is not optional: the fix in `action-candidates` keys the decision memory
 * on the recording, and nothing had ever written that key. Without this backfill
 * the memory starts empty, so every commitment decided before today would be
 * offered again the next time PLAUD's other summary variant of that meeting was
 * scanned — which is the exact flood being fixed.
 *
 * Dry run by default (the house convention for a recovery script). Pass --apply.
 *
 *   node scripts/backfill-candidate-recording-review.js
 *   node scripts/backfill-candidate-recording-review.js --apply
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const VAULT = process.env.OBSIDIAN_VAULT_PATH || '';

async function main() {
  const db = require('../db/database');
  await db.init();
  const candidates = require('../services/action-candidates');
  const { buildSemanticSignature, sameRecording, recordingIdFromContent } = candidates;
  const taskDedupe = require('../services/task-dedupe');
  const obsidian = require('../services/obsidian');

  const recCache = new Map();
  const recOf = (rel) => {
    if (!rel || !VAULT) return null;
    if (recCache.has(rel)) return recCache.get(rel);
    let id = null;
    try {
      id = recordingIdFromContent(fs.readFileSync(path.join(VAULT, rel), 'utf-8'));
    } catch { id = null; }
    recCache.set(rel, id);
    return id;
  };

  const all = db.all("SELECT id, status, payload FROM saim_actions WHERE type = 'capture_todo'");

  const rows = all.map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.payload) || {}; } catch { payload = {}; }
    return { id: r.id, status: r.status, payload };
  }).filter((r) => r.payload.text);

  const decided = rows.filter((r) => r.status === 'rejected' || r.status === 'executed');
  const pending = rows.filter((r) => r.status === 'pending');

  // ---- 1. carry decisions onto their recording -------------------------------
  const byRecording = new Map();
  let noRecording = 0;
  for (const row of decided) {
    const rec = recOf(row.payload.sourcePath);
    // No recording is NOT a reason to invent one. An email-sourced or daily-note
    // candidate keeps its per-path memory and is simply not carried.
    if (!rec) { noRecording++; continue; }
    const sig = row.payload.semanticSignature || buildSemanticSignature(row.payload.text);
    if (!sig) continue;
    if (!byRecording.has(rec)) byRecording.set(rec, {});
    byRecording.get(rec)[sig] = {
      status: row.status,
      at: new Date().toISOString(),
      actionId: row.id,
      text: row.payload.text,
      sourcePath: row.payload.sourcePath || null,
      backfilled: true,
    };
  }

  console.log(`decided actions      : ${decided.length}`);
  console.log(`  carried onto a recording: ${decided.length - noRecording}`);
  console.log(`  no recording (left as-is): ${noRecording}`);
  console.log(`recordings touched   : ${byRecording.size}`);

  if (APPLY) {
    for (const [rec, handled] of byRecording) {
      const key = `note_action_review_rec:${rec}`;
      let existing = {};
      try { existing = JSON.parse(db.getState(key) || '{}') || {}; } catch { existing = {}; }
      // A live decision always beats a backfilled one.
      const merged = { ...handled, ...(existing.handled || {}) };
      db.setState(key, JSON.stringify({ handled: merged, reviewedAt: new Date().toISOString() }));
    }
    console.log(`  written: ${byRecording.size} recording keys`);
  }

  // ---- 2. retire pending rows that are re-raises -----------------------------
  const { active, done } = obsidian.parseVaultTodos();
  const activeTexts = active.map((t) => t.text);
  const doneTexts = done.map((t) => t.text);
  const decidedTexts = decided.map((d) => d.payload.text);

  const retire = [];
  for (const row of pending) {
    const text = row.payload.text;
    const rec = recOf(row.payload.sourcePath);
    let why = null;

    if (taskDedupe.findEquivalent(text, activeTexts, { minScore: 0.85 })) {
      why = 'already an open task';
    }
    if (!why) {
      const hit = taskDedupe.findEquivalent(text, doneTexts, { minScore: 0.85 });
      const origin = hit ? (done[hit.index].originPath || done[hit.index].meta?.sourcePath || null) : null;
      if (hit && sameRecording(rec, recOf(origin))) why = 'already a completed task from this recording';
    }
    if (!why) {
      const hit = taskDedupe.findEquivalent(text, decidedTexts, { minScore: 0.85 });
      if (hit && sameRecording(rec, recOf(decided[hit.index].payload.sourcePath))) {
        why = `already ${decided[hit.index].status} on this recording`;
      }
    }
    if (why) retire.push({ row, why });
  }

  console.log(`\npending              : ${pending.length}`);
  console.log(`  to retire          : ${retire.length}`);
  console.log(`  left for Nick      : ${pending.length - retire.length}`);
  for (const r of retire) console.log(`   - #${r.row.id} [${r.why}] ${r.row.payload.text.slice(0, 70)}`);

  if (APPLY) {
    for (const { row } of retire) {
      // superseded, never rejected: Nick decided nothing here — NEURO worked out
      // that it had already asked him. The rejection history is a record of what
      // he turned down and must not be padded with NEURO's own housekeeping.
      db.updateSaimActionStatus(row.id, 'superseded');
    }
    console.log(`\n  retired: ${retire.length}`);
  } else {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
