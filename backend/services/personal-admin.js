'use strict';

/**
 * Build 25 — Personal Admin, as a SYNTHESIS over obligations NEURO already
 * holds. Not a task manager and not a store of admin items: every row here is
 * read at request time from the thing that owns it —
 *
 *   • personal-obligations: open NEURO tasks and Apple reminders whose explicit
 *     domain is admin / finance / transport (or linked by Nick to the car, or to
 *     Ember's care as an administrative kind)
 *   • vehicle obligations Nick recorded for the Captur (MOT, tax, insurance…)
 *   • finance obligations Nick recorded (renewals, annual fees…), and a bank
 *     feed that needs reconnecting
 *   • Ember's care items of an ADMINISTRATIVE kind (insurance, vet, vaccination)
 *
 * The only thing Build 25 stores is Nick's own word about an item that already
 * exists (`personal_admin_annotations`): waiting / blocked (with a reason) /
 * routine, a kind correction, and an explicit lead time. No titles, no dates,
 * no tasks.
 *
 * Rules the code turns on, each pinned by build25-personal-admin.test.js:
 *   • work never enters: the obligation reader already excludes anything
 *     without explicit non-work evidence, and nothing here reads wording;
 *   • a due date is evidence of TIMING, never of urgency on its own — needs-you
 *     is personal-obligations' rule (≤1 day / ≤14 past), the owning module's
 *     state, or a lead time Nick set; an undated item is never urgent;
 *   • completion comes only from the source that owns the item; a ticked task
 *     is the ACTION, never proof the MOT or renewal happened;
 *   • duplicates collapse only on an explicit link or an identical id.
 */

const ADMIN_KINDS = Object.freeze(['vehicle', 'insurance', 'tax', 'subscription', 'account', 'booking', 'appointment', 'form',
  'renewal', 'household', 'pet', 'finance', 'project', 'other']);
const ADMIN_STATES = Object.freeze(['needs_you', 'upcoming', 'open', 'waiting', 'blocked', 'routine', 'done', 'unknown']);
const NOTE_STATES = Object.freeze(['waiting', 'blocked', 'routine']);
// Ember's care: only these kinds are administration. Walks, feeding, grooming,
// flea and worm treatment are care, and stay on her card.
const ADMIN_CARE_KINDS = new Set(['insurance', 'vet', 'vaccination']);
const RECENT_DONE_DAYS = 14;
const SOON_DAYS = 7;
const MAX_LEAD_DAYS = 120;
const FRESH_HOURS = 48;

const FINANCE_KIND = { renewal: 'renewal', subscription_renewal: 'subscription', annual_fee: 'finance', bill: 'finance', household_charge: 'household', other: 'finance' };
const BASIS_WORDS = { declared: 'you set it on this item', classified: 'you classified the list it is on', intrinsic: 'what its source is', set: 'set on the task' };
const VEHICLE_TYPE_WORD = { mot: 'MOT', insurance: 'insurance', service: 'service', warranty: 'warranty', breakdown_cover: 'breakdown cover', tax: 'tax' };

// ── pure ────────────────────────────────────────────────────────────────────

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(`${String(b).slice(0, 10)}T12:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T12:00:00Z`)) / 86400000);
}

function _when(today, date) {
  const d = daysBetween(today, date);
  if (d === null) return 'no date';
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} past`;
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  return `in ${d} days`;
}

/** Validate Nick's annotation body. Omitted = leave alone, null = clear. PURE. */
function validateAnnotation(body = {}) {
  const out = {};
  if (body.kind !== undefined) {
    if (body.kind !== null && !ADMIN_KINDS.includes(body.kind)) return { error: `kind must be one of ${ADMIN_KINDS.join(', ')}` };
    out.kind = body.kind;
  }
  if (body.state !== undefined) {
    if (body.state !== null && !NOTE_STATES.includes(body.state)) return { error: `state must be one of ${NOTE_STATES.join(', ')}, or null` };
    out.state = body.state;
  }
  if (body.note !== undefined) {
    if (body.note !== null && (typeof body.note !== 'string' || body.note.length > 300)) return { error: 'note must be text (up to 300 characters)' };
    out.note = body.note === null ? null : body.note.trim() || null;
  }
  if (body.leadDays !== undefined) {
    if (body.leadDays !== null && !(Number.isInteger(body.leadDays) && body.leadDays >= 1 && body.leadDays <= MAX_LEAD_DAYS)) return { error: `leadDays must be a whole number from 1 to ${MAX_LEAD_DAYS}, or null` };
    out.leadDays = body.leadDays;
  }
  if (!Object.keys(out).length) return { error: 'nothing to set: give kind, state, note or leadDays' };
  return { value: out };
}

/**
 * The kind of an admin item. PURE. Nick's correction wins; otherwise only
 * what a typed source or an explicit link SAYS — never the wording.
 */
function kindFor(c, annotation = null) {
  if (annotation && annotation.kind) return { kind: annotation.kind, basis: 'you set it' };
  if (c.typedKind) return { kind: c.typedKind, basis: c.typedKindBasis || 'its record' };
  const links = c.entityLinks || [];
  if (links.some((l) => l.type === 'vehicle')) return { kind: 'vehicle', basis: 'linked to a vehicle' };
  if (links.some((l) => l.type === 'companion')) return { kind: 'pet', basis: 'linked to a companion' };
  if (links.some((l) => l.type === 'project')) return { kind: 'project', basis: 'linked to a project' };
  const doms = (c.domains || []).map((d) => d.domain || d);
  if (doms.includes('home')) return { kind: 'household', basis: 'household domain' };
  if (doms.includes('finance')) return { kind: 'finance', basis: 'finance domain' };
  return { kind: 'other', basis: 'nothing says more' };
}

/**
 * Admin state for one candidate. PURE.
 *   c.status     'open' | 'done' | 'unknown'  (from the owning source)
 *   c.baseState  'needs_you' | 'pending' | 'routine' | 'unknown'  (the source's own judgement)
 *   c.due        { date, firm } — firm = a stated, set or recorded date
 */
function adminState(c, { today, annotation = null } = {}) {
  const ann = annotation || {};
  if (c.status === 'done') return { state: 'done', why: c.doneWhy || 'its source says it is complete' };
  if (c.status === 'unknown' || c.baseState === 'unknown') return { state: 'unknown', why: c.baseWhy || 'its state cannot be established' };
  if (ann.state === 'blocked' && ann.note) return { state: 'blocked', why: `blocked — ${ann.note} (you said)` };
  if (ann.state === 'waiting') return { state: 'waiting', why: ann.note ? `waiting — ${ann.note} (you said)` : 'you said you are waiting on it' };
  const due = c.due || {};
  const days = due.date ? daysBetween(today, due.date) : null;
  if (c.baseState === 'needs_you') return { state: 'needs_you', why: c.baseWhy || 'its source says it needs you' };
  if (ann.leadDays && due.firm && days !== null && days >= 0 && days <= ann.leadDays) {
    return { state: 'needs_you', why: `${_when(today, due.date)} — inside the ${ann.leadDays}-day lead you set` };
  }
  if (ann.state === 'routine') return { state: 'routine', why: 'you marked it routine' };
  if (c.baseState === 'routine') return { state: 'routine', why: c.baseWhy || 'recurring, nothing to do yet' };
  if (due.firm && days !== null && days >= 0) return { state: 'upcoming', why: `${_when(today, due.date)}${c.baseWhy ? ` — ${c.baseWhy}` : ''}` };
  if (due.firm && days !== null && days < 0) return { state: 'open', why: `${_when(today, due.date)} and still open` };
  return { state: 'open', why: due.date ? 'its date is a placeholder, not yours — open, not urgent' : 'open, with no date — not urgent' };
}

// ── candidates from each source (pure adapters) ─────────────────────────────

/** A personal obligation (personal-obligations.shapeObligation) → candidate, or null. PURE. */
function fromObligation(o, { projectsByTask = new Map() } = {}) {
  const adminCare = (o.companions || []).filter((c) => ADMIN_CARE_KINDS.has(c.careKind));
  if (!o.admin && !adminCare.length) return null;
  const links = [
    ...(o.vehicles || []).map((v) => ({ type: 'vehicle', id: v.id, name: v.name })),
    ...adminCare.map((c) => ({ type: 'companion', id: c.id, name: c.name, careKind: c.careKind })),
    ...(projectsByTask.get(o.id) || []).map((p) => ({ type: 'project', id: p.projectId, name: p.name })),
  ];
  const firm = !!(o.due && (o.due.kind === 'stated' || o.due.kind === 'set'));
  const isReminder = o.source === 'Reminders';
  return {
    id: o.id, title: o.what, sourceKind: o.kind, source: o.source || 'NEURO',
    sourceRef: o.container ? `${o.source} · ${o.container.name}` : o.source || 'NEURO',
    domains: o.domains || [], entityLinks: links,
    due: o.due ? { date: o.due.date, time: o.due.time || null, firm, kind: o.due.kind } : null,
    status: o.actionState === 'unknown' ? 'unknown' : 'open',
    baseState: o.needsNow ? 'needs_you' : o.actionState === 'unknown' ? 'unknown' : 'pending', baseWhy: o.needsWhy,
    recurrence: null, importance: o.importance || null,
    completionAuthority: isReminder ? 'Apple Reminders — tick it there' : o.kind === 'commitment' ? 'the commitment\'s own source' : 'NEURO task — tick it here',
    canTick: /^task:neuro:\d+$/.test(o.id),
    realisedBy: o.realisedBy || null,
    evidence: [{ source: o.evidence && o.evidence.source, freshness: o.evidence && o.evidence.freshness }],
    // Say WHAT was set, not just that something was: "Transport — you set it on
    // this item". The generic annotation reason ("you set this") is replaced.
    whyVisible: [
      ...(o.domains || []).filter((d) => d.basis !== 'linked').map((d) => `${d.label || d.domain} — ${BASIS_WORDS[d.basis] || d.basis}${o.container && d.basis === 'classified' ? ` (the “${o.container.name}” list)` : ''}`),
      ...(o.whyPersonal || []).filter((w) => !/^you set this$/i.test(w) && !(o.domains || []).some((d) => w.startsWith(d.label || '\u0000'))),
    ],
    confidence: o.actionState === 'unknown' ? 'low' : 'high',
  };
}

/** A completed personal-admin task (canonical shape + evidence) → done candidate. PURE. */
function fromCompleted(t, ev, { today }) {
  const at = t.completedAt ? String(t.completedAt).slice(0, 10) : null;
  if (!at) return null;
  const ago = daysBetween(at, today);
  if (ago === null || ago > RECENT_DONE_DAYS || ago < 0) return null;
  return {
    id: t.id, title: t.description, sourceKind: 'task', source: t.sourceLabel || 'NEURO', sourceRef: t.sourceLabel || 'NEURO',
    domains: ev.domains, entityLinks: (ev.vehicles || []).map((v) => ({ type: 'vehicle', id: v.id, name: v.name })),
    due: null, status: 'done', doneOn: at,
    doneWhy: `${t.sourceLabel === 'Reminders' ? 'ticked in Apple Reminders' : 'ticked in NEURO'} on ${at}`,
    completionAuthority: t.sourceLabel === 'Reminders' ? 'Apple Reminders' : 'NEURO task',
    whyVisible: [...(ev.why || [])], confidence: 'high', evidence: [],
  };
}

/** A vehicle obligation (vehicle.read().obligations[]) → candidate. PURE. */
function fromVehicle(o, vehicle, { today }) {
  const name = `${vehicle.make} ${vehicle.model}`;
  const word = VEHICLE_TYPE_WORD[o.type] || o.type;
  const base = {
    id: o.id, title: `${vehicle.model} — ${o.label || word}`, sourceKind: 'vehicle-obligation', source: 'Vehicle record',
    sourceRef: `${name} · recorded by you`, domains: [{ domain: 'travel' }],
    entityLinks: [{ type: 'vehicle', id: vehicle.id, name }],
    typedKind: 'vehicle', typedKindBasis: `the ${name}'s ${word} record`,
    due: o.dueDate ? { date: o.dueDate, time: null, firm: true, kind: 'recorded' } : null,
    dueMileage: o.dueMileage == null ? null : o.dueMileage,
    recurrence: o.interval ? o.interval : null,
    completionAuthority: 'the vehicle record — done only with evidence (a test, a certificate, a payment)',
    linkedTaskRefs: [o.linkedTaskRef, o.linkedReminderRef].filter(Boolean),
    whyVisible: [`a ${word} date you recorded for the ${name}`, o.conflict ? `${o.conflict.message}` : null].filter(Boolean),
    confidence: o.confidence === 'conflict' ? 'low' : o.confidence === 'verified' ? 'high' : 'medium',
    evidence: [{ source: o.verifiedBy || 'you', freshness: o.lastCheckedAt ? 'checked' : 'stated' }],
  };
  if (o.recordStatus !== 'open') {
    const at = o.completedOn ? String(o.completedOn).slice(0, 10) : null;
    const ago = at ? daysBetween(at, today) : null;
    if (o.recordStatus !== 'complete' || ago === null || ago < 0 || ago > RECENT_DONE_DAYS) return null;
    return { ...base, status: 'done', doneOn: at, doneWhy: `recorded done on ${at}${o.completionEvidence ? ` — ${o.completionEvidence}` : ''}` };
  }
  const map = { overdue: 'needs_you', needs_you: 'needs_you', preparation_open: 'pending', upcoming: 'pending', later: 'pending', unknown: 'unknown' };
  return { ...base, status: 'open', baseState: map[o.status] || 'unknown', baseWhy: o.statusWhy };
}

/** A finance obligation (finance.read().obligations[]) → candidate. PURE. */
function fromFinance(o, { today }) {
  const base = {
    id: o.id, title: o.title, sourceKind: 'finance-obligation', source: 'Finance record', sourceRef: 'Finance · recorded by you',
    domains: [{ domain: 'finance' }], entityLinks: [],
    typedKind: FINANCE_KIND[o.kind] || 'finance', typedKindBasis: `a ${String(o.kind).replace(/_/g, ' ')} you recorded`,
    due: o.dueDate ? { date: o.dueDate, time: null, firm: true, kind: 'recorded' } : null,
    recurrence: o.seriesKey ? { series: o.seriesKey } : null,
    completionAuthority: 'the finance record — resolved only with evidence; a payment in Tally is not the obligation done unless you say so',
    linkedTaskRefs: [o.linkedTaskRef, o.linkedReminderRef].filter(Boolean),
    whyVisible: [`a ${String(o.kind).replace(/_/g, ' ')} you recorded`, o.payment || null].filter(Boolean),
    confidence: 'high', evidence: [{ source: 'you', freshness: 'stated' }],
  };
  if (o.status !== 'open') {
    const at = o.resolvedAt ? String(o.resolvedAt).slice(0, 10) : null;
    const ago = at ? daysBetween(at, today) : null;
    if (o.status !== 'resolved' || ago === null || ago < 0 || ago > RECENT_DONE_DAYS) return null;
    return { ...base, status: 'done', doneOn: at, doneWhy: `resolved on ${at}${o.resolvedEvidence ? ` (${o.resolvedEvidence})` : ''}` };
  }
  // A plain bill or household charge with no decision and no task is the
  // money going out as normal: routine, never a nag.
  const plain = (o.kind === 'bill' || o.kind === 'household_charge') && !o.requiresDecision && !o.linkedTaskRef && !o.linkedReminderRef;
  const map = { overdue: 'needs_you', needs_you: 'needs_you', preparation_open: 'pending', upcoming: 'pending', later: 'pending', unknown: o.dueDate ? 'unknown' : 'pending' };
  let baseState = map[o.state] || 'pending';
  if (plain && baseState === 'pending') baseState = 'routine';
  return { ...base, status: 'open', baseState, baseWhy: o.requiresDecision ? `${o.stateWhy} — it needs your decision` : o.stateWhy };
}

/** An administrative care item (companion-care shapeItem) → candidate, or null. PURE. */
function fromCare(i, { today }) {
  if (!ADMIN_CARE_KINDS.has(i.kind)) return null;
  const name = i.companionName || 'Ember';
  const base = {
    id: i.id, title: `${name} — ${i.title}`, sourceKind: 'care-item', source: `${name}'s care`, sourceRef: `${name}'s care · added by you`,
    domains: [{ domain: 'ember' }], entityLinks: [{ type: 'companion', id: i.companionId, name }],
    typedKind: i.kind === 'insurance' ? 'insurance' : 'pet', typedKindBasis: `${name}'s ${i.kindLabel || i.kind} item`,
    due: i.dueDate ? { date: i.dueDate, time: i.dueTime || null, firm: true, kind: 'recorded' } : null,
    recurrence: i.recurrence || null,
    completionAuthority: `${name}'s care — you tick it on her card`,
    whyVisible: [`you added it to ${name}'s care${i.recurrenceWords ? ` (${i.recurrenceWords})` : ''}`],
    confidence: 'high', evidence: [{ source: 'you', freshness: 'stated' }],
  };
  if (i.status === 'cancelled') return null;
  if (i.status === 'done') return null; // done care is read from the care log (careDone)
  const away = i.dueDate ? daysBetween(today, i.dueDate) : null;
  let baseState = i.actionState === 'needs_you' ? 'needs_you' : i.actionState === 'unknown' ? 'unknown' : 'pending';
  if (baseState === 'pending' && i.recurrence && (away === null || away > SOON_DAYS)) baseState = 'routine';
  return { ...base, status: 'open', baseState, baseWhy: i.why };
}

/** A bank feed that needs reconnecting (finance health) → candidate, or null. PURE. */
function fromFeed(a) {
  if (!a || a.state !== 'reconnect_required') return null;
  // Tally (Build 26) calls another person's own account `private`; Build 23 called it `helen`.
  const helen = a.owner === 'helen' || a.owner === 'private';
  return {
    id: `finance-feed:${a.accountRef}`, title: `Reconnect the ${a.name} bank feed in Tally`, sourceKind: 'feed-health', source: 'Bank feed health',
    sourceRef: 'Finance · Tally feed health', domains: [{ domain: 'finance' }], entityLinks: [],
    typedKind: 'account', typedKindBasis: 'the bank feed stopped renewing',
    due: null, status: 'open', baseState: 'needs_you', baseWhy: a.why || 'the feed has stopped refreshing',
    completionAuthority: 'the feed itself — it clears when Tally refreshes again, not when a task is ticked',
    whyVisible: [helen ? 'Helen\'s own account — she approves it at NatWest; your part is asking her' : 'needs re-approving at the bank'],
    confidence: 'high', evidence: [{ source: 'Tally', freshness: 'live' }],
  };
}

/**
 * Compose the view. PURE.
 *   candidates  from the adapters above (open and done)
 *   annotations Map entityId → { kind, state, note, leadDays }
 *   lookup      Map taskId → canonical task (for the action of a fact item)
 */
function composeAdmin({ today, candidates = [], annotations = new Map(), lookup = new Map() } = {}) {
  // 1 — one row per id; an OPEN sighting beats a stale DONE one (a reopen).
  const byId = new Map();
  for (const c of candidates) {
    if (!c) continue;
    const held = byId.get(c.id);
    if (!held || (held.status === 'done' && c.status !== 'done')) byId.set(c.id, c);
  }
  let list = [...byId.values()];
  const dedupe = { collapsed: [] };
  // 2 — a fact (vehicle / finance) whose action is an explicitly linked task:
  // the task becomes the fact's ACTION, shown once, never as a second row.
  for (const f of list.filter((x) => (x.linkedTaskRefs || []).length)) {
    for (const ref of f.linkedTaskRefs) {
      const t = byId.get(ref) || null;
      const known = t || lookup.get(ref) || null;
      if (known) {
        f.action = { id: ref, title: known.title || known.description, state: t ? (t.status === 'done' ? 'done' : 'open') : (known.state === 'completed' ? 'done' : known.state || 'unknown') };
        if (f.action.state === 'done' && f.status === 'open') f.whyVisible.push(`"${f.action.title}" is ticked — that is the action, not the ${f.title.split(' — ').pop()} itself, which stays open until its record says otherwise`);
      }
      if (t) { list = list.filter((x) => x.id !== ref); dedupe.collapsed.push({ kept: f.id, folded: ref, rule: 'linked action' }); }
    }
  }
  // 3 — a commitment realised by a task that is also here is the same thing.
  for (const c of list.filter((x) => x.sourceKind === 'commitment' && x.realisedBy && byId.has(x.realisedBy))) {
    list = list.filter((x) => x.id !== c.id);
    const t = list.find((x) => x.id === c.realisedBy);
    if (t) t.whyVisible.push('a commitment you made is realised by this task');
    dedupe.collapsed.push({ kept: c.realisedBy, folded: c.id, rule: 'realised-by' });
  }
  const items = list.map((c) => {
    const ann = annotations.get(c.id) || null;
    const st = adminState(c, { today, annotation: ann });
    const k = kindFor(c, ann);
    const days = c.due && c.due.date ? daysBetween(today, c.due.date) : null;
    const urgency = st.state === 'needs_you' ? 'now' : st.state === 'upcoming' && days !== null && days <= SOON_DAYS ? 'soon' : st.state === 'upcoming' ? 'later' : 'none';
    const why = [...c.whyVisible];
    if (ann && ann.state === 'blocked' && !ann.note) why.push('marked blocked without a reason — a block needs one, so it is not treated as blocked');
    return {
      obligationId: c.id, kind: k.kind, kindBasis: k.basis, title: c.title,
      source: c.source, sourceRef: c.sourceRef, sourceKind: c.sourceKind,
      domains: (c.domains || []).map((d) => d.domain || d), entityLinks: c.entityLinks || [],
      dueDate: c.due ? c.due.date : null, dueKind: c.due ? c.due.kind : null, dueMileage: c.dueMileage == null ? null : c.dueMileage,
      when: c.status === 'done' ? `done ${c.doneOn}` : c.due ? _when(today, c.due.date) : 'no date',
      status: c.status, state: st.state, stateWhy: st.why, urgency,
      actionRequired: ['needs_you', 'open', 'blocked'].includes(st.state),
      importance: c.importance || null, recurrence: c.recurrence || null,
      action: c.action || null, canTick: !!c.canTick && c.status === 'open',
      completionAuthority: c.completionAuthority, evidence: c.evidence || [], confidence: c.confidence || 'medium',
      annotation: ann ? { kind: ann.kind || null, state: ann.state || null, note: ann.note || null, leadDays: ann.leadDays || null } : null,
      whyVisible: [...why, st.why].filter(Boolean),
      doneOn: c.doneOn || null,
    };
  });
  const order = { needs_you: 0, blocked: 1, upcoming: 2, open: 3, waiting: 4, routine: 5, unknown: 6, done: 7 };
  items.sort((a, b) => (order[a.state] - order[b.state])
    || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))
    || String(a.obligationId).localeCompare(String(b.obligationId)));
  const counts = Object.fromEntries(ADMIN_STATES.map((s) => [s, items.filter((i) => i.state === s).length]));
  counts.total = items.length;
  counts.byKind = {};
  for (const i of items) counts.byKind[i.kind] = (counts.byKind[i.kind] || 0) + 1;
  return { items, counts, dedupe };
}

/**
 * Source health for admin. PURE over measured inputs. `complete` is false when
 * the CORE source (the tracked admin reminder lists) is stale or unknown.
 */
function sourceHealth({ now, adminLists = [], remindersHealth = [], vehicles = [], financeHealth = null, adminCalendars = [], careItems = null }) {
  const nowMs = now;
  const sources = [];
  if (!adminLists.length) {
    sources.push({ id: 'reminders-admin', label: 'Personal Admin reminders', core: true, state: 'not-set-up', why: 'no reminder list is classified admin and tracked' });
  } else {
    const newest = adminLists.map((l) => l.lastSeenAt).filter(Boolean).sort().pop() || null;
    const hc = remindersHealth.find((h) => h.freshness === 'fresh') || remindersHealth[0] || null;
    const ageH = newest ? (nowMs - Date.parse(newest)) / 3600000 : null;
    const fresh = (hc && hc.freshness === 'fresh') || (ageH !== null && ageH <= FRESH_HOURS);
    const open = adminLists.reduce((n, l) => n + (l.openCount || 0), 0);
    sources.push({ id: 'reminders-admin', label: 'Personal Admin reminders', core: true, state: fresh ? 'fresh' : newest ? 'stale' : 'unknown',
      lists: adminLists.map((l) => ({ name: l.name, open: l.openCount, completed30d: l.completedCount30d, lastSeenAt: l.lastSeenAt })),
      why: fresh ? `pushed from the phone ${ageH !== null ? `${Math.max(0, Math.round(ageH))}h ago` : 'recently'} · ${open} open` : newest ? `last pushed ${newest.slice(0, 10)} — open the NEURO or SAiM app on the phone` : 'never pushed' });
  }
  sources.push({ id: 'neuro-tasks', label: 'NEURO tasks', core: true, state: 'local', why: 'NEURO holds them itself' });
  sources.push({ id: 'vehicle', label: 'Vehicle record', core: false, state: vehicles.length ? 'manual' : 'none',
    why: vehicles.length ? `${vehicles.map((v) => `${v.name}: ${v.recorded} date${v.recorded === 1 ? '' : 's'} recorded`).join('; ')} — dates only as you record them (official DVLA/DVSA lookups unavailable)` : 'no vehicle held' });
  sources.push({ id: 'finance', label: 'Bank feeds (Tally)', core: false, state: financeHealth ? financeHealth.household : 'unknown',
    why: financeHealth ? financeHealth.label || financeHealth.household : 'finance has not been read' });
  sources.push({ id: 'calendar', label: 'Calendars classified admin', core: false, state: adminCalendars.length ? 'classified' : 'none',
    why: adminCalendars.length ? adminCalendars.join(', ') : 'no calendar is classified admin — calendar events never become admin by themselves' });
  sources.push({ id: 'care', label: 'Ember\'s care (administrative kinds)', core: false, state: careItems === null ? 'unknown' : 'local',
    why: careItems === null ? 'could not be read' : `${careItems} insurance / vet / vaccination item${careItems === 1 ? '' : 's'} recorded` });
  const core = sources.filter((s) => s.core);
  const complete = core.every((s) => s.state === 'fresh' || s.state === 'local');
  return { sources, complete, why: complete ? null : core.filter((s) => !(s.state === 'fresh' || s.state === 'local')).map((s) => `${s.label}: ${s.why}`).join('; ') };
}

// ── store ───────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function annotations() {
  try {
    return new Map(_db().all('SELECT * FROM personal_admin_annotations').map((r) => [r.entity_id,
      { kind: r.kind || null, state: r.state || null, note: r.note || null, leadDays: r.lead_days || null, setAt: r.set_at }]));
  } catch { return new Map(); }
}

function _projectsByTask() {
  const out = new Map();
  try {
    const rows = _db().all("SELECT l.project_id, l.task_id, p.name FROM project_task_links l LEFT JOIN projects p ON p.project_id = l.project_id WHERE l.state = 'linked'");
    for (const r of rows) {
      const k = `task:neuro:${r.task_id}`;
      out.set(k, [...(out.get(k) || []), { projectId: r.project_id, name: r.name || r.project_id }]);
    }
  } catch { /* no projects yet */ }
  return out;
}

/** Read everything and compose. Errors become named gaps, never empty lists. */
function read({ now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = require('./world-model').localMinute(nowMs).slice(0, 10);
  const gaps = [];
  const po = require('./personal-obligations');
  const cr = require('./canonical-read');
  const candidates = [];
  const projectsByTask = _projectsByTask();
  let workExcluded = null;
  try {
    const obl = po.read({ now: nowMs });
    workExcluded = obl.counts.workExcluded;
    for (const o of obl.items) { const c = fromObligation(o, { projectsByTask }); if (c) candidates.push(c); }
    for (const g of obl.gaps || []) gaps.push(g);
  } catch (e) { gaps.push({ input: 'obligations', why: e.message }); }
  // recently completed admin tasks and reminders — authoritative completion only
  try {
    const done = cr.tasks({ status: 'completed', now: nowMs }).items;
    let goals = []; try { goals = cr.listGoals({ status: 'active' }); } catch { goals = []; }
    const prep = po.prepLinkMap();
    let careLinks = new Map(); try { careLinks = require('./companion-care').linkMap(); } catch { careLinks = new Map(); }
    for (const t of done) {
      const ev = po.personalEvidence(t, { goalLinks: po.goalLinkMap(goals), prepLinks: prep.byEntity, careLinks });
      if (!ev.personal || !po.isAdmin(ev)) continue;
      const c = fromCompleted(t, ev, { today }); if (c) candidates.push(c);
    }
  } catch (e) { gaps.push({ input: 'completed-tasks', why: e.message }); }
  let lookup = new Map();
  try { lookup = new Map(cr.tasks({ status: 'all', now: nowMs, limit: 2000 }).items.map((t) => [t.id, t])); } catch { lookup = new Map(); }
  const vehiclesHealth = [];
  try {
    const veh = require('./vehicle');
    for (const v of veh.listVehicles().filter((x) => x.ownership_state === 'current')) {
      const r = veh.read(v.vehicle_id, { now: nowMs });
      vehiclesHealth.push({ name: `${r.vehicle.make} ${r.vehicle.model}`, recorded: r.obligations.filter((o) => o.recordStatus === 'open').length });
      for (const o of r.obligations) { const c = fromVehicle(o, r.vehicle, { today }); if (c) candidates.push(c); }
    }
  } catch (e) { gaps.push({ input: 'vehicle', why: e.message }); }
  let financeHealth = null;
  try {
    const f = require('./finance').read({ now: nowMs });
    for (const o of f.obligations || []) { const c = fromFinance(o, { today }); if (c) candidates.push(c); }
    financeHealth = f.health || null;
    for (const a of (f.health && f.health.accounts) || []) { const c = fromFeed(a); if (c) candidates.push(c); }
  } catch (e) { gaps.push({ input: 'finance', why: e.message }); }
  let careCount = null;
  try {
    const cc = require('./companion-care');
    careCount = 0;
    for (const comp of require('./personal-world').listCompanions()) {
      const rows = _db().all('SELECT * FROM companion_care_items WHERE companion_id = ?', [comp.id]);
      for (const row of rows) {
        const i = cc.shapeItem(row, { today, companionName: comp.name });
        if (ADMIN_CARE_KINDS.has(i.kind) && i.status === 'open') careCount += 1;
        const c = fromCare(i, { today }); if (c) candidates.push(c);
      }
      for (const l of _db().all('SELECT * FROM companion_care_log WHERE companion_id = ?', [comp.id])) {
        if (!ADMIN_CARE_KINDS.has(l.kind)) continue;
        const ago = daysBetween(l.done_on, today);
        if (ago === null || ago < 0 || ago > RECENT_DONE_DAYS) continue;
        candidates.push({ id: `${l.care_id}@${l.done_on}`, title: `${comp.name} — ${l.title}`, sourceKind: 'care-log', source: `${comp.name}'s care`,
          sourceRef: `${comp.name}'s care`, domains: [{ domain: 'ember' }], entityLinks: [{ type: 'companion', id: comp.id, name: comp.name }],
          typedKind: l.kind === 'insurance' ? 'insurance' : 'pet', status: 'done', doneOn: l.done_on, doneWhy: `you ticked it on ${l.done_on}`,
          completionAuthority: `${comp.name}'s care`, whyVisible: [], confidence: 'high', evidence: [] });
      }
    }
  } catch (e) { gaps.push({ input: 'companion-care', why: e.message }); careCount = null; }
  const composed = composeAdmin({ today, candidates, annotations: annotations(), lookup });
  // source health
  let adminLists = [];
  try {
    const isAdminList = (l) => ((l.classification && l.classification.domains) || []).some((d) => po.ADMIN_DOMAINS.includes(d.domain || d));
    adminLists = require('./reminder-audit').read({ now: nowMs }).lists.filter((l) => isAdminList(l) && l.trackingState === 'tracked');
  } catch (e) { gaps.push({ input: 'reminder-lists', why: e.message }); }
  let remindersHealth = [];
  try { remindersHealth = _db().all("SELECT source_id, freshness, last_observed_at FROM source_health WHERE source_id LIKE 'reminders.%' AND source_id != 'reminders.unknown'").map((h) => ({ sourceId: h.source_id, freshness: h.freshness, lastObservedAt: h.last_observed_at })); } catch { remindersHealth = []; }
  let adminCalendars = [];
  try { adminCalendars = require('./source-classification').listClassifications('calendar').filter((c) => (c.domains || []).some((d) => po.ADMIN_DOMAINS.includes(d))).map((c) => c.label); } catch { adminCalendars = []; }
  const health = sourceHealth({ now: nowMs, adminLists, remindersHealth, vehicles: vehiclesHealth, financeHealth, adminCalendars, careItems: careCount });
  return {
    ok: true, contract: 'personal-admin-v1', asOf: new Date(nowMs).toISOString(), today,
    heading: health.complete && !gaps.length ? 'Personal admin' : 'Personal admin — from the sources NEURO can currently read',
    ...composed, workExcluded, health, gaps,
    rule: 'Admin is read from what you classified (a reminder list or task set as admin, finance or transport), what you linked to the car or to Ember\'s care, and the vehicle and finance dates you recorded. Work never appears, wording never decides, and no renewal or date is invented. A ticked task is the action — the MOT or renewal itself is done only when its own record says so.',
  };
}

/** Nick's word about an item that exists. Refused for an item NEURO does not hold. */
function annotate(entityId, body = {}, { now = Date.now(), view = null } = {}) {
  if (typeof entityId !== 'string' || !entityId || entityId.length > 300) return { ok: false, status: 400, error: 'entityId is required' };
  const v = validateAnnotation(body);
  if (v.error) return { ok: false, status: 400, error: v.error };
  const current = view || read({ now });
  const item = current.items.find((i) => i.obligationId === entityId);
  if (!item) return { ok: false, status: 404, error: 'no such personal-admin item — it must already be on the Personal admin card' };
  const held = annotations().get(entityId) || {};
  const next = { kind: held.kind || null, state: held.state || null, note: held.note || null, leadDays: held.leadDays || null, ...v.value };
  if (next.state === 'blocked' && !next.note) return { ok: false, status: 400, error: 'a block needs a reason — say what is blocking it' };
  const db = _db();
  const iso = new Date(now).toISOString();
  if (!next.kind && !next.state && !next.note && !next.leadDays) db.run('DELETE FROM personal_admin_annotations WHERE entity_id = ?', [entityId]);
  else {
    db.run(`INSERT INTO personal_admin_annotations (entity_id, kind, state, note, lead_days, set_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET kind = excluded.kind, state = excluded.state, note = excluded.note, lead_days = excluded.lead_days, set_at = excluded.set_at`,
    [entityId, next.kind, next.state, next.note, next.leadDays, iso]);
  }
  const changed = Object.keys(v.value).filter((k) => (held[k] || null) !== (next[k] || null));
  if (changed.length) {
    require('./personal-obligations').logEvent('admin-annotated', { subjectId: entityId, actor: 'nick',
      detail: { title: item.title, changed, state: next.state, kind: next.kind, leadDays: next.leadDays }, dedupeKey: `admin-annotated:${entityId}:${now}`, now });
  }
  return { ok: true, entityId, annotation: next, changed };
}

/**
 * Inside the `personal-ops` durable job: log only when the CORE admin source
 * changes state (became active / stale / recovered). Items themselves are
 * already logged by the Radar pass and the owning modules. First run = baseline.
 */
function refresh({ now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const db = _db();
  const KEY = 'personal_admin_state';
  let held = null;
  try { held = JSON.parse(db.getState(KEY) || 'null'); } catch { held = null; }
  const v = read({ now: nowMs });
  const core = v.health.sources.find((s) => s.id === 'reminders-admin');
  const fromReminders = v.items.filter((i) => i.source === 'Reminders' && i.status === 'open').length;
  const state = { at: new Date(nowMs).toISOString(), source: core ? core.state : 'unknown', fromReminders, baselined: true };
  let logged = 0;
  const po = require('./personal-obligations');
  if (held && held.baselined) {
    if (held.fromReminders === 0 && fromReminders > 0) logged += po.logEvent('admin-source-active', { subjectId: 'personal-admin', detail: { items: fromReminders }, dedupeKey: `admin-source-active:${nowMs}`, now: nowMs }) ? 1 : 0;
    if (held.source === 'fresh' && state.source === 'stale') logged += po.logEvent('admin-source-stale', { subjectId: 'personal-admin', detail: { why: core.why }, dedupeKey: `admin-source-stale:${nowMs}`, now: nowMs }) ? 1 : 0;
    if (held.source === 'stale' && state.source === 'fresh') logged += po.logEvent('admin-source-recovered', { subjectId: 'personal-admin', detail: {}, dedupeKey: `admin-source-recovered:${nowMs}`, now: nowMs }) ? 1 : 0;
  }
  db.setState(KEY, JSON.stringify(state));
  return { ok: true, baseline: !(held && held.baselined), logged, ...state };
}

module.exports = {
  ADMIN_KINDS, ADMIN_STATES, NOTE_STATES, ADMIN_CARE_KINDS, RECENT_DONE_DAYS, MAX_LEAD_DAYS,
  // pure
  daysBetween, validateAnnotation, kindFor, adminState, fromObligation, fromCompleted, fromVehicle, fromFinance, fromCare, fromFeed,
  composeAdmin, sourceHealth,
  // store
  annotations, read, annotate, refresh,
};
