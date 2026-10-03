'use strict';

/**
 * Which parts of Nick's life a thing belongs to (Build 10C).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * NEURO grew up around work because work emits the most structured data. The
 * Nick-first operating model (vault: JARVIS FRIDAY Target Architecture) says
 * work is ONE domain inside the world model, not its organising principle.
 * This module is the presentation vocabulary that lets every surface say so.
 *
 * ── It is NOT `shared/task-domain.cjs` ──────────────────────────────────────
 * task-domain answers a BEHAVIOURAL question — may this task reach work
 * systems — with two values and a deliberate default of `work`. That default
 * is right for its question and wrong for this one: here a default is not
 * evidence. So a stored `tasks.domain = 'work'` is reported as basis
 * `default`, never as a fact about the task, and `personal` (which somebody
 * chose) sets the coarse SPHERE without inventing which personal domain.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *  • Unknown stays unknown: no evidence → `domains: []`, `sphere: null`.
 *  • Domain is not source. Outlook does not mean work; a calendar does not
 *    mean work; HealthKit carrying a reading is about health only because the
 *    reading IS health data, not because of the transport.
 *  • One entity may carry several domains when each has its own evidence.
 *  • Sensitive domains (health, family, finance) are never inferred from
 *    weak signals — only declared, or carried by data that is intrinsically
 *    that kind (a heart-rate source).
 *
 * Pure, browser-safe: no DB, no network, no clock.
 */

const DOMAINS = Object.freeze([
  'work', 'health', 'home', 'family', 'finance', 'fitness',
  'ember', 'travel', 'learning', 'projects', 'admin', 'leisure',
]);

const LABELS = Object.freeze({
  work: 'Work',
  health: 'Health',
  home: 'Home',
  family: 'Family & relationships',
  finance: 'Finance',
  fitness: 'Fitness & hiking',
  ember: 'Ember',
  travel: 'Transport & travel',
  learning: 'Learning',
  projects: 'Personal projects',
  admin: 'Personal admin',
  leisure: 'Leisure & interests',
});

// Never inferred — declared, or intrinsic to the data.
const SENSITIVE = Object.freeze(new Set(['health', 'family', 'finance']));

// How a domain came to be attached. Ordered strongest first.
const BASES = Object.freeze(['declared', 'intrinsic', 'set', 'source-process', 'inference', 'default']);

// What Nick may say about how much a thing matters to HIM, beside urgency.
// Explicit only — never computed. Absent means "not said", not "optional".
const IMPORTANCE = Object.freeze(['work-critical', 'personally-important', 'restorative', 'optional']);
const IMPORTANCE_LABELS = Object.freeze({
  'work-critical': 'Work-critical',
  'personally-important': 'Personally important',
  restorative: 'Restorative',
  optional: 'Optional',
});

function normaliseDomain(d) {
  const v = typeof d === 'string' ? d.trim().toLowerCase() : '';
  return DOMAINS.includes(v) ? v : null;
}

function normaliseImportance(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return IMPORTANCE.includes(s) ? s : null;
}

function domainLabel(d) { return LABELS[d] || null; }

/**
 * Fold evidence into `{domains:[{domain,basis,why}], sphere, basis}`.
 *
 * `evidence` is a list of `{domain, basis, why}` claims (`domain` may be null
 * when only a sphere is known, e.g. a task marked personal). A `declared`
 * claim REPLACES every other claim — that is Nick speaking about his own life,
 * and an inference that disagrees with him is not information. Among the rest,
 * each domain keeps its strongest basis. A sensitive domain arriving on a
 * basis weaker than `intrinsic` is DROPPED, not demoted: weak evidence about
 * health, family or money is how a system starts telling someone things about
 * themselves it has no right to say.
 */
function resolveDomains(evidence = [], { sphere = null } = {}) {
  const claims = (evidence || []).filter(Boolean);
  const declared = claims.filter((c) => c.basis === 'declared');
  const pool = declared.length ? declared : claims;
  const byDomain = new Map();
  for (const c of pool) {
    const d = normaliseDomain(c.domain);
    if (!d) continue;
    const basis = BASES.includes(c.basis) ? c.basis : 'inference';
    if (SENSITIVE.has(d) && !['declared', 'intrinsic'].includes(basis)) continue;
    const held = byDomain.get(d);
    if (!held || BASES.indexOf(basis) < BASES.indexOf(held.basis)) byDomain.set(d, { domain: d, basis, why: c.why || null });
  }
  const domains = DOMAINS.filter((d) => byDomain.has(d)).map((d) => byDomain.get(d));
  // Sphere: an explicit one wins; otherwise work if the only domain is work,
  // personal if every domain is non-work, null when there is nothing or a mix.
  let sp = sphere === 'work' || sphere === 'personal' ? sphere : null;
  if (!sp && domains.length) {
    const hasWork = domains.some((d) => d.domain === 'work');
    const hasOther = domains.some((d) => d.domain !== 'work');
    sp = hasWork && !hasOther ? 'work' : !hasWork && hasOther ? 'personal' : null;
  }
  const strongest = domains.length
    ? domains.map((d) => d.basis).sort((a, b) => BASES.indexOf(a) - BASES.indexOf(b))[0]
    : null;
  return { domains, sphere: sp, known: domains.length > 0 || sp !== null, basis: strongest };
}

module.exports = {
  DOMAINS, LABELS, SENSITIVE, BASES, IMPORTANCE, IMPORTANCE_LABELS,
  normaliseDomain, normaliseImportance, domainLabel, resolveDomains,
};
