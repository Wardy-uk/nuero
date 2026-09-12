'use strict';

/**
 * "Open the thing this task is about."
 *
 * Pure, so what is under test is the product: which provenance becomes a
 * button, and — the expensive half — which does not.
 *
 * The rule worth breaking the suite over is the email one. An email-promoted
 * task carries `email:AAMkAGI1MjNl…`, a Graph id that names the message to
 * Microsoft and to nobody else. There is a plausible-looking Outlook deeplink
 * format, and using it would produce a button that 404s — worse than no
 * button, because a control that fails teaches him not to trust the others.
 * It is also the exact id `candidate-provenance` exists to stop being rendered
 * as though it meant something.
 *
 * Fixtures are the real `origin_path` values from the live store, 12 Sep 2026.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const links = require('../../shared/task-links.cjs');

const JIRA_URL = 'https://nurturtech.atlassian.net/browse/NT-24848';
const NOTE = 'Meetings/2026/09/2026-09-08 – Support Team Performance.md';
const EMAIL_ID = 'email:AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4LWRlYWRiZWVm';

// ── Jira: the link is already on the task ────────────────────────────────────

test('a Jira task links straight to the stored URL', () => {
  const { links: out } = links.linksFor({ origin_path: JIRA_URL, source: 'jira-assigned' });
  const j = out.find(l => l.kind === 'jira');
  assert.equal(j.href, JIRA_URL, 'verbatim — no reconstruction');
  assert.equal(j.desktopOnly, false, 'a URL works on the phone too');
});

test('⚠ the STORED url wins over one built from a base', () => {
  // Two sources of truth for one address is how they drift.
  const { links: out } = links.linksFor(
    { origin_path: JIRA_URL, jiraKey: 'NT-99999' },
    { jiraBaseUrl: 'https://example.invalid' },
  );
  assert.equal(out.find(l => l.kind === 'jira').href, JIRA_URL);
});

test('a linked task with no stored URL is built from the key', () => {
  const { links: out } = links.linksFor(
    { origin_path: null, jiraKey: 'NT-27530' },
    { jiraBaseUrl: 'https://nurturtech.atlassian.net/' },
  );
  assert.equal(out.find(l => l.kind === 'jira').href, 'https://nurturtech.atlassian.net/browse/NT-27530');
});

test('⚠ no configured Jira address REFUSES by name rather than guessing one', () => {
  const { links: out, refused } = links.linksFor({ jiraKey: 'NT-27530' }, { jiraBaseUrl: null });
  assert.equal(out.length, 0);
  assert.match(refused.find(r => r.kind === 'jira').why, /NT-27530/);
});

// ── The note: a link, but only where Obsidian is ─────────────────────────────

test('a vault note becomes an obsidian:// link', () => {
  const { links: out } = links.linksFor({ origin_path: NOTE });
  const n = out.find(l => l.kind === 'note');
  assert.match(n.href, /^obsidian:\/\/open\?vault=/);
  assert.match(n.href, /Support%20Team%20Performance/);
  assert.doesNotMatch(n.href, /\.md/, 'Obsidian addresses a note without the extension');
});

test('⚠ the note link is desktop-only, and hidden elsewhere rather than broken', () => {
  const onPhone = links.visibleLinks({ origin_path: NOTE }, { atDesktop: false });
  assert.equal(onPhone.links.some(l => l.kind === 'note'), false);
  assert.deepEqual(onPhone.hiddenHere, ['note'], 'and it SAYS one was hidden — not that none exists');

  const atDesk = links.visibleLinks({ origin_path: NOTE }, { atDesktop: true });
  assert.equal(atDesk.links.some(l => l.kind === 'note'), true);
  assert.deepEqual(atDesk.hiddenHere, []);
});

test('⚠ no configured vault NAME means no link, never a guessed one', () => {
  // The path differs per machine (the Pi holds a replica), so the name is the
  // only thing that can address the vault and it cannot be inferred.
  const { links: out, refused } = links.linksFor({ origin_path: NOTE }, { vaultName: null });
  assert.equal(out.length, 0);
  assert.equal(refused[0].kind, 'note');
});

// ── What is not a link ───────────────────────────────────────────────────────

test('⚠ NEGATIVE: an email id is REFUSED, never turned into a deeplink', () => {
  const { links: out, refused } = links.linksFor({ origin_path: EMAIL_ID, source: 'email-promotion' });
  assert.deepEqual(out, [], 'no button at all');
  const r = refused.find(x => x.kind === 'email');
  assert.ok(r, 'and the reason is named, so a surface can explain the absence');
  assert.match(r.why, /cannot be turned into a link/);
});

test('⚠ NEGATIVE: the refusal does not QUOTE the opaque id back at him', () => {
  // 150 characters of base64 under the words "open this" is the bug
  // candidate-provenance was written to remove.
  const { refused } = links.linksFor({ origin_path: EMAIL_ID });
  assert.doesNotMatch(refused.find(r => r.kind === 'email').why, /AAMk/);
});

test('a plain imported task has nothing to open, and that is not an error', () => {
  const { links: out, refused } = links.linksFor({ origin_path: 'Tasks/Master Todo.md', source: 'master-todo-import' });
  // It IS a real note, so it does link — the point is that nothing throws and
  // no refusal is manufactured.
  assert.equal(out.some(l => l.kind === 'note'), true);
  assert.deepEqual(refused, []);
});

test('a task with no provenance at all yields nothing, quietly', () => {
  const { links: out, refused } = links.linksFor({ origin_path: null });
  assert.deepEqual(out, []);
  assert.deepEqual(refused, []);
});

test('no task at all does not throw', () => {
  assert.deepEqual(links.linksFor(null).links, []);
});

test('⚠ a scheme that is not http is never treated as a note path', () => {
  for (const p of ['email:abc', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(links.isVaultPath(p), false, p);
  }
});
