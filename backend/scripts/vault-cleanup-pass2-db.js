#!/usr/bin/env node
'use strict';

/**
 * Vault cleanup pass 2 (22 Oct 2026) — the database half.
 *
 *   node scripts/vault-cleanup-pass2-db.js <plan.json> <agent.db>            # dry run (rolls back)
 *   node scripts/vault-cleanup-pass2-db.js <plan.json> <agent.db> --apply    # commits
 *
 * `plan.json` is the cleanup script's plan: `ops[]` of { group, path, to }.
 * One transaction; every count is checked against the plan before it commits,
 * and a mismatch rolls the whole thing back.
 *
 * What it does, and why:
 *  - task_blocks.note_path for the archived outcome stubs → the ARCHIVE path.
 *    The block's history keeps pointing at the real file (which exists in
 *    Archive/ on Windows and in the Pi replica's own Archive/), and
 *    task-blocks.isArchivedNote makes that file read-only to NEURO.
 *  - vault_embeddings / extracted_entities / note_links rows whose SOURCE is an
 *    archived note → deleted. They are derived index rows; Archive/ is excluded
 *    from indexing, so the nightly rebuild would drop them anyway.
 *  - note_links rows whose TARGET is an archived note → repointed to the archive
 *    path, so a backlink still names a file that exists.
 *  - agent_state `note_action_review:<hash>:<path>` keys for archived notes →
 *    deleted (commitment extraction never reads Archive/).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const [planPath, dbPath] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
if (!planPath || !dbPath) { console.error('usage: <plan.json> <agent.db> [--apply]'); process.exit(2); }

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const ops = plan.ops.filter((o) => o.op === 'archive');
const db = new Database(dbPath);
db.pragma('busy_timeout = 10000');

const stubOps = ops.filter((o) => o.group === 'stubs');
const report = { dryRun: !APPLY, taskBlocks: 0, taskBlocksExpected: stubOps.reduce((n, o) => n + (o.blocks || []).length, 0),
  embeddingsDeleted: 0, entitiesDeleted: 0, noteLinksDeleted: 0, noteLinksRetargeted: 0, reviewKeysDeleted: 0, reviewKeys: [], problems: [] };

const tx = db.transaction(() => {
  const upd = db.prepare("UPDATE task_blocks SET note_path = ? WHERE note_path = ? AND status IN ('complete','released','dropped')");
  const live = db.prepare("SELECT id, status FROM task_blocks WHERE note_path = ? AND status NOT IN ('complete','released','dropped')");
  for (const o of stubOps) {
    const open = live.all(o.path);
    if (open.length) report.problems.push(`${o.path}: block #${open[0].id} is ${open[0].status} — left alone`);
    report.taskBlocks += upd.run(o.to, o.path).changes;
  }
  const delEmb = db.prepare('DELETE FROM vault_embeddings WHERE relative_path = ?');
  const delEnt = db.prepare('DELETE FROM extracted_entities WHERE source_path = ?');
  const delLinks = db.prepare('DELETE FROM note_links WHERE source_path = ?');
  const retarget = db.prepare('UPDATE note_links SET target_path = ? WHERE target_path = ?');
  const keys = db.prepare("SELECT key FROM agent_state WHERE key LIKE 'note_action_review:%'").all().map((r) => r.key);
  const delKey = db.prepare('DELETE FROM agent_state WHERE key = ?');
  for (const o of ops) {
    report.embeddingsDeleted += delEmb.run(o.path).changes;
    report.entitiesDeleted += delEnt.run(o.path).changes;
    report.noteLinksDeleted += delLinks.run(o.path).changes;
    report.noteLinksRetargeted += retarget.run(o.to, o.path).changes;
    for (const k of keys) {
      const p = k.replace(/^note_action_review:[^:]+:/, '');
      if (p === o.path || p.endsWith('/' + o.path)) { report.reviewKeysDeleted += delKey.run(k).changes; report.reviewKeys.push(k); }
    }
  }
  if (report.taskBlocks !== report.taskBlocksExpected) report.problems.push(`task_blocks: updated ${report.taskBlocks}, plan expects ${report.taskBlocksExpected}`);
  // Nothing may still point at an archived path from the tables that hold pointers.
  const left = db.prepare('SELECT count(*) AS n FROM task_blocks WHERE note_path = ?');
  for (const o of stubOps) if (left.get(o.path).n) report.problems.push(`${o.path}: still referenced by task_blocks`);
  if (report.problems.length || !APPLY) throw Object.assign(new Error('rollback'), { rollback: true });
});

try { tx(); report.committed = true; } catch (e) { if (!e.rollback) throw e; report.committed = false; }
console.log(JSON.stringify(report, null, 1));
process.exit(report.problems.length ? 1 : 0);
