'use strict';

/**
 * Personal relationships & people context (Build 31, 9 Oct 2026) — `people-v1`.
 *
 * The canonical Person stays `wm_people`, projected from People notes. This is
 * a READ MODEL over it plus Nick's corrections — there is no second people
 * store. Corrections are written INTO the People note (the frontmatter line
 * Nick could have typed himself), republished, and logged append-only in
 * personal_ops_events (`person-*`), which is the audit trail.
 *
 * It composes, per person, what the owning modules already hold:
 *   relationship / sphere / household   people-model (explicit evidence only)
 *   presence                            household.read() — CURRENT only, for
 *                                       roster members; never stored, never a
 *                                       history, never a reason for anything
 *   important dates                     personal-dates.read() — facts; the
 *                                       reminder policy is date-nags' cadence
 *   commitments                         world-obligations (who owes whom, as
 *                                       Build 4 linked it — never re-derived)
 *   linked tasks                        personal_links (Nick's explicit links)
 *
 * ⚠ What it never does: score a relationship, count contact, rank people by
 * how often they appear, say "you haven't spoken to X", create a task or a
 * reminder, or push. READING PEOPLE WRITES NOTHING.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const pm = require('./people-model');

const CONTRACT = 'people-v1';
const SECTION_ORDER = ['household', 'family', 'friends', 'work', 'other', 'unknown'];
const COMMITMENT_SAMPLE = 3;

function _try(fn, fallback, gaps, input) {
  try { return fn(); } catch (e) { if (gaps) gaps.push({ input, why: e.message }); return fallback; }
}

function _decisions() {
  const rows = _try(() => db.all('SELECT * FROM person_decisions WHERE revoked_at IS NULL'), []);
  return {
    separate: new Set(rows.filter((r) => r.kind === 'keep-separate').map((r) => r.subject)),
    rejections: new Set(rows.filter((r) => r.kind === 'not-this-person').map((r) => `${r.subject}>${r.person_id}`)),
    rows,
  };
}

function _selfManager(people) {
  const self = people.find((p) => p.personId === pm.SELF_ID);
  return self && self.manager ? self.manager : null;
}

function _rosterSubject(name) { return `household:${pm.fold(name).replace(/[^a-z0-9]+/g, '-')}`; }

/** Dates per person: personal-dates' own list, matched by strong identity only. */
function _datesFor(people, gaps, { rejections, now }) {
  const pd = _try(() => require('./personal-dates').read({ now }), null, gaps, 'personal-dates');
  const cad = _try(() => require('./date-nags').cadences(), {}, gaps, 'date-nags');
  const by = new Map(); const unlinked = [];
  if (!pd) return { by, unlinked, coverage: null };
  for (const d of [...pd.active, ...pd.later]) {
    const offsets = Array.isArray(cad[d.kind]) && cad[d.kind].length ? cad[d.kind] : null;
    const reminder = offsets
      ? { policy: 'lead-reminders', offsets, why: `Lead reminders for every ${d.kind}: ${offsets.join(', ')} days before (you set this). The last step may notify once.` }
      : { policy: 'none', offsets: [], why: `No reminder. It shows on Now and Radar within ${d.lead} days as context, and nothing notifies.` };
    const declaredNote = (d.sources || []).map((s) => s.note).find(Boolean);
    const item = {
      id: d.id, kind: d.kind, title: d.title, date: d.date, daysAway: d.away, state: d.state, reminder,
      source: (d.sources || []).map((s) => s.basis || s.provider).filter(Boolean),
      confidence: (d.sources || []).some((s) => s.basis === 'declared' || s.basis === 'birthdays-calendar') ? 'high' : 'medium',
      conflict: d.conflict || null,
    };
    let person = null;
    if (declaredNote && declaredNote.startsWith('People/')) person = people.find((p) => p.notePath === `${declaredNote}.md`) || null;
    if (!person && d.person) {
      const m = pm.matchPerson(d.person, people, { subject: `date:${d.id}`, rejections });
      person = m ? m.person : null;
    }
    if (person) { if (!by.has(person.personId)) by.set(person.personId, []); by.get(person.personId).push(item); }
    else unlinked.push({ ...item, person: d.person || null,
      why: d.person ? `No People note is named "${d.person}" (and no alias says so), so NEURO does not attach it to anyone.` : 'The entry does not name a person NEURO can match.' });
  }
  return { by, unlinked, coverage: pd.coverage ? { state: pd.coverage.state, heading: pd.heading } : null };
}

/** Open commitments per person — Build 4's links, never re-derived. */
function _commitmentsFor(gaps) {
  const rows = _try(() => require('./world-obligations').listCommitments({ status: 'open', limit: 2000 }), [], gaps, 'commitments');
  const by = new Map();
  const add = (id, c, side) => {
    if (!id || id === pm.SELF_ID) return;
    if (!by.has(id)) by.set(id, { open: 0, nickOwes: 0, owesNick: 0, items: [] });
    const e = by.get(id);
    e.open += 1;
    if (side === 'owes-nick') e.owesNick += 1; else e.nickOwes += 1;
    e.items.push({ id: c.commitmentId, description: c.description, direction: side, due: c.due,
      linkedBy: side === 'owes-nick' ? c.promisor.method : c.beneficiary.method });
  };
  for (const c of rows) {
    if (c.direction === 'to-nick') add(c.promisor.personId, c, 'owes-nick');
    else if (c.direction === 'by-nick') add(c.beneficiary.personId, c, 'nick-owes');
  }
  for (const e of by.values()) {
    e.items.sort((a, b) => String((a.due && a.due.date) || '9999').localeCompare(String((b.due && b.due.date) || '9999')));
    e.items = e.items.slice(0, COMMITMENT_SAMPLE);
  }
  return by;
}

function _linkedTasks(gaps) {
  const rows = _try(() => db.all("SELECT subject_id, entity_id, set_at FROM personal_links WHERE subject_id LIKE 'person:%'"), [], gaps, 'personal-links');
  const by = new Map();
  for (const r of rows) { if (!by.has(r.subject_id)) by.set(r.subject_id, []); by.get(r.subject_id).push({ entityId: r.entity_id, linkedAt: r.set_at }); }
  return by;
}

function _roster(gaps, now) {
  const h = _try(() => require('./household').read({ now }), null, gaps, 'household-roster');
  if (!h) return { known: false, members: [], source: null };
  return { known: h.known, source: h.source, members: (h.members || []).filter((m) => m.role === 'resident' || m.role === 'visitor') };
}

function _presence(member, rosterKnown) {
  if (!member) return null;
  // Visitors only when they are actually here (the home board's rule). A
  // resident's state is shown as it is NOW — never a history, never a count.
  if (member.role === 'visitor' && member.state !== 'home') return null;
  const state = rosterKnown ? member.state : 'unknown';
  return { state, now: true, why: rosterKnown ? 'Home Assistant\'s household sensor, right now. Not kept.' : 'The household sensor cannot be read, so this is unknown — never "away".' };
}

function card(p, ctx) {
  const rel = pm.relationshipFor(p, { selfManager: ctx.selfManager });
  const sphere = pm.sphereFor(p, rel);
  const member = ctx.memberFor.get(p.personId) || null;
  const household = pm.householdFor(p, member, rel);
  const group = pm.groupOf({ relationship: rel, sphere, household });
  const commitments = ctx.commitments.get(p.personId) || { open: 0, nickOwes: 0, owesNick: 0, items: [] };
  const personal = ['personal', 'both'].includes(sphere.value) && p.likes && p.likes.length ? { likes: p.likes } : null;
  // Work context stays in work: a personal-only card never carries a team.
  const work = ['work', 'both'].includes(sphere.value) && (p.team || p.role || p.directReport !== null)
    ? { team: p.team || null, role: p.role || null, directReport: p.directReport, status: p.status || null } : null;
  return {
    personId: p.personId, name: p.displayName, notePath: p.notePath, aliases: p.aliases || [],
    relationship: rel, sphere, household, group,
    importance: p.importance ? { value: p.importance, basis: 'declared' } : null,
    presence: _presence(member, ctx.rosterKnown),
    dates: ctx.dates.get(p.personId) || [],
    commitments,
    linkedTasks: ctx.linkedTasks.get(p.personId) || [],
    context: { personal, work },
    // How a Home Assistant roster name was matched to this note (exact name or
    // an alias) — so "not this person" can refuse it.
    rosterMatch: member ? { name: member.name, role: member.role, method: member.matchedBy, subject: _rosterSubject(member.name) } : null,
    // Nick's own words about them, verbatim — evidence to confirm, never applied.
    youWrote: p.personId === pm.SELF_ID ? [] : pm.profileMentions([p.displayName, ...(p.aliases || [])], ctx.profileLines),
    mergedInto: p.mergedInto || null,
  };
}

/**
 * The People view. PURE apart from its reads — writes NOTHING.
 */
function read({ now = Date.now() } = {}) {
  const gaps = [];
  const nowMs = now instanceof Date ? now.getTime() : now;
  const all = _try(() => require('./world-model').listPeople(), [], gaps, 'people');
  const decisions = _decisions();
  const people = all.filter((p) => !p.mergedInto);
  const merged = all.filter((p) => p.mergedInto).map((p) => ({ personId: p.personId, name: p.displayName, mergedInto: p.mergedInto }));
  const roster = _roster(gaps, nowMs);
  const prof = _try(() => require('./profile').read(), { ok: false, why: 'not read' }, gaps, 'profile');
  const profileLines = prof && prof.ok ? Object.values(prof.profile.facts || {}).flat().map((f) => f.text) : [];
  const memberFor = new Map(); const unlinkedHousehold = [];
  for (const m of roster.members) {
    const hit = pm.matchPerson(m.name, people, { subject: _rosterSubject(m.name), rejections: decisions.rejections });
    if (hit) memberFor.set(hit.person.personId, { ...m, matchedBy: hit.method });
    else if (m.role === 'resident' || m.state === 'home') {
      unlinkedHousehold.push({ name: m.name, role: m.role, subject: _rosterSubject(m.name),
        presence: _presence(m, roster.known), youWrote: pm.profileMentions([m.name], profileLines),
        why: m.role === 'resident'
          ? `Home Assistant lists ${m.name} as a resident, but no People note is named "${m.name}" or carries it as an alias. NEURO will not attach them to someone with only the same first name.`
          : `${m.name} is visiting now. Home Assistant lists them as a visitor; there is no People note for them.` });
    }
  }
  const datesRead = _datesFor(people, gaps, { rejections: decisions.rejections, now: nowMs });
  const ctx = {
    selfManager: _selfManager(people), memberFor, rosterKnown: roster.known, profileLines,
    dates: datesRead.by, commitments: _commitmentsFor(gaps), linkedTasks: _linkedTasks(gaps),
  };
  const cards = people.map((p) => card(p, ctx));
  const self = cards.find((c) => c.group === 'self') || null;
  const others = cards.filter((c) => c.group !== 'self');
  const sections = SECTION_ORDER.map((id) => ({ id, label: pm.GROUP_LABELS[id], people: others.filter((c) => c.group === id) }));
  const conflicts = _try(() => require('./world-model').identityConflicts().map((c) => ({ value: c.email, claimants: c.claimants })), [], gaps, 'identity');
  const duplicates = pm.likelyDuplicates(people, { conflicts, decided: decisions.separate });
  const queue = pm.classificationQueue(others);
  const count = (f) => others.filter(f).length;
  return {
    ok: true, contract: CONTRACT, at: new Date(nowMs).toISOString(),
    counts: {
      total: all.length, active: others.length + (self ? 1 : 0), merged: merged.length,
      classified: count((c) => c.relationship.type !== 'unknown'),
      classifiedDeclared: count((c) => c.relationship.basis === 'declared' && c.relationship.type !== 'unknown'),
      classifiedFromNoteField: count((c) => c.relationship.basis === 'note-field'),
      unknown: count((c) => c.relationship.type === 'unknown'),
      household: count((c) => c.household.value === true) + unlinkedHousehold.filter((u) => u.role === 'resident').length,
      householdWithNote: count((c) => c.household.value === true),
      personal: count((c) => c.sphere.value === 'personal'), work: count((c) => c.sphere.value === 'work'),
      both: count((c) => c.sphere.value === 'both'), sphereUnknown: count((c) => c.sphere.value === 'unknown'),
      withDates: count((c) => c.dates.length), datesLinked: others.reduce((n, c) => n + c.dates.length, 0), datesUnlinked: datesRead.unlinked.length,
      withOpenCommitments: count((c) => c.commitments.open > 0),
      presentNow: count((c) => c.presence && c.presence.state === 'home'),
      likelyDuplicates: duplicates.length,
    },
    self, sections, unlinkedHousehold, unlinkedDates: datesRead.unlinked, merged,
    queue, duplicates,
    sources: sources({ gaps, roster, datesCoverage: datesRead.coverage, now: nowMs }),
    gaps,
    rule: 'Who someone is to you comes only from what you have told NEURO: a People note line, a field that states it (direct-report), or your own correction here. Meetings, messages, visits, names and presence are never used to decide it.',
  };
}

/** Source health — separate rows, never one "People healthy". */
function sources({ gaps = [], roster = null, datesCoverage = null, now = Date.now() } = {}) {
  const out = [];
  const root = process.env.OBSIDIAN_VAULT_PATH;
  let notes = null; let readable = false;
  try { notes = fs.readdirSync(path.join(root || '', 'People')).filter((f) => f.endsWith('.md') && !f.startsWith('_')).length; readable = !!root; } catch { readable = false; }
  const lastPublish = _try(() => db.get("SELECT status, finished_at FROM runtime_job_runs WHERE job = 'world-people-sync' ORDER BY scheduled_for DESC LIMIT 1"), null);
  out.push({ id: 'people-notes', label: 'People notes (vault)', state: readable ? 'ok' : 'unreadable',
    detail: readable ? `${notes} note${notes === 1 ? '' : 's'}; republished hourly${lastPublish ? ` (last ${lastPublish.status} ${String(lastPublish.finished_at || '').slice(0, 16).replace('T', ' ')})` : ''}.` : 'The People folder cannot be read — every relationship below is what NEURO last saw.' });
  const sh = (id) => _try(() => require('./source-health').getSource(id, { now }), null);
  const ha = sh('homeassistant.presence');
  out.push({ id: 'household-roster', label: 'Household roster (Home Assistant)', state: roster && roster.known ? 'ok' : 'unknown',
    detail: roster && roster.known ? 'Residents and visitors as you configured them; presence is current only and never kept.'
      : `Cannot be read${ha && ha.state ? ` (${ha.state})` : ''} — presence reads as unknown, never away.` });
  out.push({ id: 'dates', label: 'Birthdays & anniversaries', state: datesCoverage ? datesCoverage.state : 'unknown',
    detail: datesCoverage ? datesCoverage.heading : 'Personal dates could not be read.' });
  const cal = ['microsoft.calendar', 'eventkit.neuro-ios', 'eventkit.saim-ios'].map(sh).filter((s) => s && s.known);
  const fresh = cal.filter((s) => s.freshness === 'fresh');
  out.push({ id: 'calendar', label: 'Calendars', state: !cal.length ? 'unknown' : fresh.length ? 'ok' : 'stale',
    detail: cal.length ? cal.map((s) => `${s.sourceId}: ${s.freshness}`).join(' · ') : 'No calendar source has reported.' });
  const obl = _try(() => db.get("SELECT status, finished_at FROM runtime_job_runs WHERE job = 'world-obligations-sync' ORDER BY scheduled_for DESC LIMIT 1"), null);
  out.push({ id: 'commitments', label: 'Commitments', state: obl ? (obl.status === 'succeeded' ? 'ok' : obl.status) : 'unknown',
    detail: obl ? `Linked to people by Build 4's rules (exact name, an alias, or a first name only one person has). Last sync ${obl.status}.` : 'Commitment sync has not run.' });
  out.push({ id: 'communication', label: 'Email & messages', state: 'not-used',
    detail: 'Not used for people. How often someone writes or meets you never decides who they are to you or how much they matter.' });
  if (gaps.length) out.push({ id: 'gaps', label: 'Not read this time', state: 'partial', detail: gaps.map((g) => `${g.input}: ${g.why}`).join(' · ') });
  return out;
}

function detail(personId, { now = Date.now() } = {}) {
  const r = read({ now });
  const all = [r.self, ...r.sections.flatMap((s) => s.people)].filter(Boolean);
  const c = all.find((x) => x.personId === personId);
  if (!c) return { ok: false, status: 404, error: `${personId} is not a person NEURO holds` };
  const history = _try(() => db.all(`SELECT kind, actor, at, detail_json FROM personal_ops_events
    WHERE subject_id = ? AND kind LIKE 'person-%' ORDER BY id DESC LIMIT 50`, [personId]), [])
    .map((h) => ({ kind: h.kind, actor: h.actor, at: h.at, detail: JSON.parse(h.detail_json || '{}') }));
  const dup = r.duplicates.filter((d) => d.a.personId === personId || d.b.personId === personId);
  return { ok: true, contract: CONTRACT, person: c, history, duplicates: dup, sources: r.sources };
}

// ── writes (Nick only; the authority matrix refuses machines) ──────────────

function _log(kind, subjectId, detailObj, now) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor: 'nick', detail: detailObj,
    dedupeKey: `${kind}:${subjectId}:${now}:${Math.random().toString(36).slice(2, 8)}`, now });
}

function _vaultRoot() {
  const root = process.env.OBSIDIAN_VAULT_PATH;
  if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) return null;
  return root;
}

function _noteFile(person) {
  const root = _vaultRoot();
  if (!root) return { ok: false, status: 503, error: 'the vault is not reachable' };
  if (!person.notePath || !/^People\/[^/\\]+\.md$/.test(person.notePath)) return { ok: false, status: 409, error: `${person.displayName} has no People note NEURO can write` };
  const file = path.join(root, person.notePath);
  if (!fs.existsSync(file)) return { ok: false, status: 404, error: `${person.notePath} no longer exists` };
  return { ok: true, file };
}

async function _republish({ now }) {
  const r = require('./world-sources').publishPeople({ now });
  try { await require('./event-bus').pumpConsumer('world-model'); } catch (e) { console.warn('[People] projection pump failed:', e.message); }
  return r;
}

/** PURE. Add an alias to a note's `aliases:` list (block or inline), line-based. */
function addAlias(content, alias) {
  const text = String(content || '');
  const a = String(alias).replace(/"/g, '');
  if (!text.startsWith('---')) return `---\naliases:\n  - "${a}"\n---\n\n${text}`;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  const head = text.slice(0, end); const rest = text.slice(end);
  const lines = head.split('\n');
  const i = lines.findIndex((l) => /^aliases:/.test(l));
  if (i < 0) return `${head}\naliases:\n  - "${a}"${rest}`;
  const inline = lines[i].match(/^aliases:\s*\[(.*)\]\s*\r?$/);
  if (inline) {
    const items = inline[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (items.some((s) => pm.sameName(s.replace(/^["']|["']$/g, ''), a))) return text;
    lines[i] = `aliases: [${[...items, `"${a}"`].join(', ')}]`;
    return lines.join('\n') + rest;
  }
  let j = i + 1;
  while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
    if (pm.sameName(lines[j].replace(/^\s+-\s+/, '').replace(/^["']|["']\r?$/g, '').trim(), a)) return text;
    j += 1;
  }
  if (!/^aliases:\s*\r?$/.test(lines[i])) return text; // a scalar alias line: leave it alone rather than mangle it
  lines.splice(j, 0, `  - "${a}"`);
  return lines.join('\n') + rest;
}

/** PURE. Remove one alias from a block or inline list. */
function removeAlias(content, alias) {
  const text = String(content || '');
  const lines = text.split('\n');
  const end = lines.findIndex((l, n) => n > 0 && /^---\s*$/.test(l));
  for (let n = 0; n < end; n += 1) {
    if (/^\s+-\s+/.test(lines[n]) && pm.sameName(lines[n].replace(/^\s+-\s+/, '').replace(/^["']|["']\r?$/g, '').trim(), alias)) {
      lines.splice(n, 1); return lines.join('\n');
    }
    const inline = lines[n].match(/^aliases:\s*\[(.*)\]\s*\r?$/);
    if (inline) {
      const items = inline[1].split(',').map((s) => s.trim()).filter((s) => s && !pm.sameName(s.replace(/^["']|["']$/g, ''), alias));
      lines[n] = `aliases: [${items.join(', ')}]`; return lines.join('\n');
    }
  }
  return text;
}

const FIELD_KEYS = { relationship: 'relationship', 'relationship-detail': 'relationship-detail', sphere: 'sphere', household: 'household', importance: 'importance' };

/**
 * Nick classifies or corrects a person. body: relationshipType, relationshipDetail,
 * sphere, household, importance — omitted = untouched, null = clear.
 */
async function classify(personId, body = {}, { now = Date.now() } = {}) {
  const v = pm.validateClassification(body);
  if (!v.ok) return { ok: false, status: 400, error: v.errors.join('; ') };
  const person = require('./world-model').getPerson(personId);
  if (!person) return { ok: false, status: 404, error: `${personId} is not a person NEURO holds` };
  if (personId === pm.SELF_ID) return { ok: false, status: 409, error: 'This is your own note — there is no relationship to classify.' };
  if (person.mergedInto) return { ok: false, status: 409, error: `${person.displayName} was merged into ${person.mergedInto}; correct that person instead` };
  const where = _noteFile(person);
  if (!where.ok) return where;
  const fe = require('./frontmatter-edit');
  let text = fs.readFileSync(where.file, 'utf8');
  const before = { relationship: person.relationship, 'relationship-detail': person.relationshipDetail, sphere: person.sphere,
    household: person.household, importance: person.importance };
  const changes = [];
  for (const [field, value] of Object.entries(v.fields)) {
    const key = FIELD_KEYS[field];
    const prev = before[field] === undefined ? null : before[field];
    if (value === prev || (value === null && prev === null)) continue;
    text = value === null ? fe.removeFrontmatterKey(text, key) : fe.upsertFrontmatterValue(text, key, value);
    if (field === 'relationship') text = fe.removeFrontmatterKey(text, 'relation'); // one line decides
    changes.push({ field, from: prev, to: value });
  }
  if (!changes.length) return { ok: true, changed: false, person: detail(personId, { now }).person };
  fs.writeFileSync(where.file, text, 'utf8');
  const nowMs = now instanceof Date ? now.getTime() : now;
  for (const c of changes) {
    const kind = c.field === 'household' ? 'person-household-set' : c.field === 'sphere' ? 'person-sphere-set' : 'person-classified';
    _log(kind, personId, { name: person.displayName, field: c.field, from: c.from, to: c.to }, nowMs);
  }
  await _republish({ now: nowMs });
  const d = detail(personId, { now: nowMs });
  return { ok: true, changed: true, changes, person: d.ok ? d.person : null };
}

function _validName(name) {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!clean) return { ok: false, error: 'a name is required' };
  if (clean.length > 60 || /[\\/:*?"<>|#^[\]\u0000-\u001f]/.test(clean) || clean.startsWith('.') || clean.startsWith('_')) return { ok: false, error: 'that name cannot be a note title' };
  return { ok: true, name: clean };
}

/**
 * Nick creates a People note for someone NEURO only knows from another source
 * (a resident in the household roster). Never overwrites; the roster name is
 * kept as an alias so the strong-identity match holds from then on.
 */
async function createPerson({ name, rosterName = null, relationshipType, relationshipDetail, sphere, household } = {}, { now = Date.now() } = {}) {
  const n = _validName(name);
  if (!n.ok) return { ok: false, status: 400, error: n.error };
  const v = pm.validateClassification({ relationshipType, relationshipDetail, sphere, household });
  const fields = v.ok ? v.fields : {};
  if (!v.ok && !/nothing to change/.test(v.errors.join(' '))) return { ok: false, status: 400, error: v.errors.join('; ') };
  if (rosterName !== null && rosterName !== undefined && !_validName(rosterName).ok) return { ok: false, status: 400, error: 'rosterName is not a usable name' };
  const root = _vaultRoot();
  if (!root) return { ok: false, status: 503, error: 'the vault is not reachable' };
  const existing = require('./world-model').listPeople().find((p) => pm.sameName(p.displayName, n.name));
  const file = path.join(root, 'People', `${n.name}.md`);
  if (existing || fs.existsSync(file)) return { ok: false, status: 409, error: `People/${n.name}.md already exists — classify that person instead` };
  const q = (s) => JSON.stringify(String(s));
  const lines = ['---', 'type: person'];
  if (rosterName && !pm.sameName(rosterName, n.name)) lines.push('aliases:', `  - ${q(rosterName)}`);
  for (const [k, val] of Object.entries(fields)) if (val !== null) lines.push(`${FIELD_KEYS[k]}: ${typeof val === 'boolean' ? val : q(val)}`);
  const nowMs = now instanceof Date ? now.getTime() : now;
  lines.push(`created: ${new Date(nowMs).toISOString().slice(0, 10)}`, 'created-via: NEURO Life → People', '---', '', `# ${n.name}`, '');
  fs.mkdirSync(path.join(root, 'People'), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), { flag: 'wx' });
  const personId = require('./world-sources').personPayload(n.name, `People/${n.name}.md`, {}).personId;
  _log('person-created', personId, { name: n.name, rosterName: rosterName || null, fields }, nowMs);
  await _republish({ now: nowMs });
  const d = detail(personId, { now: nowMs });
  return { ok: true, notePath: `People/${n.name}.md`, personId, person: d.ok ? d.person : null };
}

/**
 * Nick decides a likely duplicate. decision: keep-separate | merge | unmerge.
 * merge: `keep` stays; the other note gains `merged-into: [[keep]]` and keep
 * gains the other's name as an alias. No note is deleted.
 */
async function decideDuplicate({ a, b, decision, keep = null } = {}, { now = Date.now() } = {}) {
  if (!['keep-separate', 'merge', 'unmerge'].includes(decision)) return { ok: false, status: 400, error: 'decision must be keep-separate, merge or unmerge' };
  const wm = require('./world-model');
  const pa = wm.getPerson(a); const pb = wm.getPerson(b);
  if (!pa || !pb || a === b) return { ok: false, status: 404, error: 'both a and b must be people NEURO holds, and different' };
  const [x, y] = [a, b].sort();
  const subject = `${x}|${y}`;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const iso = new Date(nowMs).toISOString();
  if (decision === 'keep-separate') {
    db.run(`INSERT INTO person_decisions (kind, subject, person_id, decided_at, revoked_at) VALUES ('keep-separate', ?, ?, ?, NULL)
            ON CONFLICT(kind, subject, person_id) DO UPDATE SET decided_at = excluded.decided_at, revoked_at = NULL`, [subject, x, iso]);
    _log('person-kept-separate', x, { a: pa.displayName, b: pb.displayName }, nowMs);
    return { ok: true, decision, subject };
  }
  const keeper = keep === a ? pa : keep === b ? pb : null;
  if (!keeper) return { ok: false, status: 400, error: 'keep must be a or b' };
  const other = keeper === pa ? pb : pa;
  const fk = _noteFile(keeper); const fo = _noteFile(other);
  if (!fk.ok) return fk;
  if (!fo.ok) return fo;
  const fe = require('./frontmatter-edit');
  if (decision === 'merge') {
    if (other.mergedInto) return { ok: false, status: 409, error: `${other.displayName} is already merged into ${other.mergedInto}` };
    fs.writeFileSync(fk.file, addAlias(fs.readFileSync(fk.file, 'utf8'), other.displayName), 'utf8');
    fs.writeFileSync(fo.file, fe.upsertFrontmatterValue(fs.readFileSync(fo.file, 'utf8'), 'merged-into', `[[${keeper.displayName}]]`), 'utf8');
    _log('person-merged', keeper.personId, { kept: keeper.displayName, merged: other.displayName, mergedId: other.personId }, nowMs);
  } else {
    if (!other.mergedInto) return { ok: false, status: 409, error: `${other.displayName} is not merged` };
    fs.writeFileSync(fo.file, fe.removeFrontmatterKey(fs.readFileSync(fo.file, 'utf8'), 'merged-into'), 'utf8');
    fs.writeFileSync(fk.file, removeAlias(fs.readFileSync(fk.file, 'utf8'), other.displayName), 'utf8');
    _log('person-unmerged', keeper.personId, { kept: keeper.displayName, restored: other.displayName, restoredId: other.personId }, nowMs);
  }
  await _republish({ now: nowMs });
  return { ok: true, decision, kept: keeper.personId, other: other.personId };
}

/** "Not this person" — refuse a strong-identity match from another source. */
function rejectLink({ subject, personId, restore = false } = {}, { now = Date.now() } = {}) {
  if (typeof subject !== 'string' || !/^(household:[a-z0-9-]{1,40}|date:pd:.{1,300})$/.test(subject)) {
    return { ok: false, status: 400, error: 'subject must be household:<name> or date:<personal date id>' };
  }
  const person = require('./world-model').getPerson(personId);
  if (!person) return { ok: false, status: 404, error: `${personId} is not a person NEURO holds` };
  const nowMs = now instanceof Date ? now.getTime() : now;
  const iso = new Date(nowMs).toISOString();
  if (restore) {
    const r = db.run('UPDATE person_decisions SET revoked_at = ? WHERE kind = ? AND subject = ? AND person_id = ? AND revoked_at IS NULL', [iso, 'not-this-person', subject, personId]);
    if (!r.changes) return { ok: false, status: 404, error: 'no such decision to undo' };
    _log('person-link-restored', personId, { name: person.displayName, subject }, nowMs);
    return { ok: true, restored: true };
  }
  db.run(`INSERT INTO person_decisions (kind, subject, person_id, decided_at, revoked_at) VALUES ('not-this-person', ?, ?, ?, NULL)
          ON CONFLICT(kind, subject, person_id) DO UPDATE SET decided_at = excluded.decided_at, revoked_at = NULL`, [subject, personId, iso]);
  _log('person-link-rejected', personId, { name: person.displayName, subject }, nowMs);
  return { ok: true, rejected: true };
}

module.exports = {
  CONTRACT, SECTION_ORDER, read, detail, sources, card,
  classify, createPerson, decideDuplicate, rejectLink, addAlias, removeAlias,
};
