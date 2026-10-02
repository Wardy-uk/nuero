'use strict';

/**
 * Notes Nick wrote that look like knowledge.
 *
 * ⚠ The threshold in the service was MEASURED on the live vault, and the
 * measurement moved it: 459 notes, 54 stubs, and scores 5 and 6 holding 224 of
 * the 405 real ones. A bar of 6 offers 217 notes — half the folder, ordered by
 * nothing much, which is the pile this exists to replace. The bar sits at 8,
 * where the output is the Support Improvement Plan, the VANTAGE findings, the
 * service-desk specs and the SOPs.
 *
 * Two findings the measurement produced that reading the code would not:
 *   - `Projects/_about.md` scored 7 on FIFTEEN inbound links. A folder
 *     description outranking real write-ups because everything points at it.
 *   - the largest single arm has to be inbound links, and they must be counted
 *     once per SOURCE note or a heavily cross-referencing page mints hubs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const candidates = require('./knowledge-candidates');

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-kcand-'));
  process.env.OBSIDIAN_VAULT_PATH = root;
  candidates.invalidate();
  return root;
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/** A note that clears the bar on its own merits. */
function goodNote(title, { links = 4, tags = true, headings = 4 } = {}) {
  return [
    '---',
    `title: ${title}`,
    ...(tags ? ['tags: [support]'] : []),
    '---',
    '',
    ...Array.from({ length: headings }, (_, i) => `## Section ${i + 1}\n\nSome real prose here.`),
    Array.from({ length: links }, (_, i) => `[[Other Note ${i}]]`).join(' '),
    '',
    Array.from({ length: 700 }, (_, i) => `word${i}`).join(' '),
  ].join('\n');
}

// ── Scoring ──────────────────────────────────────────────────────────────────

test('a stub scores nothing and is marked as one', () => {
  const scored = candidates.scoreNote({ wordCount: 40, headings: 1, outboundCount: 0, tags: [], revisitedDays: 0 }, 10);
  assert.equal(scored.stub, true);
  assert.equal(scored.score, 0);
});

test('inbound links are the strongest arm', () => {
  const base = { wordCount: 700, headings: 0, outboundCount: 0, tags: [], revisitedDays: 0 };
  const alone = candidates.scoreNote(base, 0).score;
  const hub = candidates.scoreNote(base, 8).score;
  // A note several others point at is one Nick keeps returning to, and it is
  // the one signal no amount of writing can fake from inside a note.
  assert.equal(hub - alone, 3);
});

test('every arm is banded, so length alone cannot run away with the queue', () => {
  const base = { headings: 0, outboundCount: 0, tags: [], revisitedDays: 0 };
  const long = candidates.scoreNote({ ...base, wordCount: 700 }, 0).score;
  const enormous = candidates.scoreNote({ ...base, wordCount: 32000 }, 0).score;
  assert.equal(long, enormous);
});

test('nothing scores negative except the stub test', () => {
  // "I cannot see structure in this" is not evidence the note is worthless —
  // most of these folders predate any convention.
  const bare = candidates.scoreNote({ wordCount: 300, headings: 0, outboundCount: 0, tags: [], revisitedDays: null }, 0);
  assert.ok(bare.score > 0);
  assert.equal(bare.stub, false);
});

// ── The scan ─────────────────────────────────────────────────────────────────

test('it reads the folders the promotion queue and the task scanner both skip', () => {
  const root = makeVault();
  write(root, 'Projects/Good.md', goodNote('Good'));
  write(root, 'Meetings/2026/09/Recording.md', goodNote('Recording'));
  write(root, 'Plaud/Transcripts/Raw.md', goodNote('Raw'));

  const result = candidates.candidates({ minScore: 0 });
  const paths = result.candidates.map((c) => c.path);

  assert.ok(paths.includes('Projects/Good.md'));
  // Meetings and Plaud belong to knowledge-memory's promotion queue. A note is
  // raw material or a write-up, never offered as both.
  assert.equal(paths.some((p) => p.startsWith('Meetings/')), false);
  assert.equal(paths.some((p) => p.startsWith('Plaud/')), false);
});

test('⚠ _about.md is never offered, however many notes point at it', () => {
  const root = makeVault();
  write(root, 'Projects/_about.md', goodNote('About'));
  // Fifteen inbound links, exactly the live case.
  for (let i = 0; i < 15; i += 1) write(root, `Projects/Linker ${i}.md`, '---\n---\n\n[[_about]]\n');

  const result = candidates.candidates({ minScore: 0 });
  assert.equal(result.candidates.some((c) => c.path === 'Projects/_about.md'), false);
});

test('⚠ inbound links count once per SOURCE note', () => {
  const root = makeVault();
  write(root, 'Projects/Target.md', goodNote('Target'));
  // One note pointing six times is ONE note pointing at it. Letting repeats
  // accumulate mints a hub out of a single cross-referencing page.
  write(root, 'Projects/Heavy.md', `---\n---\n\n${Array.from({ length: 6 }, () => '[[Target]]').join(' ')}\n`);

  const result = candidates.candidates({ minScore: 0 });
  const target = result.candidates.find((c) => c.path === 'Projects/Target.md');
  assert.equal(target.inbound, 1);
});

test('inbound links are counted from the WHOLE vault, not just the candidate folders', () => {
  const root = makeVault();
  write(root, 'Projects/Target.md', goodNote('Target'));
  // A Projects note linked from thirty meeting notes is the clearest hub in the
  // vault; a link map scoped to the candidates would score it an orphan.
  write(root, 'Meetings/2026/09/A.md', '---\n---\n\n[[Target]]\n');
  write(root, 'Meetings/2026/09/B.md', '---\n---\n\n[[Target]]\n');

  const result = candidates.candidates({ minScore: 0 });
  assert.equal(result.candidates.find((c) => c.path === 'Projects/Target.md').inbound, 2);
});

// ── What is withheld ─────────────────────────────────────────────────────────

test('an already-trusted note leaves the queue, and a dismissed one stays out', () => {
  const root = makeVault();
  write(root, 'Projects/Trusted.md', goodNote('Trusted').replace('---\n\n', '---\n\n'));
  write(root, 'Projects/Trusted.md', `---\ntitle: T\nknowledge_state: trusted\n---\n\n${goodNote('T')}`);
  write(root, 'Projects/Dismissed.md', `---\ntitle: D\nknowledge_dismissed: "2026-09-01"\n---\n\n${goodNote('D')}`);
  write(root, 'Projects/Open.md', goodNote('Open'));

  const result = candidates.candidates({ minScore: 0 });
  const paths = result.candidates.map((c) => c.path);

  assert.equal(paths.includes('Projects/Trusted.md'), false);
  assert.equal(paths.includes('Projects/Dismissed.md'), false);
  assert.ok(paths.includes('Projects/Open.md'));
  assert.equal(result.withheld.trusted, 1);
  assert.equal(result.withheld.dismissed, 1);
});

test('⚠ everything withheld is COUNTED — a filter nobody can check is noise', () => {
  const root = makeVault();
  // Three inbound links is what takes a good write-up over the bar, and that is
  // the scorer working as measured rather than a fixture convenience: length,
  // structure and tags together reach 6, and 224 of the live vault's 405 real
  // notes sit at 5 or 6. What separates the top 50 is other notes pointing at
  // them.
  write(root, 'Projects/Good.md', goodNote('Good'));
  for (const n of ['A', 'B', 'C']) write(root, `Meetings/2026/09/${n}.md`, '---\n---\n\n[[Good]]\n');
  write(root, 'Projects/Stub.md', '---\n---\n\nToo short.\n');
  write(root, 'Projects/Middling.md', `---\n---\n\n${Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ')}\n`);

  const result = candidates.candidates({ minScore: 8 });

  // people-gap's rule: three candidates out of four hundred notes with no
  // account of the other 397 is a list nobody can check.
  assert.equal(result.considered, 3);
  assert.equal(result.matched, 1);
  assert.equal(result.withheld.stub, 1);
  assert.equal(result.withheld.belowBar, 1);
  assert.equal(result.matched + result.withheld.stub + result.withheld.belowBar
    + result.withheld.trusted + result.withheld.dismissed, result.considered);
});

test('a good write-up with NOTHING pointing at it does not clear the bar', () => {
  const root = makeVault();
  // Measured: length + structure + tags reaches 6, and 224 of 405 real notes in
  // the live vault sit at 5 or 6. Offering those is offering the whole folder,
  // which is the pile this replaces.
  write(root, 'Projects/Orphan.md', goodNote('Orphan'));
  const result = candidates.candidates({ minScore: 8 });
  assert.equal(result.matched, 0);
  assert.equal(result.withheld.belowBar, 1);
});

test('⚠ an unreadable vault is a NAMED GAP, never an empty list', () => {
  process.env.OBSIDIAN_VAULT_PATH = '';
  candidates.invalidate();
  const result = candidates.candidates();
  // A partly-read vault offering nothing reads exactly like a vault with
  // nothing in it.
  assert.equal(result.known, false);
  assert.ok(result.reasons.length > 0);
});

test('nothing is persisted — there is no queue to flood', () => {
  const root = makeVault();
  write(root, 'Projects/Good.md', goodNote('Good'));

  candidates.candidates({ minScore: 0 });
  candidates.candidates({ minScore: 0, force: true });

  // action-candidates needed maxCreate after 911 rows landed in one night.
  // These are computed on read, so the failure mode does not exist: the vault
  // is byte-identical and nothing was written anywhere.
  const files = fs.readdirSync(path.join(root, 'Projects'));
  assert.deepEqual(files, ['Good.md']);
});

test('the offer is capped and says how many it did not show', () => {
  const root = makeVault();
  for (let i = 0; i < 8; i += 1) write(root, `Projects/Note ${i}.md`, goodNote(`Note ${i}`));

  const result = candidates.candidates({ minScore: 0, limit: 3 });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.shown, 3);
  assert.equal(result.matched, 8);
});

test('⚠ tags are read from the FRONTMATTER, not just body hashtags', () => {
  // Measured on the live vault: 164 notes in the candidate folders tag in
  // frontmatter against 16 in the body. `obsidian.extractTags` reads the body
  // only, so the original arm scored 90% of tagged notes untagged — no error,
  // just a plausible wrong number, which is the `sleep_core_hours` species.
  assert.deepEqual(candidates.readTags('---\ntags: [support, ops]\n---\n\nb'), ['support', 'ops']);
  // Both YAML shapes are live and parseFrontmatter returns '' for the block
  // form, so the block is read directly.
  assert.deepEqual(candidates.readTags('---\ntags:\n  - support\n  - ops\n---\n\nb'), ['support', 'ops']);
  assert.deepEqual(candidates.readTags('---\n---\n\nbody #support'), ['support']);
  assert.deepEqual(candidates.readTags('---\ntitle: x\n---\n\nbody'), []);
});

test('a frontmatter-tagged note scores the tag arm', () => {
  const root = makeVault();
  const body = `\n${Array.from({ length: 700 }, (_, i) => `w${i}`).join(' ')}\n`;
  write(root, 'Projects/Tagged.md', `---\ntitle: T\ntags: [support]\n---\n${body}`);
  write(root, 'Projects/Untagged.md', `---\ntitle: U\n---\n${body}`);

  const result = candidates.candidates({ minScore: 0 });
  const tagged = result.candidates.find((c) => c.path === 'Projects/Tagged.md');
  const untagged = result.candidates.find((c) => c.path === 'Projects/Untagged.md');
  assert.equal(tagged.score - untagged.score, 1);
});
