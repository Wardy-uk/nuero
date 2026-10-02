'use strict';

/**
 * THE ONE SURGICAL FRONTMATTER WRITER.
 *
 * ⚠⚠ NOT `obsidian.updateFrontmatter`, AND THAT IS THE WHOLE POINT. That one
 * reserialises the block line by line and SILENTLY DROPS YAML LIST VALUES — the
 * lesson paid for twice, by `people:` on meeting notes and `aliases:` on People
 * notes, where a write asking to add one key deleted every alias on the note it
 * touched. 31 notes in this vault carry an `aliases:` list and hundreds carry
 * `people:` or `tags:`, so any writer that goes near them has to be line-based.
 *
 * These two functions were written inside `knowledge-memory.js` and lived there
 * alone until `knowledge-trust.js` needed the same job. A second copy is how
 * the two come to disagree about what a safe write is, and the weaker copy is
 * then the one that eats a list — so there is one implementation and
 * `knowledge-memory` delegates to it.
 *
 * PURE: both take content and return content. No filesystem, no clock.
 */

/**
 * Set a key, adding it if absent, without touching any other line.
 *
 * The value is always quoted, which is correct for the timestamps, states and
 * paths these callers write and is NOT safe for a list — a caller wanting a
 * list must build the line itself.
 */
function upsertFrontmatterValue(content, key, value) {
  const line = `${key}: "${String(value).replace(/"/g, '\\"')}"`;
  if (!content.startsWith('---')) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const fmBlock = content.slice(0, endIdx + 3);
  const body = content.slice(endIdx + 3).replace(/^\s*/, '');
  const pattern = new RegExp(`^${key}:.*$`, 'm');
  const nextFm = pattern.test(fmBlock)
    ? fmBlock.replace(pattern, line)
    : fmBlock.replace(/---\s*$/, `${line}\n---`);
  return `${nextFm}\n\n${body}`;
}

/**
 * Drop a key from a note's frontmatter entirely.
 *
 * ⚠ Removing the LINE, never blanking the value: `knowledge_dismissed: ""`
 * still reads as present to anything testing presence, so a blanking "undo"
 * would leave the note hidden for ever with no sign of why.
 */
function removeFrontmatterKey(content, key) {
  const text = String(content || '');
  if (!text.startsWith('---')) return text;

  const endIdx = text.indexOf('---', 3);
  if (endIdx === -1) return text;

  const fmBlock = text.slice(0, endIdx + 3);
  const rest = text.slice(endIdx + 3);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = fmBlock.replace(new RegExp(`^${escaped}:.*(?:\\r?\\n)?`, 'm'), '');
  return stripped + rest;
}

module.exports = { upsertFrontmatterValue, removeFrontmatterKey };
