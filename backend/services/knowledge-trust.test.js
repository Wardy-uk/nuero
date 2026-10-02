'use strict';

/**
 * Marking a note as knowledge, in place.
 *
 * The finding this pins (26 Sep 2026): the knowledge feature only ever read
 * Plaud and Meetings, so the 332 notes under `Projects/` and everything like
 * them could never become curated knowledge — not judged and rejected, simply
 * never looked at. Four notes had ever been promoted and all four were meeting
 * recordings.
 *
 * The rules here are all rules about NOT LYING, because every one of them fails
 * silently if it is wrong:
 *
 *   - unknown is not empty        a lookup that never ran must not read as
 *                                 "Nick has curated nothing"
 *   - a partial walk is not stored  or it silently un-trusts what it missed
 *   - the index is not knowledge  a rendering of the set is not a member of it
 *   - un-trusting a Knowledge/ note is REFUSED, not reported as done
 *   - a list value survives a mark  the `aliases:`/`people:` lesson
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const trust = require('./knowledge-trust');

// ── Temp vault ───────────────────────────────────────────────────────────────

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-trust-'));
  process.env.OBSIDIAN_VAULT_PATH = root;
  return root;
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

// ── Pure predicates ──────────────────────────────────────────────────────────

test('a note under Knowledge/ is trusted by location', () => {
  assert.equal(trust.trustedByLocation('Knowledge/Nurtur/SOP.md'), true);
  assert.equal(trust.trustedByLocation('Projects/Support Hub/SOP.md'), false);
  // Segment-aware: a sibling folder sharing the prefix is not inside it.
  assert.equal(trust.trustedByLocation('Knowledge-old/x.md'), false);
});

test('a note is trusted by its own flag, wherever it lives', () => {
  assert.equal(trust.trustedByFlag({ knowledge_state: 'trusted' }), true);
  // plaud-sync writes frontmatter values QUOTED, and a bare === comparison
  // against the raw value is the trap this codebase has hit three times.
  assert.equal(trust.trustedByFlag({ knowledge_state: '"trusted"' }), true);
  assert.equal(trust.trustedByFlag({ knowledge_state: 'DISTILLED' }), true);
  assert.equal(trust.trustedByFlag({ knowledge_state: 'raw' }), false);
  assert.equal(trust.trustedByFlag({}), false);
});

test('the generated index is NEVER trusted, even though it sits in Knowledge/', () => {
  // It qualifies by location, so the refusal has to come first. A rendering of
  // the set that is also a member of it would be returned as curated knowledge
  // about itself — a page of titles matching every query about any of them.
  assert.equal(trust.trustedByLocation(trust.INDEX_PATH), true);
  assert.equal(trust.isTrustedNote(trust.INDEX_PATH, { knowledge_state: 'trusted' }), false);
  assert.equal(trust.isTrustedNote('Knowledge/Nurtur/SOP.md', {}), true);
});

test('domain comes from frontmatter first, then the path', () => {
  assert.equal(trust.domainOf('Projects/NEURO/x.md', { knowledge_domain: 'Nurtur' }), 'Nurtur');
  assert.equal(trust.domainOf('Knowledge/Health/x.md', {}), 'Health');
  assert.equal(trust.domainOf('Projects/NEURO/x.md', {}), 'Projects');
  assert.equal(trust.domainOf('loose.md', {}), 'General');
});

// ── Marking ──────────────────────────────────────────────────────────────────

test('marking writes three lines and creates no file', () => {
  const root = makeVault();
  write(root, 'Projects/NEURO/Design.md', '---\ntitle: Design\n---\n\nBody text.\n');
  const before = fs.readdirSync(path.join(root, 'Projects/NEURO'));

  const result = trust.markTrusted({ path: 'Projects/NEURO/Design.md', domain: 'Nurtur' });

  assert.equal(result.status, 'ok');
  assert.equal(result.already, false);
  assert.equal(result.domain, 'Nurtur');

  const after = read(root, 'Projects/NEURO/Design.md');
  assert.match(after, /knowledge_state: "trusted"/);
  assert.match(after, /knowledge_domain: "Nurtur"/);
  assert.match(after, /knowledge_trusted_at: "/);
  assert.match(after, /Body text\./);

  // ⚠ NOTHING IS COPIED. That is the entire difference from promoteCandidate,
  // which writes a new note under Knowledge/.
  assert.deepEqual(fs.readdirSync(path.join(root, 'Projects/NEURO')), before);
  assert.equal(fs.existsSync(path.join(root, 'Knowledge')), false);
});

test('⚠ marking does not eat a YAML list — the aliases/people lesson', () => {
  const root = makeVault();
  // obsidian.updateFrontmatter reserialises and silently drops these. 31 notes
  // in the live vault carry an aliases list and hundreds carry people/tags, so
  // a writer that goes near them has to be line-based.
  write(root, 'People/Naomi Wentworth.md', [
    '---',
    'title: Naomi Wentworth',
    'aliases:',
    '  - Naomi Winkworth',
    '  - Naomi W',
    'people:',
    '  - "[[People/Nick Ward]]"',
    '---',
    '',
    'Body.',
  ].join('\n'));

  trust.markTrusted({ path: 'People/Naomi Wentworth.md' });

  const after = read(root, 'People/Naomi Wentworth.md');
  assert.match(after, /- Naomi Winkworth/);
  assert.match(after, /- Naomi W\b/);
  assert.match(after, /- "\[\[People\/Nick Ward\]\]"/);
  assert.match(after, /knowledge_state: "trusted"/);
});

test('marking twice is a success, not an error', () => {
  const root = makeVault();
  write(root, 'Projects/a.md', '---\ntitle: A\n---\n\nBody.\n');
  trust.markTrusted({ path: 'Projects/a.md' });
  const second = trust.markTrusted({ path: 'Projects/a.md' });
  // A repeated press that reports failure reads as a broken control.
  assert.equal(second.status, 'ok');
  assert.equal(second.already, true);
});

test('a note the knowledge index could never return is REFUSED, with the reason', () => {
  const root = makeVault();
  write(root, 'Daily/2026-09-26.md', '---\n---\n\nBody.\n');
  write(root, 'Archive/old.md', '---\n---\n\nBody.\n');

  // Both are excluded from the embedding index, so marking one would write a
  // flag into a note no search can ever return — a button reporting success and
  // changing nothing.
  for (const p of ['Daily/2026-09-26.md', 'Archive/old.md']) {
    const result = trust.markTrusted({ path: p });
    assert.equal(result.status, 'error', p);
    assert.match(result.error, /no effect/);
  }

  assert.equal(trust.markTrusted({ path: trust.INDEX_PATH }).status, 'error');
  assert.equal(trust.markTrusted({ path: 'Projects/missing.md' }).status, 'error');
});

test('⚠ Personal/ is NOT refused — it is sensitive WORK material and stays searchable', () => {
  const root = makeVault();
  write(root, 'Personal/OH Report.md', '---\ntitle: OH\n---\n\nBody long enough.\n');
  // vault-exclusions has already decided this folder stays in embeddings
  // because "this is Nick's own brain and he must be able to ask it about his
  // own OH report". Refusing here would overrule that from a second place.
  assert.equal(trust.markTrusted({ path: 'Personal/OH Report.md' }).status, 'ok');
});

// ── Un-marking ───────────────────────────────────────────────────────────────

test('un-marking removes the lines rather than blanking them', () => {
  const root = makeVault();
  write(root, 'Projects/a.md', '---\ntitle: A\n---\n\nBody.\n');
  trust.markTrusted({ path: 'Projects/a.md' });

  const result = trust.unmarkTrusted({ path: 'Projects/a.md' });
  assert.equal(result.status, 'ok');

  const after = read(root, 'Projects/a.md');
  // Blanking leaves `knowledge_state: ""`, which still reads as present to
  // anything testing presence.
  assert.equal(/knowledge_state/.test(after), false);
  assert.equal(/knowledge_trusted_at/.test(after), false);
  assert.match(after, /title: A/);
});

test('⚠⚠ un-marking a Knowledge/ note is REFUSED and says why', () => {
  const root = makeVault();
  write(root, 'Knowledge/Nurtur/SOP.md', '---\nknowledge_state: distilled\n---\n\nBody.\n');

  const result = trust.unmarkTrusted({ path: 'Knowledge/Nurtur/SOP.md' });

  // Stripping the flag would leave it trusted BY LOCATION, so the button would
  // appear to work and the note would go on being preferred in chat — the
  // silent half-success this codebase keeps removing.
  assert.equal(result.status, 'error');
  assert.equal(result.trustedBy, 'location');
  assert.match(result.error, /Move it out/);
  assert.match(read(root, 'Knowledge/Nurtur/SOP.md'), /knowledge_state/);
});

// ── The scan ─────────────────────────────────────────────────────────────────

test('the scan finds both kinds of trusted note and excludes the index', () => {
  const root = makeVault();
  write(root, 'Knowledge/Nurtur/Promoted.md', '---\nknowledge_state: distilled\n---\n\nBody.\n');
  write(root, 'Projects/Marked.md', '---\nknowledge_state: "trusted"\n---\n\nBody.\n');
  write(root, 'Projects/Plain.md', '---\ntitle: Plain\n---\n\nBody.\n');
  write(root, trust.INDEX_PATH, '---\n---\n\nIndex.\n');

  const scan = trust.scanTrusted();

  assert.equal(scan.known, true);
  assert.deepEqual(scan.paths.sort(), ['Knowledge/Nurtur/Promoted.md', 'Projects/Marked.md']);
  assert.equal(scan.notes.find((n) => n.path === 'Projects/Marked.md').by, 'flag');
  assert.equal(scan.notes.find((n) => n.path === 'Knowledge/Nurtur/Promoted.md').by, 'location');
});

test('an unconfigured vault is known:false, never an empty answer', () => {
  process.env.OBSIDIAN_VAULT_PATH = '';
  const scan = trust.scanTrusted();
  assert.equal(scan.known, false);
  assert.ok(scan.reasons.length > 0);
});

// ── The index ────────────────────────────────────────────────────────────────

test('the index carries links and never the notes it lists', () => {
  const body = trust.renderIndexBody([
    { path: 'Projects/NEURO/Design.md', title: 'Design', domain: 'Nurtur', by: 'flag' },
    { path: 'Knowledge/Health/Eyes.md', title: 'Eyes', domain: 'Health', by: 'location' },
  ], new Date('2026-09-26T10:00:00Z'));

  assert.match(body, /## Health/);
  assert.match(body, /## Nurtur/);
  assert.match(body, /\[\[Projects\/NEURO\/Design\|Design\]\]/);
  assert.ok(body.startsWith(trust.INDEX_OPEN));
  assert.ok(body.trimEnd().endsWith(trust.INDEX_CLOSE));
});

test('⚠ rendering is SURGICAL — anything outside the markers survives', () => {
  const root = makeVault();
  write(root, trust.INDEX_PATH, [
    '---',
    'title: Knowledge Index',
    '---',
    '',
    '# Knowledge Index',
    '',
    trust.INDEX_OPEN,
    'old generated content',
    trust.INDEX_CLOSE,
    '',
    '## My own notes',
    '',
    'Something Nick wrote here.',
  ].join('\n'));

  trust.renderIndex({
    apply: true,
    notes: [{ path: 'Projects/a.md', title: 'A', domain: 'Projects', by: 'flag' }],
  });

  const after = read(root, trust.INDEX_PATH);
  assert.match(after, /Something Nick wrote here\./);
  assert.match(after, /## My own notes/);
  assert.equal(/old generated content/.test(after), false);
  assert.match(after, /\[\[Projects\/a\|A\]\]/);
});

test('⚠ an unchanged render writes NOTHING — no mtime churn', () => {
  const root = makeVault();
  const notes = [{ path: 'Projects/a.md', title: 'A', domain: 'Projects', by: 'flag' }];

  trust.renderIndex({ apply: true, notes });
  const first = read(root, trust.INDEX_PATH);

  const second = trust.renderIndex({ apply: true, notes });

  // Touching the file every pass moves its mtime into every recent-notes scan —
  // the #78 lesson, where one automation's bulk restamp triggered another's
  // flood. Note the date line is part of the body, so this also proves the
  // render is stable within a day.
  assert.equal(second.changed, false);
  assert.equal(read(root, trust.INDEX_PATH), first);
});

test('a partial walk never renders the index', () => {
  process.env.OBSIDIAN_VAULT_PATH = '';
  const result = trust.renderIndex({ apply: true });
  // An index missing whatever the walk could not reach is indistinguishable
  // from one where Nick un-marked those notes.
  assert.equal(result.status, 'error');
});
