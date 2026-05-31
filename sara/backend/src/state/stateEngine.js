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
const ha = require('../telemetry/homeAssistant');
const { deriveInference } = require('./inference');

const RUNTIME_LABEL = 'WS5-WP1';

// Input providers, one per contract domain. Seeded in WS1; swap for live readers
// later without touching the engine or the contract.
const PROVIDERS = {
  queue: seed.queue,
  focus: seed.focus,
  people: seed.people,
  vault: seed.vault,
};

// Current location is a situational input (not a domain). The seed reader is the
// honest fallback; WS3 lets the Home Assistant telemetry bridge feed it live when a
// location signal is present. The contract is unchanged — location stays the same
// shape whether it comes from HA or seed (that is the seam).
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

// Map a context label off the HA location zone, so a screen reading location stays
// the same shape it always was. Display/representation only — no decision is taken.
function locationContext(zone) {
  if (zone === 'home') return 'home';
  if (zone === 'not_home') return 'away';
  return 'elsewhere';
}

/**
 * Build the situational `location` block. When the HA telemetry bridge reports a live
 * location signal, location comes from HA (`source: 'home-assistant'`); otherwise it
 * falls back to the seeded reader (`source: 'seed'`). Either way the shape is the same
 * — HA being absent can never break a consumer, it only changes the source.
 */
function buildLocation(telemetry) {
  const loc = telemetry.available ? telemetry.signals.location : null;
  if (loc && loc.label) {
    return {
      source: ha.TELEMETRY_SOURCE,
      label: loc.label,
      context: locationContext(loc.zone),
      since: telemetry.polledAt,
      summary: `Home Assistant places you at ${loc.label}.`,
      entityId: loc.entityId,
    };
  }
  // Honest fallback: HA unavailable or carrying no location signal -> seeded input.
  return { ...LOCATION_PROVIDER(), telemetry: 'fallback' };
}

// Shape the cached HA snapshot into the model's telemetry block. Read-only: the engine
// never asks HA to decide anything, it only surfaces what HA reported and how stale it
// is. `ageMs` lets a consumer judge freshness without owning its own clock.
function buildTelemetry(telemetry) {
  return {
    source: telemetry.source,
    available: telemetry.available,
    reason: telemetry.reason || null,
    detail: telemetry.detail || null,
    polledAt: telemetry.polledAt || null,
    ageMs: telemetry.polledAt ? Date.now() - Date.parse(telemetry.polledAt) : null,
    signals: telemetry.signals,
  };
}

/**
 * Assemble the single shared runtime model from the domain providers, derive the
 * briefing, fold in Home Assistant telemetry, and self-validate against the contract.
 * @returns {object} the assembled model (carries meta.valid / meta.errors)
 */
function buildModel() {
  const domains = {};
  for (const name of DOMAINS) domains[name] = PROVIDERS[name]();

  // Read the latest cached HA telemetry snapshot. This is synchronous and never
  // throws — an absent/unreachable HA yields an honest `available: false` snapshot,
  // so model assembly is never blocked or broken by telemetry.
  const telemetry = ha.getTelemetry();

  // Domains are still seeded (WS3 is a telemetry slice, not a domain-integration one).
  // The location and telemetry blocks below may be live via HA; that is surfaced on
  // their own `source` fields, so `dataSource` stays an honest statement about domains.
  const dataSource = 'seed';
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
      note: 'State Engine contract is live. Domain inputs are seeded (hardcoded); location/telemetry may be live via the Home Assistant bridge when configured, otherwise they fall back honestly.',
    },
    location: buildLocation(telemetry),
    telemetry: buildTelemetry(telemetry),
    confidence: deriveConfidence(domains, dataSource),
    briefing: buildBriefing(domains),
    domains,
  };

  // Context inference (WS5-WP1). Derived AFTER the rest of the model is assembled, from
  // the same inputs the model already carries — so inference extends the one shared
  // model rather than owning a parallel state. It is advisory: it recommends a view but
  // never selects one, and telemetry is just one of its inputs (HA stays a bus).
  model.inference = deriveInference({
    domains: model.domains,
    telemetry: model.telemetry,
    location: model.location,
  });

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
    locationSource: model.location.source,
    confidence: { level: model.confidence.level, score: model.confidence.score },
    // Same telemetry verdict the state model carries, so health and state can never
    // disagree about whether Home Assistant telemetry is live or unavailable.
    telemetry: {
      source: model.telemetry.source,
      available: model.telemetry.available,
      reason: model.telemetry.reason,
      polledAt: model.telemetry.polledAt,
    },
    // Same inference verdict the state model carries (WS5-WP1) — advisory only. Health
    // reports the inferred activity, the recommended view, and confidence so operators
    // can see what SARA inferred without parsing the full model. It is a read-only echo;
    // health takes no action on it.
    inference: {
      activity: model.inference.activity,
      recommendedView: model.inference.recommendedView,
      advisory: model.inference.advisory,
      confidence: { level: model.inference.confidence.level, score: model.inference.confidence.score },
    },
    startedAt: model.startedAt,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { getState, getHealth, buildModel, RUNTIME_LABEL };
