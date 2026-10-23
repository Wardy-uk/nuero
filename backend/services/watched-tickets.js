'use strict';

/**
 * Watched tickets — Jira tickets Nick follows, and a push when the CUSTOMER
 * replies (23 Oct 2026). Rendered in the Escalations page beside the escalated
 * queue; nothing else surfaces it.
 *
 * Nick's design calls, asked one at a time:
 *  - Only a CUSTOMER reply notifies — a public comment by a JSM customer
 *    account. Agents' public replies, internal notes and automation never do.
 *    Measured on live NT tickets first: customers are `accountType: 'customer'`
 *    every time; agents are 'atlassian' (often with the email hidden, so a
 *    domain rule would have missed them) and NOVA/automation are 'app'.
 *  - One push per reply, SUPPRESSIBLE (quiet hours and the hourly cap apply),
 *    plus an unread badge in the list until he opens it.
 *  - On resolve the ticket leaves the visible list but is LISTENED to for 10
 *    working days. In that window a reply only flags if it is a real follow-up,
 *    not a thank-you: rules first, the model when the rules cannot tell, and a
 *    reply the model cannot judge is FLAGGED — a missed follow-up is the
 *    expensive mistake, an extra push about a "thanks" is the cheap one.
 *
 * ⚠ JSM often reopens a ticket when the customer comments — a "thanks" moves it
 * out of Done. So a reopen that came with nothing but thank-yous does NOT bring
 * it back; a reopen with no customer comment at all (someone reopened it on
 * purpose) does, silently.
 *
 * ⚠ The baseline: whatever was on the ticket when he started watching is never
 * announced. `seen_comment_id` is the highest comment id already considered;
 * NULL means the baseline is still to be taken. Replies are keyed on the Jira
 * comment id, so a re-run can never push the same reply twice. A crash between
 * recording a reply and sending its push loses the PUSH, never the reply: it
 * stays unread in the list.
 */

const db = require('../db/database');

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const LISTEN_WORKING_DAYS = 10;
const EXCERPT_CHARS = 280;
const PUSH_TYPE = 'watched_reply';

// ── Pure ─────────────────────────────────────────────────────────────────────

function normaliseKey(k) {
  const key = String(k || '').trim().toUpperCase();
  return KEY_RE.test(key) ? key : null;
}

/** ADF or plain string → text. */
function adfText(node, depth = 0) {
  if (!node || depth > 12) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => adfText(n, depth + 1)).join('');
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = adfText(node.content, depth + 1);
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type) ? `${inner}\n` : inner;
}

/** A public comment written by a JSM customer account. Nothing else counts. */
function isCustomerReply(c) {
  return !!c && c.author?.accountType === 'customer' && c.jsdPublic !== false;
}

const QUOTE_START = [
  /^on .{3,200} wrote:$/i,
  /^-{2,}\s*original message/i,
  /^from:\s/i,
  /^sent from my /i,
  /^_{5,}$/,
];

/** The customer's own words: drops quoted history below "On … wrote:" etc. */
function ownWords(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const t = line.trim();
    if (QUOTE_START.some((r) => r.test(t))) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

function excerptOf(text, n = EXCERPT_CHARS) {
  const s = ownWords(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Longest first, so "thanks again" goes before "thanks" and leaves no "again"
// behind to read as a trouble word.
const PLEASANTRIES = [
  'thank you so much', 'thank you very much', 'thanks very much', 'thanks so much', 'thanks a lot',
  'thanks again', 'many thanks', 'thank you', 'thanks', 'thank u', 'thx', 'cheers', 'ta',
  'for all your help', 'for your help', 'for your assistance', 'for your support', 'for sorting this',
  'for sorting', 'for that', 'for this', 'much appreciated', 'really appreciated', 'appreciate it',
  'appreciate that', 'appreciated', 'great stuff', 'great news', 'good news', 'that has worked',
  "that's worked", 'that worked', 'that works', 'working fine', 'working now', 'all working',
  "that's fixed", 'fixed now', 'all sorted', 'sorted', 'all good', 'no worries', 'no problem',
  'you can close this', 'you can close the ticket', 'this can be closed', 'feel free to close',
  'happy for you to close', 'please close', 'have a great weekend', 'have a good weekend',
  'have a great day', 'have a good day', 'have a nice day', 'speak soon', 'kind regards',
  'best regards', 'warm regards', 'regards', 'best wishes', 'great', 'brilliant', 'perfect', 'lovely',
  'fantastic', 'excellent', 'amazing', 'awesome', 'superb', 'wonderful', 'spot on', 'ok', 'okay',
];
const FILLER = new Set(['hi', 'hello', 'hey', 'morning', 'afternoon', 'good', 'yes', 'yep', 'that', 'is',
  'it', 'now', 'all', 'the', 'this', 'you', 'a', 'and', 'very', 'much', 'so', 'again', 'again', 'just',
  'really', 'that\'s', 'thats', 'we', 'i', 'im', 'i\'m', 'are', 'was', 'has', 'have', 'been', 'for', 'to',
  'of', 'me', 'us', 'your', 'team', 'guys', 'all']);
const TROUBLE = /\b(still|not|no longer|broken|error|errors|issue|issues|problem|problems|fault|fail|fails|failed|failing|wrong|can't|cant|cannot|doesn't|doesnt|isn't|isnt|won't|wont|didn't|didnt|unable|however|but|urgent|asap|reopen|query|question|missing|again)\b/i;

/**
 * 'thanks' | 'follow-up' | 'unsure'. PURE. Only ever says 'thanks' for a short
 * reply made of nothing but pleasantries (plus a name). Anything it is not sure
 * of goes to the model.
 */
function judgeByRule(text) {
  const own = ownWords(text);
  if (!own) return { verdict: 'thanks', why: 'no words of their own' };
  if (own.includes('?')) return { verdict: 'follow-up', why: 'asks a question' };
  let s = ` ${own.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  for (const p of PLEASANTRIES) s = s.split(` ${p} `).join(' ');
  s = s.replace(/\s+/g, ' ');
  if (TROUBLE.test(s)) return { verdict: 'follow-up', why: 'says something is still wrong' };
  const left = s.trim().split(' ').filter((w) => w && !FILLER.has(w));
  const words = own.split(/\s+/).filter(Boolean).length;
  if (left.length <= 2 && words <= 60) return { verdict: 'thanks', why: 'only thanks' };
  return { verdict: 'unsure', why: null };
}

/** The end of the 10th working day after `from` (local). `nextWorkingDay(Date) → Date`. */
function listenUntil(from, nextWorkingDay, n = LISTEN_WORKING_DAYS) {
  let d = new Date(from);
  for (let i = 0; i < n; i++) d = nextWorkingDay(d);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
}

function commentId(c) {
  const n = Number(c && c.id);
  return Number.isFinite(n) ? n : null;
}

// ── Store ────────────────────────────────────────────────────────────────────

function _row(key) { return db.get('SELECT * FROM watched_tickets WHERE ticket_key = ?', [key]); }

function _defaultDeps() {
  const jira = require('./jira');
  const wd = require('./working-days');
  return {
    configured: () => jira.isConfigured(),
    states: (keys) => jira.fetchIssueStates(keys),
    comments: (key) => jira.fetchIssueComments(key),
    judge: judgeByModel,
    push: (title, body, data) => require('./webpush').sendToAll(title, body, data),
    nextWorkingDay: (d) => wd.nextWorkingDay(d),
    now: () => new Date(),
  };
}

function _deps(over) { return { ..._defaultDeps(), ...(over || {}) }; }

async function _baseline(key, deps) {
  try {
    const r = await deps.comments(key);
    if (!r) return null;
    const ids = (r.comments || []).map(commentId).filter((n) => n != null);
    return ids.length ? Math.max(...ids) : 0;
  } catch (e) {
    console.warn(`[Watched] baseline for ${key} failed: ${e.message} — taken on the next check`);
    return null;
  }
}

/**
 * Start watching. Refuses a malformed key (400) and a ticket Jira does not have
 * (404). Watching a ticket already watched is `already: true`. A ticket that is
 * already resolved goes straight into the 10-working-day listen.
 */
async function watch(rawKey, depsOver) {
  const deps = _deps(depsOver);
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key (expected e.g. NT-28061)` };
  if (!deps.configured()) return { ok: false, status: 503, error: 'Jira is not configured on NEURO' };
  const existing = _row(key);
  if (existing && existing.phase !== 'ended') return { ok: true, already: true, ticket: _present(existing) };

  let issue;
  try {
    const r = await deps.states([key]);
    issue = (r?.issues || []).find((i) => i.key === key);
  } catch (e) {
    if (/does not exist|400/.test(e.message)) issue = null;
    else return { ok: false, status: 502, error: `Could not reach Jira: ${e.message}` };
  }
  if (!issue) return { ok: false, status: 404, error: `${key} not found in Jira` };

  const now = deps.now();
  const done = issue.statusCategory === 'done';
  const seen = await _baseline(key, deps);
  db.run(`INSERT INTO watched_tickets (ticket_key, summary, status, status_category, url, phase, watched_at,
            resolved_at, background_until, ended_at, ended_reason, seen_comment_id, jira_updated, last_checked_at, last_error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)
          ON CONFLICT(ticket_key) DO UPDATE SET summary = excluded.summary, status = excluded.status,
            status_category = excluded.status_category, url = excluded.url, phase = excluded.phase,
            watched_at = excluded.watched_at, resolved_at = excluded.resolved_at,
            background_until = excluded.background_until, ended_at = NULL, ended_reason = NULL,
            seen_comment_id = excluded.seen_comment_id, jira_updated = excluded.jira_updated,
            last_checked_at = excluded.last_checked_at, last_error = NULL`,
  [key, issue.summary || null, issue.status || null, issue.statusCategory || null, issue.url || null,
    done ? 'background' : 'active', now.toISOString(),
    done ? now.toISOString() : null,
    done ? listenUntil(now, deps.nextWorkingDay).toISOString() : null,
    seen, issue.updated || null, now.toISOString()]);
  return { ok: true, already: false, ticket: _present(_row(key)) };
}

/** Stop watching. The row is kept (phase ended, reason unwatched) so history survives. */
function unwatch(rawKey) {
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key` };
  const row = _row(key);
  if (!row || row.phase === 'ended') return { ok: false, status: 404, error: `${key} is not being watched` };
  db.run(`UPDATE watched_tickets SET phase = 'ended', ended_at = ?, ended_reason = 'unwatched' WHERE ticket_key = ?`,
    [new Date().toISOString(), key]);
  return { ok: true };
}

/** Mark every unread reply on a ticket as read. */
function markRead(rawKey) {
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key` };
  const r = db.run(`UPDATE watched_ticket_replies SET read_at = ? WHERE ticket_key = ? AND flagged = 1 AND read_at IS NULL`,
    [new Date().toISOString(), key]);
  return { ok: true, marked: r?.changes ?? 0 };
}

function _present(row) {
  if (!row) return null;
  const replies = db.all(`SELECT * FROM watched_ticket_replies WHERE ticket_key = ? ORDER BY created DESC LIMIT 5`, [row.ticket_key]);
  const unread = db.get(`SELECT COUNT(*) AS n FROM watched_ticket_replies WHERE ticket_key = ? AND flagged = 1 AND read_at IS NULL`, [row.ticket_key])?.n || 0;
  return {
    key: row.ticket_key,
    summary: row.summary,
    status: row.status,
    statusCategory: row.status_category,
    url: row.url,
    phase: row.phase,
    watchedAt: row.watched_at,
    resolvedAt: row.resolved_at,
    listeningUntil: row.background_until,
    endedAt: row.ended_at,
    endedReason: row.ended_reason,
    baselineTaken: row.seen_comment_id != null,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    unread,
    replies: replies.map((r) => ({
      id: r.comment_id, author: r.author, created: r.created, excerpt: r.excerpt,
      verdict: r.verdict, judgedBy: r.judged_by, flagged: r.flagged === 1, read: !!r.read_at,
    })),
  };
}

/** What the Escalations page renders. */
function list() {
  const rows = db.all(`SELECT * FROM watched_tickets WHERE phase IN ('active', 'background') ORDER BY watched_at ASC`);
  const items = rows.map(_present);
  const ended = db.all(`SELECT * FROM watched_tickets WHERE phase = 'ended' AND ended_at >= ? ORDER BY ended_at DESC LIMIT 10`,
    [new Date(Date.now() - 14 * 86400000).toISOString()]).map(_present);
  return {
    active: items.filter((t) => t.phase === 'active'),
    listening: items.filter((t) => t.phase === 'background'),
    recentlyEnded: ended,
    unread: items.reduce((n, t) => n + t.unread, 0),
    lastRun: _lastRun,
  };
}

// ── Model judge ──────────────────────────────────────────────────────────────

/** 'thanks' | 'follow-up', or null when the model could not answer. */
async function judgeByModel(text) {
  const prompt = `A customer wrote this on a support ticket that had already been resolved.\n`
    + `Decide whether it is ONLY a thank-you / acknowledgement (nothing more is needed from support), `
    + `or a follow-up that needs attention (a problem, a question, a request, new information).\n`
    + `Ignore email signatures, disclaimers and quoted history.\n`
    + `Answer with JSON only: {"verdict":"thanks"} or {"verdict":"follow-up"}.\n\n`
    + `Customer wrote:\n"""\n${ownWords(text).slice(0, 3000)}\n"""`;
  try {
    const r = await require('./ai-routing').runTask('watched_reply_judge', { prompt, maxTokens: 50 }, { forceCloud: true, timeout: 45000 });
    const m = /"verdict"\s*:\s*"(thanks|follow-up)"/i.exec(r?.text || '');
    return m ? m[1].toLowerCase() : null;
  } catch (e) {
    console.warn(`[Watched] model judge failed: ${e.message}`);
    return null;
  }
}

async function _judge(text, deps) {
  const rule = judgeByRule(text);
  if (rule.verdict !== 'unsure') return { verdict: rule.verdict, by: 'rule' };
  const m = await deps.judge(text);
  if (m === 'thanks' || m === 'follow-up') return { verdict: m, by: 'model' };
  return { verdict: 'follow-up', by: 'model-unavailable' };
}

// ── The poll ─────────────────────────────────────────────────────────────────

let _running = false;
let _lastRun = null;

async function _issues(keys, deps) {
  try {
    const r = await deps.states(keys);
    return { map: new Map((r?.issues || []).map((i) => [i.key, i])), errors: new Map() };
  } catch (e) {
    // One deleted or forbidden key makes Jira refuse the whole `key in (...)`.
    // Ask one at a time so the rest are still checked and the bad one is named.
    const map = new Map(); const errors = new Map();
    for (const k of keys) {
      try {
        const r = await deps.states([k]);
        const i = (r?.issues || []).find((x) => x.key === k);
        if (i) map.set(k, i); else errors.set(k, 'not returned by Jira');
      } catch (e2) { errors.set(k, e2.message); }
    }
    return { map, errors };
  }
}

async function _process(row, issue, deps, now, sent) {
  const done = issue.statusCategory === 'done';
  const wasDone = row.status_category === 'done';
  const listening = row.phase === 'background';
  let phase = row.phase;
  let resolvedAt = row.resolved_at;
  let until = row.background_until;
  if (phase === 'active' && done) {
    phase = 'background'; resolvedAt = now.toISOString(); until = listenUntil(now, deps.nextWorkingDay).toISOString();
  }

  // Comments — only when something changed on the ticket, or the baseline is owed.
  let seen = row.seen_comment_id;
  const fresh = [];
  if (seen == null || issue.updated !== row.jira_updated) {
    const r = await deps.comments(row.ticket_key);
    const comments = r?.comments || [];
    const ids = comments.map(commentId).filter((n) => n != null);
    if (seen == null) {
      seen = ids.length ? Math.max(...ids) : 0;
    } else {
      for (const c of comments) {
        const id = commentId(c);
        if (id != null && id > seen && isCustomerReply(c)) fresh.push(c);
      }
      if (r && r.complete === false && ids.length && Math.min(...ids) > seen) {
        console.warn(`[Watched] ${row.ticket_key}: more new comments than one page — the oldest may be missed`);
      }
      if (ids.length) seen = Math.max(seen, ...ids);
    }
  }
  fresh.sort((a, b) => commentId(a) - commentId(b));

  let followUps = 0; let thanks = 0;
  for (const c of fresh) {
    const text = adfText(c.body);
    let verdict = 'reply'; let by = null;
    if (listening) {
      const j = await _judge(text, deps);
      verdict = j.verdict; by = j.by;
    }
    const flagged = verdict !== 'thanks';
    if (verdict === 'follow-up') followUps += 1;
    if (verdict === 'thanks') thanks += 1;
    const author = c.author?.displayName || 'The customer';
    const excerpt = excerptOf(text);
    const ins = db.run(`INSERT OR IGNORE INTO watched_ticket_replies
        (comment_id, ticket_key, author, created, excerpt, phase, verdict, judged_by, flagged, read_at, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [String(c.id), row.ticket_key, author, c.created || null, excerpt, listening ? 'background' : 'active',
      verdict, by, flagged ? 1 : 0, now.toISOString()]);
    if (flagged && ins?.changes) {
      const title = verdict === 'follow-up'
        ? `${row.ticket_key}: customer came back after it was resolved`
        : `${row.ticket_key}: customer replied`;
      try {
        await deps.push(title, `${author}: ${excerpt.slice(0, 160)}`,
          { type: 'watched_reply', key: `watched:${c.id}`, url: '/?view=escalations' });
        sent.push(String(c.id));
      } catch (e) { console.warn(`[Watched] push for ${row.ticket_key} failed: ${e.message}`); }
    }
  }

  if (listening) {
    if (followUps > 0) { phase = 'active'; resolvedAt = null; until = null; }
    else if (!done && wasDone && fresh.length === 0) { phase = 'active'; resolvedAt = null; until = null; }
    // A reopen that came with nothing but thank-yous stays in the listen.
  }

  let endedAt = null; let endedReason = null;
  if (phase === 'background' && until && now.getTime() > Date.parse(until)) {
    phase = 'ended'; endedAt = now.toISOString(); endedReason = 'quiet-after-resolve';
  }

  db.run(`UPDATE watched_tickets SET summary = ?, status = ?, status_category = ?, url = COALESCE(?, url), phase = ?,
            resolved_at = ?, background_until = ?, ended_at = COALESCE(?, ended_at), ended_reason = COALESCE(?, ended_reason),
            seen_comment_id = ?, jira_updated = ?, last_checked_at = ?, last_error = NULL
          WHERE ticket_key = ?`,
  [issue.summary || row.summary, issue.status || row.status, issue.statusCategory || row.status_category,
    issue.url || null, phase, resolvedAt, until, endedAt, endedReason, seen, issue.updated || null,
    now.toISOString(), row.ticket_key]);
  return { fresh: fresh.length, followUps, thanks };
}

/**
 * One pass over every watched ticket. Never throws. `depsOver` replaces Jira,
 * the model, the push and the clock in tests.
 */
async function check(depsOver) {
  if (_running) return { ok: true, skipped: 'already running' };
  _running = true;
  const deps = _deps(depsOver);
  const now = deps.now();
  try {
    const rows = db.all(`SELECT * FROM watched_tickets WHERE phase IN ('active', 'background')`);
    if (!rows.length) return (_lastRun = { ok: true, at: now.toISOString(), checked: 0 });
    if (!deps.configured()) return (_lastRun = { ok: false, at: now.toISOString(), why: 'Jira is not configured' });

    const { map, errors } = await _issues(rows.map((r) => r.ticket_key), deps);
    const sent = []; let replies = 0; let failed = 0;
    for (const row of rows) {
      const issue = map.get(row.ticket_key);
      if (!issue) {
        failed += 1;
        db.run('UPDATE watched_tickets SET last_checked_at = ?, last_error = ? WHERE ticket_key = ?',
          [now.toISOString(), errors.get(row.ticket_key) || 'not returned by Jira', row.ticket_key]);
        continue;
      }
      try {
        const r = await _process(row, issue, deps, now, sent);
        replies += r.fresh;
      } catch (e) {
        failed += 1;
        db.run('UPDATE watched_tickets SET last_checked_at = ?, last_error = ? WHERE ticket_key = ?',
          [now.toISOString(), e.message.slice(0, 300), row.ticket_key]);
      }
    }
    if (replies || failed) console.log(`[Watched] ${rows.length} checked — ${replies} customer repl${replies === 1 ? 'y' : 'ies'}, ${sent.length} pushed, ${failed} unreadable`);
    return (_lastRun = { ok: failed === 0, at: now.toISOString(), checked: rows.length, replies, pushed: sent.length, failed });
  } catch (e) {
    console.warn(`[Watched] check failed: ${e.message}`);
    return (_lastRun = { ok: false, at: now.toISOString(), why: e.message });
  } finally {
    _running = false;
  }
}

module.exports = {
  watch, unwatch, markRead, list, check,
  PUSH_TYPE, LISTEN_WORKING_DAYS,
  // pure, for the tests
  normaliseKey, isCustomerReply, ownWords, judgeByRule, listenUntil, adfText, excerptOf,
};
