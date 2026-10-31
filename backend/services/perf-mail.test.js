'use strict';

/**
 * Sent Items as performance evidence (31 Oct 2026). Real scratch SQLite, fake Graph.
 * Pins: a document attachment counts (a pasted image or inline logo does not);
 * a new message to 4+ people counts, a reply-all does not; meeting responses
 * and mail only to himself never; the cursor advances; unread is a named gap.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-mail-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const mail = require('./perf-mail');

test.before(async () => { await db.init(); });

const rcp = (name) => ({ emailAddress: { name, address: `${name.toLowerCase().replace(/ /g, '.')}@nurtur.tech` } });
const M = (id, subject, to, at, extra = {}) => ({ id, subject, toRecipients: to.map(rcp), ccRecipients: [], sentDateTime: at, hasAttachments: false, uniqueBody: { content: 'Hi all, attached is the guide.' }, ...extra });

test('unread before the first run is a named gap', () => {
  assert.throws(() => mail.itemsFor({ from: '2026-09-01', to: '2026-09-30' }), /not read yet/);
});

test('documents and broadcasts are kept; the rest is not', async () => {
  const msgs = [
    M('m1', 'Support Standards & Routing Guide', ['Team Leads'], '2026-09-20T09:00:00Z', { hasAttachments: true }),
    M('m2', 'Screenshot', ['Lucy'], '2026-09-20T10:00:00Z', { hasAttachments: true }),
    M('m3', 'New on-call rota', ['A B', 'C D', 'E F', 'G H'], '2026-09-21T09:00:00Z'),
    M('m4', 'RE: New on-call rota', ['A B', 'C D', 'E F', 'G H'], '2026-09-21T10:00:00Z'),
    M('m5', 'Accepted: 1-2-1', ['Lucy'], '2026-09-22T09:00:00Z', { hasAttachments: true }),
    M('m6', 'Note to self', ['Nick W'], '2026-09-22T10:00:00Z', { hasAttachments: true, toRecipients: [{ emailAddress: { name: 'Nick', address: 'nickw@nurtur.tech' } }] }),
    M('m7', 'quick q', ['Lucy'], '2026-09-23T09:00:00Z'),
  ];
  const atts = { m1: [{ name: 'Support Standards & Routing Guide.pdf', isInline: false }, { name: 'logo.png', isInline: true }],
    m2: [{ name: 'image001.png', isInline: false }], m5: [{ name: 'x.pdf', isInline: false }], m6: [{ name: 'y.pdf', isInline: false }] };
  const calls = [];
  const fake = {
    getAccessToken: async () => 'tok',
    getSignedInAddress: async () => 'nickw@nurtur.tech',
    graphFetch: async (url) => {
      calls.push(url);
      const a = url.match(/messages\/([^/]+)\/attachments/);
      if (a) return { value: atts[decodeURIComponent(a[1])] || [] };
      return { value: msgs };
    },
  };
  const r = await mail.run({ microsoft: fake });
  assert.equal(r.ok, true);
  assert.equal(r.read, 7);
  const items = mail.itemsFor({ from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(items.map((i) => [i.kind, i.title]), [
    ['mail-document', 'Sent Support Standards & Routing Guide.pdf to Team Leads'],
    ['mail-broadcast', 'Emailed A B, C D, E F, G H: "New on-call rota"'],
  ]);
  assert.match(items[0].detail, /You wrote: Hi all/);
  assert.ok(!calls.some((u) => /messages\/m3\/attachments/.test(u)), 'no attachment read without attachments');

  // The cursor advanced: the next run asks from the last message sent.
  await mail.run({ microsoft: { ...fake, graphFetch: async (url) => { calls.push(url); return { value: [] }; } } });
  assert.match(decodeURIComponent(calls[calls.length - 1]), /sentDateTime gt 2026-09-23T09:00:00Z/);
});

test('documents: text first, Claude only for a near-empty PDF, unread waits for the next pass', async () => {
  const atts = {
    m1: [{ id: 'a1', name: 'Support Standards & Routing Guide.pdf', size: 1000, isInline: false }, { id: 'a0', name: 'logo.png', size: 10, isInline: true }],
  };
  const fake = {
    getAccessToken: async () => 'tok',
    graphFetch: async (url) => {
      const one = url.match(/messages\/([^/]+)\/attachments\/([^/?]+)/);
      if (one) return { contentBytes: Buffer.from('pdf-bytes').toString('base64') };
      const list = url.match(/messages\/([^/]+)\/attachments/);
      if (list) return { value: atts[decodeURIComponent(list[1])] || [] };
      return null;
    },
  };
  const visionCalls = [];
  const provider = { isConfigured: () => true, vision: async (sys, input) => { visionCalls.push(input); return { text: 'Defines who owns a ticket and how it is routed.', usage: {}, model: 'm' }; } };
  const aiRouting = { isCloudAllowed: () => true, recordUsage: () => {} };

  // Text came out: carried as is, no model call.
  let r = await mail.readDocs({ microsoft: fake, provider, aiRouting, maxPages: 20,
    extract: async () => ({ ok: true, text: 'Ticket ownership. '.repeat(30) }) });
  assert.equal(r.text, 1);
  assert.equal(visionCalls.length, 0);
  let item = mail.itemsFor({ from: '2026-09-01', to: '2026-09-30' }).find((i) => i.kind === 'mail-document');
  assert.match(item.detail, /Attachment "Support Standards & Routing Guide.pdf" begins: Ticket ownership/);

  // A scanned PDF (no text): Claude reads it — but only within the pass's budget.
  require('../db/database').getDb().prepare('UPDATE perf_mail_items SET doc_text = NULL').run();
  const scanned = async () => ({ ok: true, text: '', pages: 3 });
  r = await mail.readDocs({ microsoft: fake, provider, aiRouting, maxPages: 20, extract: scanned, aiPerRun: 0 });
  assert.equal(r.read, 0, 'no budget: left for the next pass');
  r = await mail.readDocs({ microsoft: fake, provider, aiRouting, maxPages: 20, extract: scanned });
  assert.equal(r.ai, 1);
  assert.ok(visionCalls[0].pdfBase64);
  item = mail.itemsFor({ from: '2026-09-01', to: '2026-09-30' }).find((i) => i.kind === 'mail-document');
  assert.match(item.detail, /\(read by AI\): Defines who owns a ticket/);

  // Too many pages for the model: said, not guessed.
  require('../db/database').getDb().prepare('UPDATE perf_mail_items SET doc_text = NULL').run();
  r = await mail.readDocs({ microsoft: fake, provider, aiRouting, maxPages: 20, extract: async () => ({ ok: true, text: '', pages: 80 }) });
  assert.equal(r.unreadable, 1);
  assert.equal(visionCalls.length, 1);
  item = mail.itemsFor({ from: '2026-09-01', to: '2026-09-30' }).find((i) => i.kind === 'mail-document');
  assert.match(item.detail, /could not be read \(almost no text in it\)/);
});
