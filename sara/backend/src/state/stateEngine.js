// SARA State Engine — PLACEHOLDER (WS0-WP1)
//
// Protected principle: there is ONE SARA and ONE shared state model. This module
// is the single source of truth for runtime state. In WS0 it holds an in-memory
// placeholder so the runtime can boot and prove the frontend/backend loop.
//
// This is intentionally temporary. A later work package replaces the internals
// with the real central State Engine. The SHAPE here is forward-compatible:
//   - one root object, namespaced by domain
//   - `placeholder: true` so any consumer can tell this is not real state yet
//   - additive — future domains (queue, vault, people, focus...) slot in as keys
//
// CommonJS only (NEURO backend convention — no ESM).

const RUNTIME_LABEL = 'WS0-WP1';

// Single in-memory state object. Replaced by the central State Engine later.
const state = {
  schemaVersion: 0,
  placeholder: true,
  runtime: RUNTIME_LABEL,
  startedAt: new Date().toISOString(),
  sara: {
    name: 'SARA',
    status: 'online',
    note: 'Runtime foundation only. No intelligence wired yet (WS0 scope).',
  },
  // Future central State Engine populates these. Empty + labelled for now.
  domains: {
    // queue:  {}   // Jira triage
    // vault:  {}   // Obsidian
    // people: {}   // team board
    // focus:  {}   // do-next
  },
};

/**
 * Return the current shared state.
 * @returns {object} the single shared state model (placeholder in WS0).
 */
function getState() {
  return {
    ...state,
    servedAt: new Date().toISOString(),
  };
}

/**
 * Lightweight health view derived from the same single state model, so health
 * and state can never disagree about whether SARA is up.
 */
function getHealth() {
  return {
    status: 'ok',
    sara: state.sara.status,
    runtime: state.runtime,
    placeholder: state.placeholder,
    startedAt: state.startedAt,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { getState, getHealth, RUNTIME_LABEL };
