// The study tablet's greeting in her natural voice (Nick, 2 Oct 2026: Android's
// own voice was "so unnatural that it was annoying").
//
//   run: npm test   (from saim/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const pending = require('../src/greeting/pending');

test('a queued greeting carries a clip link when a renderer is set', async () => {
  pending.reset();
  pending.setRenderer(async (text) => Buffer.from(`WAV:${text}`));
  pending.put('study', 'Rain from three.');
  const g = pending.take('study');
  assert.equal(g.text, 'Rain from three.');
  assert.match(g.audio, /^\/api\/presence\/greeting-audio\//);
  const id = decodeURIComponent(g.audio.split('/').pop());
  assert.equal(String(await pending.clip(id)), 'WAV:Rain from three.');
});

test('a failed render is null, so the tablet uses its own voice — never silence', async () => {
  pending.reset();
  pending.setRenderer(async () => { throw new Error('NEURO down'); });
  const g = pending.put('study', 'Hello.');
  assert.equal(await pending.clip(g.id), null);
  // The words still go: the greeting itself is untouched by a failed clip.
  assert.equal(pending.take('study').text, 'Hello.');
});

test('no renderer, no audio field — the old behaviour exactly', () => {
  pending.reset();
  pending.setRenderer(null);
  pending.put('study', 'Hello.');
  assert.equal(pending.take('study').audio, undefined);
});

test('the clip is served as audio, and an unknown id is a 404', async () => {
  const router = require('../src/routes/presence');
  // The route installs NEURO's renderer on require; replace it for the test.
  pending.reset();
  pending.setRenderer(async () => Buffer.from('RIFFfake'));
  const g = pending.put('study', 'Hi.');
  const app = express();
  app.use('/api/presence', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/presence`;
  try {
    const ok = await fetch(`${base}/greeting-audio/${encodeURIComponent(g.id)}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'audio/wav');
    assert.equal(await ok.text(), 'RIFFfake');
    const missing = await fetch(`${base}/greeting-audio/nope`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    pending.reset();
    pending.setRenderer(null);
  }
});
