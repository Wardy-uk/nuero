'use strict';

/**
 * The wiring, scanned at the source.
 *
 * ⚠⚠ WRITTEN BECAUSE MUTATION FOUND THE HOLE. Reverting `chat-context-v2` from
 * `scope: 'trusted'` to `scope: 'folder:Knowledge'` passed the entire service
 * suite AND the routing suite — 27 tests green over a change that switches the
 * whole user-visible payoff back off. Every marked note would have gone back to
 * competing with 457 Plaud transcripts for three retrieval slots, silently,
 * because the two halves each still work on their own.
 *
 * That is this codebase's commonest failure by a distance: a reader with no
 * writer, a writer with no reader, a payload field nobody renders. These are
 * source scans — crude, and the only thing that can see a join that has been
 * unplugged rather than broken.
 *
 * ⚠ Each carries a POSITIVE CONTROL, so a scan that has stopped finding the
 * file cannot pass by absence. The first draft of two tests in this repo did
 * exactly that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf-8');

test('⚠ chat context asks for the TRUSTED SET, not a folder', () => {
  const src = read('chat-context-v2.js');

  // Positive control: the curated block is still there at all.
  assert.match(src, /Curated knowledge/, 'the curated-knowledge block has gone — this scan is checking nothing');

  assert.match(src, /scope: 'trusted'/,
    'chat context must scope on the trusted set, or a note marked in place earns no privilege');

  // ⚠ The old scope must be GONE, not merely accompanied. `folder:Knowledge`
  // can only ever see notes that promotion copied there, which is Plaud and
  // Meetings — the exact blindness this change exists to remove.
  assert.equal(/scope: 'folder:Knowledge'/.test(src), false,
    'folder:Knowledge is back — every note marked in place is invisible to chat again');
});

test('⚠ the semantic arm narrows BEFORE ranking for a trusted scope', () => {
  const src = read('retrieval.js');

  // Positive control.
  assert.match(src, /function semanticSearchScoped/, 'semanticSearchScoped has gone — this scan is checking nothing');

  // Without a pathFilter the trusted scope becomes "global top N, then filter",
  // which is the documented `folder:` recall bug: a scope whose notes all rank
  // 201st and below comes back EMPTY and looks exactly like a vault where Nick
  // has marked nothing. `inScope` still keeps the results CORRECT, so this can
  // only ever fail quietly, as worse recall.
  const trustedBranch = src.slice(src.indexOf("_parsed.kind === 'trusted'"));
  assert.match(trustedBranch.slice(0, 400), /pathFilter = \(rel\) => trust\.paths\.has\(rel\)/,
    'the trusted scope must narrow the candidate set before ranking, not filter after it');
});

test('⚠ the generated index is excluded from the vault indexes', () => {
  const src = read('vault-exclusions.js');
  assert.match(src, /GENERATED_FILE_PATTERNS/, 'positive control: the pattern list has gone');
  // A page listing every knowledge note would match every query about any of
  // them and hand back a list of titles — the 1-2-1 tracker failure, on the
  // notes chat is told to PREFER.
  assert.match(src, /\^Knowledge Index/,
    'the Knowledge Index must be excluded, or it is indexed as content about itself');
});

test('⚠ the vault write hook keeps the trusted set current', () => {
  const src = read('vault-hooks.js');
  assert.match(src, /_processWrite/, 'positive control: the hook has gone');
  // Nick can mark a note by typing `knowledge_state: trusted` into it in
  // Obsidian. Without this the set only catches up on the next scheduled pass,
  // so the flag appears to do nothing for up to an hour.
  assert.match(src, /knowledge-trust/,
    'vault writes must patch the trusted set, or a hand-typed flag is invisible until the next sweep');
});

test('⚠ the scheduler rebuilds the set and renders the index', () => {
  const src = read('scheduler.js');
  assert.match(src, /cron\.schedule/, 'positive control: the scheduler has gone');
  assert.match(src, /refreshTrustedKnowledge/,
    'nothing rebuilds the trusted set, so the vault-hooks patch is the only writer and a miss is permanent');
});

test('⚠ ONE surgical frontmatter writer, and neither caller reserialises', () => {
  // obsidian.updateFrontmatter drops YAML list values. 31 notes in the live
  // vault carry an `aliases:` list and hundreds carry `people:` or `tags:`, so
  // a second, gentler writer is how one of them eats a list.
  const trust = read('knowledge-trust.js');
  const memory = read('knowledge-memory.js');

  assert.match(trust, /frontmatter-edit/, 'positive control: knowledge-trust no longer uses the shared writer');
  assert.match(memory, /frontmatter-edit/, 'knowledge-memory must delegate, or there are two writers again');

  for (const [name, src] of [['knowledge-trust', trust], ['knowledge-memory', memory]]) {
    assert.equal(/updateFrontmatter\(/.test(src), false,
      `${name} must never call updateFrontmatter — it silently drops list values`);
  }
});
