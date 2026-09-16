'use strict';

/**
 * The promotion queue: what it offers, and why.
 *
 * Pins the three faults found on 16 Sep 2026, all of which were invisible from the
 * screen because each produced a plausible wrong answer rather than an error:
 *
 *   1. The queue offered the RAW TRANSCRIPT and hid the distilled summary it came
 *      from. `Plaud/Summaries/` scored +5 and holds ONE file (imports.js routes every
 *      summary into `Meetings/YYYY/MM/`, where 263 live and scored +2), and the
 *      tie-breaker that would have flipped it — `summary_type` — is a key on ZERO
 *      notes in this vault. Live pair: transcript 8, its own summary 7.
 *   2. The card rendered `excerpt(content, 260)`, which for a PLAUD note is the title,
 *      the title again as a wikilink and the speaker warning — boilerplate all 347
 *      transcripts share.
 *   3. Two counts rendered the CAP beside them ("Reflection Notes 4" against 13 on
 *      disk) and "recent" reflections were readdir order, i.e. the oldest.
 *
 * The signal fixtures are the FOUR layouts PLAUD actually emits, copied from live
 * notes. Invented fixtures would have agreed with the first implementation, which knew
 * only one of them and reported zero topics for the rest.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const km = require('./knowledge-memory');

// --- fixtures: the four live layouts -------------------------------------------------

// A: `## Meeting Notes` with `- Topic Title:` / `- Conclusion:` (43 notes)
const LAYOUT_A = [
  '# 09-14 Weekly Meeting',
  '',
  'Summary: [[Meetings/2026/09/2026-09-14 something]]',
  '',
  '## Meeting Notes',
  '- Topic Title: Sprint planning status and reporting issues',
  '  - Teams are starting and finishing items.',
  '  - Conclusion: Planning discipline is weak.',
  '- Topic Title: Agentic brain planning',
  '  - Conclusion: The agentic planner requires targeted improvements.',
  '',
  '## Next Arrangements',
  '- [ ] Liam to tweak the planning logic.',
  '- [ ] Automate sprint start.',
  '- [ ] Redesign the sprint report.',
  '',
  '## Mentioned',
  '- [[People/Chris Middleton]]'
].join('\n');

// B: `### Meeting Notes` nested under `## Summary`, topics as bare `**X**` (15 notes)
const LAYOUT_B = [
  '# 08-26 Meeting',
  '',
  '## Summary',
  '',
  '> Date: 2026-08-26',
  '### Meeting Notes',
  '**Omnichannel Platform and WhatsApp Integration**',
  '- The team discussed the platform.',
  '**New and Future Platform Features**',
  '- Repeat calendar booking.',
  '### Next Arrangements',
  '- [ ] Clarify the pricing model with Rich.',
  '- [ ] Send marketing materials to the lawyer.',
  '### AI Suggestions',
  '> **AI Suggestions**',
  '',
  '## Mentioned'
].join('\n');

// C: `## Meeting Notes` whose topics are `### **Bold**` SUBHEADINGS (11 notes).
// This is the one that broke the section boundary.
const LAYOUT_C = [
  '# 09-08 Meeting',
  '',
  '## Meeting Notes',
  '### **Team Performance, Process Breakdowns, and Leadership**',
  '- Detail one.',
  '### **Defining Support Scope**',
  '- Detail two.',
  '### **AI Adoption and Measurement**',
  '- Detail three.',
  '',
  '## Next Arrangements',
  '- [ ] Something to do.',
  '',
  '## Mentioned'
].join('\n');

// D: the Consultation layout — no Meeting Notes, no Next Arrangements (9 / 15 notes)
const LAYOUT_D = [
  '# 09-13 Consultation',
  '',
  '## Summary',
  '',
  'Date & Time: 2026-09-13 14:10:08',
  '## Overview',
  'The consultation covers multiple trial contact lenses. His primary goal is outdoor use.',
  '## Background',
  'Prescription includes astigmatism.',
  '## Next Steps',
  '- Nick will contact the lens colleague.',
  '- The consultant will update the prescription.',
  '> **AI Suggestions**',
  '> 1. **Introduce Toric Multifocal Lenses:** something.',
  '',
  '## Mentioned'
].join('\n');

function noteFrom(content, frontmatter = {}, extra = {}) {
  return {
    path: 'Meetings/2026/09/note.md',
    name: 'note',
    folder: 'Meetings/2026/09',
    modified: '2026-09-14T10:00:00.000Z',
    wordCount: 900,
    links: 2,
    tags: [],
    content,
    frontmatter,
    ...extra
  };
}

// --- the ranking ---------------------------------------------------------------------

test('a distilled summary outranks the raw transcript it came from', () => {
  // The live 2026-09-14 pair. Under the old scorer these were 8 and 7 THE WRONG WAY UP.
  const transcript = noteFrom('# T\n\n## Transcript\n\nSpeaker 1 said things.', {
    note_type: 'transcript',
    source: 'PLAUD',
    plaud_id: 'of_a9bf223d6fa5587fd07b3f2f485878b8'
  }, { path: 'Plaud/Transcripts/2026-09-14 weekly.md', folder: 'Plaud/Transcripts', wordCount: 11820 });

  const summary = noteFrom(LAYOUT_A, {
    note_type: 'summary',
    plaud_summary_type: 'auto_sum_note',
    source: 'PLAUD',
    plaud_id: 'a9bf223d6fa5587fd07b3f2f485878b8'
  }, { path: 'Meetings/2026/09/2026-09-14 weekly.md', wordCount: 2081 });

  assert.ok(
    km.scorePromotionCandidate(summary) > km.scorePromotionCandidate(transcript),
    'the write-up must beat the recording'
  );
});

test('a transcript whose summary exists is superseded, across the of_ id change', () => {
  const transcript = noteFrom('# T', {
    note_type: 'transcript',
    plaud_id: 'of_a9bf223d6fa5587fd07b3f2f485878b8'
  }, { path: 'Plaud/Transcripts/x.md', folder: 'Plaud/Transcripts' });

  const summary = noteFrom(LAYOUT_A, {
    note_type: 'summary',
    plaud_id: 'a9bf223d6fa5587fd07b3f2f485878b8'
  });

  const index = km.indexSummariesByRecording([transcript, summary]);

  // The join is the CANONICAL id: the two spellings are one recording.
  assert.equal(km.supersedingSummary(transcript, index), summary.path);
  // A summary never supersedes itself.
  assert.equal(km.supersedingSummary(summary, index), '');

  const penalised = { ...transcript, supersededBy: summary.path };
  assert.ok(km.scorePromotionCandidate(penalised) < km.scorePromotionCandidate(transcript));
});

test('a transcript with no summary is NOT penalised', () => {
  // Penalised, never filtered — and only when there is real evidence of a write-up.
  const transcript = noteFrom('# T', {
    note_type: 'transcript',
    plaud_id: 'of_deadbeefdeadbeefdeadbeef'
  }, { path: 'Plaud/Transcripts/x.md', folder: 'Plaud/Transcripts' });

  const index = km.indexSummariesByRecording([transcript]);
  assert.equal(km.supersedingSummary(transcript, index), '');
});

test('NEGATIVE: summary_type is not the key — plaud_summary_type is', () => {
  // `summary_type` is on ZERO notes in this vault and `plaud_summary_type` on 2,326.
  // A scorer reading the dead key cannot tell a summary from anything else.
  const deadKey = noteFrom(LAYOUT_A, { summary_type: 'auto_sum_note' });
  const realKey = noteFrom(LAYOUT_A, { plaud_summary_type: 'auto_sum_note' });

  assert.equal(km.isSummaryNote(deadKey), false, 'the dead key must not identify a summary');
  assert.equal(km.isSummaryNote(realKey), true);
});

test('a note already promoted drops out of contention', () => {
  const note = noteFrom(LAYOUT_A, { note_type: 'summary' });
  const promoted = { ...note, promotedTo: 'Knowledge/Meetings/x.md' };
  assert.ok(km.scorePromotionCandidate(promoted) < km.scorePromotionCandidate(note));
});

// --- the signal ----------------------------------------------------------------------

test('layout A: topics, conclusion and open follow-ups', () => {
  const signal = km.promotionSignal(noteFrom(LAYOUT_A, { duration_ms: '3062000' }));
  assert.equal(signal.topics, 2);
  assert.equal(signal.openFollowUps, 3);
  assert.equal(signal.durationMinutes, 51, 'a QUOTED duration_ms must still parse');
  assert.match(signal.conclusion, /Planning discipline is weak/);
});

test('layout B: an h3 section nested under Summary is still read', () => {
  const signal = km.promotionSignal(noteFrom(LAYOUT_B, { duration_ms: 1320000 }));
  assert.equal(signal.topics, 2);
  assert.equal(signal.openFollowUps, 2);
  assert.deepEqual(signal.topicNames.slice(0, 1), ['Omnichannel Platform and WhatsApp Integration']);
});

test('layout C: a bold SUBHEADING does not end the section it is inside', () => {
  // The boundary bug: `## Meeting Notes` followed by `### **X**` ended immediately,
  // so 11 long meetings reported zero topics while their follow-ups counted fine.
  const signal = km.promotionSignal(noteFrom(LAYOUT_C, {}));
  assert.equal(signal.topics, 3);
  assert.equal(signal.openFollowUps, 1);
  assert.ok(
    signal.topicNames.every(name => !name.includes('*')),
    'bold markers must be stripped from a topic name'
  );
});

test('layout D: the Consultation template reports next steps, not follow-ups', () => {
  const signal = km.promotionSignal(noteFrom(LAYOUT_D, {}));
  assert.equal(signal.openFollowUps, 0, 'plain bullets are not ticked boxes');
  assert.equal(signal.nextSteps, 2);
  assert.match(signal.conclusion, /trial contact lenses/);
  assert.ok(
    !/open follow-up/.test(signal.headline),
    'must not claim a tick state the note does not carry'
  );
  assert.ok(
    !/AI Suggestions|Introduce Toric/.test(JSON.stringify(signal)),
    'the blockquoted AI suggestions are not next steps'
  );
});

test('NEGATIVE: a note with no structure yields null, not an empty shape', () => {
  // Null is what lets the card fall back to the excerpt. An empty shape would render
  // as a candidate with nothing to say about it, which is the bug being fixed.
  assert.equal(km.promotionSignal(noteFrom('Just some prose, no headings.', {})), null);
});

test('the headline never states a count it did not find', () => {
  const signal = km.promotionSignal(noteFrom(LAYOUT_C, {}));
  assert.ok(!/0 /.test(signal.headline), 'a zero is omitted, never printed');
  assert.ok(!/min/.test(signal.headline), 'no duration recorded means no duration claimed');
});

// --- the section extractor ------------------------------------------------------------

test('extractSectionFlexible stops at the same level, not at any heading', () => {
  const notes = km.extractSectionFlexible(LAYOUT_C, 'Meeting Notes');
  assert.ok(notes.includes('AI Adoption and Measurement'), 'must reach the last subheading');
  assert.ok(!notes.includes('Next Arrangements'), 'must stop at the next h2');
});

test('extractSectionFlexible finds a heading at either level', () => {
  assert.ok(km.extractSectionFlexible(LAYOUT_A, 'Meeting Notes').length > 0, 'h2');
  assert.ok(km.extractSectionFlexible(LAYOUT_B, 'Meeting Notes').length > 0, 'h3');
  assert.equal(km.extractSectionFlexible(LAYOUT_A, 'Nonexistent'), '');
});

// --- dates -----------------------------------------------------------------------------

test('a candidate is dated by its own content, not by file mtime', () => {
  // Syncthing, the vault hooks and the enrichment pass all rewrite mtime, so the queue
  // was ranking a 26 Aug meeting above a 14 Sep one and calling both recent.
  const note = noteFrom(LAYOUT_A, { start_at: '"2026-09-14T08:03:45"' }, {
    modified: '2026-08-01T00:00:00.000Z'
  });
  const stamp = km.candidateTimestamp(note);
  assert.equal(stamp.when, 'note');
  assert.equal(new Date(stamp.ms).toISOString().slice(0, 10), '2026-09-14');
});

test('an undateable note falls back to mtime and SAYS it did', () => {
  const note = noteFrom(LAYOUT_A, {}, { modified: '2026-08-01T00:00:00.000Z' });
  const stamp = km.candidateTimestamp(note);
  assert.equal(stamp.when, 'file', 'a weaker signal must be visible, not hidden');
  assert.equal(new Date(stamp.ms).toISOString().slice(0, 10), '2026-08-01');
});

// --- reflections: a cap is not a measurement --------------------------------------------

test('recentReflections returns the NEWEST, and a total that is not the cap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'km-reflect-'));
  const dir = path.join(root, 'Reflections', 'Knowledge');
  fs.mkdirSync(dir, { recursive: true });

  // ⚠ THE MTIMES DELIBERATELY DISAGREE WITH THE NAMES. On the Pi these are Syncthing
  // replicas, so mtime bears no relation to the week a reflection covers — the live
  // list came back 09-14, 09-07, 08-24, 08-31 when this sorted by mtime. Giving every
  // file the SAME mtime means only the filename can produce the right order, so a
  // revert to mtime sorting cannot pass by luck.
  const days = ['2026-06-29', '2026-07-06', '2026-07-20', '2026-08-31', '2026-09-07', '2026-09-14'];
  const sameMtime = new Date('2026-09-16T12:00:00Z');
  days.forEach((day) => {
    const file = path.join(dir, `${day} - Knowledge Reflection.md`);
    fs.writeFileSync(file, `# Knowledge Reflection — ${day}\n\nbody\n`, 'utf-8');
    fs.utimesSync(file, sameMtime, sameMtime);
  });

  const previous = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    const result = km.recentReflections(4);
    assert.equal(result.total, 6, 'the total is what is on disk, never the cap');
    assert.equal(result.items.length, 4);
    assert.ok(result.items[0].name.startsWith('2026-09-14'), 'newest first, not readdir order');
    assert.deepEqual(
      result.items.map(item => item.name.slice(0, 10)),
      ['2026-09-14', '2026-09-07', '2026-08-31', '2026-07-20'],
      'strictly newest-first by the date in the NAME, with identical mtimes'
    );
    assert.ok(
      !result.items.some(item => item.name.startsWith('2026-06-29')),
      'the oldest must not appear in a list headed "recent"'
    );
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- the shared line ---------------------------------------------------------------------

test('the Monday note and the card describe a candidate identically', () => {
  // One describer, two surfaces — the describeCandidateSource rule. Two copies is how
  // the reflection note and the Insights card come to say different things.
  const candidate = {
    excerpt: 'boilerplate that must not win',
    signal: km.promotionSignal(noteFrom(LAYOUT_A, { duration_ms: 3062000 }))
  };
  const line = km.candidateSummaryLine(candidate);
  assert.match(line, /51 min/);
  assert.match(line, /Planning discipline is weak/);
  assert.ok(!line.includes('boilerplate'));
});

test('candidateSummaryLine falls back to the excerpt when there is no signal', () => {
  assert.equal(
    km.candidateSummaryLine({ excerpt: 'some prose', signal: null }),
    'some prose'
  );
});
