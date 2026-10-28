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

// Our own mail domains. A support mailbox that emails a ticket (the ServiceHub
// resolution notice from tpj.support@nurtur.tech, 28 Oct 2026) gets a JSM
// CUSTOMER account, so accountType alone called it the customer replying.
const OWN_DOMAINS = String(process.env.WATCHED_OWN_DOMAINS || 'nurtur.tech')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

function isOwnAddress(author) {
  for (const v of [author?.emailAddress, author?.displayName]) {
    const m = String(v || '').trim().toLowerCase().match(/@([a-z0-9.-]+)$/);
    if (m && OWN_DOMAINS.some((d) => m[1] === d || m[1].endsWith(`.${d}`))) return true;
  }
  return false;
}

/** A public comment written by a JSM customer account that is not one of ours. Nothing else counts. */
function isCustomerReply(c) {
  return !!c && c.author?.accountType === 'customer' && c.jsdPublic !== false && !isOwnAddress(c.author);
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
  if (!s) return '(an attachment, no text)';
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
  // Measured on live NT tickets (23 Oct 2026): 10 of 29 last customer comments on
  // resolved tickets were an IMAGE and nothing else — a screenshot. That is the
  // "it's still doing this" the listen exists for, never a thank-you.
  if (!own) return { verdict: 'follow-up', why: 'sent an attachment or quoted text only' };
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

// ── Update commitments (PURE) ────────────────────────────────────────────────
//
// "I will provide you with a further update before 5pm today" — Nick's own
// words on NT-35291, the fixture this was built against. A commitment needs
// THREE things in one sentence: a first-person promise (I/we will…), an act of
// telling the customer (update, get back, let you know…), and a time. Anything
// less is not proposed; a proposal is only ever a proposal until he confirms.

const { londonWall, londonInstant, addDays } = require('./promise-score');

const PROMISE_RE = /\b(i|we)\s*(?:'ll|’ll|\s+will|\s+shall|'m going to|’m going to|\s+am going to|\s+are going to|\s+aim to|\s+will aim to|\s+will endeavour to|\s+expect to)\b/i;
const TELL_RE = /\b(update|get back|come back|be in touch|follow up|follow-up|let you know|contact you|call you|ring you|respond|send you|provide you|confirm)\b/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NAMED_TIMES = [
  [/\b(?:end of (?:the )?(?:working )?day|close of (?:business|play)|end of play|cob|eod|eop)\b/i, '17:00'],
  [/\b(?:midday|noon|lunchtime|lunch time)\b/i, '12:00'],
  [/\bthis afternoon\b/i, '17:00'],
  [/\b(?:tomorrow|this) morning\b/i, '12:00'],
  [/\btomorrow afternoon\b/i, '17:00'],
];

function _clock(sentence) {
  const ampm = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i.exec(sentence);
  if (ampm) {
    let h = Number(ampm[1]) % 12; const m = Number(ampm[2] || 0);
    if (ampm[3].toLowerCase() === 'pm') h += 12;
    if (h > 23 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const h24 = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(sentence);
  if (h24) return `${h24[1].padStart(2, '0')}:${h24[2]}`;
  for (const [re, t] of NAMED_TIMES) if (re.test(sentence)) return t;
  return null;
}

/** The London date a sentence names, relative to the day it was written. null = it names none. */
function _day(sentence, madeDate) {
  const s = sentence.toLowerCase();
  if (/\btomorrow\b/.test(s)) return addDays(madeDate, 1);
  if (/\b(today|tonight|this (?:afternoon|morning|evening))\b/.test(s)) return madeDate;
  const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b(?:on|by|before|this|next)?\\s*${d}\\b`).test(s));
  if (wd >= 0) {
    const today = new Date(`${madeDate}T12:00:00Z`).getUTCDay();
    let ahead = (wd - today + 7) % 7;
    if (ahead === 0) ahead = 7;
    return addDays(madeDate, ahead);
  }
  return null;
}

/**
 * { dueAt (ISO), phrase } or null. PURE. `madeAt` is when the reply was posted;
 * the date and time words are read on Europe/London's wall clock.
 */
function detectCommitment(text, madeAt) {
  const madeMs = typeof madeAt === 'number' ? madeAt : Date.parse(madeAt);
  if (!Number.isFinite(madeMs)) return null;
  const madeDate = londonWall(madeMs).date;
  const sentences = ownWords(text).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || !PROMISE_RE.test(s) || !TELL_RE.test(s)) continue;
    const clock = _clock(s);
    const day = _day(s, madeDate);
    if (!clock && !day) continue;
    let dateKey = day || madeDate;
    let due = londonInstant(dateKey, clock || '17:00');
    // "by 9am" written at 16:00 with no day named means tomorrow morning.
    if (!day && due <= madeMs) { dateKey = addDays(dateKey, 1); due = londonInstant(dateKey, clock || '17:00'); }
    if (!Number.isFinite(due) || due <= madeMs) continue;
    return { dueAt: new Date(due).toISOString(), phrase: s.length > 240 ? `${s.slice(0, 239)}…` : s };
  }
  return null;
}

/** The commitment's state at an instant. PURE. */
function commitmentTiming(c, nowMs, leadMs = REMIND_LEAD_MS) {
  const due = Date.parse(c.due_at || c.dueAt);
  if (!Number.isFinite(due)) return { due: null, dueSoon: false, missed: false };
  return { due, dueSoon: nowMs >= due - leadMs && nowMs < due, missed: nowMs >= due };
}

const REMIND_LEAD_MS = 30 * 60000;

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
    // Nick, as Jira knows him: the API token's own email, else his display name.
    isMe: (author) => {
      const email = String(process.env.JIRA_EMAIL || '').toLowerCase();
      return !!author && ((email && String(author.emailAddress || '').toLowerCase() === email)
        || /\bnick ward\b/i.test(author.displayName || ''));
    },
    now: () => new Date(),
  };
}

/** A public reply by Nick — what the customer can see from him. */
function _isMyPublicReply(c, deps) {
  return !!c && c.jsdPublic !== false && c.author?.accountType !== 'customer' && deps.isMe(c.author);
}

/**
 * A public reply by a person on the team (Nick or a colleague) — the customer
 * got an update, so it keeps a promised update whoever wrote it (NT-35291,
 * 23 Oct 2026: Hope's 16:56 reply kept Nick's 17:30 promise and went unseen).
 * Apps (NOVA, Automation for Jira) are not a person updating the customer.
 */
function _isTeamPublicReply(c, deps) {
  if (!c || c.jsdPublic === false) return false;
  if (deps.isMe(c.author)) return c.author?.accountType !== 'customer';
  return c.author?.accountType === 'atlassian';
}

const _commitments = (key, states) => db.all(
  `SELECT * FROM watched_ticket_commitments WHERE ticket_key = ? AND state IN (${states.map(() => '?').join(',')}) ORDER BY due_at ASC`,
  [key, ...states]);

/** Propose what a reply of Nick's promised. Idempotent on the comment id. */
function _proposeFrom(key, comment, deps, nowMs) {
  if (!_isMyPublicReply(comment, deps)) return null;
  const found = detectCommitment(adfText(comment.body), comment.created);
  if (!found || Date.parse(found.dueAt) <= nowMs) return null;
  const r = db.run(`INSERT OR IGNORE INTO watched_ticket_commitments
      (ticket_key, due_at, source, state, phrase, comment_id, made_at) VALUES (?, ?, 'detected', 'proposed', ?, ?, ?)`,
  [key, found.dueAt, found.phrase, String(comment.id), comment.created || new Date(nowMs).toISOString()]);
  return r?.changes ? found : null;
}

/**
 * A public reply from Nick keeps every open commitment made BEFORE it, and
 * supersedes an unconfirmed proposal from an earlier reply. Returns how many.
 */
function _keepWith(key, reply, byOther = null) {
  const at = reply.created;
  const atMs = Date.parse(at);
  const closedBy = byOther ? `reply:${byOther}` : 'reply';
  let kept = 0;
  for (const c of _commitments(key, ['open', 'proposed'])) {
    if (!(Date.parse(c.made_at) < atMs)) continue;
    if (c.state === 'proposed') {
      db.run(`UPDATE watched_ticket_commitments SET state = 'dismissed', closed_at = ?, closed_by = 'superseded' WHERE id = ?`, [at, c.id]);
      continue;
    }
    db.run(`UPDATE watched_ticket_commitments SET state = 'kept', closed_at = ?, closed_by = ?, kept_late = ? WHERE id = ?`,
      [at, closedBy, atMs > Date.parse(c.due_at) ? 1 : 0, c.id]);
    kept += 1;
  }
  return kept;
}

function _deps(over) { return { ..._defaultDeps(), ...(over || {}) }; }

/** The highest comment id now on the ticket, plus the comments (to read Nick's latest promise from). */
async function _baseline(key, deps) {
  try {
    const r = await deps.comments(key);
    if (!r) return { seen: null, comments: [] };
    const ids = (r.comments || []).map(commentId).filter((n) => n != null);
    return { seen: ids.length ? Math.max(...ids) : 0, comments: r.comments || [] };
  } catch (e) {
    console.warn(`[Watched] baseline for ${key} failed: ${e.message} — taken on the next check`);
    return { seen: null, comments: [] };
  }
}

/**
 * At the baseline, Nick's LATEST public reply is not old news if it promised an
 * update still to come — that is how NT-35291 arrives ("before 5pm today",
 * written before he watched it). Only the latest: an earlier promise has been
 * overtaken by the reply after it.
 */
function _proposeFromLatest(key, comments, deps, nowMs) {
  const mine = comments.filter((c) => _isMyPublicReply(c, deps))
    .sort((a, b) => (commentId(b) ?? 0) - (commentId(a) ?? 0));
  return mine.length ? _proposeFrom(key, mine[0], deps, nowMs) : null;
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
  const base = await _baseline(key, deps);
  const seen = base.seen;
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
  const proposed = _proposeFromLatest(key, base.comments, deps, now.getTime());
  return { ok: true, already: false, proposed, ticket: _present(_row(key)) };
}

/** Stop watching. The row is kept (phase ended, reason unwatched) so history survives. */
function unwatch(rawKey) {
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key` };
  const row = _row(key);
  if (!row || row.phase === 'ended') return { ok: false, status: 404, error: `${key} is not being watched` };
  const at = new Date().toISOString();
  db.run(`UPDATE watched_tickets SET phase = 'ended', ended_at = ?, ended_reason = 'unwatched' WHERE ticket_key = ?`, [at, key]);
  db.run(`UPDATE watched_ticket_commitments SET state = 'cancelled', closed_at = ?, closed_by = 'unwatched'
          WHERE ticket_key = ? AND state IN ('open', 'proposed')`, [at, key]);
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
    commitments: _commitmentsFor(row.ticket_key),
    replies: replies.map((r) => ({
      id: r.comment_id, author: r.author, created: r.created, excerpt: r.excerpt,
      verdict: r.verdict, judgedBy: r.judged_by, flagged: r.flagged === 1, read: !!r.read_at,
    })),
  };
}

function _shapeCommitment(c, nowMs = Date.now()) {
  const t = commitmentTiming(c, nowMs);
  return {
    id: c.id, dueAt: c.due_at, source: c.source, state: c.state, phrase: c.phrase,
    madeAt: c.made_at, confirmedAt: c.confirmed_at, closedAt: c.closed_at, closedBy: c.closed_by,
    keptLate: c.kept_late === 1, dueSoon: c.state === 'open' && t.dueSoon, missed: c.state === 'open' && t.missed,
  };
}

/** Open and proposed, plus anything kept in the last 24 hours (so "kept" is seen). */
function _commitmentsFor(key) {
  const since = new Date(Date.now() - 86400000).toISOString();
  return db.all(`SELECT * FROM watched_ticket_commitments WHERE ticket_key = ?
                   AND (state IN ('open', 'proposed') OR (state = 'kept' AND closed_at >= ?))
                 ORDER BY due_at ASC`, [key, since]).map((c) => _shapeCommitment(c));
}

/** London wall clock 'YYYY-MM-DDTHH:MM' or 'HH:MM' (today) → ISO, or null. PURE. */
function parseDue(raw, nowMs) {
  const s = String(raw || '').trim();
  let m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(s);
  let dateKey; let hhmm;
  if (m) { dateKey = m[1]; hhmm = `${m[2]}:${m[3]}`; }
  else if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) { dateKey = londonWall(nowMs).date; hhmm = `${m[1].padStart(2, '0')}:${m[2]}`; }
  else return null;
  const [h, mi] = hhmm.split(':').map(Number);
  if (h > 23 || mi > 59) return null;
  const check = new Date(`${dateKey}T12:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== dateKey) return null;
  const ms = londonInstant(dateKey, hhmm);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Nick adds a commitment by hand. Refused, never repaired: junk or a time already past is 400. */
function addCommitment(rawKey, due, nowMs = Date.now()) {
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key` };
  const row = _row(key);
  if (!row || row.phase === 'ended') return { ok: false, status: 404, error: `${key} is not being watched` };
  const dueAt = parseDue(due, nowMs);
  if (!dueAt) return { ok: false, status: 400, error: 'due must be HH:MM (today) or YYYY-MM-DDTHH:MM, London time' };
  if (Date.parse(dueAt) <= nowMs) return { ok: false, status: 400, error: 'That time has already passed' };
  const at = new Date(nowMs).toISOString();
  const r = db.run(`INSERT INTO watched_ticket_commitments (ticket_key, due_at, source, state, made_at, confirmed_at)
                    VALUES (?, ?, 'manual', 'open', ?, ?)`, [key, dueAt, at, at]);
  return { ok: true, commitment: _shapeCommitment(db.get('SELECT * FROM watched_ticket_commitments WHERE id = ?', [r.lastInsertRowid]), nowMs) };
}

/**
 * confirm (proposed → open) | dismiss (proposed → dismissed, open → cancelled) | done (open → kept, by hand).
 * The wrong state for the action is 409 and changes nothing.
 */
function actOnCommitment(rawKey, id, action, nowMs = Date.now()) {
  const key = normaliseKey(rawKey);
  const c = key && db.get('SELECT * FROM watched_ticket_commitments WHERE id = ? AND ticket_key = ?', [Number(id), key]);
  if (!c) return { ok: false, status: 404, error: 'No such commitment on that ticket' };
  const at = new Date(nowMs).toISOString();
  if (action === 'confirm' && c.state === 'proposed') {
    db.run(`UPDATE watched_ticket_commitments SET state = 'open', confirmed_at = ? WHERE id = ?`, [at, c.id]);
  } else if (action === 'dismiss' && (c.state === 'proposed' || c.state === 'open')) {
    db.run(`UPDATE watched_ticket_commitments SET state = ?, closed_at = ?, closed_by = 'nick' WHERE id = ?`,
      [c.state === 'proposed' ? 'dismissed' : 'cancelled', at, c.id]);
  } else if (action === 'done' && c.state === 'open') {
    db.run(`UPDATE watched_ticket_commitments SET state = 'kept', closed_at = ?, closed_by = 'nick', kept_late = ? WHERE id = ?`,
      [at, nowMs > Date.parse(c.due_at) ? 1 : 0, c.id]);
  } else {
    return { ok: false, status: ['confirm', 'dismiss', 'done'].includes(action) ? 409 : 400,
      error: `Cannot ${action || '(nothing)'} a commitment that is ${c.state}` };
  }
  return { ok: true, commitment: _shapeCommitment(db.get('SELECT * FROM watched_ticket_commitments WHERE id = ?', [c.id]), nowMs) };
}

function _hhmm(iso) { return londonWall(Date.parse(iso)).time; }

/**
 * The two pushes: 30 minutes before (only if he confirmed it before that
 * window opened — one confirmed at 16:45 for 17:00 is already in front of him),
 * and once when the time passes. Always delivered (ALWAYS_DELIVER).
 */
async function _remind(deps, nowMs) {
  const open = db.all(`SELECT c.*, t.summary FROM watched_ticket_commitments c
                       JOIN watched_tickets t ON t.ticket_key = c.ticket_key WHERE c.state = 'open'`);
  let sent = 0;
  for (const c of open) {
    const t = commitmentTiming(c, nowMs);
    if (t.due == null) continue;
    const at = new Date(nowMs).toISOString();
    if (t.missed && !c.missed_at) {
      db.run('UPDATE watched_ticket_commitments SET missed_at = ? WHERE id = ?', [at, c.id]);
      try {
        await deps.push(`${c.ticket_key}: the update you promised for ${_hhmm(c.due_at)} hasn't gone out`,
          `${c.summary || c.ticket_key}: no public reply from you yet.`,
          { type: 'ticket_commitment', key: `tc:${c.id}:missed`, url: '/?view=escalations' });
        sent += 1;
      } catch (e) { console.warn(`[Watched] commitment push failed: ${e.message}`); }
    } else if (t.dueSoon && !c.reminded_at) {
      db.run('UPDATE watched_ticket_commitments SET reminded_at = ? WHERE id = ?', [at, c.id]);
      const confirmedMs = Date.parse(c.confirmed_at || c.made_at);
      if (Number.isFinite(confirmedMs) && confirmedMs > t.due - REMIND_LEAD_MS) continue;
      try {
        await deps.push(`${c.ticket_key}: update due by ${_hhmm(c.due_at)}`,
          `You told the customer you'd update them by ${_hhmm(c.due_at)}. ${c.summary || ''}`.trim(),
          { type: 'ticket_commitment', key: `tc:${c.id}:soon`, url: '/?view=escalations' });
        sent += 1;
      } catch (e) { console.warn(`[Watched] commitment push failed: ${e.message}`); }
    }
  }
  return sent;
}

/**
 * Cards for NEURO's Now (decision-engine's collector): an open commitment from
 * 30 minutes before its time until his reply; a missed one above a due one.
 */
function nowCards(nowMs = Date.now()) {
  let rows;
  try {
    rows = db.all(`SELECT c.*, t.summary, t.url FROM watched_ticket_commitments c
                   JOIN watched_tickets t ON t.ticket_key = c.ticket_key WHERE c.state = 'open'`);
  } catch { return []; }
  const out = [];
  for (const c of rows) {
    const t = commitmentTiming(c, nowMs);
    if (!t.dueSoon && !t.missed) continue;
    const time = _hhmm(c.due_at);
    out.push({
      type: 'ticket_commitment',
      id: `ticket-commitment-${c.id}`,
      dedupeKey: `ticket-commitment:${c.id}`,
      title: t.missed ? `${c.ticket_key}: the update you promised for ${time} is overdue` : `${c.ticket_key}: update the customer by ${time}`,
      reason: `${c.summary || c.ticket_key}${c.phrase ? ` — you wrote: “${c.phrase}”` : ''}`,
      score: t.missed ? 97 : 90,
      urgency: t.missed ? 'critical' : 'high',
      source: 'jira',
      actionHint: `Open ${c.ticket_key} in Jira`,
      meta: { ticket_key: c.ticket_key, url: c.url || null, dueAt: c.due_at, commitmentId: c.id },
    });
  }
  return out;
}

/**
 * Nick just posted `comment` from NEURO (ticket-replies). Do now what the next
 * poll would do — keep what it fulfils — and, for a promise he has just read in
 * the preview, set it OPEN rather than proposing it (his call, 23 Oct 2026).
 * Idempotent on the comment id: the poll that later sees the same comment
 * proposes nothing new.
 */
function recordMyReply(rawKey, comment, nowMs = Date.now()) {
  const key = normaliseKey(rawKey);
  if (!key || !comment || comment.id == null) return { kept: 0, commitment: null };
  const isPublic = comment.jsdPublic !== false;
  const kept = isPublic ? _keepWith(key, comment) : 0;
  let commitment = null;
  if (isPublic) {
    const found = detectCommitment(adfText(comment.body), comment.created);
    if (found && Date.parse(found.dueAt) > nowMs) {
      const at = new Date(nowMs).toISOString();
      db.run(`INSERT OR IGNORE INTO watched_ticket_commitments
          (ticket_key, due_at, source, state, phrase, comment_id, made_at, confirmed_at) VALUES (?, ?, 'detected', 'open', ?, ?, ?, ?)`,
      [key, found.dueAt, found.phrase, String(comment.id), comment.created || at, at]);
      // watch() may already have proposed it from the same reply — confirm that one.
      db.run(`UPDATE watched_ticket_commitments SET state = 'open', confirmed_at = COALESCE(confirmed_at, ?) WHERE comment_id = ? AND state = 'proposed'`,
        [at, String(comment.id)]);
      commitment = _shapeCommitment(db.get('SELECT * FROM watched_ticket_commitments WHERE comment_id = ?', [String(comment.id)]), nowMs);
    }
  }
  return { kept, commitment };
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
      _proposeFromLatest(row.ticket_key, comments, deps, now.getTime());
    } else {
      const mine = [];
      for (const c of comments) {
        const id = commentId(c);
        if (id == null || id <= seen) continue;
        if (isCustomerReply(c)) fresh.push(c);
        else if (_isTeamPublicReply(c, deps)) mine.push(c);
      }
      // Oldest first: a reply keeps what came before it, then (Nick's only) may promise again.
      mine.sort((a, b) => commentId(a) - commentId(b));
      for (const c of mine) {
        const isMe = deps.isMe(c.author);
        _keepWith(row.ticket_key, c, isMe ? null : (c.author?.displayName || 'a colleague'));
        if (isMe) _proposeFrom(row.ticket_key, c, deps, now.getTime());
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
    db.run(`UPDATE watched_ticket_commitments SET state = 'cancelled', closed_at = ?, closed_by = 'watch-ended'
            WHERE ticket_key = ? AND state IN ('open', 'proposed')`, [endedAt, row.ticket_key]);
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
    const reminders = await _remind(deps, now.getTime());
    if (replies || failed || reminders) console.log(`[Watched] ${rows.length} checked — ${replies} customer repl${replies === 1 ? 'y' : 'ies'}, ${sent.length} pushed, ${reminders} commitment reminder(s), ${failed} unreadable`);
    return (_lastRun = { ok: failed === 0, at: now.toISOString(), checked: rows.length, replies, pushed: sent.length, failed });
  } catch (e) {
    console.warn(`[Watched] check failed: ${e.message}`);
    return (_lastRun = { ok: false, at: now.toISOString(), why: e.message });
  } finally {
    _running = false;
  }
}

module.exports = {
  watch, unwatch, markRead, list, check, addCommitment, actOnCommitment, nowCards, recordMyReply, isWatched: (k) => { const r = _row(normaliseKey(k)); return !!r && r.phase !== 'ended'; },
  PUSH_TYPE, LISTEN_WORKING_DAYS,
  // pure, for the tests
  normaliseKey, isCustomerReply, detectCommitment, commitmentTiming, parseDue, ownWords, judgeByRule, listenUntil, adfText, excerptOf,
};
