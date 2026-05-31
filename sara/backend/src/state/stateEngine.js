// SARA State Engine — v1 (WS1-WP1).
//
// Protected principle: there is ONE SARA and ONE shared state model. This module
// is the single source of truth for runtime state. WS0 returned a placeholder
// literal; WS1 makes this a real engine: it assembles the one shared model from
// named domain inputs, derives SARA's briefing from that model, validates the
// result against the v1 contract, and exposes it over the existing /api path.
//
// Inputs are still seeded (hardcoded) — the engine and the contract are real;
// only the data source is not yet live, and that is surfaced honestly
// (`dataSource: 'seed'` at the root, `source: 'seed'` on every domain). Swapping
// seed.js providers for live readers later changes neither this engine nor the
// contract — that is the seam.
//
// CommonJS only (NEURO backend convention — no ESM).

const { CONTRACT, SCHEMA_VERSION, DOMAINS, DOMAIN_CONTRACTS, validate } = require('./contract');
const seed = require('./seed');

const RUNTIME_LABEL = 'WS1-WP1';

// Input providers, one per contract domain. Seeded in WS1; swap for live readers
// later without touching the engine or the contract.
const PROVIDERS = {
  queue: seed.queue,
  focus: seed.focus,
  people: seed.people,
  vault: seed.vault,
};

// Current location is a seeded situational input (not a domain). Same seam as the
// domain providers: swap for a live reader (OwnTracks / calendar) in a later WP.
const LOCATION_PROVIDER = seed.location;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Derive SARA's confidence in the assembled model — real engine work, not a seeded
 * value. Confidence falls out of two honest signals: whether every domain is
 * contract-shaped, and whether inputs are live or still seeded. A malformed domain
 * (the same fault the invalid-model path surfaces) drops confidence to `low`, so
 * confidence and the existing degraded-health behaviour stay consistent.
 */
function deriveConfidence(domains, dataSource) {
  const malformed = DOMAINS.filter((name) => {
    const d = domains[name];
    return !isObject(d) || !DOMAIN_CONTRACTS[name].every((k) => k in d);
  });
  if (malformed.length) {
    const plural = malformed.length === 1 ? 'domain is' : 'domains are';
    return {
      source: 'derived',
      score: 0.3,
      level: 'low',
      rationale: `Model is degraded — ${malformed.join(', ')} ${plural} not contract-shaped.`,
      basis: ['domain-structure-incomplete'],
    };
  }
  if (dataSource === 'seed') {
    return {
      source: 'derived',
      score: 0.6,
      level: 'moderate',
      rationale: 'All domains are contract-shaped, but inputs are seeded (hardcoded), not live.',
      basis: ['contract-valid', 'inputs-seeded'],
    };
  }
  return {
    source: 'derived',
    score: 0.9,
    level: 'high',
    rationale: 'All domains are contract-shaped and sourced from live inputs.',
    basis: ['contract-valid', 'inputs-live'],
  };
}

// Process start — stable across requests so consumers can read uptime.
const startedAt = new Date().toISOString();

/**
 * Derive SARA's briefing line from the assembled domains. This is real work the
 * engine does over the model — not a hardcoded sentence — so the headline always
 * reflects current domain data. When the providers go live, the briefing follows.
 */
function buildBriefing(domains) {
  const parts = [];
  if (domains.queue.breaching > 0) {
    const n = domains.queue.breaching;
    parts.push(`${n} ${n === 1 ? 'ticket is' : 'tickets are'} breaching SLA.`);
  }
  const slipping = domains.people.members.find((m) => m.status === 'slipping');
  if (slipping) parts.push(`${slipping.name} is slipping — ${slipping.flag}.`);
  if (domains.focus.current) parts.push(`Start with: ${domains.focus.current.title}.`);
  const line = parts.length
    ? parts.join(' ')
    : 'Queue is calm. Pick the highest-leverage thing and start.';
  return { line, derivedFrom: ['queue', 'people', 'focus'] };
}

/**
 * Assemble the single shared runtime model from the domain providers, derive the
 * briefing, and self-validate against the v1 contract.
 * @returns {object} the assembled model (carries meta.valid / meta.errors)
 */
function buildModel() {
  const domains = {};
  for (const name of DOMAINS) domains[name] = PROVIDERS[name]();

  const dataSource = 'seed'; // honest: inputs are hardcoded, not live yet (WS1 scope)
  const model = {
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    runtime: RUNTIME_LABEL,
    dataSource,
    generatedAt: new Date().toISOString(),
    startedAt,
    sara: {
      name: 'SARA',
      status: 'online',
      note: 'State Engine v1 contract is live. Inputs are seeded (hardcoded), not yet wired to real sources (WS1 scope).',
    },
    location: LOCATION_PROVIDER(),
    confidence: deriveConfidence(domains, dataSource),
    briefing: buildBriefing(domains),
    domains,
  };

  const { valid, errors } = validate(model);
  model.meta = { valid, errors, domainCount: DOMAINS.length };
  return model;
}

/**
 * Return the current shared state model (assembled fresh, validated, stamped).
 */
function getState() {
  return { ...buildModel(), servedAt: new Date().toISOString() };
}

/**
 * Health view derived from the SAME model, so health and state can never disagree
 * about whether SARA is up or whether the model is contract-valid. Reports
 * `degraded` if the engine produced a model that fails its own contract.
 */
function getHealth() {
  const model = buildModel();
  return {
    status: model.meta.valid ? 'ok' : 'degraded',
    sara: model.sara.status,
    runtime: model.runtime,
    contract: model.contract,
    schemaVersion: model.schemaVersion,
    dataSource: model.dataSource,
    valid: model.meta.valid,
    location: model.location.label,
    confidence: { level: model.confidence.level, score: model.confidence.score },
    startedAt: model.startedAt,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { getState, getHealth, buildModel, RUNTIME_LABEL };
