'use strict';

/**
 * Which Jira ticket a NEURO task stands for (16 Oct 2026, SAiM Alt Jira hand-off). PURE.
 *
 * In order of trust:
 *   1. the jira-tasks ledger (key → task id), with the task's own browse URL
 *      (`origin_path`) when Jira created it — NEURO's structured link;
 *   2. ONLY when there is no structured link: a STRICTLY recognised key at the very
 *      start of the task wording ("NT-24162: …", "[NT-24162] …") whose project NEURO
 *      already knows. A key anywhere else in the text, or of a project NEURO does not
 *      know, is not a link. A URL is never taken from text.
 *
 * Returns `{ key, url, basis: 'ledger' | 'text' }` or null.
 */

const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const LEADING_KEY = /^\s*\[?([A-Z][A-Z0-9]+-\d+)\]?(?=[\s:–—-]|$)/;

function ticketFor(taskId, text, { links = null, projects = null } = {}) {
  const known = links && taskId != null ? links.get(Number(taskId)) || null : null;
  if (known && TICKET_KEY.test(String(known.key || ''))) return { key: known.key, url: typeof known.url === 'string' ? known.url : null, basis: 'ledger' };
  const m = LEADING_KEY.exec(String(text || ''));
  if (!m || !Array.isArray(projects) || !projects.includes(m[1].split('-')[0])) return null;
  return { key: m[1], url: null, basis: 'text' };
}

module.exports = { ticketFor, TICKET_KEY };
