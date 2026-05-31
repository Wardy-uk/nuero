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
