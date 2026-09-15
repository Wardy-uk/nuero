'use strict';

/**
 * What things were called before the SARA → SAiM rename (15 Sep 2026).
 *
 * ONE place, deliberately. The rename touched three kinds of thing that exist
 * ON DISK in Nick's vault, written there by the old code and not rewritten by
 * this repo changing its mind:
 *
 *   - frontmatter keys      (`sara_ai_source_hash`, `sara_consolidated_to`, …)
 *   - markdown section headings (`## SARA Insight`, `## SARA Actions`)
 *   - frontmatter VALUES    (`managed_by: sara-knowledge-memory`)
 *
 * ⚠ A reader that knows only the new name does NOT error — it finds nothing,
 * and "nothing" is the expensive answer in every one of these cases:
 *   - an unmatched source hash re-enriches the note, which is a paid model call
 *     per note, across the whole knowledge base;
 *   - an unmatched heading appends a SECOND copy of a section that is already
 *     in the note;
 *   - an unmatched `managed_by` makes a consolidated note look unmanaged, so it
 *     gets consolidated again.
 *
 * Every helper here reads NEW FIRST and falls back to old, so a note that has
 * been rewritten since the rename never consults the legacy name.
 *
 * PURE — no DB, no filesystem, no clock.
 */

/** `saim_ai_source_hash` -> `sara_ai_source_hash`. Returns null if not a saim_ key. */
function legacyKey(key) {
  if (typeof key !== 'string' || !key.startsWith('saim_')) return null;
  return `sara_${key.slice('saim_'.length)}`;
}

/**
 * Read a frontmatter key, falling back to what it was called before the rename.
 * `fm` is the parsed frontmatter object; a missing key reads as undefined, as
 * it did before.
 */
function fmValue(fm, key) {
  if (!fm || typeof fm !== 'object') return undefined;
  const current = fm[key];
  if (current !== undefined && current !== null && current !== '') return current;
  const old = legacyKey(key);
  return old ? fm[old] : current;
}

/**
 * Both spellings of a markdown section heading, new first.
 * `headingAliases('SAiM Insight')` -> ['SAiM Insight', 'SARA Insight'].
 */
function headingAliases(name) {
  if (typeof name !== 'string') return [];
  const old = name.replace(/SAiM/g, 'SARA');
  return old === name ? [name] : [name, old];
}

/**
 * Both spellings of a frontmatter VALUE, lowercased, new first.
 * `valueAliases('saim-knowledge-memory')` -> ['saim-knowledge-memory', 'sara-knowledge-memory'].
 */
function valueAliases(value) {
  if (typeof value !== 'string') return [];
  const lower = value.toLowerCase();
  const old = lower.replace(/saim/g, 'sara');
  return old === lower ? [lower] : [lower, old];
}

/** Does `value` match `canonical` under either spelling? Case-insensitive. */
function matchesValue(value, canonical) {
  if (typeof value !== 'string') return false;
  return valueAliases(canonical).includes(value.trim().toLowerCase());
}

module.exports = { legacyKey, fmValue, headingAliases, valueAliases, matchesValue };
