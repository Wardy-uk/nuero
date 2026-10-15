'use strict';

/**
 * PLAUD backlog fixes (15 Oct 2026) — prepared behind PLAUD_SYNC_RETRY_V2, default OFF.
 *
 *   1. RETRY COST: a recording whose get_file inventory is explicitly empty (no transcript
 *      blocks, no notes) is "not ready" without get_note and four get_transcript tries.
 *      Live: 13 such recordings cost ~78 MCP calls and ~3 minutes of back-off every cycle.
 *   2. RETRY REACH: a failure's retry window reaches the RECORDING's date. A 7 Jul meeting
 *      that failed on 12 Aug was never listed again, because the window started 11 Aug.
 *   3. RE-PULL IDEMPOTENCY: re-pulling a recording twice writes into the same notes. Before
 *      this, the second run landed as "<title> 2.md" (proved in a scratch vault on the
 *      real 7 Jul payload); a bare ledger id resolves to PLAUD's of_ id; the follow-up link
 *      pass is scoped to the notes the re-pull wrote.
 *
 * Synthetic fixtures (the repo is public), shaped like the live PLAUD MCP answers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-retry-v2-'));
const vault = path.join(work, 'vault');
fs.mkdirSync(path.join(vault, 'Meetings'), { recursive: true });
process.env.NEURO_DB_PATH = path.join(work, 'test.db');
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.PLAUD_SUMMARY_FOLDER = 'Plaud/Summaries';
process.env.PLAUD_TRANSCRIPT_FOLDER = 'Plaud/Transcripts';
process.env.PLAUD_MCP_BETWEEN_RECORDINGS_MS = '0';
process.env.PLAUD_SPEAKER_WAIT_ENABLED = 'false';
delete process.env.PLAUD_SYNC_RETRY_V2;
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENROUTER|OPENAI|VOYAGE|OLLAMA)/.test(k)) delete process.env[k];

// Side effects recorded, never run.
const hookWrites = [];
require.cache[require.resolve('./vault-hooks')] = { exports: { onVaultWrite: (p) => hookWrites.push(path.relative(vault, p).replace(/\\/g, '/')) } };
require.cache[require.resolve('./transcript-processor')] = { exports: { processTranscript: async () => null } };
const linkCalls = [];
const vh = require('./vault-hygiene');
vh.contextualLinkApply = (root, opts) => { linkCalls.push(opts); return { applied: [] }; };

const db = require('../db/database');
const ps = require('./plaud-sync');
const I = ps._internal;

test.before(async () => { await db.init(); });

const BARE = 'aaaabbbbccccddddeeeeffff00001111';
const OF = `of_${BARE}`;
const EMPTY = 'bbbbccccddddeeeeffff000011112222';
const segs = [
  { speaker: 'Nick Ward', original_speaker: 'Speaker 1', start_time: 0, end_time: 4000, content: 'We agreed the dashboard goes live on Friday.' },
  { speaker: 'Sam Example', original_speaker: 'Speaker 2', start_time: 4000, end_time: 9000, content: 'I will send the onboarding fixes by Thursday.' },
];
const fullFile = { id: OF, name: '07-07 Weekly Meeting: Dashboard and Onboarding', created_at: '2026-07-07T09:05:30', start_at: '2026-07-07T08:03:03', duration: 9000,
  source_list: [{ data_type: 'transaction', data_content: JSON.stringify(segs) }], note_list: [{ data_type: 'auto_sum_note', data_title: 'Summary', data_tab_name: 'Summary', data_content: '## Summary\n\nDashboard goes live Friday.\n\n## Next Steps\n\n- Sam to send onboarding fixes' }] };
const emptyFile = { id: `of_${EMPTY}`, name: '2026-10-15 10:00:32', created_at: '2026-10-15T09:12:57', start_at: '2026-10-15T09:00:32', duration: 739000, source_list: [], note_list: [] };

function fakeClient(files) {
  const calls = [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const answer = (name, args) => {
    if (name === 'list_files') return { data: files.map(({ id, name: n, created_at, start_at, duration }) => ({ id, name: n, created_at, start_at, duration })), page: 1 };
    const f = byId.get(args.file_id);
    if (!f) return { __error: 'API error: 404 Not Found' };
    if (name === 'get_file') return f;
    if (name === 'get_note') return f.note_list;
    if (name === 'get_transcript') {
      const tx = f.source_list.find((s) => s.data_type === 'transaction');
      const s = tx ? JSON.parse(tx.data_content) : [];
      return { file_id: f.id, block: 'transaction', total: s.length, offset: 0, limit: 500, returned: s.length, next_cursor: null, segments: s };
    }
    return null;
  };
  const client = { callTool: async ({ name, arguments: args }) => {
    calls.push(`${name}:${args.file_id || ''}`);
    const a = answer(name, args || {});
    if (a && a.__error) return { isError: true, content: [{ type: 'text', text: a.__error }] };
    return { content: [{ type: 'text', text: JSON.stringify(a) }] };
  } };
  return { calls, factory: async () => ({ client, transport: { close: async () => {} } }) };
}
const resetState = (s = {}) => I.writeSyncState({ syncedRecordings: {}, failedRecordings: {}, pendingSpeakers: {}, pendingRecordings: {}, lastSuccessfulSyncAt: '2026-10-15T12:00:00.000Z', lastRunAt: null, ...s });
const listVault = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(vault, p).replace(/\\/g, '/')); } }; walk(vault); return out.sort(); };

// ── Fix 1: retry cost ────────────────────────────────────────────────────
test('isUntranscribed: only an EXPLICIT empty inventory counts — absent fields are not evidence', () => {
  assert.equal(I.isUntranscribed({ source_list: [], note_list: [] }), true);
  assert.equal(I.isUntranscribed({ source_list: [] }), false, 'note_list absent: cannot tell');
  assert.equal(I.isUntranscribed({}), false);
  assert.equal(I.isUntranscribed({ source_list: [{ data_type: 'outline' }], note_list: [] }), false);
  assert.equal(I.retryV2Enabled(), false, 'prepared, not enabled');
});

test('flag OFF: an untranscribed recording still costs get_note + four get_transcript tries (today’s behaviour)', { timeout: 60000 }, async () => {
  resetState();
  const fc = fakeClient([emptyFile]);
  await ps.syncPlaudRecordings({ clientFactory: fc.factory });
  const reads = fc.calls.filter((c) => c.endsWith(EMPTY) || c.includes(EMPTY));
  assert.deepEqual(reads.map((c) => c.split(':')[0]), ['get_file', 'get_note', 'get_transcript', 'get_transcript', 'get_transcript', 'get_transcript']);
  assert.ok(I.readSyncState().pendingRecordings[EMPTY], 'remembered as pending');
});

test('flag ON: the same recording is ONE get_file and stays pending — nothing written, nothing ledgered', async () => {
  process.env.PLAUD_SYNC_RETRY_V2 = 'true';
  try {
    resetState();
    const before = listVault();
    const fc = fakeClient([emptyFile]);
    await ps.syncPlaudRecordings({ clientFactory: fc.factory });
    assert.deepEqual(fc.calls.filter((c) => c.includes(EMPTY)), [`get_file:of_${EMPTY}`]);
    const st = I.readSyncState();
    assert.ok(st.pendingRecordings[EMPTY]);
    assert.equal(st.syncedRecordings[EMPTY], undefined);
    assert.deepEqual(listVault(), before, 'no stub note');
  } finally { delete process.env.PLAUD_SYNC_RETRY_V2; }
});

test('flag ON: a transcribed recording is still pulled normally', async () => {
  process.env.PLAUD_SYNC_RETRY_V2 = 'true';
  try {
    resetState();
    const fc = fakeClient([fullFile]);
    await ps.syncPlaudRecordings({ clientFactory: fc.factory });
    assert.ok(I.readSyncState().syncedRecordings[BARE], 'synced');
    assert.ok(fc.calls.some((c) => c.startsWith('get_transcript')));
  } finally { delete process.env.PLAUD_SYNC_RETRY_V2; }
});

// ── Fix 2: retry reach ───────────────────────────────────────────────────
test('retry reach: flag ON reaches the RECORDING’s date; OFF keeps the failure-date window', () => {
  const failed = { [BARE]: { failedAt: '2026-08-12T13:22:22.690Z', startAt: '2026-07-07T08:03:03' } };
  const last = '2026-10-15T12:00:00.000Z';
  assert.equal(I.incrementalDateFrom(last, true, 14, failed, null, { byRecordingDate: false }), '2026-08-11');
  assert.equal(I.incrementalDateFrom(last, true, 14, failed, null, { byRecordingDate: true }), '2026-07-06');
  // An entry written before the fix has no startAt: unchanged either way.
  const legacy = { [BARE]: { failedAt: '2026-08-12T13:22:22.690Z' } };
  assert.equal(I.incrementalDateFrom(last, true, 14, legacy, null, { byRecordingDate: true }), '2026-08-11');
});

test('retry eligibility stays the FAILURE’s age: a failure older than the retry limit reaches nothing', () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const failed = { [BARE]: { failedAt: old, startAt: '2026-01-01T09:00:00' } };
  const last = new Date().toISOString();
  const plain = I.incrementalDateFrom(last, true, 14, {}, null, { byRecordingDate: true });
  assert.equal(I.incrementalDateFrom(last, true, 14, failed, null, { byRecordingDate: true }), plain);
});

test('a failure entry records the recording’s date (inert while the flag is off)', async () => {
  resetState();
  const broken = { ...fullFile, id: 'of_ccccddddeeeeffff0000111122223333' };
  const fc = fakeClient([broken]);
  // Break the transcript fetch for this one file.
  const real = fc.factory;
  const factory = async () => { const c = await real(); const orig = c.client.callTool; c.client.callTool = async (req) => (req.name === 'get_note' ? { isError: true, content: [{ type: 'text', text: 'Bad Request' }] } : orig(req)); return c; };
  await ps.syncPlaudRecordings({ clientFactory: factory });
  const f = I.readSyncState().failedRecordings.ccccddddeeeeffff0000111122223333;
  assert.ok(f, 'failure recorded');
  assert.equal(f.startAt, '2026-07-07T08:03:03');
});

// ── Re-pull idempotency ──────────────────────────────────────────────────
test('re-pull twice: the SAME two notes, no " 2" twin, one ledger entry', async () => {
  // Its own recording, so nothing an earlier test pulled is mistaken for this one's output.
  const ID = 'eeeeffff000011112222333344445555';
  const file = { ...fullFile, id: `of_${ID}`, name: '07-08 Weekly Meeting: Idempotency Check' };
  resetState({ failedRecordings: { [ID]: { failedAt: '2026-08-12T13:22:22.690Z', message: 'MCP error -32001: Request timed out' } } });
  const fc = fakeClient([file]);
  const before = new Set(listVault());
  const r1 = await ps.repullPlaudRecordings({ ids: [file.id], clientFactory: fc.factory });
  const after1 = listVault().filter((f) => !before.has(f) && !f.startsWith('Decision Log/'));
  const r2 = await ps.repullPlaudRecordings({ ids: [file.id], clientFactory: fc.factory });
  const after2 = listVault().filter((f) => !before.has(f) && !f.startsWith('Decision Log/'));
  assert.equal(r1.pulled, 1); assert.equal(r2.pulled, 1);
  assert.deepEqual(after2, after1, 'the second run created nothing new');
  assert.equal(after1.filter((f) => f.startsWith('Meetings/')).length, 1, 'one meeting note');
  assert.equal(after1.filter((f) => f.startsWith('Plaud/Transcripts/')).length, 1, 'one transcript');
  assert.ok(!after2.some((f) => / 2\.md$/.test(f)), 'no twin');
  const st = I.readSyncState();
  assert.deepEqual(Object.keys(st.syncedRecordings), [ID]);
  assert.equal(st.failedRecordings[ID], undefined, 'the old failure is cleared by a successful pull');
});

test('re-pull: a BARE ledger id resolves to PLAUD’s of_ id — never a 404 recorded as a failure', async () => {
  resetState();
  const fc = fakeClient([fullFile]);
  const r = await ps.repullPlaudRecordings({ ids: [BARE], clientFactory: fc.factory });
  assert.equal(r.failed, 0);
  assert.ok(fc.calls.includes(`get_file:${OF}`));
});

test('re-pull: the follow-up link pass is scoped to the notes this re-pull wrote', async () => {
  resetState();
  linkCalls.length = 0;
  await ps.repullPlaudRecordings({ ids: [OF], clientFactory: fakeClient([fullFile]).factory });
  assert.equal(linkCalls.length, 1);
  assert.ok(Array.isArray(linkCalls[0].only) && linkCalls[0].only.length === 2, 'only the meeting note and its transcript');
  assert.ok(linkCalls[0].only.every((p) => p.startsWith('Meetings/') || p.startsWith('Plaud/Transcripts/')));
});

test('re-pull: a failure is keyed by the CANONICAL id and keeps the recording date', async () => {
  resetState();
  const fc = fakeClient([]);
  await ps.repullPlaudRecordings({ ids: [`of_dddd${'0'.repeat(28)}`], clientFactory: fc.factory });
  const keys = Object.keys(I.readSyncState().failedRecordings);
  assert.deepEqual(keys, [`dddd${'0'.repeat(28)}`]);
});
