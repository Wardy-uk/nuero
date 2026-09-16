'use strict';

/**
 * Ranking by what is IN a note, and the ability to say no.
 *
 * Before this the scorer was a shape test: measured on the live vault, ALL NINETEEN
 * PLAUD summaries in the window scored exactly 11 — not similar, identical — so a
 * 51-minute meeting that changed how the department plans sprints and a 15-minute
 * chat about postage ranked the same, and the order was purely chronological. And
 * there was no dismiss of any kind: the only thing that took a note out of the queue
 * was `knowledge_promoted_to`, so the sole way to stop being offered a personal
 * optician appointment was to file it in the knowledge base.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const km = require('./knowledge-memory');

const SUMMARY_BODY = [
  '# 09-14 Weekly Meeting',
  '',
  '## Meeting Notes',
  '- Topic Title: Sprint planning',
  '  - Conclusion: Planning discipline is weak.',
  '',
  '## Next Arrangements',
  '- [ ] Automate sprint start.',
  ''
].join('\n');

const AI_SECTIONS = [
  '## SAiM Insight',
  '',
  'The team is not starting sprints properly and reporting suffers for it.',
  '',
  '## Durable Insights',
  '',
  '- Sprint reporting quality depends on sprints being formally started.',
  '- Mid-sprint injection is the main cause of missed commitments.',
  '',
  '## Open Loops',
  '',
  '- Whether sprint start can be automated.',
  ''
].join('\n');

function note(content, frontmatter = {}, extra = {}) {
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

const SUMMARY_FM = { note_type: 'summary', source: 'PLAUD', start_at: '2026-09-14T08:03:45' };

// --- the three states ------------------------------------------------------------------

test('unjudged, judged-with-value and judged-empty are three different answers', () => {
  const unjudged = km.knowledgeValue(note(SUMMARY_BODY, SUMMARY_FM));
  assert.equal(unjudged.judged, false, 'no stamp means nothing has read it');
  assert.equal(unjudged.durable, 0);

  const valued = km.knowledgeValue(note(
    `${SUMMARY_BODY}\n${AI_SECTIONS}`,
    { ...SUMMARY_FM, saim_ai_enriched_at: '"2026-09-16T10:00:00.000Z"' }
  ));
  assert.equal(valued.judged, true);
  assert.equal(valued.durable, 2);
  assert.equal(valued.loops, 1);

  // Read, and genuinely nothing in it. NOT the same as never read.
  const empty = km.knowledgeValue(note(
    `${SUMMARY_BODY}\n## SAiM Insight\n\nA short recording with nothing durable.\n`,
    { ...SUMMARY_FM, saim_ai_enriched_at: '2026-09-16T10:00:00.000Z' }
  ));
  assert.equal(empty.judged, true);
  assert.equal(empty.durable, 0);
});

test('the stamp decides judged, not the presence of the sections', () => {
  // A note could carry a `## Durable Insights` heading Nick typed himself. What makes
  // it JUDGED is that a pass ran and said so.
  const handTyped = km.knowledgeValue(note(`${SUMMARY_BODY}\n${AI_SECTIONS}`, SUMMARY_FM));
  assert.equal(handTyped.judged, false);
  assert.equal(handTyped.durable, 2, 'the bullets are still counted, just not vouched for');
});

test('the legacy sara_ stamp still counts as judged', () => {
  const legacyStamp = km.knowledgeValue(note(
    `${SUMMARY_BODY}\n${AI_SECTIONS}`,
    { ...SUMMARY_FM, sara_ai_enriched_at: '2026-08-01T10:00:00.000Z' }
  ));
  assert.equal(legacyStamp.judged, true, 'notes enriched before the rename are not un-judged');
});

// --- the ranking -------------------------------------------------------------------------

test('RANKS MOST TO LEAST USEFUL, and unjudged sits above judged-empty', () => {
  const stamp = { saim_ai_enriched_at: '2026-09-16T10:00:00.000Z' };

  const twoInsights = note(`${SUMMARY_BODY}\n${AI_SECTIONS}`, { ...SUMMARY_FM, ...stamp });
  const oneInsight = note(
    `${SUMMARY_BODY}\n## SAiM Insight\n\nx\n\n## Durable Insights\n\n- Only one thing here.\n`,
    { ...SUMMARY_FM, ...stamp }
  );
  const loopsOnly = note(
    `${SUMMARY_BODY}\n## SAiM Insight\n\nx\n\n## Open Loops\n\n- Chase this.\n`,
    { ...SUMMARY_FM, ...stamp }
  );
  const unjudged = note(SUMMARY_BODY, SUMMARY_FM);
  const judgedEmpty = note(`${SUMMARY_BODY}\n## SAiM Insight\n\nNothing durable.\n`, { ...SUMMARY_FM, ...stamp });

  const s = n => km.scorePromotionCandidate(n);

  assert.ok(s(twoInsights) > s(oneInsight), '2 insights beats 1');
  assert.ok(s(oneInsight) > s(loopsOnly), 'a durable insight beats an open loop');
  assert.ok(s(loopsOnly) > s(unjudged), 'a judged note with something beats an unread one');
  assert.ok(
    s(unjudged) > s(judgedEmpty),
    'UNREAD outranks READ-AND-EMPTY: silence is not evidence of worthlessness'
  );
});

test('a rich transcript STILL never beats the summary of the same recording', () => {
  // ⚠ This is the invariant that matters, and it is NOT "shape always wins". A judged
  // transcript scores 13 against an unjudged summary's 11, and on reflection that is
  // correct: an ORPHAN recording the model has read and found two durable points in
  // is a better candidate than an unread write-up of a different meeting. My first
  // version of this test asserted the shape floor dominates, which was an assumption
  // I had not justified — the thing that protects against offering the recording
  // instead of the write-up is `supersededBy`, and it is absolute.
  const stamp = { saim_ai_enriched_at: '2026-09-16T10:00:00.000Z' };
  const richTranscript = note(
    `# T\n${AI_SECTIONS}`,
    { note_type: 'transcript', source: 'PLAUD', plaud_id: 'of_a9bf223d6fa5587fd07b3f2f485878b8', ...stamp },
    { path: 'Plaud/Transcripts/x.md', folder: 'Plaud/Transcripts' }
  );
  const plainSummary = note(SUMMARY_BODY, { ...SUMMARY_FM, plaud_id: 'a9bf223d6fa5587fd07b3f2f485878b8' });

  const index = km.indexSummariesByRecording([richTranscript, plainSummary]);
  const superseded = { ...richTranscript, supersededBy: km.supersedingSummary(richTranscript, index) };
  assert.ok(superseded.supersededBy, 'precondition: the summary is found across the of_ prefix');
  assert.ok(
    km.scorePromotionCandidate(plainSummary) > km.scorePromotionCandidate(superseded),
    'no amount of model-found value promotes a recording over its own write-up'
  );
});

test('insight counting is bounded, so one note cannot run away with the queue', () => {
  const stamp = { ...SUMMARY_FM, saim_ai_enriched_at: '2026-09-16T10:00:00.000Z' };
  const many = Array.from({ length: 12 }, (_, i) => `- Insight ${i}.`).join('\n');
  const stuffed = note(`${SUMMARY_BODY}\n## SAiM Insight\n\nx\n\n## Durable Insights\n\n${many}\n`, stamp);
  const exactlyTwo = note(
    `${SUMMARY_BODY}\n## SAiM Insight\n\nx\n\n## Durable Insights\n\n- One.\n- Two.\n`,
    stamp
  );
  assert.equal(
    km.scorePromotionCandidate(stuffed),
    km.scorePromotionCandidate(exactlyTwo),
    'past the cap, more bullets buy nothing at all'
  );
});

// --- dismissal ----------------------------------------------------------------------------

function scratchVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'km-dismiss-'));
  fs.mkdirSync(path.join(root, 'Meetings', '2026', '09'), { recursive: true });
  const rel = 'Meetings/2026/09/2026-09-14 test.md';
  fs.writeFileSync(
    path.join(root, rel),
    `---\nnote_type: summary\nsource: PLAUD\ndate: 2026-09-14\n---\n\n${SUMMARY_BODY}`,
    'utf-8'
  );
  return { root, rel };
}

function withVault(fn) {
  const { root, rel } = scratchVault();
  const previous = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    return fn(root, rel);
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('dismissing writes to the NOTE, and the note survives it', () => {
  withVault((root, rel) => {
    const before = fs.readFileSync(path.join(root, rel), 'utf-8');
    const result = km.dismissCandidate({ sourcePath: rel, reason: 'personal appointment' });
    assert.equal(result.status, 'ok');
    assert.equal(result.already, false);

    const after = fs.readFileSync(path.join(root, rel), 'utf-8');
    assert.match(after, /knowledge_dismissed:/);
    assert.match(after, /personal appointment/);
    // ⚠ The body is untouched. A dismissal is an annotation, never an edit.
    assert.ok(after.includes('Conclusion: Planning discipline is weak.'));
    assert.ok(before.includes('note_type: summary') && after.includes('note_type: summary'));
  });
});

test('a dismissed note leaves the queue, and comes back when put back', () => {
  withVault((root, rel) => {
    const listed = () => km.getPromotionCandidates({ limit: 50 }).map(c => c.path);
    assert.ok(listed().includes(rel), 'precondition: it is in the queue');

    km.dismissCandidate({ sourcePath: rel, reason: 'not mine' });
    assert.ok(!listed().includes(rel), 'dismissed notes are not offered');

    km.undismissCandidate({ sourcePath: rel });
    assert.ok(listed().includes(rel), 'THE WAY BACK: undismiss restores it');

    // The keys are REMOVED, not blanked — a blank value still reads as present.
    const after = fs.readFileSync(path.join(root, rel), 'utf-8');
    assert.ok(!/knowledge_dismissed/.test(after));
  });
});

test('dismissing twice is a success, not an error', () => {
  withVault((root, rel) => {
    km.dismissCandidate({ sourcePath: rel });
    const second = km.dismissCandidate({ sourcePath: rel });
    assert.equal(second.status, 'ok');
    assert.equal(second.already, true);
  });
});

test('a reason is optional and its absence is not stored as a reason', () => {
  withVault((root, rel) => {
    km.dismissCandidate({ sourcePath: rel });
    const after = fs.readFileSync(path.join(root, rel), 'utf-8');
    assert.match(after, /knowledge_dismissed:/);
    assert.ok(!/knowledge_dismissed_reason/.test(after), 'no reason given, no reason key');
  });
});

test('listDismissed reports what was said no to, with the reason', () => {
  withVault((root, rel) => {
    km.dismissCandidate({ sourcePath: rel, reason: 'optician' });
    const listed = km.listDismissed({});
    assert.equal(listed.status, 'ok');
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].reason, 'optician');
    assert.ok(listed.items[0].dismissedAt);
  });
});

test('a missing note is refused by name, never silently ignored', () => {
  withVault(() => {
    const result = km.dismissCandidate({ sourcePath: 'Meetings/nope.md' });
    assert.equal(result.status, 'error');
    assert.match(result.error, /not found/i);
  });
});

test('NEGATIVE: an already-promoted note cannot also be dismissed', () => {
  withVault((root, rel) => {
    const full = path.join(root, rel);
    fs.writeFileSync(
      full,
      fs.readFileSync(full, 'utf-8').replace('note_type: summary', 'note_type: summary\nknowledge_promoted_to: "Knowledge/Meetings/x.md"'),
      'utf-8'
    );
    const result = km.dismissCandidate({ sourcePath: rel });
    assert.equal(result.status, 'error', 'a note cannot be both knowledge and not knowledge');
  });
});

// --- the frontmatter surgery --------------------------------------------------------------

test('removeFrontmatterKey drops the line and leaves the rest alone', () => {
  const before = '---\na: "1"\nknowledge_dismissed: "2026-09-16"\nb: "2"\n---\n\nbody here\n';
  const after = km.removeFrontmatterKey(before, 'knowledge_dismissed');
  assert.ok(!after.includes('knowledge_dismissed'));
  assert.match(after, /a: "1"/);
  assert.match(after, /b: "2"/);
  assert.match(after, /body here/);
});

test('removeFrontmatterKey is a no-op on a note with no frontmatter', () => {
  assert.equal(km.removeFrontmatterKey('just a body', 'anything'), 'just a body');
});

// --- what a small model actually returns ---------------------------------------------

test('a model that answers with an OBJECT instead of an array does not lose the note', () => {
  // ⚠ MEASURED, NOT ANTICIPATED. qwen2.5:1.5b answered a real meeting note with
  // `"durableInsights": { "topics": ["Agentic brain planning..."] }`. uniqueStrings
  // iterates with for...of, a plain object is not iterable, so it THREW — and the
  // throw was caught upstream and turned the whole note into a silent "no answer".
  assert.deepEqual(km.toStringArray({ topics: ['Agentic brain planning'] }), ['Agentic brain planning']);
  assert.deepEqual(km.uniqueStrings({ topics: ['one', 'two'] }, 6), ['one', 'two']);
});

test('toStringArray handles every shape a model has produced, and refuses none of them loudly', () => {
  assert.deepEqual(km.toStringArray(['a', 'b']), ['a', 'b']);
  assert.deepEqual(km.toStringArray('single'), ['single']);
  assert.deepEqual(km.toStringArray(null), []);
  assert.deepEqual(km.toStringArray(undefined), []);
  assert.deepEqual(km.toStringArray(42), [], 'an unreadable shape is empty, never a crash');
  assert.deepEqual(km.toStringArray({ a: 'one', b: ['two', 'three'] }), ['one', 'two', 'three']);
});

test('uniqueStrings still folds duplicates and honours its limit', () => {
  assert.deepEqual(km.uniqueStrings(['a', 'A', ' a ', 'b'], 6), ['a', 'b']);
  assert.deepEqual(km.uniqueStrings(['a', 'b', 'c'], 2), ['a', 'b']);
});
