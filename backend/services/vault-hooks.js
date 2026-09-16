'use strict';

/**
 * Vault Hooks — triggered after NEURO writes to the vault.
 *
 * Performs:
 *  1. Incremental re-embedding of the changed file
 *  2. Entity re-extraction for the changed file
 *  3. Working memory cache invalidation
 *
 * All operations are fire-and-forget — failures are logged but never
 * block the caller. This keeps vault writes fast.
 */

const path = require('path');
const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

/**
 * Call after any vault write. Pass the absolute or relative path of the file.
 * Debounces rapid writes to the same file (e.g., multiple appends within 2s).
 */
const _pending = new Map(); // relativePath → timeout handle
const DEBOUNCE_MS = 2000;

function onVaultWrite(filePath, source) {
  if (!VAULT_PATH || !filePath) return;

  // Normalise to relative path
  let relativePath = filePath;
  if (path.isAbsolute(filePath)) {
    relativePath = path.relative(VAULT_PATH, filePath).replace(/\\/g, '/');
  }

  // Skip non-markdown
  if (!relativePath.endsWith('.md')) return;

  // Debounce: reset timer if same file written again quickly
  if (_pending.has(relativePath)) {
    clearTimeout(_pending.get(relativePath));
  }

  _pending.set(relativePath, setTimeout(() => {
    _pending.delete(relativePath);
    _processWrite(relativePath, source);
  }, DEBOUNCE_MS));
}

async function _processWrite(relativePath, source) {
  const fullPath = path.join(VAULT_PATH, relativePath);
  const tag = `[VaultHook:${source || 'unknown'}]`;

  // 1. Invalidate vault cache + working memory
  try {
    require('./vault-cache').invalidate(`vault write: ${relativePath}`);
  } catch {}
  try {
    const workingMemory = require('./working-memory');
    workingMemory.invalidate(`vault write: ${relativePath}`);
  } catch (e) {
    console.warn(`${tag} Working memory invalidation failed:`, e.message);
  }

  // 2. Incremental embedding update (async, non-blocking)
  try {
    const embeddings = require('./embeddings');
    if (embeddings.isConfigured()) {
      const updated = await embeddings.embedVaultFile(relativePath, fullPath);
      if (updated) {
        console.log(`${tag} Re-embedded: ${relativePath}`);
      }
    }
  } catch (e) {
    // Rate limit or API error — non-fatal, nightly rebuild will catch it
    console.warn(`${tag} Embedding update failed for ${relativePath}:`, e.message);
  }

  // 3. Entity re-extraction (sync, pattern-matching only — no API calls)
  try {
    const entities = require('./entities');
    const result = entities.processNote(relativePath);
    if (result && result.total > 0) {
      console.log(`${tag} Extracted ${result.total} entities from: ${relativePath}`);
    }
  } catch (e) {
    console.warn(`${tag} Entity extraction failed for ${relativePath}:`, e.message);
  }

  // 4. Candidate action extraction from notes
  //
  // ⚠⚠ NOT ON AN AI-ENRICHMENT WRITE. That pass appends NEURO's OWN `## Open Loops`
  // and `## Promote Next` sections, which read exactly like commitments — so
  // extracting from them is NEURO raising tasks off its own generated text, and the
  // meeting underneath was already scanned when the note first landed. Measured: a
  // three-note trial created 2 candidates per note, so enriching 100 would have put
  // ~200 into the Spotted queue. That is the 229-restamp / 911-candidate flood
  // reproduced exactly, and `vault-hooks` has no `maxCreate` cap to catch it
  // (`scanRecentNotes` has one; this path does not).
  //
  // ⚠ Only THIS step is skipped. Re-embedding and entity extraction above still run,
  // because the note's content genuinely changed and the insight text is worth
  // indexing — it is the commitment inference that must not read a machine's output
  // as a promise somebody made.
  //
  // ⚠ A GUARD, NOT AN EARLY RETURN — step 5 below still logs the write. An early
  // return here would silently stop the activity feed recording enrichment writes.
  if (source === 'knowledge-ai-enrichment') {
    console.log(`${tag} Skipped action candidates for ${relativePath} — enrichment writes NEURO's own sections`);
  } else try {
    const actionCandidates = require('./action-candidates');
    // ⚠ ExcludingNova, matching the nightly sweep (item 21). Without it a
    // NOVA-owned 1-2-1 note routed into `Meetings/` by `imports` was extracted
    // here AND by NOVA — one conversation, two systems, and the same commitment
    // in front of Nick twice. Fails open: nothing cached means nothing excluded.
    const result = actionCandidates.syncNoteActionCandidatesUnlessNova(relativePath);
    if (result.novaOwned) {
      console.log(`${tag} Left ${relativePath} to NOVA — it owns that 1-2-1 recording`);
    }
    if (result.created > 0 || result.superseded > 0) {
      console.log(
        `${tag} Synced action candidates for ${relativePath} ` +
        `(created=${result.created}, auto=${result.autoPromoted}, pending=${result.pending}, superseded=${result.superseded})`
      );
    }
  } catch (e) {
    console.warn(`${tag} Action candidate sync failed for ${relativePath}:`, e.message);
  }

  // 5. Log vault write activity
  try {
    const activity = require('./activity');
    activity.trackVaultWrite(source || relativePath);
  } catch {}
}

module.exports = { onVaultWrite };
