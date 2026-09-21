'use strict';

/**
 * An archived note is not a write target, and routing never drags one back out.
 *
 * The loop this closes, evidenced on the live Pi on 21 Sep 2026:
 *
 *  1. 16 Sep: 111 duplicate notes were MOVED to
 *     `Archive/Plaud duplicates (id format change 2026-09-15)/`, keeping their
 *     `plaud_id` frontmatter.
 *  2. `buildExistingNoteIndex` walked the WHOLE vault, Archive included, so it
 *     found two notes per recording and treated the archived one as a place to
 *     write the summary. The pm2 log shows exactly that:
 *       [VaultHook:plaud-sync] Re-embedded: Archive/Plaud duplicates .../... 2.md
 *  3. That write fired the vault hooks, `imports.routePlaudSummary` routed the
 *     note back into `Meetings/YYYY/MM/`, the canonical name was already taken by
 *     the live note, and it landed as "<title> 2.md".
 *  4. Result: 117 fresh duplicates across meetings back to 8 July, and the
 *     archive folder emptied down to its own `_about.md`.
 *
 * So the 16 Sep cleanup ARMED the recurrence. Cleaning up by archiving is only
 * safe once both halves below hold — which is why they are pinned together.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-archive-loop-'));
const vault = path.join(root, 'vault');
fs.mkdirSync(path.join(vault, 'Meetings', '2026', '07'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Archive', 'Plaud duplicates (id format change 2026-09-15)'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Projects', 'Archive'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.NEURO_DB_PATH = path.join(root, 'archive-loop.db');

const REC = 'd47366cc77be1c824fa931f1350984a4';

function note(id, body = 'content') {
  return ['---', `plaud_id: "${id}"`, 'note_type: "summary"', '---', '', '## Summary', '', body].join('\n');
}

const LIVE = path.join(vault, 'Meetings', '2026', '07', '2026-07-08 – Weekly Meeting.md');
const ARCHIVED = path.join(vault, 'Archive', 'Plaud duplicates (id format change 2026-09-15)',
  'Meetings — 2026 — 07 — 2026-07-08 – Weekly Meeting 2.md');
const NESTED = path.join(vault, 'Projects', 'Archive', 'Old Meeting.md');

fs.writeFileSync(LIVE, note(REC, 'the live note'), 'utf-8');
fs.writeFileSync(ARCHIVED, note(REC, 'the archived duplicate'), 'utf-8');
fs.writeFileSync(NESTED, note('aaaabbbbccccddddeeeeffff00001111', 'nested archive'), 'utf-8');

const plaudSync = require('./plaud-sync');
const imports = require('./imports');

test('the existing-note index does not offer an ARCHIVED note as a write target', () => {
  assert.equal(typeof plaudSync._internal.buildExistingNoteIndex, 'function',
    'positive control: must be exported, or this test passes by absence');
  const index = plaudSync._internal.buildExistingNoteIndex();
  const entry = index[REC];
  assert.ok(entry, 'the live note must still be indexed');
  const all = [...(entry.summaries || []), ...(entry.transcripts || [])];
  assert.equal(all.length, 1, 'only the live note may be a write target');
  assert.ok(all[0].startsWith('Meetings/'), `expected the live note, got ${all[0]}`);
});

test('the vault walk skips retired directories at ANY depth', () => {
  assert.equal(typeof plaudSync._internal.readMarkdownFiles, 'function',
    'positive control: must be exported, or this test passes by absence');
  const files = plaudSync._internal.readMarkdownFiles(vault);
  const rel = files.map((f) => path.relative(vault, f).split(path.sep).join('/'));
  assert.ok(rel.includes('Meetings/2026/07/2026-07-08 – Weekly Meeting.md'), 'live notes must be walked');
  assert.ok(!rel.some((r) => r.startsWith('Archive/')), 'top-level Archive must be skipped');
  assert.ok(!rel.some((r) => r.includes('/Archive/')), 'a nested Archive must be skipped too');
});

test('routing REFUSES to move a note out of Archive', async () => {
  const result = await imports.routePlaudSummary(ARCHIVED, {});
  assert.equal(result.status, 'skipped', 'an archived note must not be routed');
  assert.equal(result.reason, 'archived');
  assert.ok(fs.existsSync(ARCHIVED), 'and it must still be there afterwards');
  // The whole point: no new duplicate appears beside the live note.
  const meetings = fs.readdirSync(path.join(vault, 'Meetings', '2026', '07'));
  assert.equal(meetings.length, 1, `archiving must not mint a twin, found: ${meetings.join(', ')}`);
});

test('routing a note that is NOT archived is not affected', async () => {
  // Positive control: the guard must not refuse everything, or the test above
  // would pass with routing switched off entirely.
  const result = await imports.routePlaudSummary(LIVE, {});
  assert.notEqual(result.status, 'skipped', 'a live note must still be routable');
});
