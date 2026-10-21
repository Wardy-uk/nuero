'use strict';

/**
 * Promise delivery — the ONE producer of promise-linked delivery evidence
 * (21 Oct 2026). Selected from `promise-loop.prepare` on saim-meeting-promises
 * (13516eef / 27dd2a7b): the deliver-email half only.
 *
 * It PREPARES a governed `compose_email` through the existing
 * prepared-actions path and nothing else. Its evidence names the promise:
 *   { promiseKey, move: 'deliver-email', taskIds }
 * which is exactly what promise-score-v1 reads once the existing executor has
 * sent it and Sent Items has read it back (`verified`).
 *
 * What it keeps from the loop, unchanged:
 *   - origin 'saim-promise' — SAiM drafted it, so approval needs the APPROVAL
 *     CODE in Actions (intent-grants: not a human origin);
 *   - the [details] placeholder, which the executor refuses to send until Nick
 *     has written what he promised (an edit keeps the evidence and origin);
 *   - an employment matter gets the ROUTING NOTE and no draft, refused here at
 *     the write door, not just hidden;
 *   - a recipient NEURO cannot name exactly once is CHOSEN by Nick, never guessed;
 *   - one live delivery draft per promise.
 * What it deliberately does NOT bring: the goal proposal, chase emails,
 * re-commits, "I delivered it" closures, task closing and the agent_state loop
 * store. There is no new sender, executor, allowance or confirmation: sending
 * is the governed executor's, after Nick's approval.
 */

const policy = require('../../saim/policy/promises.cjs');

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MOVE = 'deliver-email';
const ORIGIN = 'saim-promise';
/** A promise with an action in one of these already has its delivery in hand. */
const LIVE = ['prepared', 'approved', 'executing', 'execution_uncertain', 'executed', 'verified'];

const msOf = (now) => (typeof now === 'number' ? now : Date.parse(now));
const firstName = (name) => String(name || '').split(/\s+/)[0] || 'there';
const sentenceCase = (t) => { const s = String(t || '').trim().replace(/[.\s]+$/, ''); return s.charAt(0).toLowerCase() + s.slice(1); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** PURE (from promise-loop). "2026-08-18 – Weekly Meeting TLO" → "our Weekly Meeting TLO on 18 Aug". */
function meetingPhrase(title) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s*[–—-]\s*(.+)$/.exec(String(title || '').trim());
  if (!m) return title ? `our meeting (${String(title).trim()})` : 'our meeting';
  const name = m[4].split(/[,:]/)[0].trim();
  return `our ${name} on ${Number(m[3])} ${MON[Number(m[2]) - 1]}`;
}

/** PURE (from promise-loop, deliver-email only). [details] is where Nick puts what he promised. */
function draftFor(p, recipientName) {
  return {
    subject: `Following up: ${String(p.text).trim().replace(/[.\s]+$/, '').slice(0, 120)}`,
    body: `Hi ${firstName(recipientName)},\n\nIn ${meetingPhrase(p.source && p.source.title)} I said I would ${sentenceCase(p.text)}. Here it is:\n\n[details]\n\nNick`,
  };
}

/** The promise-linked delivery actions already on record for a key (any version). */
function actionsFor(key, db = require('../db/database')) {
  const rows = db.all(`SELECT action_id, status, evidence_json, created_at FROM prepared_actions WHERE evidence_json LIKE ? ORDER BY created_at`, [`%${key}%`]);
  return rows.filter((r) => { try { const e = JSON.parse(r.evidence_json); return e.promiseKey === key && e.move === MOVE; } catch { return false; } });
}

/**
 * Prepare the governed delivery email for one promise. Never sends.
 *   to: [{ name, email }] — required when NEURO cannot name ONE recipient.
 * Deps (tests only): ledger, contacts.
 */
function prepare(key, { to = null, now = Date.now(), deps = {} } = {}) {
  const nowMs = msOf(now);
  let facts;
  try { facts = deps.ledger || require('./promise-ledger').read({ now: nowMs }); } catch (e) { return { ok: false, code: 503, error: `NEURO couldn’t read your promises: ${e.message}` }; }
  if ((facts.gaps || []).some((g) => g.input === 'tasks')) return { ok: false, code: 503, error: 'NEURO couldn’t read the task list, so nothing is prepared' };
  const p = (facts.promises || []).find((x) => x.key === key);
  if (!p) return { ok: false, code: 404, error: 'no such promise' };
  // ⚠ The HR rule, enforced at the write door.
  if (p.sensitivity && p.sensitivity.sensitive) return { ok: false, code: 409, routing: true, error: policy.ROUTING_TEXT };
  if (!p.open) return { ok: false, code: 409, error: 'this promise is closed — there is nothing left to deliver' };

  let existing;
  try { existing = actionsFor(key); } catch (e) { return { ok: false, code: 503, error: `NEURO couldn’t read its prepared actions: ${e.message}` }; }
  const live = existing.filter((r) => LIVE.includes(r.status));
  if (live.some((r) => r.status === 'verified')) return { ok: false, code: 409, delivered: true, error: 'this promise was already delivered and read back in Sent Items' };
  if (live.length) {
    const pa = require('./prepared-actions');
    return { ok: true, already: true, action: pa.get(live[live.length - 1].action_id) };
  }

  let recipients;
  if (Array.isArray(to) && to.length) {
    recipients = to.map((r) => ({ name: r && r.name ? String(r.name).slice(0, 120) : null, email: String((r && r.email) || '').trim().toLowerCase() }));
    if (recipients.some((r) => !EMAIL_RE.test(r.email))) return { ok: false, code: 400, error: 'a recipient address is not valid' };
  } else {
    if (!p.owedTo || !p.owedTo.resolved) return { ok: false, code: 409, recipientNeeded: true, error: 'NEURO cannot tell who this is owed to — choose the recipient' };
    const contacts = deps.contacts || require('./contact-directory').fromPeopleNotes();
    const c = contacts.find((x) => x.name === p.owedTo.resolved);
    if (!c || !EMAIL_RE.test(String(c.email || ''))) return { ok: false, code: 409, recipientNeeded: true, error: `no address for ${p.owedTo.resolved} in their People note — choose the recipient` };
    recipients = [{ name: c.name, email: String(c.email).toLowerCase() }];
  }

  const d = draftFor(p, recipients[0].name);
  return require('./prepared-actions').prepareCompose({
    from: 'work', to: recipients, subject: d.subject, body: d.body, origin: ORIGIN,
    generatedBy: 'template (promise delivery, no model call)',
    evidence: { promiseKey: key, move: MOVE, taskIds: p.taskIds },
    now: nowMs,
  });
}

module.exports = { MOVE, ORIGIN, LIVE, meetingPhrase, draftFor, actionsFor, prepare };
