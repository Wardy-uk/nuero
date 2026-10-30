#!/usr/bin/env node
'use strict';

/**
 * Retire pending meeting candidates the CURRENT extractor no longer raises.
 *
 * On 30 Oct 2026 the extractor learned to read PLAUD's `**@Owner**` blocks, so other
 * people's actions stopped being offered as "Unassigned". The rows it had already
 * queued stay pending, because a note is only re-read when its BODY changes. This
 * re-runs extraction over each pending row's source note and supersedes the rows it
 * no longer produces — the same thing `syncNoteActionCandidates`' own loop does.
 *
 * ⚠ `superseded`, never `rejected`: Nick decided nothing, and his rejection history
 * must not be padded with NEURO's housekeeping.
 * ⚠ Meeting-action rows only, and a note that cannot be read is LEFT ALONE — absence
 * of a note is not evidence its actions were someone else's.
 *
 * Dry run by default; --apply to write.
 */

const fs = require('fs');
const path = require('path');
const db = require(path.join(__dirname, '..', 'db', 'database'));
const { extractMeetingActions } = require(path.join(__dirname, '..', 'services', 'action-candidates'));

const apply = process.argv.includes('--apply');
const VAULT = process.env.OBSIDIAN_VAULT_PATH || '';

async function main() {
  if (!VAULT || !path.isAbsolute(VAULT) || !fs.existsSync(VAULT)) {
    console.error(`[owner-blocks] Vault not readable at "${VAULT}". Refusing.`);
    process.exit(1);
  }
  await db.init();

  const pending = db.getPendingSaimActionsByType('capture_todo', 10000)
    .filter((a) => a.payload && a.payload.extractedFrom === 'meeting-action' && a.payload.sourcePath);

  const byNote = new Map();
  for (const a of pending) {
    if (!byNote.has(a.payload.sourcePath)) byNote.set(a.payload.sourcePath, []);
    byNote.get(a.payload.sourcePath).push(a);
  }

  let retire = 0, keep = 0, unreadable = 0;
  for (const [rel, actions] of byNote) {
    let text;
    try { text = fs.readFileSync(path.join(VAULT, rel), 'utf-8'); } catch { unreadable += actions.length; continue; }
    const active = new Set(extractMeetingActions(text, rel).map((c) => c.focusItemId));
    for (const a of actions) {
      if (active.has(a.focus_item_id)) { keep += 1; continue; }
      retire += 1;
      console.log(`${apply ? 'SUPERSEDE' : 'would supersede'} #${a.id}  ${a.payload.text}`);
      if (apply) db.updateSaimActionStatus(a.id, 'superseded');
    }
  }
  console.log(`\npending meeting candidates: ${pending.length} · retire ${retire} · keep ${keep} · unreadable note ${unreadable}${apply ? '' : '  (dry run)'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
