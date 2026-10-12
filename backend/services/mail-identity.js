'use strict';

/**
 * Which address an email goes from (12 Oct 2026). THE one answer — every screen
 * that shows "sends from" renders what this returns, and every sender picks its
 * transport from the same answer, so the two cannot disagree.
 *
 * Nick's rules:
 *   · Work people → the work address (nickw@nurtur.tech, Microsoft Graph).
 *   · Personal people, written or approved by Nick → nick@nickward.co.uk.
 *   · Mail NEURO writes itself (hike alerts, all-clears, reminders) → saim@,
 *     "SAiM (for Nick Ward)", Reply-To nick@ — work as the fallback.
 *   · A reply goes from the mailbox the email arrived in (Gmail included).
 *   · A mixed or unknown audience is ASKED about, never guessed.
 *
 * Who someone is comes from the People model (`people-model.sphereFor` — a
 * People note line, a stating field, or Nick's correction), an address on a
 * work domain, or a list Nick set himself (the hike contacts). Never from
 * whether he happens to email them.
 */

const pm = require('./personal-mail');

const WORK_DOMAINS = ['nurtur.tech'];
// ⚠ Owned here, NOT required from email-sender: prepared-actions (which renders
// "sends from") must import no sender, even indirectly. A test pins this equal
// to email-sender.OWN_ADDRESS so the two cannot drift.
const WORK_ADDRESS = 'nickw@nurtur.tech';

function workSender() {
  const address = WORK_ADDRESS;
  return { mailbox: 'work', address, from: pm.formatAddress('Nick Ward', address), replyTo: null, via: 'Microsoft (Outlook)' };
}

function personalSender(key) {
  const s = pm.senderFor(key);
  if (!s) return null;
  return { ...s, via: pm.PROVIDERS[pm.box(key).provider].label };
}

/** Sender for a mailbox key ('work' or a personal key), or null if it cannot send. */
function senderFor(mailbox) {
  if (mailbox === 'work') return workSender();
  if (!pm.credentialFor(mailbox)) return null;
  return personalSender(mailbox);
}

/** Can this personal mailbox be trusted to send right now? Saved password, and its last check did not fail. */
function usable(key) {
  if (!pm.credentialFor(key)) return { ok: false, why: `${pm.box(key).address || key} has no password saved in Settings` };
  const check = (pm.status().mailboxes.find((m) => m.key === key) || {}).check;
  if (check && check.smtp && check.smtp.ok === false) return { ok: false, why: `${pm.box(key).address} failed its last connection check` };
  return { ok: true };
}

/**
 * Mail NEURO writes itself. saim@ when usable, else work — and says which, and why.
 */
function forNeuroGenerated() {
  const u = usable('saim');
  if (u.ok) return { ...personalSender('saim'), fallback: workSender(), why: 'NEURO wrote it, so it comes from SAiM; replies go to nick@.' };
  return { ...workSender(), fallback: null, why: `Would come from saim@, but ${u.why} — so it goes from your work address.` };
}

/**
 * The hike overdue alert (Nick, 12 Oct 2026): from saim@ AND a copy from his
 * Gmail — two independent sends, so one being refused or spam-foldered does
 * not leave Helen with nothing. Not from work. The work address is a LAST
 * RESORT only, used when neither personal mailbox can send at that moment
 * (a missing alert is worse than one from the wrong address).
 *   { primary, copy, lastResort, why }
 */
function forHikeAlert() {
  const saim = usable('saim').ok;
  const gmail = usable('gmail').ok;
  if (saim) return { primary: 'saim', copy: gmail ? 'gmail' : null, lastResort: 'work', why: gmail ? 'From SAiM, and a copy from your Gmail.' : `From SAiM only — ${usable('gmail').why}.` };
  if (gmail) return { primary: 'gmail', copy: null, lastResort: 'work', why: `From your Gmail only — ${usable('saim').why}.` };
  return { primary: 'work', copy: null, lastResort: null, why: `Neither saim@ nor your Gmail can send (${usable('saim').why}; ${usable('gmail').why}), so the last resort — your work address — would be used.` };
}

/**
 * A governed action. Derived from the SAME registry field the executor
 * dispatches on, so the card and the send cannot disagree: every executor today
 * is Microsoft, so every governed action sends as the work address.
 */
function forAction(action) {
  const policy = action && require('./action-registry').policyFor(action.actionType);
  if (!policy || !policy.executable) return null;
  // The executor's _forAction reads this same field and the same allow-list.
  const box = action.target && action.target.mailbox;
  if (box && box !== 'work') {
    if (!(policy.personalMailboxes || []).includes(box)) return null; // the executor refuses it, so it sends from nowhere
    const s = personalSender(box);
    return s ? { ...s, kind: 'email' } : null;
  }
  if (policy.executor === 'microsoft.mail' || policy.executor === 'microsoft.calendar') {
    return { ...workSender(), kind: policy.executor === 'microsoft.calendar' ? 'invite' : 'email' };
  }
  return null;
}

// ── who sees it ─────────────────────────────────────────────────────────────

function _domain(address) { return String(address || '').toLowerCase().split('@')[1] || ''; }

/**
 * work | personal | unknown, with why. PURE given its lookups.
 *   lookups.person(address) → { name, sphere: 'work'|'personal'|'both'|'unknown' } | null
 *   lookups.personalList(address) → true when Nick put the address on a personal list
 */
function classifyAddress(address, lookups = {}) {
  const a = String(address || '').trim().toLowerCase();
  if (!a.includes('@')) return { sphere: 'unknown', why: 'not an address' };
  if (WORK_DOMAINS.includes(_domain(a))) return { sphere: 'work', why: `a ${_domain(a)} address` };
  if (pm.MAILBOXES.some((m) => m.address === a) || a === pm.addressFor('gmail')) return { sphere: 'personal', why: 'one of your own personal addresses' };
  const p = lookups.person ? lookups.person(a) : null;
  if (p && (p.sphere === 'work' || p.sphere === 'personal')) return { sphere: p.sphere, why: `${p.name}'s People note` };
  if (p && p.sphere === 'both') return { sphere: 'unknown', why: `${p.name} is both work and personal` };
  if (lookups.personalList && lookups.personalList(a)) return { sphere: 'personal', why: 'on a personal list you set (hike contacts)' };
  return { sphere: 'unknown', why: p ? `${p.name}'s People note does not say work or personal` : 'nobody NEURO knows' };
}

/**
 * Decide the sending mailbox for a message Nick writes or approves. PURE given
 * lookups. Returns { mailbox, why } or { ask: true, why, recipients }.
 *   kind: 'reply' (needs sourceMailbox) | 'compose' | 'neuro'
 */
function decide({ kind = 'compose', recipients = [], sourceMailbox = null, lookups = {} } = {}) {
  if (kind === 'reply') {
    if (!sourceMailbox) return { ask: true, why: 'NEURO does not know which mailbox the email arrived in.' };
    return { mailbox: sourceMailbox, why: 'A reply goes from the mailbox the email arrived in.' };
  }
  if (kind === 'neuro') return { mailbox: 'saim', fallback: 'work', why: 'NEURO wrote it.' };
  const classified = (recipients || []).map((r) => ({ address: typeof r === 'string' ? r : r.email || r.address, ...classifyAddress(typeof r === 'string' ? r : r.email || r.address, lookups) }));
  if (!classified.length) return { ask: true, why: 'Nobody to send it to.', recipients: [] };
  const spheres = new Set(classified.map((c) => c.sphere));
  if (spheres.has('unknown')) return { ask: true, why: 'NEURO cannot tell whether some of these people are work or personal.', recipients: classified };
  if (spheres.size > 1) return { ask: true, why: 'This goes to both work and personal people.', recipients: classified };
  return spheres.has('work')
    ? { mailbox: 'work', why: 'Everyone on it is work.', recipients: classified }
    : { mailbox: 'nick', why: 'Everyone on it is personal.', recipients: classified };
}

/** The real lookups: the People model and the hike contacts list. */
function defaultLookups() {
  return {
    person: (a) => {
      try {
        const p = require('./world-model').personByEmail(a);
        if (!p) return null;
        const model = require('./people-model');
        return { name: p.displayName, sphere: model.sphereFor(p, model.relationshipFor(p, {})).value };
      } catch { return null; } // unknown stays unknown
    },
    personalList: (a) => {
      try { return require('./hike-safety').contacts().some((c) => String(c.email).toLowerCase() === a); } catch { return false; }
    },
  };
}

module.exports = { WORK_DOMAINS, WORK_ADDRESS, workSender, personalSender, senderFor, usable, forNeuroGenerated, forHikeAlert, forAction, classifyAddress, decide, defaultLookups };
