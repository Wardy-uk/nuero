'use strict';

/**
 * Personal relationships & people context — the PURE half (Build 31, 9 Oct 2026).
 *
 * "Who are the important people in my life, what is my relationship to them,
 * what matters about it, and is there anything useful to remember or act on?"
 * — answered ONLY from what Nick has told NEURO. NEURO knows who someone is
 * because he said so, never because it watched them enough to guess.
 *
 * ── Relationship authority (31B) ────────────────────────────────────────────
 * A relationship comes from, in order:
 *   declared    the People note's own `relationship:` line — which is also
 *               where Nick's corrections land (people.classify writes it)
 *   note-field  a structured field that states the relationship outright:
 *               `direct-report: true` (his direct report), or Nick's OWN
 *               note naming someone as `manager:` (his manager)
 *   unknown     everything else
 * NEVER from: message, meeting or visit frequency; shared location; a shared
 * surname; a recurring birthday; household co-presence; task mentions; a
 * "Wedding anniversary" in the diary. Those are context at most.
 *
 * ── Sphere (31E) ────────────────────────────────────────────────────────────
 *   declared `sphere:` (the ONLY way to get `both`) > the relationship's own
 *   sphere > a `team:` field (a work org unit → work) > unknown.
 *
 * ── Household (31F) ─────────────────────────────────────────────────────────
 * Separate from relationship. Declared `household:` > Home Assistant's
 * household sensor ROLE (configured by Nick: resident = household, visitor =
 * not) for a roster member matched to the note by STRONG identity > unknown.
 * Presence never sets it: a phone on the Wi-Fi is not a resident.
 *
 * ── Identity (31G/H) ────────────────────────────────────────────────────────
 * A name links to a person only by exact full name or an alias exactly one
 * person claims. A first name, a surname, a similar role: never. A likely
 * duplicate is SHOWN for Nick to merge or keep separate — never merged here.
 */

const RELATIONSHIP_TYPES = Object.freeze([
  'spouse_partner', 'child', 'parent', 'sibling', 'extended_family', 'friend',
  'colleague', 'manager', 'direct_report', 'professional_contact', 'service_contact',
  'household_member', 'acquaintance', 'other', 'unknown',
]);
const RELATIONSHIP_LABELS = Object.freeze({
  spouse_partner: 'Partner', child: 'Child', parent: 'Parent', sibling: 'Sibling', extended_family: 'Extended family',
  friend: 'Friend', colleague: 'Colleague', manager: 'Your manager', direct_report: 'Your direct report',
  professional_contact: 'Professional contact', service_contact: 'Service contact', household_member: 'Lives with you',
  acquaintance: 'Acquaintance', other: 'Other', unknown: 'Not said',
});
// Words an older note (Build 11E) or a person typing by hand may use. Each maps
// to exactly one type; anything else is not read, never guessed at.
const LEGACY = Object.freeze({
  spouse: 'spouse_partner', partner: 'spouse_partner', wife: 'spouse_partner', husband: 'spouse_partner',
  son: 'child', daughter: 'child', mother: 'parent', father: 'parent', mum: 'parent', dad: 'parent',
  brother: 'sibling', sister: 'sibling', household: 'household_member', 'direct-report': 'direct_report',
});
const FAMILY_TYPES = Object.freeze(['spouse_partner', 'child', 'parent', 'sibling', 'extended_family']);
const WORK_TYPES = Object.freeze(['colleague', 'manager', 'direct_report', 'professional_contact']);
const PERSONAL_TYPES = Object.freeze([...FAMILY_TYPES, 'friend', 'household_member']);
const SPHERES = Object.freeze(['personal', 'work', 'both', 'unknown']);
const GROUPS = Object.freeze(['household', 'family', 'friends', 'work', 'other', 'unknown']);
const GROUP_LABELS = Object.freeze({
  household: 'Household', family: 'Family', friends: 'Friends', work: 'Work', other: 'Other', unknown: 'Unknown relationship',
});
// A `team:` value that names no team is not work evidence.
const NO_TEAM = /^(unknown|\(?to confirm\)?|tbc|n\/a|none|-)?$/i;
const SELF_ID = 'person:nick-ward'; // the codebase's existing identity for Nick (world-obligations)

const fold = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A relationship word as a note states it → { type, detail } | null. The
 * legacy word `family` (Build 11E) states family without saying which kind,
 * so it reads as type `other` with detail `family` — grouped with Family,
 * never promoted to a closeness it did not state.
 */
function normaliseRelationship(raw) {
  const s = fold(Array.isArray(raw) ? raw[0] : raw).replace(/\s+/g, '_');
  if (!s) return null;
  if (RELATIONSHIP_TYPES.includes(s)) return { type: s, detail: null };
  const h = s.replace(/_/g, '-');
  if (LEGACY[h]) return { type: LEGACY[h], detail: null };
  if (s === 'family') return { type: 'other', detail: 'family' };
  return null;
}

function normaliseSphere(raw) {
  const s = fold(raw);
  return SPHERES.includes(s) ? s : null;
}

function sphereOfType(type, detail = null) {
  if (PERSONAL_TYPES.includes(type) || (type === 'other' && detail === 'family')) return 'personal';
  if (WORK_TYPES.includes(type)) return 'work';
  return null;
}

/**
 * The relationship NEURO may state for a person. PURE.
 * person: wm_people shape ({ personId, displayName, relationship, relationshipDetail, directReport, ... })
 * ctx.selfManager: the display name Nick's own note gives as `manager:`, or null.
 */
function relationshipFor(person, { selfManager = null } = {}) {
  const name = person.displayName;
  if (person.personId === SELF_ID) return { type: 'self', label: 'You', detail: null, basis: 'self', why: 'This is your own People note.' };
  const declared = person.relationship ? normaliseRelationship(person.relationship) : null;
  if (declared) {
    const detail = person.relationshipDetail || declared.detail || null;
    return { type: declared.type, label: RELATIONSHIP_LABELS[declared.type], detail, basis: 'declared',
      why: declared.type === 'unknown' ? `You said you don't want ${name} classified.` : `${name}'s People note says so (relationship: ${person.relationship}).` };
  }
  if (person.directReport === true) {
    return { type: 'direct_report', label: RELATIONSHIP_LABELS.direct_report, detail: person.relationshipDetail || null, basis: 'note-field',
      why: `${name}'s People note says direct-report: true.` };
  }
  if (selfManager && fold(selfManager) === fold(name)) {
    return { type: 'manager', label: RELATIONSHIP_LABELS.manager, detail: person.relationshipDetail || null, basis: 'note-field',
      why: `Your own People note names ${name} as your manager.` };
  }
  return { type: 'unknown', label: RELATIONSHIP_LABELS.unknown, detail: null, basis: 'none',
    why: `Nothing states how you know ${name}. NEURO does not guess from meetings, messages, visits or names.` };
}

function sphereFor(person, rel) {
  if (person.personId === SELF_ID) return { value: 'both', basis: 'self', why: 'You.' };
  const declared = normaliseSphere(person.sphere);
  if (declared) return { value: declared, basis: 'declared', why: `${person.displayName}'s People note says sphere: ${declared}.` };
  const fromRel = rel && rel.type !== 'unknown' ? sphereOfType(rel.type, rel.detail) : null;
  if (fromRel) return { value: fromRel, basis: 'relationship', why: `Follows from "${rel.label}". Only you can make it both.` };
  if (person.team && !NO_TEAM.test(String(person.team).trim())) {
    return { value: 'work', basis: 'note-field', why: `${person.displayName}'s People note names a team (${person.team}).` };
  }
  return { value: 'unknown', basis: 'none', why: 'Nothing states whether this is work or personal.' };
}

/**
 * Household membership. rosterMember: the HA household roster entry matched to
 * this person by strong identity, or null. Presence state is NOT read here.
 */
function householdFor(person, rosterMember = null, rel = null) {
  if (typeof person.household === 'boolean') {
    return { value: person.household, basis: 'declared', why: `${person.displayName}'s People note says household: ${person.household}.` };
  }
  if (rel && rel.basis === 'declared' && rel.type === 'household_member') {
    return { value: true, basis: 'declared', why: `${person.displayName}'s People note says they live with you.` };
  }
  if (rosterMember && rosterMember.role === 'resident') {
    return { value: true, basis: 'configured', why: 'Home Assistant\'s household sensor lists them as a resident — a list you configured, not a guess from their phone.' };
  }
  if (rosterMember && rosterMember.role === 'visitor') {
    return { value: false, basis: 'configured', why: 'Home Assistant\'s household sensor lists them as a visitor, not a resident.' };
  }
  return { value: null, basis: 'none', why: 'Not stated.' };
}

function groupOf({ relationship, sphere, household }) {
  if (relationship && relationship.type === 'self') return 'self';
  if (household && household.value === true) return 'household';
  const t = relationship ? relationship.type : 'unknown';
  if (FAMILY_TYPES.includes(t) || (t === 'other' && relationship.detail === 'family')) return 'family';
  if (t === 'friend') return 'friends';
  if (WORK_TYPES.includes(t)) return 'work';
  if (['service_contact', 'acquaintance', 'other', 'household_member'].includes(t)) return 'other';
  if (sphere && sphere.value === 'work') return 'work';
  if (sphere && sphere.value === 'personal') return 'other';
  return 'unknown';
}

/** Two names are the SAME name — case, accents, apostrophes and spacing folded. Nothing looser. */
function sameName(a, b) { return !!a && !!b && fold(a) === fold(b); }

/**
 * Which person a bare name (an HA roster name, a calendar birthday) belongs
 * to — exact full name, or an alias exactly one person claims. A first name
 * alone, a surname, a "similar" name: never. rejections: Set of
 * `${subject}>${personId}` pairs Nick said are not the same.
 */
function matchPerson(name, people, { subject = null, rejections = new Set() } = {}) {
  if (!name) return null;
  const ok = (p) => !(subject && rejections.has(`${subject}>${p.personId}`));
  const byName = people.filter((p) => sameName(p.displayName, name) && ok(p));
  if (byName.length === 1) return { person: byName[0], method: 'exact-name' };
  if (byName.length > 1) return null;
  const byAlias = people.filter((p) => (p.aliases || []).some((a) => sameName(a, name)) && ok(p));
  if (byAlias.length === 1) return { person: byAlias[0], method: 'exact-alias' };
  return null;
}

/**
 * Likely duplicates, for Nick to decide. Strong signals only: one note's name
 * is another's alias, two notes fold to the same name, or two notes claim one
 * email address. Two people sharing a FIRST name is not a signal (two Nathans
 * work with Nick). decided: Set of `${a}|${b}` (sorted) pairs already decided.
 */
function likelyDuplicates(people, { conflicts = [], decided = new Set() } = {}) {
  const out = new Map();
  const add = (a, b, why) => {
    if (a.personId === b.personId) return;
    const [x, y] = [a, b].sort((p, q) => p.personId.localeCompare(q.personId));
    const key = `${x.personId}|${y.personId}`;
    if (decided.has(key)) return;
    const held = out.get(key) || { key, a: { personId: x.personId, name: x.displayName }, b: { personId: y.personId, name: y.displayName }, why: [] };
    if (!held.why.includes(why)) held.why.push(why);
    out.set(key, held);
  };
  for (const a of people) {
    for (const b of people) {
      if (a.personId >= b.personId) continue;
      if (sameName(a.displayName, b.displayName)) add(a, b, 'the two notes have the same name');
      if ((b.aliases || []).some((al) => sameName(al, a.displayName))) add(a, b, `${b.displayName}'s note lists "${a.displayName}" as an alias`);
      if ((a.aliases || []).some((al) => sameName(al, b.displayName))) add(a, b, `${a.displayName}'s note lists "${b.displayName}" as an alias`);
    }
  }
  for (const c of conflicts) {
    const ids = Array.isArray(c.claimants) ? c.claimants : [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = people.find((p) => p.personId === ids[i]); const b = people.find((p) => p.personId === ids[j]);
        if (a && b) add(a, b, `both notes claim ${c.value}`);
      }
    }
  }
  return [...out.values()];
}

/**
 * "Who is this?" — the bounded classification queue. Only people whose
 * relationship nobody has stated (an explicit `unknown` means Nick already
 * looked). Ordered by where an answer is most useful: household first, then
 * people with a date or an open commitment, then the rest by name. Never all
 * at once.
 */
function classificationQueue(cards, { limit = 5 } = {}) {
  const pending = cards.filter((c) => c.relationship && c.relationship.basis === 'none');
  const rank = (c) => (c.household && c.household.value === true ? 0 : 3)
    - (c.dates && c.dates.length ? 1 : 0) - (c.commitments && c.commitments.open ? 1 : 0)
    + (c.sphere && c.sphere.value === 'work' ? 2 : 0);
  const ordered = [...pending].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { total: pending.length, next: ordered.slice(0, limit) };
}

/**
 * Lines from Nick's own profile (Me/About Nick.md) that name someone, as a
 * whole word — shown VERBATIM as "You wrote: …" so confirming a relationship
 * is one click. NEVER applied: "Wife is Helen" in prose is evidence for Nick
 * to confirm, not a field NEURO parses into a relationship. PURE.
 */
function profileMentions(names, lines, { limit = 3 } = {}) {
  const want = [...new Set((names || []).filter((n) => typeof n === 'string' && n.trim().length >= 2))];
  if (!want.length) return [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}])(${want.map(esc).join('|')})(?=$|[^\\p{L}])`, 'iu');
  return (lines || []).filter((l) => re.test(String(l))).slice(0, limit);
}

const TEXT_MAX = 60;
const BAD_TEXT = /[\r\n\u0000-\u001f"]/;

/**
 * Validate a correction. Omitted (undefined) = leave alone; null = clear back
 * to "not stated". An unrecognised value is REFUSED, never normalised to null
 * — "I didn't understand you" and "clear it" are different requests.
 */
function validateClassification(body = {}) {
  const out = {};
  const errors = [];
  if (body.relationshipType !== undefined) {
    if (body.relationshipType === null) out.relationship = null;
    else if (RELATIONSHIP_TYPES.includes(body.relationshipType)) out.relationship = body.relationshipType;
    else errors.push(`relationshipType must be one of ${RELATIONSHIP_TYPES.join(', ')}`);
  }
  if (body.relationshipDetail !== undefined) {
    if (body.relationshipDetail === null || body.relationshipDetail === '') out['relationship-detail'] = null;
    else if (typeof body.relationshipDetail === 'string' && body.relationshipDetail.trim().length <= TEXT_MAX && !BAD_TEXT.test(body.relationshipDetail)) out['relationship-detail'] = body.relationshipDetail.trim();
    else errors.push(`relationshipDetail must be text of at most ${TEXT_MAX} characters, one line`);
  }
  if (body.sphere !== undefined) {
    if (body.sphere === null) out.sphere = null;
    else if (SPHERES.includes(body.sphere)) out.sphere = body.sphere;
    else errors.push(`sphere must be one of ${SPHERES.join(', ')}`);
  }
  if (body.household !== undefined) {
    if (body.household === null || body.household === true || body.household === false) out.household = body.household;
    else errors.push('household must be true, false or null');
  }
  if (body.importance !== undefined) {
    const { IMPORTANCE } = require('../../shared/life-domains.cjs');
    if (body.importance === null) out.importance = null;
    else if (IMPORTANCE.includes(body.importance)) out.importance = body.importance;
    else errors.push(`importance must be one of ${IMPORTANCE.join(', ')}`);
  }
  if (errors.length) return { ok: false, errors };
  if (!Object.keys(out).length) return { ok: false, errors: ['nothing to change — send relationshipType, relationshipDetail, sphere, household or importance'] };
  return { ok: true, fields: out };
}

module.exports = {
  RELATIONSHIP_TYPES, RELATIONSHIP_LABELS, LEGACY, FAMILY_TYPES, WORK_TYPES, PERSONAL_TYPES, SPHERES, GROUPS, GROUP_LABELS, SELF_ID,
  fold, normaliseRelationship, normaliseSphere, sphereOfType, relationshipFor, sphereFor, householdFor, groupOf,
  sameName, matchPerson, likelyDuplicates, classificationQueue, validateClassification, profileMentions,
};
