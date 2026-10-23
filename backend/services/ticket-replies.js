'use strict';

/**
 * Draft and post a reply on a Jira ticket from the Escalations page (23 Oct 2026).
 *
 * Nick's design calls, asked one at a time:
 *  - DRAFT: a model drafts from the ticket's own thread, to Nurtur's three
 *    golden rules (Ownership, What's happening, Timeframes), steered by an
 *    optional line from Nick. Anything the thread and his line do not say is a
 *    [square-bracket gap] — never an invented owner, fix or time — and a reply
 *    with a gap left in it cannot be posted.
 *  - POST: his click on a preview is the approval (the Inbox Send rule). It is
 *    the external writer `jira.comment` (A3, human-only, ledgered): written to
 *    the ledger BEFORE the call, read back after, one post per exact text, and
 *    an unknown outcome blocks a repeat until he resolves it — a timeout must
 *    never become a second message to a customer.
 *  - VISIBILITY: a toggle, defaulting to INTERNAL. Posted through JSM's request
 *    API (`public: false` is the real internal-note marker); the read-back
 *    checks the comment landed with the visibility asked for, and says so
 *    loudly if it did not.
 *  - PROMISE: a public reply that promises an update ("by 5pm today") sets an
 *    OPEN commitment at once (he read it in the preview) and starts watching
 *    the ticket, so reminders and kept-by-reply work.
 */

const crypto = require('crypto');
const ext = require('./external-writes');
const wt = require('./watched-tickets');

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const MAX_TEXT = 20000;
const VISIBILITIES = ['public', 'internal'];
// A gap the draft left for Nick: "[time of next update]". Two or more
// characters, so "[1]" style references and a lone "[x]" checkbox stay legal.
const GAP_RE = /\[[^\]\n]{2,60}\]/;

function normaliseKey(k) {
  const key = String(k || '').trim().toUpperCase();
  return KEY_RE.test(key) ? key : null;
}

// ── PURE ─────────────────────────────────────────────────────────────────────

/** Why this text cannot be posted, or null. */
function problemsWith(text) {
  const t = String(text || '');
  if (!t.trim()) return 'The reply is empty.';
  if (t.length > MAX_TEXT) return `The reply is longer than ${MAX_TEXT} characters.`;
  const gap = GAP_RE.exec(t);
  if (gap) return `Fill in ${gap[0]} before posting — it is a gap the draft left for you.`;
  return null;
}

/** What posting would do. PURE apart from the clock. */
function preview({ key, text, visibility, watched, nowMs = Date.now() }) {
  const vis = VISIBILITIES.includes(visibility) ? visibility : null;
  const promise = vis === 'public' ? wt.detectCommitment(text, new Date(nowMs).toISOString()) : null;
  return {
    key, visibility: vis,
    audience: vis === 'public' ? 'The customer sees this, from you.' : vis === 'internal' ? 'Internal note — your team sees it, the customer does not.' : null,
    problem: vis ? problemsWith(text) : 'Choose public reply or internal note.',
    promise,
    willWatch: vis === 'public' && !watched,
  };
}

function firstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0];
  return n && /^[A-Za-z][A-Za-z'’-]*$/.test(n) ? n : null;
}

/** The thread, oldest first, labelled by who wrote it. */
function threadText(comments, isMe) {
  return [...(comments || [])].sort((a, b) => Number(a.id) - Number(b.id)).slice(-15).map((c) => {
    const who = c.author?.accountType === 'customer' ? `CUSTOMER (${c.author.displayName || 'customer'})`
      : isMe(c.author) ? 'NICK' : c.author?.accountType === 'app' ? 'AUTOMATION' : `AGENT (${c.author?.displayName || 'agent'})`;
    const vis = c.jsdPublic === false ? 'INTERNAL NOTE — never repeat to the customer' : 'public';
    return `--- ${who} · ${vis} · ${c.created || ''}\n${wt.ownWords(wt.adfText(c.body)).slice(0, 1500)}`;
  }).join('\n\n');
}

function buildPrompt({ ticket, comments, guidance, visibility, isMe }) {
  const name = firstName(ticket.reporter);
  const audience = visibility === 'public'
    ? `A PUBLIC reply to the customer${name ? ` (${name})` : ''}, written as Nick Ward, Head of Technical Support at Nurtur. Plain, warm, professional British English. Open with a greeting by first name if known, end "Kind regards,\\nNick". Never mention internal notes, internal names of systems or blame.`
    : 'An INTERNAL NOTE for Nurtur colleagues (the customer never sees it). Blunt and concise, no greeting or sign-off.';
  return [
    `Draft ${audience}`,
    '',
    'It must meet Nurtur\'s three golden rules:',
    '- Ownership: name who owns the next step (a person, role or team), never "the relevant team".',
    '- What\'s happening: a concrete next action, not "looking into it".',
    '- Timeframes: when the next update or step happens ("by 3pm today"), never "ASAP" or "shortly".',
    '',
    'Meet the rules in natural prose — short paragraphs, no headings, no labels like "What\'s happening:".',
    'PLAIN TEXT ONLY: no markdown, no **bold**, no # headings, no bullet symbols — Jira shows them to the reader literally.',
    '',
    'Use ONLY facts from the ticket thread and Nick\'s note below. If something the rules need is not known —',
    'an owner, what is happening, a time — write ONE short gap in square brackets for Nick to fill, e.g. [time of next update].',
    'A gap is a single pair of brackets, never nested, never offering options inside it.',
    'Never invent a name, a fix, a cause or a time. Return only the reply text, nothing else.',
    '',
    `Ticket ${ticket.key}: ${ticket.summary}`,
    `Status: ${ticket.status || 'unknown'} · Priority: ${ticket.priority || 'unset'} · Assignee: ${ticket.assignee || 'unassigned'}`,
    '',
    `Nick's note on what to say: ${String(guidance || '').trim() || '(none — draft from the thread, leaving gaps where needed)'}`,
    '',
    'Thread (oldest first):',
    threadText(comments, isMe) || '(no comments yet)',
  ].join('\n');
}

function _isMe(author) {
  const email = String(process.env.JIRA_EMAIL || '').toLowerCase();
  return !!author && ((email && String(author.emailAddress || '').toLowerCase() === email)
    || /\bnick ward\b/i.test(author.displayName || ''));
}

function _deps(over) {
  const jira = require('./jira');
  return {
    basics: (k) => jira.fetchIssueBasics(k),
    comments: (k) => jira.fetchIssueComments(k),
    post: (k, body, isPublic) => jira.postRequestComment(k, body, isPublic),
    model: async (prompt) => {
      const r = await require('./ai-routing').runTask('ticket_reply_draft', { prompt, maxTokens: 900 }, { forceCloud: true, timeout: 60000 });
      if (!r || !r.text) throw new Error((r && r.reason) || 'no AI provider answered');
      return { text: r.text, model: r.model || r.provider || null };
    },
    watch: (k) => wt.watch(k),
    isWatched: (k) => wt.isWatched(k),
    recordMyReply: (k, c) => wt.recordMyReply(k, c),
    isMe: _isMe,
    now: () => Date.now(),
    ...(over || {}),
  };
}

// ── Draft ────────────────────────────────────────────────────────────────────

async function draft({ key: rawKey, guidance, visibility }, depsOver) {
  const d = _deps(depsOver);
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key` };
  if (!VISIBILITIES.includes(visibility)) return { ok: false, status: 400, error: 'visibility must be public or internal' };
  if (guidance != null && String(guidance).length > 2000) return { ok: false, status: 400, error: 'The note is too long (2,000 characters at most).' };
  let ticket; let comments;
  try {
    ticket = await d.basics(key);
    comments = (await d.comments(key))?.comments || [];
  } catch (e) {
    return { ok: false, status: /404|does not exist/i.test(e.message) ? 404 : 502, error: `Could not read ${key} from Jira: ${e.message}` };
  }
  if (!ticket) return { ok: false, status: 503, error: 'Jira is not configured on NEURO' };
  let answer;
  try {
    answer = await d.model(buildPrompt({ ticket, comments, guidance, visibility, isMe: d.isMe }));
  } catch (e) {
    return { ok: false, status: 502, error: `Couldn't draft it: ${e.message}. You can still write it yourself.` };
  }
  const text = String(answer.text || '').trim().replace(/^```\w*\n?|\n?```$/g, '').trim();
  return { ok: true, text, model: answer.model, ...preview({ key, text, visibility, watched: d.isWatched(key), nowMs: d.now() }) };
}

// ── Post ─────────────────────────────────────────────────────────────────────

const READBACK_WINDOW_MS = 5 * 60000;

async function post({ key: rawKey, text, visibility, initiatedBy = 'nick' }, depsOver) {
  const d = _deps(depsOver);
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key` };
  if (!VISIBILITIES.includes(visibility)) return { ok: false, status: 400, error: 'visibility must be public or internal' };
  const problem = problemsWith(text);
  if (problem) return { ok: false, status: 400, error: problem };
  const body = String(text).trim();
  const isPublic = visibility === 'public';

  const hash = crypto.createHash('sha256').update(`${visibility}\n${body}`).digest('hex').slice(0, 16);
  const claim = ext.begin({ writer: 'jira.comment', key: `jira-comment:${key}:${hash}`, target: key,
    request: { key, visibility, chars: body.length, hash }, initiatedBy, now: d.now() });
  if (!claim.ok) {
    if (claim.duplicate) return { ok: false, status: 409, outcome: 'duplicate', error: `That exact ${isPublic ? 'reply' : 'note'} is already on ${key} — not posted twice.` };
    if (claim.blocked) return { ok: false, status: 409, outcome: 'blocked', ledgerKey: claim.entry.key,
      error: `The last attempt to post this to ${key} has an unknown outcome. Check the ticket in Jira first, then say whether it is there.` };
    return { ok: false, status: 400, outcome: 'refused', error: claim.why };
  }

  const startedAt = d.now();
  let created;
  try {
    created = await d.post(key, body, isPublic);
  } catch (e) {
    const status = ext.classifyError(e);
    ext.settle(claim.entry.id, { status, result: { error: e.message }, now: d.now() });
    return { ok: false, status: 502, outcome: status, ledgerKey: status === 'uncertain' ? claim.entry.key : null, error: status === 'failed'
      ? `Jira refused it: ${e.message}. Nothing was posted.`
      : `Jira didn't answer clearly (${e.message}). It may or may not have posted — check ${key} before trying again.` };
  }

  // Read back: the comment exists, is Nick's, and has the visibility asked for.
  let found = null; let readback = 'unreadable';
  try {
    const all = (await d.comments(key))?.comments || [];
    found = all.find((c) => created?.id && String(c.id) === String(created.id))
      || all.find((c) => d.isMe(c.author) && Date.parse(c.created) >= startedAt - READBACK_WINDOW_MS
        && wt.ownWords(wt.adfText(c.body)).replace(/\s+/g, ' ').trim().startsWith(body.replace(/\s+/g, ' ').trim().slice(0, 60)));
    if (!found) readback = 'comment not found';
    else if ((found.jsdPublic !== false) !== isPublic) readback = `VISIBILITY MISMATCH: asked ${visibility}, landed ${found.jsdPublic === false ? 'internal' : 'public'}`;
    else readback = `${visibility} comment present`;
  } catch { /* stays unreadable */ }
  const confirmed = readback === `${visibility} comment present`;
  ext.settle(claim.entry.id, { status: confirmed ? 'confirmed' : 'applied-unverified',
    result: { commentId: created?.id || null }, readback, now: d.now() });

  let watchedNow = false; let commitment = null;
  if (isPublic) {
    try {
      if (!d.isWatched(key)) { await d.watch(key); watchedNow = true; }
      if (found) commitment = d.recordMyReply(key, found).commitment;
    } catch (e) { console.warn(`[TicketReplies] after-post bookkeeping for ${key} failed: ${e.message}`); }
  }

  return {
    ok: true, outcome: confirmed ? 'confirmed' : 'applied-unverified', commentId: created?.id || null,
    visibility, readback, watchedNow, commitment,
    warning: readback.startsWith('VISIBILITY MISMATCH')
      ? `Posted, but Jira shows it as ${found.jsdPublic === false ? 'INTERNAL' : 'PUBLIC'} — not what you chose. Check ${key} now.`
      : confirmed ? null : `Jira accepted it but NEURO couldn't read it back (${readback}). Check ${key}.`,
  };
}

module.exports = { draft, post, preview, problemsWith, buildPrompt, VISIBILITIES };
