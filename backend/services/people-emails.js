'use strict';

/**
 * People emails — NEURO adds a person's address to their People note when it
 * SEES it (Nick, 15 Oct 2026: "for all people, personal and work").
 *
 * Every place NEURO already holds a name beside an address is a sighting:
 * calendar participants (the world model), the work inbox triage, the personal
 * inbox (nick@, contact@, Gmail — senders AND recipients) and sent replies.
 *
 * The rules are about not writing the WRONG address, because an address in a
 * People note is what a chase, an invite or a reply is sent to:
 *
 *   1. A sighting names a person only by their FULL name, or by a multi-word
 *      alias exactly one note claims (`entities.getRoster`). Never a first name.
 *   2. An address seen under two different people is SHARED (a team box, a
 *      PA sending for someone) and is never given to either.
 *   3. An address another note already declares is that note's.
 *   3b. Nick's own note is never written — his identity is the signed-in account,
 *      and a shared box (servicehub@) sends under his name.
 *   2b. An address also seen under a name with a DIFFERENT surname that is not
 *      the same person (a shared box sending as several people) is shared too.
 *   4. Automated senders (no-reply, notifications, calendar, bounces) and Nick's
 *      own addresses are never anyone's.
 *   5. One address seen → written. Several → only when the person's sphere
 *      picks exactly one (work → the single work-domain address; personal → the
 *      single non-work one). Otherwise it is AMBIGUOUS and reported, not guessed.
 *   6. Fills an EMPTY `email:` only — an existing address is never overwritten
 *      (`contact-directory.learnEmail`, which also backs the note up).
 *
 * `decide()` is PURE; `gather()` reads; `run({apply})` writes.
 */

const WORK_DOMAINS = ['nurtur.tech'];

const AUTOMATED = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|calendar|alerts?|automated|system|support|helpdesk|service-?desk|info|hello|team|admin|billing|accounts?|newsletter|news|marketing|jira|confluence|teams)([._+-]|@)/i;

function normName(s) {
  let n = String(s || '').replace(/["']/g, '').replace(/\(.*?\)/g, ' ').trim();
  // "Surname, First" → "First Surname"
  const comma = n.match(/^([^,]+),\s*([^,]+)$/);
  if (comma) n = `${comma[2]} ${comma[1]}`;
  return n.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normAddr(s) {
  const a = String(s || '').trim().toLowerCase().replace(/^mailto:/, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : null;
}

function isWorkAddress(a) {
  const dom = a.split('@')[1] || '';
  return WORK_DOMAINS.some((d) => dom === d || dom.endsWith(`.${d}`));
}

/**
 * PURE. sightings: [{name, email, source}]; roster: {full:[names], aliases: Map(lower->full)};
 * declared: Map(fullName -> address|null) for every People note; spheres: Map(fullName -> 'work'|'personal'|'unknown');
 * own: Set of Nick's addresses.
 */
function decide({ sightings = [], roster = { full: [], aliases: new Map() }, declared = new Map(), spheres = new Map(), own = new Set(), self = new Set() } = {}) {
  const byName = new Map();
  for (const f of roster.full || []) byName.set(normName(f), f);
  for (const [alias, full] of roster.aliases || new Map()) {
    const k = normName(alias);
    if (k.split(' ').length >= 2 && !byName.has(k)) byName.set(k, full);   // rule 1: multi-word aliases only
  }

  const claimed = new Map();   // address -> note that already declares it
  for (const [person, addr] of declared) { const a = normAddr(addr); if (a) claimed.set(a, person); }

  const ownSet = new Set([...own].map(normAddr).filter(Boolean));
  const addrPeople = new Map(); // address -> Set(person)
  const sources = new Map();    // `${person}|${addr}` -> Set(source)
  const skipped = { automated: 0, own: 0, unmatched: 0, self: 0 };
  const addrNames = new Map();  // address -> Set(normalised display name), every sighting
  const surname = (n) => n.split(' ').pop();

  for (const s of sightings) {
    const a = normAddr(s && s.email);
    if (!a) continue;
    if (ownSet.has(a)) { skipped.own++; continue; }
    if (AUTOMATED.test(a)) { skipped.automated++; continue; }
    const nn = normName(s.name);
    // A display name that is just an address says nothing about who it is.
    if (nn && !String(s.name || '').includes('@')) { if (!addrNames.has(a)) addrNames.set(a, new Set()); addrNames.get(a).add(nn); }
    const person = byName.get(nn);
    if (!person) { skipped.unmatched++; continue; }
    if (self.has(person)) { skipped.self++; continue; }   // rule 3b
    if (!addrPeople.has(a)) addrPeople.set(a, new Set());
    addrPeople.get(a).add(person);
    const k = `${person}|${a}`;
    if (!sources.has(k)) sources.set(k, new Set());
    sources.get(k).add(s.source || 'unknown');
  }

  const shared = [];
  for (const [a, people] of addrPeople) {
    if (people.size > 1) { shared.push({ email: a, people: [...people].sort() }); continue; }
    // rule 2b: seen under another name that is not this person
    const [person] = [...people];
    const toks = normName(person).split(' ');
    const sameish = (n) => { const t = n.split(' '); return t.includes(toks[0]) || t.includes(surname(normName(person))); };
    const others = [...(addrNames.get(a) || [])].filter((n) => byName.get(n) !== person && !sameish(n));
    if (others.length) shared.push({ email: a, people: [person], alsoSeenAs: others.sort() });
  }
  const sharedSet = new Set(shared.map((x) => x.email));

  const perPerson = new Map();
  for (const [a, people] of addrPeople) {
    if (sharedSet.has(a)) continue;                      // rule 2
    const [person] = [...people];
    if (claimed.has(a) && claimed.get(a) !== person) continue;   // rule 3
    if (!perPerson.has(person)) perPerson.set(person, []);
    perPerson.get(person).push(a);
  }

  const learn = [];
  const ambiguous = [];
  let alreadySet = 0;
  for (const [person, addrs] of perPerson) {
    if (declared.get(person)) { alreadySet++; continue; }        // rule 6
    let pick = null;
    let why = null;
    if (addrs.length === 1) { pick = addrs[0]; why = 'the only address seen under this name'; }
    else {
      const sphere = spheres.get(person) || 'unknown';
      const work = addrs.filter(isWorkAddress);
      const personal = addrs.filter((a) => !isWorkAddress(a));
      if (sphere === 'work' && work.length === 1) { pick = work[0]; why = 'the only work address seen; they are a work contact'; }
      else if (sphere === 'personal' && personal.length === 1) { pick = personal[0]; why = 'the only personal address seen; they are a personal contact'; }
    }
    if (pick) {
      learn.push({ person, email: pick, why, sources: [...sources.get(`${person}|${pick}`)].sort() });
    } else {
      ambiguous.push({ person, emails: addrs.sort(), sphere: spheres.get(person) || 'unknown' });
    }
  }
  learn.sort((x, y) => x.person.localeCompare(y.person));
  ambiguous.sort((x, y) => x.person.localeCompare(y.person));
  return { learn, ambiguous, shared, alreadySet, skipped };
}

// ── Reading what NEURO has seen ────────────────────────────────────────────

function _people(list) {
  if (!Array.isArray(list)) return [];
  return list.map((r) => (typeof r === 'string' ? { email: r } : {
    name: r && (r.name || (r.emailAddress && r.emailAddress.name)),
    email: r && (r.email || r.address || (r.emailAddress && r.emailAddress.address)),
  }));
}

function _json(s) { try { return JSON.parse(s); } catch { return null; } }

function gather() {
  const db = require('../db/database');
  const out = [];
  const gaps = [];
  const tryRead = (label, fn) => { try { fn(); } catch (e) { gaps.push(`${label}: ${e.message}`); } };

  tryRead('calendar', () => {
    for (const r of db.all('SELECT DISTINCT name, email FROM wm_meeting_participants WHERE name IS NOT NULL') || []) {
      out.push({ name: r.name, email: r.email, source: 'calendar' });
    }
  });
  tryRead('work inbox', () => {
    for (const e of _json(db.getState('email_triage')) || []) {
      if (e && e.fromEmail) out.push({ name: e.from, email: e.fromEmail, source: 'work-inbox' });
    }
  });
  tryRead('personal inbox', () => {
    for (const r of db.all('SELECT mailbox, from_name, from_email, to_json, cc_json FROM personal_inbox') || []) {
      const src = `personal-inbox:${r.mailbox}`;
      if (r.from_email) out.push({ name: r.from_name, email: r.from_email, source: src });
      for (const p of [..._people(_json(r.to_json)), ..._people(_json(r.cc_json))]) {
        if (p.email && p.name) out.push({ name: p.name, email: p.email, source: src });
      }
    }
  });
  tryRead('sent replies', () => {
    for (const r of db.all("SELECT recipients FROM sent_replies WHERE recipients_source = 'explicit'") || []) {
      for (const p of _people(_json(r.recipients))) if (p.email && p.name) out.push({ name: p.name, email: p.email, source: 'sent-reply' });
    }
  });
  return { sightings: out, gaps };
}

function _ownAddresses() {
  const own = new Set();
  try { own.add(require('./mail-identity').WORK_ADDRESS); } catch { /* fine */ }
  try {
    const pm = require('./personal-mail');
    for (const k of pm.KEYS || []) { const a = pm.addressFor(k); if (a) own.add(a); }
  } catch { /* fine */ }
  return own;
}

function _spheres() {
  const db = require('../db/database');
  const out = new Map();
  try {
    for (const r of db.all('SELECT display_name, sphere, team, relationship, direct_report FROM wm_people') || []) {
      const s = String(r.sphere || '').toLowerCase();
      let v = 'unknown';
      if (s === 'work' || s === 'personal') v = s;
      else if (r.relationship) v = 'personal';
      else if (r.direct_report || (r.team && !/unknown|confirm/i.test(r.team))) v = 'work';
      out.set(r.display_name, v);
    }
  } catch { /* unknown for everyone */ }
  return out;
}

function _self() {
  const out = new Set(['Nick Ward']);
  try {
    const { SELF_ID } = require('./people-model');
    const r = require('../db/database').get('SELECT display_name FROM wm_people WHERE person_id = ?', [SELF_ID]);
    if (r && r.display_name) out.add(r.display_name);
  } catch { /* the literal stands */ }
  return out;
}

/** Plan, and with apply:true write each learned address into its People note. */
function run({ apply = false } = {}) {
  const directory = require('./contact-directory');
  const entities = require('./entities');
  const { sightings, gaps } = gather();
  const roster = entities.getRoster();
  const declared = new Map((roster.full || []).map((n) => [n, null]));
  for (const c of directory.fromPeopleNotes()) declared.set(c.name, c.email);

  const plan = decide({ sightings, roster, declared, spheres: _spheres(), own: _ownAddresses(), self: _self() });
  const written = [];
  const failed = [];
  if (apply) {
    const today = new Date().toISOString().slice(0, 10);
    for (const l of plan.learn) {
      const r = directory.learnEmail(l.person, l.email, {
        source: `NEURO ${today}: ${l.why} (${l.sources.join(', ')})`,
      });
      if (r.ok) {
        written.push(l);
        try {
          require('./personal-obligations').logEvent('person-email-learned', {
            subjectId: l.person, actor: 'neuro', detail: { name: l.person, why: l.why, sources: l.sources },
            dedupeKey: `person-email-learned:${l.person}:${l.email}`,
          });
        } catch { /* the audit line is bookkeeping */ }
      } else failed.push({ ...l, reason: r.reason });
    }
    if (written.length) {
      console.log(`[PeopleEmails] Added ${written.length}: ${written.map((w) => `${w.person} <${w.email}>`).join(', ')}`);
    }
  }
  return { ok: true, apply, sightings: sightings.length, gaps, ...plan, written, failed };
}

module.exports = { decide, gather, run, _internals: { normName, normAddr, isWorkAddress, AUTOMATED } };
