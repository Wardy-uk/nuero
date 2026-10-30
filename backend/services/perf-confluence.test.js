'use strict';

/**
 * Confluence evidence (30 Oct 2026). Pins Nick's rules against a fake
 * Confluence answering the real response shapes:
 *  - a page he created counts; a batch day (20+) and a "Migrated from" page do
 *    not, unless the page names him as Owner;
 *  - a revision counts on his own page for any real change, on anyone else's
 *    only when a quarter of the page changed; edits on the creation day and
 *    edits made today are not judged (yet);
 *  - each day's revision is read once; an unchanged page is not re-read;
 *  - the feed says it cannot answer until a run has succeeded.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-conf-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
process.env.JIRA_EMAIL = 'nick@example.com';
process.env.JIRA_API_TOKEN = 'x';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pc = require('./perf-confluence');
const { changeRatio, judgeCreated, judgeRevision, groupVersions, londonDay } = pc._internals;

test.before(async () => { await require('../db/database').init(); });

const ME = 'acc-nick';
const NOW = new Date('2026-10-30T12:00:00Z');

test('rules: batch, migrated, owner; revision thresholds', () => {
  assert.equal(judgeCreated({ excerpt: 'Prerequisites…', sameDayCount: 3 }).counted, true);
  assert.equal(judgeCreated({ excerpt: 'Prerequisites…', sameDayCount: 19 }).counted, true);
  assert.equal(judgeCreated({ excerpt: 'Prerequisites…', sameDayCount: 20 }).counted, false, 'a batch of 20 is a move, not writing');
  assert.equal(judgeCreated({ excerpt: 'Migrated from BriefYourMarket Knowledge Base', sameDayCount: 1 }).counted, false);
  assert.equal(judgeCreated({ excerpt: 'Owner: Nick Ward | Version: 1.0', sameDayCount: 40 }).counted, true, 'Owner beats the batch rule');
  assert.equal(judgeRevision({ change: 0.24, owner: false }).counted, false);
  assert.equal(judgeRevision({ change: 0.25, owner: false }).counted, true);
  assert.equal(judgeRevision({ change: 0.05, owner: true }).counted, true, 'any real change to his own page');
  assert.equal(judgeRevision({ change: 0.01, owner: true }).counted, false);
  assert.equal(changeRatio('a b c d', 'a b c d'), 0);
  assert.equal(changeRatio('a b c d', 'a b c d e f g h'), 0.5);
  assert.equal(londonDay('2026-07-15T23:30:00Z'), '2026-07-16', 'BST: London day, not UTC');
});

test('versions are grouped per day, his only, never version 1', () => {
  const g = groupVersions([
    { number: 5, authorId: ME, createdAt: '2026-07-07T12:20:00Z', message: 'Fix path' },
    { number: 4, authorId: ME, createdAt: '2026-07-07T12:13:00Z', message: 'Added 1.5' },
    { number: 3, authorId: 'someone', createdAt: '2026-07-06T10:00:00Z' },
    { number: 1, authorId: ME, createdAt: '2026-05-21T07:22:00Z' },
  ], ME, '2025-01-01');
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].day, g[0].first, g[0].last], ['2026-07-07', 4, 5]);
  assert.deepEqual(g[0].notes, ['Fix path', 'Added 1.5']);
});

function fakeConfluence() {
  const calls = [];
  const words = (n, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
  const created = [
    // A real page he wrote, and 20 pages moved the same day.
    { id: '100', title: 'Ticket Routing SOP', excerpt: 'Owner: Nick Ward | Version 1.0', createdDate: '2026-07-16T10:00:00Z' },
    { id: '101', title: 'Failed Jobs notes', excerpt: 'I have compiled scripts', createdDate: '2026-09-23T08:00:00Z' },
    { id: '102', title: 'Old KB page', excerpt: 'Migrated from BriefYourMarket Knowledge Base', createdDate: '2026-09-03T14:00:00Z' },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `2${i}`, title: `Moved ${i}`, excerpt: 'Prerequisites', createdDate: '2026-05-27T10:00:00Z' })),
  ];
  const contributed = [
    { id: '100', title: 'Ticket Routing SOP', when: '2026-08-01T10:00:00Z' },
    { id: '300', title: 'ROI Dashboard', when: '2026-07-14T11:00:00Z' },
    { id: '301', title: 'Typo page', when: '2026-07-10T09:00:00Z' },
    { id: '101', title: 'Failed Jobs notes', when: '2026-10-30T09:00:00Z' },
  ];
  const versions = {
    100: [{ number: 3, authorId: ME, createdAt: '2026-08-01T10:00:00Z', message: 'Tidied priorities' }, { number: 2, authorId: ME, createdAt: '2026-07-16T11:00:00Z' }, { number: 1, authorId: ME, createdAt: '2026-07-16T10:00:00Z' }],
    300: [{ number: 6, authorId: ME, createdAt: '2026-07-14T11:00:00Z', message: 'Rewritten July 2026' }, { number: 5, authorId: 'other', createdAt: '2025-12-01T10:00:00Z' }],
    301: [{ number: 9, authorId: ME, createdAt: '2026-07-10T09:00:00Z' }, { number: 8, authorId: 'other', createdAt: '2026-06-01T10:00:00Z' }],
    101: [{ number: 2, authorId: ME, createdAt: '2026-10-30T09:00:00Z' }, { number: 1, authorId: ME, createdAt: '2026-09-23T08:00:00Z' }],
  };
  const bodies = {
    '100:2': `<p>Owner: Nick Ward ${words(100)}</p>`, '100:3': `<p>Owner: Nick Ward ${words(95)} ${words(5, 'new')}</p>`,
    '300:5': `<p>${words(100)}</p>`, '300:6': `<p>${words(40)} ${words(60, 'fresh')}</p>`,
    '301:8': `<p>${words(100)}</p>`, '301:9': `<p>${words(99)} typo</p>`,
  };
  const res = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith('/user/current')) return res({ accountId: ME });
    if (u.pathname.endsWith('/rest/api/search')) {
      const cql = u.searchParams.get('cql');
      if (cql.startsWith('creator')) return res({ results: created.map((p) => ({ excerpt: p.excerpt, content: { id: p.id, title: p.title, _links: { webui: `/pages/${p.id}` }, space: { name: 'NSSH' }, history: { createdDate: p.createdDate } } })), _links: {} });
      return res({ results: contributed.map((p) => ({ content: { id: p.id, title: p.title, _links: { webui: `/pages/${p.id}` }, space: { name: 'NSSH' }, version: { when: p.when } } })), _links: {} });
    }
    const vm = u.pathname.match(/\/pages\/(\d+)\/versions$/);
    if (vm) return res({ results: versions[vm[1]] || [], _links: {} });
    const pm = u.pathname.match(/\/pages\/(\d+)$/);
    if (pm) return res({ body: { storage: { value: bodies[`${pm[1]}:${u.searchParams.get('version')}`] || '' } } });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, calls };
}

test('the feed cannot answer before a run; a run applies every rule', async () => {
  assert.throws(() => pc.itemsFor({ from: '2026-01-01', to: '2026-12-31' }), /not read yet/);
  const f = fakeConfluence();
  const r = await pc.run({ deps: { fetch: f.fetch, now: NOW } });
  assert.equal(r.ok, true, r.error);

  const items = pc.itemsFor({ from: '2025-01-01', to: '2026-12-31' });
  const titles = items.map((i) => i.title);
  assert.ok(titles.some((t) => /Wrote .*Ticket Routing SOP/.test(t)));
  assert.ok(titles.some((t) => /Wrote .*Failed Jobs notes/.test(t)));
  assert.ok(!titles.some((t) => /Old KB page|Moved \d/.test(t)), 'migrated and batch-moved pages are not evidence');
  assert.ok(titles.some((t) => /Revised .*Ticket Routing SOP/.test(t)), 'a 5% change to his own page counts');
  const roi = items.find((i) => /Revised .*ROI Dashboard/.test(i.title));
  assert.ok(roi, 'a substantial rewrite of someone else\'s page counts');
  assert.match(roi.detail, /Rewritten July 2026/);
  assert.ok(!titles.some((t) => /Typo page/.test(t)), 'a one-word edit to someone else\'s page does not');
  assert.equal(items.filter((i) => /Ticket Routing/.test(i.title) && i.kind === 'doc-revised').length, 1, 'the creation-day edit folds into writing it');
  assert.ok(!items.some((i) => i.kind === 'doc-revised' && /Failed Jobs/.test(i.title)), "today's edits wait until the day is over");
  assert.ok(items.every((i) => i.ref.startsWith('https://example.atlassian.net/wiki/pages/')));

  // Second pass: nothing re-read except the page edited today.
  f.calls.length = 0;
  const r2 = await pc.run({ deps: { fetch: f.fetch, now: new Date(NOW.getTime() + 3600_000) } });
  assert.equal(r2.ok, true);
  assert.equal(r2.createdSweep, null, 'created pages are swept daily, not hourly');
  assert.equal(r2.pagesChecked, 1, 'only the page with an unfinished day is re-read');
  assert.ok(!f.calls.some((c) => /version=/.test(c)), 'no page body is fetched again');
});
