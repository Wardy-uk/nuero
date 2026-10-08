'use strict';

// Pins the 2026-10-08 transcript paging fix. get_transcript pages by an opaque CURSOR;
// the old loop sent `offset`, which the server ignores, so it got page one every time and
// wrote the first 50 segments ceil(total/50) times — 145 of 263 vault transcripts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('./plaud-sync');

const {
  fetchTranscriptPages, fetchTranscriptSegments, assessTranscriptCoverage,
  assessVaultTranscript, replaceTranscriptBody, formatSegmentTime, TranscriptIncompleteError,
} = _internal;

function makeSegments(n) {
  return Array.from({ length: n }, (_, i) => ({
    start_time: i * 7000 + 880,
    end_time: i * 7000 + 6000,
    speaker: i % 2 ? 'Lucy Read' : 'Chris Middleton',
    original_speaker: i % 2 ? 'Speaker 2' : 'Speaker 1',
    content: `utterance ${i}`,
  }));
}

const encode = (o) => Buffer.from(JSON.stringify({ o })).toString('base64url');
const decode = (c) => JSON.parse(Buffer.from(c, 'base64url').toString()).o;

/** A fake PLAUD speaking the real 0.3.14 shape. `honourCursor:false` reproduces what the
 *  live server does with the old `offset` argument: ignores it and serves page one. */
function fakePlaud(all, { honourCursor = true, pageCap = 50 } = {}) {
  const calls = [];
  return {
    calls,
    async callTool({ name, arguments: args }) {
      assert.equal(name, 'get_transcript');
      calls.push(args);
      const limit = Math.min(args.limit || 50, pageCap);
      const offset = honourCursor && args.cursor ? decode(args.cursor) : 0;
      const segments = all.slice(offset, offset + limit);
      const end = offset + segments.length;
      return {
        content: [{ type: 'text', text: JSON.stringify({
          file_id: 'of_x', block: 'transaction', total: all.length, offset, limit,
          returned: segments.length, next_cursor: end < all.length ? encode(end) : null, segments,
        }) }],
      };
    },
  };
}

test('a multi-page transcript is assembled whole, in order, with no repeats', async () => {
  const all = makeSegments(697);
  const client = fakePlaud(all, { pageCap: 50 });
  const got = await fetchTranscriptPages(client, 'of_x');
  assert.equal(got.length, 697);
  assert.deepEqual(got.map((s) => s.content), all.map((s) => s.content));
  assert.equal(client.calls.length, 14);
  assert.equal(client.calls[0].cursor, undefined, 'first page carries no cursor');
  assert.ok(client.calls.slice(1).every((a) => typeof a.cursor === 'string'), 'later pages follow next_cursor');
  assert.ok(client.calls.every((a) => a.offset === undefined), 'never sends offset — get_transcript has no such parameter');
});

test('asks for big pages, so a long meeting is a couple of calls', async () => {
  const client = fakePlaud(makeSegments(697), { pageCap: 500 });
  const got = await fetchTranscriptPages(client, 'of_x');
  assert.equal(got.length, 697);
  assert.equal(client.calls.length, 2);
});

test('THE BUG: a server that ignores the paging argument is REFUSED, never written', async () => {
  const client = fakePlaud(makeSegments(697), { honourCursor: false });
  await assert.rejects(fetchTranscriptPages(client, 'of_x'), (e) => {
    assert.ok(e instanceof TranscriptIncompleteError);
    return true;
  });
  // It must stop at the first sign, not page fourteen times first.
  assert.equal(client.calls.length, 2);
});

test('page one served again under a FRESH cursor and no offset field is caught by the repeat check', async () => {
  const all = makeSegments(120);
  let n = 0;
  const client = {
    async callTool() {
      n += 1;
      return { structuredContent: { total: 120, segments: all.slice(0, 50), next_cursor: `c${n}` } };
    },
  };
  await assert.rejects(fetchTranscriptPages(client, 'of_x'), /arrived twice/);
});

test('a page whose own offset disagrees with what is held is refused', async () => {
  const all = makeSegments(120);
  const client = {
    n: 0,
    async callTool() {
      const offset = this.n === 0 ? 0 : 75; // skips 50..74
      this.n += 1;
      const segments = all.slice(offset, offset + 50);
      return { structuredContent: { total: 120, offset, segments, next_cursor: 'c' + this.n } };
    },
  };
  await assert.rejects(fetchTranscriptPages(client, 'of_x'), /did not advance/);
});

test('a total the pages never reach is refused', async () => {
  const all = makeSegments(80);
  const client = {
    async callTool() {
      return { structuredContent: { total: 200, offset: 0, segments: all, next_cursor: null } };
    },
  };
  await assert.rejects(fetchTranscriptPages(client, 'of_x'), /80 of 200 segments/);
});

test('a repeated cursor is refused rather than looped on', async () => {
  const all = makeSegments(120);
  let n = 0;
  const client = {
    async callTool() {
      const offset = n * 50; n += 1;
      // Advances its offset honestly but hands back the same cursor every time.
      return { structuredContent: { total: 120, offset, segments: all.slice(offset, offset + 50), next_cursor: 'stuck' } };
    },
  };
  await assert.rejects(fetchTranscriptPages(client, 'of_x'), /next_cursor did not change/);
});

test('the old array shape (no paging fields) still reads as one complete page', async () => {
  const segments = makeSegments(30);
  const client = {
    async callTool() {
      return { content: [{ type: 'text', text: JSON.stringify([{ data_type: 'transaction', data_content: JSON.stringify(segments) }]) }] };
    },
  };
  const got = await fetchTranscriptPages(client, 'old');
  assert.equal(got.length, 30);
});

test('a short single-page transcript is untouched by the guard', async () => {
  const got = await fetchTranscriptSegments(fakePlaud(makeSegments(12)), 'of_x', { emptyRetries: 0 });
  assert.equal(got.length, 12);
});

test('coverage: a long recording ending before half-way is refused; trailing silence is not', () => {
  const segs = [{ start_time: 446050 }]; // 7:26 into the 7 Oct meeting
  assert.equal(assessTranscriptCoverage(segs, 5189000).refuse, true);
  // 16 of 118 healthy transcripts end before 95% of the recording — written, only logged.
  const quiet = assessTranscriptCoverage([{ start_time: 0.83 * 240000 }], 240000);
  assert.equal(quiet.refuse, false);
  assert.equal(quiet.warn, true);
  // Short recordings are never refused on coverage, however sparse.
  assert.equal(assessTranscriptCoverage([{ start_time: 1000 }], 9 * 60000).refuse, false);
  // Unknown duration cannot be judged.
  assert.deepEqual(
    { known: assessTranscriptCoverage(segs, null).known, refuse: assessTranscriptCoverage(segs, null).refuse },
    { known: false, refuse: false },
  );
});

test('timestamps keep the hour instead of wrapping at 60 minutes', () => {
  assert.equal(formatSegmentTime(880), '00:00');
  assert.equal(formatSegmentTime(446050), '07:26');
  assert.equal(formatSegmentTime(3599000), '59:59');
  assert.equal(formatSegmentTime(5184000), '1:26:24');
});

const NOTE_HEAD = [
  '---', 'plaud_id: "b373"', 'type: transcript', 'speakers_named: true', '---', '',
  '# Title', '', 'Summary: [[Meetings/2026/10/x]]', '', '## Transcript', '', '',
].join('\n');
const line = (i) => `**Chris Middleton** \`0${i}:00\`  line ${i}`;

test('the vault-side detector sees a repeated block and nothing else', () => {
  const block = [1, 2, 3].map(line).join('\n\n');
  const bad = assessVaultTranscript(`${NOTE_HEAD}${block}\n\n${block}\n\n${block}\n`);
  assert.deepEqual({ s: bad.segments, u: bad.unique, r: bad.repeated }, { s: 9, u: 3, r: true });
  const ok = assessVaultTranscript(`${NOTE_HEAD}${block}\n`);
  assert.equal(ok.repeated, false);
  assert.equal(ok.coveredTo, '03:00');
});

test('repair replaces ONLY the segment lines — head kept byte for byte, idempotent', () => {
  const warned = `${NOTE_HEAD}> ⚠ Speakers were never named in PLAUD — x.\n\n`;
  const damaged = `${warned}${line(1)}\n\n${line(1)}\n`;
  const fixed = replaceTranscriptBody(damaged, `${line(1)}\n\n${line(2)}`);
  assert.ok(fixed.startsWith(warned), 'frontmatter, title, Summary link and warning untouched');
  assert.equal(assessVaultTranscript(fixed).repeated, false);
  assert.equal(replaceTranscriptBody(fixed, `${line(1)}\n\n${line(2)}`), fixed, 'a second pass changes nothing');
});
