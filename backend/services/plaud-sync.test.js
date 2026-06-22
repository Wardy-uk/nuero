'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderNote,
  renderTranscript,
  extractTranscriptSegments,
  htmlUnescape
} = require('./plaud-sync');

// Sample get_note(file_id) response: a summary item plus a consumer_note that
// carries only an expiring S3 link and must be dropped.
const SAMPLE_GET_NOTE = [
  {
    data_type: 'auto_sum_note',
    data_content:
      '## Meeting Information\n> Participants: Arman Shazad, Nick Ward\n\n## Meeting Notes\n- Reviewed Q3 plan &amp; budget\n- Arman said &quot;we should ship&quot; if &lt;5 blockers remain',
    data_link: ''
  },
  {
    data_type: 'consumer_note',
    data_content: '',
    data_link: 'https://example-bucket.s3.amazonaws.com/audio.mp3?X-Amz-Expires=900&sig=abc'
  }
];

// Sample get_transcript(file_id) response: a transaction item whose data_content
// is a JSON string of segments with real `speaker` names.
const SAMPLE_GET_TRANSCRIPT = [
  {
    data_type: 'transaction',
    data_content: JSON.stringify([
      { start_time: 297020, content: 'Apologize, okay?', speaker: 'Arman Shazad', original_speaker: 'Speaker 5' },
      { start_time: 302000, content: '  No worries at all.  ', speaker: 'Nick Ward', original_speaker: 'Speaker 2' },
      { start_time: 305000, content: '', speaker: 'Nick Ward', original_speaker: 'Speaker 2' }
    ])
  }
];

test('htmlUnescape decodes the five common entities without double-decoding', () => {
  assert.equal(htmlUnescape('a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;'), 'a <b> & "c" \'d\'');
  assert.equal(htmlUnescape('&amp;lt;'), '&lt;'); // &amp; resolved last, so this stays literal
  assert.equal(htmlUnescape(null), '');
});

test('renderNote drops empty consumer_note / S3-link items and unescapes content', () => {
  const out = renderNote(SAMPLE_GET_NOTE);

  // The S3 link and the consumer_note item are gone.
  assert.ok(!out.includes('s3.amazonaws.com'), 'S3 link must be dropped');
  assert.ok(!out.includes('consumer_note'), 'consumer_note must be dropped');

  // No raw JSON object blocks and no escaped newlines leaked through.
  assert.ok(!out.includes('"data_type"'), 'no raw note JSON');
  assert.ok(!out.includes('\\n'), 'no literal escaped newlines');

  // HTML entities are decoded.
  assert.ok(out.includes('Q3 plan & budget'));
  assert.ok(out.includes('"we should ship"'));
  assert.ok(out.includes('if <5 blockers'));
  assert.ok(out.startsWith('## Meeting Information'));
});

test('renderNote joins multiple real summaries with a divider', () => {
  const out = renderNote([
    { data_type: 'auto_sum_note', data_content: 'First' },
    { data_type: 'consumer_note', data_content: '', data_link: 'https://s3/x' },
    { data_type: 'custom_note', data_content: 'Second' }
  ]);
  assert.equal(out, 'First\n\n---\n\nSecond');
});

test('extractTranscriptSegments parses the transaction JSON string', () => {
  const segments = extractTranscriptSegments(SAMPLE_GET_TRANSCRIPT);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].speaker, 'Arman Shazad');
});

test('renderTranscript uses real speaker names, not "Speaker N"', () => {
  const out = renderTranscript(extractTranscriptSegments(SAMPLE_GET_TRANSCRIPT));

  // Real names from `speaker`, never the raw original_speaker labels.
  assert.ok(out.includes('**Arman Shazad**'));
  assert.ok(out.includes('**Nick Ward**'));
  assert.ok(!/Speaker \d/.test(out), 'must not contain raw "Speaker N" labels');

  // mm:ss timestamp formatting (297020ms -> 04:57).
  assert.ok(out.includes('`04:57`'));

  // Empty-content segment is dropped -> only 2 rendered lines.
  assert.equal(out.split('\n\n').length, 2, 'empty segment dropped -> 2 rendered lines');

  // Exact line shape: **speaker** `mm:ss`  content (content trimmed; the two
  // spaces before content are the intentional separator, not stray whitespace).
  assert.equal(out.split('\n\n')[0], '**Arman Shazad** `04:57`  Apologize, okay?');
  assert.equal(out.split('\n\n')[1], '**Nick Ward** `05:02`  No worries at all.');
});

test('renderTranscript and renderNote degrade gracefully on junk input', () => {
  assert.equal(renderTranscript(null), '');
  assert.equal(renderNote(undefined), '');
  assert.equal(extractTranscriptSegments('not an array').length, 0);
});
