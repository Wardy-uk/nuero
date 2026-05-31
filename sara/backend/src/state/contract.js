// SARA State Engine — v1 contract (WS1-WP1).
//
// The contract is the *shape* of the single shared runtime model plus the rules
// that make an assembled model valid. WS0 shipped a placeholder literal with no
// contract; WS1 makes the contract real and enforced. Inputs are still hardcoded
// (seeded) in WS1 — the contract does not care where domain data comes from, only
// that the assembled model conforms. That is the seam: swap seed inputs for live
// readers later without changing this contract or any consumer.
//
// CommonJS only (NEURO backend convention — no ESM).

const CONTRACT = 'state-engine-v1';
const SCHEMA_VERSION = 1;

// The domains that make up the one shared model. This array is the canonical set
// and order. Future work packages add domains here (and a matching provider).
const DOMAINS = ['queue', 'focus', 'people', 'vault'];

// Required keys per domain. Every domain shares source + summary; each adds its
// own structural backbone. This is the enforced part of the contract — a domain
// missing any of these makes the whole model invalid.
const DOMAIN_CONTRACTS = {
  queue: ['source', 'summary', 'open', 'breaching', 'sections'],
  focus: ['source', 'summary', 'current', 'deferEscalation'],
  people: ['source', 'summary', 'members'],
  vault: ['source', 'summary', 'picks'],
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate an assembled model against the v1 contract.
 * @param {object} model assembled shared runtime model
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(model) {
  const errors = [];
  if (!isObject(model)) return { valid: false, errors: ['model is not an object'] };

  if (model.contract !== CONTRACT) errors.push(`contract must be "${CONTRACT}"`);
  if (model.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (typeof model.generatedAt !== 'string') errors.push('generatedAt must be an ISO string');

  if (!isObject(model.sara) || typeof model.sara.name !== 'string' || typeof model.sara.status !== 'string') {
    errors.push('sara must be an object with name and status strings');
  }
  if (!isObject(model.briefing) || typeof model.briefing.line !== 'string' || !model.briefing.line) {
    errors.push('briefing.line must be a non-empty string');
  }

  // Current location and confidence are part of SARA's situational state (WS1
  // criterion 2: state + location + confidence exposed consistently). Location is
  // a seeded input in WS1 (swappable seam, like the domains); confidence is derived
  // by the engine. The contract enforces their shape only — not where they come from.
  if (!isObject(model.location) || typeof model.location.source !== 'string' || typeof model.location.label !== 'string') {
    errors.push('location must be an object with source and label strings');
  }
  if (!isObject(model.confidence) || typeof model.confidence.score !== 'number' || typeof model.confidence.level !== 'string') {
    errors.push('confidence must be an object with a numeric score and level string');
  }

  // Telemetry is the Home Assistant signal block folded into SARA's situational state
  // (WS3-WP1). HA is a telemetry bus only; the engine still produces the model. The
  // contract enforces the block's shape so state and health can NEVER disagree about
  // whether telemetry is live or unavailable — `available` is a required boolean and
  // `source` a required string. Signals themselves are allowed to be null (honest
  // "no live signal"), so their per-field shape is not enforced here.
  if (!isObject(model.telemetry) || typeof model.telemetry.source !== 'string' || typeof model.telemetry.available !== 'boolean') {
    errors.push('telemetry must be an object with a source string and available boolean');
  } else if (!isObject(model.telemetry.signals)) {
    errors.push('telemetry.signals must be an object');
  }

  // Inference is the bounded context-inference block folded into the one shared model
  // (WS5-WP1). It extends the same model — it is NOT a parallel state owner. The
  // contract enforces its shape AND its advisory guarantee: `advisory` MUST be exactly
  // `true`, so the shared model itself promises the recommendation never drives the UI.
  // `recommendedView` is null (honest "no confident recommendation") or a view id
  // string. `confidence` and `reasons` are required so a recommendation can never be
  // exposed without the uncertainty and evidence behind it.
  if (!isObject(model.inference)) {
    errors.push('inference must be an object');
  } else {
    if (model.inference.advisory !== true) errors.push('inference.advisory must be exactly true (recommendation is advisory only)');
    if (typeof model.inference.activity !== 'string' || !model.inference.activity) errors.push('inference.activity must be a non-empty string');
    if (!(model.inference.recommendedView === null || typeof model.inference.recommendedView === 'string')) {
      errors.push('inference.recommendedView must be null or a view id string');
    }
    if (!isObject(model.inference.confidence) || typeof model.inference.confidence.score !== 'number' || typeof model.inference.confidence.level !== 'string') {
      errors.push('inference.confidence must be an object with a numeric score and level string');
    }
    if (!Array.isArray(model.inference.reasons)) errors.push('inference.reasons must be an array');
  }

  if (!isObject(model.domains)) {
    errors.push('domains must be an object');
  } else {
    for (const name of DOMAINS) {
      const d = model.domains[name];
      if (!isObject(d)) {
        errors.push(`domains.${name} is missing or not an object`);
        continue;
      }
      for (const key of DOMAIN_CONTRACTS[name]) {
        if (!(key in d)) errors.push(`domains.${name}.${key} is missing`);
      }
      if (typeof d.source !== 'string') errors.push(`domains.${name}.source must be a string`);
      if (typeof d.summary !== 'string') errors.push(`domains.${name}.summary must be a string`);
    }
    const extra = Object.keys(model.domains).filter((k) => !DOMAINS.includes(k));
    if (extra.length) errors.push(`unexpected domains: ${extra.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { CONTRACT, SCHEMA_VERSION, DOMAINS, DOMAIN_CONTRACTS, validate };
