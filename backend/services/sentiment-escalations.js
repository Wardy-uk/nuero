'use strict';

/**
 * Sentiment escalations (28 Oct 2026). Nick: "if a ticket is flagged as Angry in
 * NOVA, it should automatically escalate to me in Neuro". NOVA owns the score;
 * this keeps the list, its seen state and the push.
 *
 * `sentiment_escalation_seen` = { [key]: { seen, summary, score, angryAt } }. Same
 * rules as pending rejections: unseen until Nick opens the row; a ticket that
 * stops being Angry (calmer reply, or resolved) is DROPPED, so turning angry again
 * later is a new escalation. Only a complete, successful read may drop anything.
 *
 * A push goes out once per ticket arriving in the list. The very first read seeds
 * silently — the tickets already angry did not just arrive, and pushing the whole
 * backlog at once would teach Nick to ignore this.
 */

const db = require('../db/database');
const nova = require('./nova-client');

const STORE = 'sentiment_escalation_seen';
const SEEDED = 'sentiment_escalation_seeded';

function _read() {
  try { const raw = db.getState(STORE); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function jiraUrl(key) {
  const base = String(process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}/browse/${key}` : null;
}

/** Fold a fresh, COMPLETE list into the store. Returns the tickets that are new to it. */
function absorb(list) {
  const known = _read();
  const next = {};
  const arrived = [];
  for (const t of list || []) {
    if (!known[t.key]) arrived.push(t);
    next[t.key] = { ...(known[t.key] || { seen: false }), summary: t.summary || '', score: t.score, angryAt: t.angryAt || null };
  }
  db.setState(STORE, JSON.stringify(next));
  db.setState('sentiment_escalation_last_sync', new Date().toISOString());
  return arrived;
}

/** Stamp each ticket with `seen` and its Jira link (an unknown key is unseen). */
function decorate(list) {
  const known = _read();
  return (list || []).map((t) => ({ ...t, url: t.url || jiraUrl(t.key), seen: !!known[t.key]?.seen }));
}

/** Mark the NAMED keys seen. Returns the keys that changed. */
function markSeen(keys) {
  const known = _read();
  const changed = [];
  for (const k of new Set((keys || []).filter(Boolean))) {
    if (known[k] && !known[k].seen) { known[k].seen = true; known[k].seenAt = new Date().toISOString(); changed.push(k); }
  }
  if (changed.length) db.setState(STORE, JSON.stringify(known));
  return changed;
}

function getUnseenCount() {
  return Object.values(_read()).filter((r) => !r.seen).length;
}

/**
 * Read NOVA, absorb, push for each new arrival. Throws when NOVA cannot answer,
 * leaving the store as it was — an unread list is not an empty one.
 */
async function sync({ push = (title, body, data) => require('./webpush').sendToAll(title, body, data) } = {}) {
  if (!nova.isConfigured()) return { ok: false, reason: 'NOVA not configured' };
  const data = await nova.listSentimentEscalations();
  const tickets = data?.tickets || [];
  const seeded = !!db.getState(SEEDED);
  const arrived = absorb(tickets);
  if (!seeded) {
    db.setState(SEEDED, new Date().toISOString());
    return { ok: true, total: tickets.length, arrived: arrived.length, pushed: 0, seeded: true };
  }
  let pushed = 0;
  for (const t of arrived) {
    try {
      await push(`${t.key}: customer is angry`,
        `${t.summary || t.key}${t.why ? ` — ${t.why}` : ''}`.slice(0, 200),
        { type: 'sentiment_escalation', key: `sentiment:${t.key}:${t.commentId || t.angryAt || ''}`, url: '/?view=escalations' });
      pushed += 1;
    } catch (e) { console.warn(`[Sentiment] push for ${t.key} failed: ${e.message}`); }
  }
  return { ok: true, total: tickets.length, arrived: arrived.length, pushed };
}

module.exports = { absorb, decorate, markSeen, getUnseenCount, sync, STORE };
