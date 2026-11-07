'use strict';

/**
 * Edits made in PLAUD after the first pull reach the vault (4 Nov 2026).
 *
 * list_files has no updated_at, so the ledger's fingerprint was the START TIME and a
 * recording renamed, speaker-named or given a new summary in PLAUD days later was never
 * pulled again. The 30 Oct Support Leadership Meeting stayed "Speaker 1/2/3" under its
 * old name and the SOAP report could not find it. Synthetic fixtures (the repo is public).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-revisit-'));
const vault = path.join(work, 'vault');
fs.mkdirSync(path.join(vault, 'Meetings'), { recursive: true });
process.env.NEURO_DB_PATH = path.join(work, 'test.db');
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.PLAUD_SUMMARY_FOLDER = 'Plaud/Summaries';
process.env.PLAUD_TRANSCRIPT_FOLDER = 'Plaud/Transcripts';
process.env.PLAUD_MCP_BETWEEN_RECORDINGS_MS = '0';
process.env.PLAUD_SPEAKER_WAIT_ENABLED = 'false';
process.env.PLAUD_REVISIT_MINUTES = '0.0001';
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENROUTER|OPENAI|VOYAGE|OLLAMA)/.test(k)) delete process.env[k];
// ⚠ No network in this test (7 Nov 2026). On pi5 Ollama and Home Assistant
// really answer on localhost, so under the full suite's load a side call made
// during a sync took long enough to blow the 60 s timeout; on a laptop nothing
// answers and it failed fast. Everything a sync needs here is the fake PLAUD.
global.fetch = async () => { throw new Error('network disabled in plaud-revisit.test'); };

require.cache[require.resolve('./vault-hooks')] = { exports: { onVaultWrite: () => {} } };
const processed = [];
require.cache[require.resolve('./transcript-processor')] = { exports: { processTranscript: async (p) => { processed.push(p); return null; } } };
require('./vault-hygiene').contextualLinkApply = () => ({ applied: [] });

const db = require('../db/database');
const ps = require('./plaud-sync');
const I = ps._internal;

test.before(async () => { await db.init(); });

const ID = 'f_0aaa1111bbbb2222cccc3333dddd4444';
const startAt = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 19);
const seg = (speaker, label, content, t) => ({ speaker, original_speaker: label, start_time: t, end_time: t + 3000, content });
function file({ name = '10-30 Operations Review: Workload', named = false, summary = 'Workload discussed.', id = ID } = {}) {
  const segs = [
    seg(named ? 'Nick Ward' : 'Speaker 1', 'Speaker 1', 'Tier 2 is behind.', 0),
    seg(named ? 'Stephen Mitchell' : 'Speaker 2', 'Speaker 2', 'We need cover on Friday.', 3000),
  ];
  return {
    id, name, created_at: startAt, start_at: startAt, duration: 6000,
    presigned_url: `https://example.invalid/${Math.random()}`,
    source_list: [{ data_type: 'transaction', data_content: JSON.stringify(segs), data_link: `https://example.invalid/${Math.random()}` }],
    note_list: [{ data_id: 'o_1', data_type: 'auto_sum_note', data_title: 'Summary', data_tab_name: 'Summary', data_content: summary, data_link: `https://example.invalid/${Math.random()}` }],
  };
}

function fakeClient(current) {
  const calls = [];
  const all = () => [].concat(current());
  const client = { callTool: async ({ name, arguments: args }) => {
    calls.push(name);
    const f = all().find((x) => x.id === (args || {}).file_id);
    let a = null;
    if (name === 'list_files') a = { data: all().map((x) => ({ id: x.id, name: x.name, created_at: x.created_at, start_at: x.start_at, duration: x.duration })), page: 1 };
    else if (name === 'get_file') a = f;
    else if (name === 'get_note') a = f.note_list;
    else if (name === 'get_transcript') {
      const s = JSON.parse(f.source_list[0].data_content);
      a = { file_id: f.id, total: s.length, offset: 0, limit: 500, returned: s.length, next_cursor: null, segments: s };
    }
    return { content: [{ type: 'text', text: JSON.stringify(a) }] };
  } };
  // A short pause so the (test-sized) revisit interval has passed between runs.
  return { calls, factory: async () => { await new Promise((r) => setTimeout(r, 25)); return { client, transport: { close: async () => {} } }; } };
}
const resetState = () => I.writeSyncState({ syncedRecordings: {}, failedRecordings: {}, pendingSpeakers: {}, pendingRecordings: {}, lastSuccessfulSyncAt: new Date().toISOString(), lastRunAt: null });
const listVault = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(vault, p).replace(/\\/g, '/')); } }; walk(vault); return out.sort(); };
const entry = () => I.readSyncState().syncedRecordings[ID];
const readRel = (rel) => fs.readFileSync(path.join(vault, rel), 'utf8');

// ── pure ─────────────────────────────────────────────────────────────────

test('fingerprint ignores presigned links, and moves on a rename, a speaker name or a new summary', () => {
  const base = I.contentFingerprint(file());
  assert.equal(I.contentFingerprint(file()), base, 'two reads with different presigned URLs are the same content');
  assert.notEqual(I.contentFingerprint(file({ name: '10-30 Support Leadership: Workload' })), base);
  assert.notEqual(I.contentFingerprint(file({ named: true })), base);
  assert.notEqual(I.contentFingerprint(file({ summary: 'Regenerated with the Obsidian template.' })), base);
});

test('revisitDue: only recent recordings, and only once per interval', () => {
  const now = Date.now();
  const rec = { start_at: new Date(now - 2 * 86400000).toISOString() };
  const cfg = { days: 14, minutes: 60 };
  assert.equal(I.revisitDue({}, rec, now, cfg), true, 'never looked at');
  assert.equal(I.revisitDue({ lastRevisitedAt: new Date(now - 10 * 60000).toISOString() }, rec, now, cfg), false);
  assert.equal(I.revisitDue({ lastRevisitedAt: new Date(now - 61 * 60000).toISOString() }, rec, now, cfg), true);
  assert.equal(I.revisitDue({}, { start_at: new Date(now - 20 * 86400000).toISOString() }, now, cfg), false, 'older than the window');
  assert.equal(I.revisitDue(null, rec, now, cfg), false);
});

test('legacyChange: speaker names, a rename or a better summary — and nothing when the vault matches', () => {
  const note = (title, body) => `---\nplaud_id: "${ID}"\ntitle: "${title}"\nnote_type: "transcript"\n---\n\n${body}`;
  const unnamedBody = '**Speaker 1** `00:00`  Tier 2 is behind.';
  const namedBody = '**Nick Ward** `00:00`  Tier 2 is behind.\n\n**Stephen Mitchell** `00:03`  We need cover.';
  const ex = { summaryPreferenceRank: 2 };
  assert.equal(I.legacyChange({ details: file({ named: true }), existing: ex, transcriptText: note('10-30 Operations Review: Workload', unnamedBody) }), 'speakers named in PLAUD');
  assert.equal(I.legacyChange({ details: file({ name: '10-30 Support Leadership: Workload', named: true }), existing: ex, transcriptText: note('10-30 Operations Review: Workload', namedBody) }), 'renamed in PLAUD');
  const better = file({ named: true });
  better.note_list.push({ data_id: 'o_2', data_type: 'custom', data_title: 'Obsidian Meeting Template', data_tab_name: 'Obsidian Meeting Template', data_content: 'x' });
  assert.equal(I.legacyChange({ details: better, existing: ex, transcriptText: note('10-30 Operations Review: Workload', namedBody) }), 'a better summary appeared in PLAUD');
  assert.equal(I.legacyChange({ details: file({ named: true }), existing: ex, transcriptText: note('10-30 Operations Review: Workload', namedBody) }), null);
});

// ── through the real sync ────────────────────────────────────────────────

test('an edit in PLAUD reaches the SAME notes; nothing re-pulls when nothing changed', { timeout: 60000 }, async () => {
  resetState();
  let current = file();
  const fc = fakeClient(() => current);
  await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  const first = entry();
  assert.ok(first && first.contentFingerprint, 'the first pull records a fingerprint');
  assert.match(readRel(first.transcriptRelativePath), /\*\*Speaker 1\*\*/);

  // Unchanged: a look, no rewrite, no paid processing.
  const before = processed.length;
  const r1 = await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  assert.equal(r1.revisit.checked, 1);
  assert.equal(r1.revisit.revised, 0);
  assert.equal(processed.length, before, 'no re-processing when PLAUD holds the same thing');

  // Speakers named in PLAUD afterwards.
  current = file({ named: true });
  const files = listVault();
  const r2 = await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  assert.equal(r2.revisit.revised, 1);
  const after = entry();
  assert.equal(after.transcriptRelativePath, first.transcriptRelativePath, 'same transcript note');
  assert.equal(after.summaryRelativePath, first.summaryRelativePath, 'same summary note');
  assert.match(readRel(after.transcriptRelativePath), /\*\*Nick Ward\*\*/);
  assert.equal(after.revisedBecause, 'changed in PLAUD');
  assert.ok(!listVault().some((p) => / \d+\.md$/.test(p)), 'no " 2.md" twin');
  const backups = listVault().filter((p) => p.startsWith('Scripts/.lint-backups/plaud-update-'));
  assert.ok(backups.some((p) => p.endsWith(first.transcriptRelativePath)), 'the old transcript was copied aside first');
  assert.equal(listVault().filter((p) => !p.startsWith('Scripts/')).length, files.filter((p) => !p.startsWith('Scripts/')).length, 'no new notes');
});

test('a legacy ledger entry (no fingerprint) is baselined when the vault matches, re-pulled when it does not', { timeout: 60000 }, async () => {
  resetState();
  let current = file({ named: true });
  const fc = fakeClient(() => current);
  await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  const st = I.readSyncState();
  delete st.syncedRecordings[ID].contentFingerprint;
  delete st.syncedRecordings[ID].lastRevisitedAt;
  I.writeSyncState(st);
  const r1 = await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  assert.equal(r1.revisit.revised, 0, 'nothing moved on: baseline only');
  assert.ok(entry().contentFingerprint, 'baseline stored');

  const st2 = I.readSyncState();
  delete st2.syncedRecordings[ID].contentFingerprint;
  delete st2.syncedRecordings[ID].lastRevisitedAt;
  I.writeSyncState(st2);
  current = file({ named: true, name: '10-30 Support Leadership: Workload' });
  const r2 = await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  assert.equal(r2.revisit.revised, 1);
  assert.equal(entry().revisedBecause, 'renamed in PLAUD');
});

test('the re-pull cap defers rather than drops, and a deferred one is not stamped', { timeout: 60000 }, async () => {
  resetState();
  const ID2 = 'f_0bbb1111bbbb2222cccc3333dddd5555';
  let named = false;
  const fc = fakeClient(() => [file({ named }), file({ named, id: ID2, name: '10-30 Planning: Routing' })]);
  await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  process.env.PLAUD_REVISIT_MAX_REPULLS = '1';
  try {
    named = true;
    const r1 = await ps.syncPlaudRecordings({ clientFactory: fc.factory });
    assert.equal(r1.revisit.revised, 1);
    assert.equal(r1.revisit.deferred, 1, 'the second change waits');
    const st = I.readSyncState().syncedRecordings;
    const deferred = [ID, ID2].find((k) => !st[k].revisedAt);
    const stampBefore = st[deferred].lastRevisitedAt;
    const r2 = await ps.syncPlaudRecordings({ clientFactory: fc.factory });
    assert.equal(r2.revisit.revised, 1, 'picked up on the next run');
    assert.ok(I.readSyncState().syncedRecordings[deferred].revisedAt);
    assert.notEqual(I.readSyncState().syncedRecordings[deferred].lastRevisitedAt, stampBefore);
  } finally { delete process.env.PLAUD_REVISIT_MAX_REPULLS; }
});

test('switched off: a changed recording is left alone', { timeout: 60000 }, async () => {
  resetState();
  let current = file();
  const fc = fakeClient(() => current);
  await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  process.env.PLAUD_REVISIT_ENABLED = 'false';
  try {
    current = file({ named: true });
    const r = await ps.syncPlaudRecordings({ clientFactory: fc.factory });
    assert.equal(r.revisit.checked, 0);
    assert.match(readRel(entry().transcriptRelativePath), /\*\*Speaker 1\*\*/);
  } finally { delete process.env.PLAUD_REVISIT_ENABLED; }
});
