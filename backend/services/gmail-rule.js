'use strict';

/**
 * Which Gmail messages reach NEURO's Gmail tab (12 Oct 2026, Nick). PURE apart
 * from the two small stores at the bottom (rules + correspondents, agent_state).
 *
 * Measured first, over the 30 days to 12 Oct: 1,693 received, 80% mailing-list
 * mail, 1% opened, 2% marked Important by Gmail. Important found most of what
 * mattered and MISSED the rest (Zilch payment reminders, a recruiter writing to
 * him, a family invitation) — so Gmail's verdict is ONE reason here, beside
 * rescues NEURO decides itself. Every shown message carries the reason it was
 * shown, in words, so a surprising row can be traced to the rule that let it in.
 *
 * Order, explicit first:
 *   hidden  — Nick said "stop showing this sender". Beats everything.
 *   keep    — Nick said "always show this sender" (address or @domain).
 *   starred — he starred it in Gmail.
 *   wrote   — from someone he has written to from Gmail in the last year.
 *   important — Gmail marks it Important.
 *   personal  — Gmail's Primary tab AND not a mailing list AND not automated.
 * Anything else is not shown. Nothing here ever changes the mailbox.
 */

const RULES_KEY = 'gmail_sender_rules';
const CORRESPONDENTS_KEY = 'gmail_correspondents';
const CORRESPONDENTS_TTL_MS = 24 * 3600 * 1000;

const REASON_WORDS = {
  keep: 'On your always-show list',
  starred: 'Starred in Gmail',
  wrote: 'Someone you have written to',
  important: 'Gmail marks it Important',
  personal: 'Personal-looking: Primary tab, not a mailing list',
};

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** A sender rule key: a full address or "@domain". Anything else is null (refused). */
function normSender(s) {
  const v = String(s || '').trim().toLowerCase();
  if (EMAIL_RE.test(v) || DOMAIN_RE.test(v)) return v;
  return null;
}

function senderMatches(list, email) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  const domain = `@${e.split('@')[1] || ''}`;
  return (list || []).some((x) => x === e || x === domain);
}

const _has = (setOrList, v) => (setOrList instanceof Set ? setOrList.has(v) : Array.isArray(setOrList) && setOrList.includes(v));

/** A mailing list: List-Unsubscribe / List-Id / Precedence bulk|list|junk. */
function isBulk(headers) { return /(^|\n)(list-unsubscribe|list-id):|(^|\n)precedence:\s*(bulk|list|junk)/i.test(String(headers || '')); }
/** Machine-sent: Auto-Submitted anything but "no". */
function isAuto(headers) { return /(^|\n)auto-submitted:\s*(?!no\b)\S+/i.test(String(headers || '')); }

/**
 * { show, reason } for one message. msg: { fromEmail, labels, flags, headers,
 * primary }. ctx: { keep, hide, correspondents (Set), own (Nick's address) }.
 */
function judge(msg, ctx = {}) {
  const from = String((msg && msg.fromEmail) || '').toLowerCase();
  if (!from) return { show: false, reason: 'no-sender' };
  if (ctx.own && from === String(ctx.own).toLowerCase()) return { show: false, reason: 'own' };
  if (senderMatches(ctx.hide, from)) return { show: false, reason: 'hidden' };
  if (senderMatches(ctx.keep, from)) return { show: true, reason: 'keep' };
  if (_has(msg.flags, '\\Flagged')) return { show: true, reason: 'starred' };
  if (ctx.correspondents && ctx.correspondents.has(from)) return { show: true, reason: 'wrote' };
  if (_has(msg.labels, '\\Important')) return { show: true, reason: 'important' };
  if (msg.primary && !isBulk(msg.headers) && !isAuto(msg.headers)) return { show: true, reason: 'personal' };
  return { show: false, reason: isBulk(msg.headers) ? 'bulk' : 'not-matched' };
}

// ── the two small stores ─────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function readRules() {
  try {
    const r = JSON.parse(_db().getState(RULES_KEY) || 'null');
    if (r && Array.isArray(r.keep) && Array.isArray(r.hide)) return { keep: r.keep, hide: r.hide };
  } catch { /* fall through */ }
  return { keep: [], hide: [] };
}

/**
 * Put a sender on 'keep' or 'hide', or take it off both (list null). A sender is
 * on at most one list. Refuses what is not an address or @domain.
 */
function setRule(sender, list) {
  const s = normSender(sender);
  if (!s) return { ok: false, error: 'A sender is a full email address or @domain.' };
  if (list !== null && list !== 'keep' && list !== 'hide') return { ok: false, error: 'list must be keep, hide or null' };
  const r = readRules();
  const next = { keep: r.keep.filter((x) => x !== s), hide: r.hide.filter((x) => x !== s) };
  if (list) next[list] = [...next[list], s].sort();
  _db().setState(RULES_KEY, JSON.stringify(next));
  return { ok: true, sender: s, list, rules: next };
}

function readCorrespondents() {
  try {
    const c = JSON.parse(_db().getState(CORRESPONDENTS_KEY) || 'null');
    if (c && Array.isArray(c.addresses)) return c;
  } catch { /* fall through */ }
  return null;
}
function correspondentsStale(c, now) { return !c || !(Date.parse(c.at) > now - CORRESPONDENTS_TTL_MS); }
function writeCorrespondents(addresses, at) {
  _db().setState(CORRESPONDENTS_KEY, JSON.stringify({ at, addresses: [...new Set(addresses)].sort() }));
}

module.exports = {
  RULES_KEY, CORRESPONDENTS_KEY, REASON_WORDS,
  normSender, senderMatches, isBulk, isAuto, judge,
  readRules, setRule, readCorrespondents, correspondentsStale, writeCorrespondents,
};
