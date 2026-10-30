'use strict';

/**
 * Nick's actions come from the TRANSCRIPT, read by one model call, because PLAUD's
 * summary layout depends on whichever template its auto-summary picked. Once a
 * recording's transcript has been read, the summary note stops raising candidates
 * for it, so the same commitment is never in the queue twice.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-cand-transcript-'));
const vault = path.join(root, 'vault');
for (const dir of ['People', 'Meetings/2026/10', 'Plaud/Transcripts']) {
  fs.mkdirSync(path.join(vault, dir), { recursive: true });
}
for (const p of ['Nick Ward', 'Chris Middleton', 'Josh Mills']) {
  fs.writeFileSync(path.join(vault, 'People', `${p}.md`), '# x\n');
}
process.env.NEURO_DB_PATH = path.join(root, 'cand.db');
process.env.OBSIDIAN_VAULT_PATH = vault;

// The model, stubbed at the provider. Each test sets the answer.
let modelAnswer = null;
require.cache[require.resolve('./ai-provider')] = {
  exports: { processTranscript: async () => ({ text: modelAnswer, provider: 'openrouter' }) },
};

const db = require('../db/database');
const ac = require('./action-candidates');
const tp = require('./transcript-processor');

const NOW = new Date('2026-10-29T12:00:00Z');

function note(id, body) {
  return `---\nplaud_id: "${id}"\ntype: meeting\n---\n${body}\n`;
}
function transcript(id) {
  return `---\nplaud_id: "${id}"\nstart_at: "2026-10-29T10:02:32"\nnote_type: transcript\n---\n# T\n\n[00:00:01] Nick Ward: Right, let's go.\n[00:00:05] Chris Middleton: I'll send the dashboard link.\n`;
}
function pending(fromPath) {
  return db.getPendingSaimActionsByType('capture_todo', 1000)
    .filter((a) => !fromPath || a.payload.sourcePath === fromPath);
}

test.before(async () => { await db.init(); });

test('only Nick\'s actions are queued, joint ones included', () => {
  const rel = 'Plaud/Transcripts/2026-10-29 a.md';
  const content = transcript('f_aaa');
  const r = ac.syncTranscriptActions(rel, content, [
    { owner: 'Nick Ward', task: 'Send the revised rota to the team', due: null },
    { owner: 'Nick Ward and Josh Mills', task: 'Review the KPI integration approach', due: null },
    { owner: 'Chris Middleton', task: 'Send Nick the dashboard link', due: null },
    { owner: 'Speaker 7', task: 'Review the new ticket marked urgent', due: null },
    { owner: 'unknown', task: 'Speak with Nick about the emails going out', due: null },
  ], { now: NOW });
  assert.equal(r.created, 2);
  assert.deepEqual(pending(rel).map((a) => a.payload.text).sort(),
    ['Review the KPI integration approach', 'Send the revised rota to the team']);
  assert.ok(pending(rel).every((a) => a.payload.extractedFrom === 'transcript-action'));
});

test('a past due date is dropped, a future one kept', () => {
  const rel = 'Plaud/Transcripts/2026-10-29 b.md';
  ac.syncTranscriptActions(rel, transcript('f_bbb'), [
    { owner: 'Nick Ward', task: 'Book the risk review with Chris', due: '2026-10-01' },
    { owner: 'Nick Ward', task: 'Publish the support hub guide', due: '2026-11-05' },
  ], { now: NOW });
  const byText = Object.fromEntries(pending(rel).map((a) => [a.payload.text, a.payload.dueDate || null]));
  assert.equal(byText['Book the risk review with Chris'], null);
  assert.equal(byText['Publish the support hub guide'], '2026-11-05');
});

test('the summary note stops raising candidates once the transcript has been read', () => {
  const noteRel = 'Meetings/2026/10/2026-10-29 – Stand-up.md';
  fs.writeFileSync(path.join(vault, noteRel), note('f_ccc', '## Next Arrangements\n- Nick to chase the TPJ backlog with Justin'));
  ac.syncNoteActionCandidates(noteRel);
  assert.equal(pending(noteRel).length, 1, 'baseline: the summary raised it');

  const rel = 'Plaud/Transcripts/2026-10-29 c.md';
  const r = ac.syncTranscriptActions(rel, transcript('f_ccc'), [
    { owner: 'Nick Ward', task: 'Chase Justin about the TPJ backlog', due: null },
  ], { now: NOW });
  assert.equal(r.supersededFromNotes, 1);
  assert.equal(pending(noteRel).length, 0, 'the summary copy is superseded');
  assert.ok(ac.transcriptOwnsRecording('f_ccc'));

  // A later edit to the note raises nothing for this recording.
  fs.writeFileSync(path.join(vault, noteRel), note('f_ccc', '## Next Arrangements\n- Nick to chase the TPJ backlog with Justin\n- Nick to update the rota'));
  ac.syncNoteActionCandidates(noteRel);
  assert.equal(pending(noteRel).length, 0);
});

test('another recording\'s summary candidates are left alone', () => {
  const noteRel = 'Meetings/2026/10/2026-10-29 – Other.md';
  fs.writeFileSync(path.join(vault, noteRel), note('f_ddd', '## Next Arrangements\n- Nick to draft the escalation guide'));
  ac.syncNoteActionCandidates(noteRel);
  ac.syncTranscriptActions('Plaud/Transcripts/x.md', transcript('f_eee'), [
    { owner: 'Nick Ward', task: 'Draft the onboarding checklist', due: null },
  ], { now: NOW });
  assert.equal(pending(noteRel).length, 1);
});

test('reading the same transcript twice queues nothing new', () => {
  const rel = 'Plaud/Transcripts/2026-10-29 a.md';
  const before = pending(rel).length;
  const r = ac.syncTranscriptActions(rel, transcript('f_aaa'), [
    { owner: 'Nick Ward', task: 'Send the revised rota to the team', due: null },
    { owner: 'Nick Ward and Josh Mills', task: 'Review the KPI integration approach', due: null },
  ], { now: NOW });
  assert.equal(r.created, 0);
  assert.equal(pending(rel).length, before);
});

test('processTranscript reads the model\'s owners and feeds the queue', async () => {
  const rel = 'Plaud/Transcripts/2026-10-30 wired.md';
  fs.writeFileSync(path.join(vault, rel), transcript('f_fff'));
  modelAnswer = JSON.stringify({
    summary: 'Stand-up.', is121: false, peopleNames: ['Nick Ward', 'Chris Middleton'],
    actions: [
      { owner: 'Nick Ward', task: 'Check the failed jobs from yesterday', due: null },
      { owner: 'Chris Middleton', task: 'Send the written incident update', due: null },
    ],
    keyTopics: [],
  });
  const out = await tp.processTranscript(path.join(vault, rel));
  assert.equal(out.queued.created, 1);
  assert.deepEqual(pending(rel).map((a) => a.payload.text), ['Check the failed jobs from yesterday']);
});

test('a 1-2-1 is left to NOVA, and an unreadable answer claims nothing', async () => {
  const rel121 = 'Plaud/Transcripts/2026-10-30 one.md';
  fs.writeFileSync(path.join(vault, rel121), transcript('f_ggg'));
  modelAnswer = JSON.stringify({ is121: true, actions: [{ owner: 'Nick Ward', task: 'Send the meeting notes to Heidi', due: null }] });
  await tp.processTranscript(path.join(vault, rel121));
  assert.equal(pending(rel121).length, 0);
  assert.equal(ac.transcriptOwnsRecording('f_ggg'), false);

  const relBad = 'Plaud/Transcripts/2026-10-30 bad.md';
  fs.writeFileSync(path.join(vault, relBad), transcript('f_hhh'));
  modelAnswer = 'Sorry, I cannot help with that.';
  assert.equal(await tp.processTranscript(path.join(vault, relBad)), null);
  assert.equal(ac.transcriptOwnsRecording('f_hhh'), false);
});
