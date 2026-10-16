'use strict';

// action-mail's attachment calls against a fake fetch (16 Oct 2026): small
// files inline, large ones through an upload session in 320 KiB-multiple
// chunks — and the pre-authorised upload URL never gets the bearer token.

const test = require('node:test');
const assert = require('node:assert/strict');

const id = require.resolve('./microsoft');
require.cache[id] = { id, filename: id, loaded: true, exports: { getAccessToken: async () => 'TOKEN' } };
const mail = require('./action-mail');

function fakeFetch(calls) {
  return async (url, opts = {}) => {
    calls.push({ url, method: opts.method, headers: opts.headers || {}, body: opts.body });
    let status = 201; let data = {};
    if (url.endsWith('/createUploadSession')) data = { uploadUrl: 'https://upload.example/session?sig=abc' };
    else if (url.startsWith('https://upload.example')) status = 200;
    else if (opts.method === 'GET') { status = 200; data = { value: [{ name: 'sig.png', isInline: true }, { name: 'a.txt', isInline: false }] }; }
    return { status, text: async () => JSON.stringify(data) };
  };
}

test('a small file goes inline as a fileAttachment; a large one through an upload session without the token', async () => {
  const calls = [];
  const real = global.fetch;
  global.fetch = fakeFetch(calls);
  try {
    const small = Buffer.from('hello');
    const big = Buffer.alloc(3 * 1024 * 1024 + 10, 7);
    const r = await mail.addAttachments('DRAFT1', [
      { name: 'a.txt', contentType: 'text/plain', content: small },
      { name: 'big.bin', contentType: 'application/octet-stream', content: big },
    ]);
    assert.equal(r.ok, true);
    const inline = calls[0];
    assert.match(inline.url, /\/me\/messages\/DRAFT1\/attachments$/);
    assert.equal(JSON.parse(inline.body).contentBytes, small.toString('base64'));
    assert.match(calls[1].url, /createUploadSession$/);
    assert.equal(JSON.parse(calls[1].body).AttachmentItem.size, big.length);
    const puts = calls.filter((c) => c.url.startsWith('https://upload.example'));
    assert.equal(puts.length, 1, 'just over 3 MB fits in one 3.125 MB chunk');
    assert.equal(calls.length, 3);
  } finally { global.fetch = real; }
});

test('upload chunks: contiguous ranges, each a multiple of 320 KiB except the last, never the bearer token', async () => {
  const calls = [];
  const real = global.fetch;
  global.fetch = fakeFetch(calls);
  try {
    const big = Buffer.alloc(7 * 1024 * 1024 + 5, 1);
    assert.equal((await mail.addAttachments('D', [{ name: 'big.bin', content: big }])).ok, true);
    const puts = calls.filter((c) => c.url.startsWith('https://upload.example'));
    let next = 0;
    puts.forEach((p, i) => {
      assert.equal(p.headers.Authorization, undefined, 'the upload URL is pre-authorised; the token must not go to it');
      const [, s, e, total] = p.headers['Content-Range'].match(/bytes (\d+)-(\d+)\/(\d+)/).map(Number);
      assert.equal(s, next); assert.equal(total, big.length);
      const len = e - s + 1;
      assert.equal(p.body.length, len);
      if (i < puts.length - 1) assert.equal(len % (320 * 1024), 0);
      next = e + 1;
    });
    assert.equal(next, big.length, 'every byte sent once');
  } finally { global.fetch = real; }
});

test('read-back leaves inline parts out — they are not Nick\'s attachments', async () => {
  const real = global.fetch;
  global.fetch = fakeFetch([]);
  try {
    assert.deepEqual(await mail.listAttachments('D'), { ok: true, names: ['a.txt'] });
  } finally { global.fetch = real; }
});
