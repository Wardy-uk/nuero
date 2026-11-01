'use strict';

/**
 * Muted senders are archived in the real Outlook mailbox (1 Nov 2026).
 *
 * A sender mute used to act inside NEURO only: the triage entry was filed, and
 * the newsletter went on sitting unread in Outlook's Inbox. Now, on a mute and
 * on every triage pass, mail in the Outlook INBOX from an EXACT muted address is
 * MOVED to the well-known `archive` folder and marked read. Never deleted.
 *
 * Rules (each pinned by email-muted-archive.test.js):
 *   - Only the Inbox, only an exact (case-insensitive) muted address, never
 *     Nick's own address.
 *   - A FLAGGED message (flagStatus flagged or complete) is left where it is: a
 *     flag is Nick saying keep it.
 *   - Behind the Settings switch `email_muted_archive` (default ON).
 *   - Each move is one row on the external-write ledger (`microsoft.mail.archive`),
 *     written BEFORE the call, keyed on the message's IMMUTABLE id (so a move
 *     does not change the id the ledger and the read-back use).
 *   - Read back after every move: the message's parentFolderId must be the
 *     Archive folder's id. A 2xx whose read-back disagrees is `uncertain` and
 *     REPORTED, never counted.
 *   - An unknown outcome (a crash, a timeout, a 5xx, a mismatch) is READ BACK
 *     before anything repeats: in Archive → confirmed; still in the Inbox →
 *     failed, and only then a new attempt.
 *   - A message already archived once (confirmed) that is back in the Inbox was
 *     put back by Nick, and is left alone.
 *   - Capped per pass; the rest go next pass.
 *   - Sign-in expired / Graph down → the pass skips with a logged reason. It is
 *     a passenger and never fails triage.
 *   - Unmuting stops future archiving and moves nothing back.
 */

const db = require('../db/database');
const ext = require('./external-writes');

const WRITER = 'microsoft.mail.archive';
const FLAG_KEY = 'email_muted_archive';
const COUNTS_KEY = 'email_muted_archive_counts';
const LAST_KEY = 'email_muted_archive_last';
const PER_PASS_CAP = 200;
const ADDRESSES_PER_QUERY = 10;
const INITIATED_BY = 'neuro:muted-archive';
const GRAPH = 'https://graph.microsoft.com/v1.0';
// Immutable ids survive a move, so the ledger key and the read-back name the
// same message before and after it lands in Archive.
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };

function enabled() {
  try { return require('./feature-flags').isEnabled(FLAG_KEY); } catch { return true; }
}

function _readJson(key, fallback) {
  try { const raw = db.getState(key); const v = raw ? JSON.parse(raw) : fallback; return v && typeof v === 'object' ? v : fallback; } catch { return fallback; }
}

function archivedCounts() { return _readJson(COUNTS_KEY, {}); }
function lastPass() { return _readJson(LAST_KEY, null); }

function _bump(address, now) {
  const counts = archivedCounts();
  const c = counts[address] || { archived: 0, lastAt: null };
  c.archived += 1; c.lastAt = new Date(now).toISOString();
  counts[address] = c;
  db.setState(COUNTS_KEY, JSON.stringify(counts));
}

/** PURE. Is this message left where it is because of its flag? */
function isFlagged(msg) {
  const s = msg && msg.flag && msg.flag.flagStatus;
  return s === 'flagged' || s === 'complete';
}

/** PURE. OData string literal: single quotes doubled. */
function odataString(s) { return `'${String(s).replace(/'/g, "''")}'`; }

/** PURE. The Inbox queries for a list of addresses, chunked. */
function inboxQueries(addresses, size = ADDRESSES_PER_QUERY) {
  const out = [];
  for (let i = 0; i < addresses.length; i += size) {
    const chunk = addresses.slice(i, i + size);
    const filter = chunk.map((a) => `from/emailAddress/address eq ${odataString(a)}`).join(' or ');
    out.push({ chunk, path: `/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}&$select=id,from,flag,isRead,parentFolderId,subject&$top=50` });
  }
  return out;
}

async function _graph(method, urlPath, token, body) {
  const url = urlPath.startsWith('http') ? urlPath : `${GRAPH}${urlPath}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...IMMUTABLE },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { ok: false, status: 0, reason: 'network', detail: e.message };
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) return { ok: false, status: res.status, reason: res.status === 401 ? 'auth' : `http_${res.status}`, detail: text.slice(0, 200) };
  return { ok: true, status: res.status, data };
}

/** A 4xx other than 408/429 proves nothing moved; anything else might have. */
function _outcomeOf(r) {
  if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return 'failed';
  return 'uncertain';
}

async function _readBack(id, token) {
  const r = await _graph('GET', `/me/messages/${encodeURIComponent(id)}?$select=parentFolderId,isRead`, token);
  if (!r.ok) return { known: false, reason: r.reason };
  return { known: true, folder: r.data && r.data.parentFolderId, isRead: !!(r.data && r.data.isRead) };
}

let running = null;

/**
 * One pass. Returns a report; never throws.
 * deps: { getToken, selfAddress, rules, now }
 */
async function run(deps = {}) {
  const now = deps.now || Date.now();
  const report = { ok: true, at: new Date(now).toISOString(), moved: 0, flaggedLeft: 0, movedBackLeft: 0, mismatches: [], errors: [], reconciled: 0, capped: false, reason: null };
  const finish = () => {
    try { db.setState(LAST_KEY, JSON.stringify(report)); } catch { /* bookkeeping */ }
    if (report.reason) console.log(`[MutedArchive] skipped — ${report.reason}`);
    else if (report.moved || report.mismatches.length || report.errors.length) {
      console.log(`[MutedArchive] archived ${report.moved} in Outlook; ${report.flaggedLeft} flagged left; ${report.mismatches.length} read-back mismatch(es); ${report.errors.length} error(s)`);
    }
    return report;
  };

  if (!enabled()) { report.ok = false; report.reason = 'switched off (email_muted_archive)'; return finish(); }

  let rules = deps.rules;
  if (!rules) {
    try { rules = require('./email-triage')._internals.readSenderRules(); } catch { rules = {}; }
  }
  let self = deps.selfAddress;
  if (self === undefined) {
    try { self = await require('./microsoft').getSignedInAddress(); } catch { self = null; }
  }
  self = self ? String(self).trim().toLowerCase() : null;
  const addresses = Object.keys(rules || {}).map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@') && a !== self);
  if (!addresses.length) return finish();

  let token = null;
  try { token = deps.getToken ? await deps.getToken() : await require('./microsoft').getAccessToken(); } catch { token = null; }
  if (!token) { report.ok = false; report.reason = 'not signed in to Microsoft'; return finish(); }

  const folder = await _graph('GET', '/me/mailFolders/archive?$select=id', token);
  if (!folder.ok || !folder.data || !folder.data.id) { report.ok = false; report.reason = `Archive folder unreadable (${folder.reason || 'no id'})`; return finish(); }
  const archiveId = folder.data.id;

  const wanted = new Set(addresses);
  let budget = PER_PASS_CAP;
  for (const q of inboxQueries(addresses)) {
    if (budget <= 0) { report.capped = true; break; }
    let next = q.path;
    while (next && budget > 0) {
      const page = await _graph('GET', next, token);
      if (!page.ok) {
        report.errors.push({ stage: 'inbox-read', reason: page.reason });
        if (page.reason === 'auth') { report.ok = false; report.reason = 'Microsoft sign-in refused'; return finish(); }
        break;
      }
      for (const msg of (page.data && page.data.value) || []) {
        if (budget <= 0) { report.capped = true; break; }
        const from = String(msg.from && msg.from.emailAddress && msg.from.emailAddress.address || '').trim().toLowerCase();
        if (!wanted.has(from)) continue; // the server matched loosely; only an exact address moves
        if (isFlagged(msg)) { report.flaggedLeft++; continue; }
        const result = await _archiveOne(msg, from, archiveId, token, now, report);
        if (result === 'attempted') budget--;
        if (result === 'auth') { report.ok = false; report.reason = 'Microsoft sign-in refused'; return finish(); }
      }
      next = page.data && page.data['@odata.nextLink'];
    }
  }
  return finish();
}

async function _archiveOne(msg, from, archiveId, token, now, report) {
  const key = `mail-archive:${msg.id}`;
  let claim = ext.begin({ writer: WRITER, key, target: from, request: { messageId: msg.id, from, to: 'archive' }, initiatedBy: INITIATED_BY, now });
  if (claim.duplicate) {
    // Archived once already and back in the Inbox: Nick moved it back. Leave it.
    report.movedBackLeft++;
    return 'skipped';
  }
  if (claim.blocked) {
    // Unknown outcome: read back before anything repeats.
    const rb = await _readBack(msg.id, token);
    if (!rb.known) { report.errors.push({ stage: 'readback', id: msg.id, reason: rb.reason }); return 'skipped'; }
    if (rb.folder === archiveId) {
      ext.settle(claim.entry.id, { status: 'confirmed', readback: 'later read-back: in Archive', now });
      report.reconciled++;
      _bump(from, now);
      return 'skipped';
    }
    ext.settle(claim.entry.id, { status: 'failed', readback: 'later read-back: still in the Inbox', now });
    claim = ext.begin({ writer: WRITER, key, target: from, request: { messageId: msg.id, from, to: 'archive' }, initiatedBy: INITIATED_BY, now });
    if (!claim.ok) return 'skipped';
  }
  if (!claim.ok) { report.errors.push({ stage: 'ledger', id: msg.id, reason: claim.why }); return 'skipped'; }

  const moved = await _graph('POST', `/me/messages/${encodeURIComponent(msg.id)}/move`, token, { destinationId: 'archive' });
  if (!moved.ok) {
    const status = moved.reason === 'auth' ? 'failed' : _outcomeOf(moved);
    ext.settle(claim.entry.id, { status, result: { reason: moved.reason }, readback: `move refused: ${moved.reason}`, now });
    report.errors.push({ stage: 'move', id: msg.id, reason: moved.reason });
    return moved.reason === 'auth' ? 'auth' : 'attempted';
  }
  const movedId = (moved.data && moved.data.id) || msg.id;
  const rb = await _readBack(movedId, token);
  if (!rb.known || rb.folder !== archiveId) {
    const why = rb.known ? `move answered ${moved.status} but the message is in folder ${rb.folder || 'unknown'}, not Archive` : `move answered ${moved.status} but the read-back failed (${rb.reason})`;
    ext.settle(claim.entry.id, { status: 'uncertain', result: { status: moved.status }, readback: why, now });
    report.mismatches.push({ id: msg.id, from, why });
    return 'attempted';
  }
  let readNote = 'already read';
  if (!rb.isRead) {
    const patched = await _graph('PATCH', `/me/messages/${encodeURIComponent(movedId)}`, token, { isRead: true });
    readNote = patched.ok ? 'marked read' : `left unread (${patched.reason})`;
  }
  ext.settle(claim.entry.id, { status: 'confirmed', result: { status: moved.status }, readback: `in Archive; ${readNote}`, now });
  _bump(from, now);
  report.moved++;
  return 'attempted';
}

/**
 * Start a pass if none is running. Not awaited by triage: a first pass over a
 * backlog makes hundreds of Graph calls and must not hold up classification.
 */
function kick(deps = {}) {
  // Never from a test process: triage tests run the real runTriage, and a
  // machine with a Microsoft sign-in cached would archive REAL mail. Tests call
  // run() with an injected token and a fake Graph instead.
  if (process.env.NODE_TEST_CONTEXT && !deps.allowInTest) return Promise.resolve(null);
  if (running) return running;
  running = run(deps)
    .catch((e) => { console.warn('[MutedArchive] pass failed:', e.message); return null; })
    .finally(() => { running = null; });
  return running;
}

module.exports = {
  run, kick, enabled, archivedCounts, lastPass,
  WRITER, FLAG_KEY, PER_PASS_CAP,
  _internals: { isFlagged, inboxQueries, odataString, COUNTS_KEY, LAST_KEY },
};
