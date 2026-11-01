'use strict';

/**
 * SOAP report items — the ONE place that names each line of the report
 * (1 Nov 2026, Nick: "I need more granularity about what is included/excluded —
 * not just the section, but each item").
 *
 * A key is `<section>:<id>`. The server's render() and the SOAP screen both build
 * keys here, so an item ticked off on the screen is the item dropped from the
 * email. Ids come from the item itself (a stable key, an id, an account number),
 * never its position, so a rebuild that reorders a list keeps Nick's choices.
 * PURE, browser-safe.
 */

const k = (section, id) => `${section}:${String(id)}`;

const itemKey = {
  success: (s) => k('success', s.key),
  fixed: (f) => k('success', `fix:${f.id}`),
  amber: (a) => k('amber', a.key),
  red: (r) => k('red', r.key),
  carried: (c) => k('carried', c.key),
  correction: (c) => k('corrections', c.id),
  perQueue: (q) => k('perQueue', q.key),
  slaDaily: (d) => k('slaDaily', d.day),
  ageing: (a) => k('ageing', a.kpi),
  volume: (r) => k('volumes', r.name),
  myEscalations: () => k('volumes', 'myEscalations'),
  csat: (c) => k('csat', c.key || c.label),
  sentiment: (part) => k('csat', `sentiment:${part}`),
  agent: (which) => k('agents', which),
  customer: (c) => k('customers', c.bcAccountNumber || c.name),
  winning: (c) => k('winning', c.bcAccountNumber || c.name),
  planStatus: () => k('plan', 'status'),
  planCompleted: () => k('plan', 'completed'),
  planDone: (d) => k('plan', `done:${d.id}`),
  planOverdue: (o) => k('plan', `overdue:${o.id}`),
  finding: (f) => k('findings', f.id),
  leading: (i) => k('leading', i.key || i.title),
  slm: (heading, text) => k('slm', `${heading}:${text}`),
};

/** The section a key belongs to. */
const sectionOf = (key) => String(key).split(':')[0];

/**
 * The ticket line for a worst-customer row: open tickets split between Support
 * and Development, and how many they raised in the last 30 days. NOVA sends
 * `open` and `openDev` (open tickets currently with Development — a subset of
 * open). A count NOVA did not send is left out, never shown as 0. PURE.
 */
function customerTickets(c) {
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const open = n(c && c.open);
  const dev = n(c && c.openDev);
  const recent = n(c && c.last30Days);
  const bits = [];
  if (open !== null) {
    if (open === 0) bits.push('none open now');
    else if (dev !== null) bits.push(`${open} open now (${Math.max(open - dev, 0)} Support, ${dev} Development)`);
    else bits.push(`${open} open now`);
  }
  if (recent !== null) bits.push(`${recent} raised in the last 30 days`);
  return bits.length ? bits.join(' · ') : null;
}

/**
 * A leading indicator's tone (VANTAGE, 1 Nov 2026): a CONCERN (moved the bad way),
 * a POSITIVE (moved the good way) or WORTH KNOWING (the KPI has no good or bad
 * direction). A card from before tones existed was a warning, so it reads as one.
 */
const TONES = Object.freeze({
  concern: { label: 'Concern', mark: '⚠️', order: 0 },
  positive: { label: 'Positive', mark: '✅', order: 1 },
  neutral: { label: 'Worth knowing', mark: 'ℹ️', order: 2 },
});
function leadingTone(i) {
  return TONES[i && i.tone] ? i.tone : 'concern';
}
/** Concerns first, then positives, then worth knowing; VANTAGE's order within each. PURE. */
function byTone(list) {
  return (list || []).map((x, n) => [x, n])
    .sort((a, b) => TONES[leadingTone(a[0])].order - TONES[leadingTone(b[0])].order || a[1] - b[1])
    .map(([x]) => x);
}

module.exports = { itemKey, sectionOf, customerTickets, TONES, leadingTone, byTone };
