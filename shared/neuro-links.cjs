'use strict';

/**
 * NEURO exact-item deep links (15 Oct 2026). PURE: the shape of a link and the
 * id each kind accepts. Resolution against real records lives in
 * backend/services/neuro-links.js; the route is GET /api/links/resolve.
 *
 *   neuro:?item=<kind>:<id>          e.g.  neuro:?item=task%3A283
 *
 * One parameter, typed. `neuro:` is relative to wherever the client knows NEURO
 * lives (the same form as `neuro:?view=sources`), so no host is in the link.
 *
 * ⚠ A LINK NAMES ONE STABLE RECORD OR IT IS NOT A LINK. Each kind's id is the
 * record's own primary key (task row id, prepared-action id, the triage or
 * personal-inbox message id, the Home Assistant entity id, the calendar event
 * id) — never a title, a position in a list, or a label that can change.
 * Opening a link either shows THAT record or says explicitly why it can't
 * (invalid / missing / stale / unreadable); it never lands on a broad page and
 * lets that pass for success.
 */

const ID = Object.freeze({
  // NEURO tasks table primary key.
  task: /^[1-9]\d{0,8}$/,
  // prepared_actions.action_id: `pa_` + 16 hex (sha1 prefix).
  action: /^pa_[0-9a-f]{16}$/,
  // Work triage: a Graph message id. Personal inbox: pmail:<mailbox>:<uidvalidity>:<uid> or gmail:<X-GM-MSGID>.
  email: /^(?:pmail:[a-z]+:\d+:\d+|gmail:\d+|[A-Za-z0-9_=+/-]{20,512})$/,
  // A Home Assistant hazard sensor's entity id.
  hazard: /^binary_sensor\.[a-z0-9_]{1,120}$/,
  // calendar_cache.event_id (Graph id, or apple:<uid>:<start> rows — iCloud UIDs carry '@'; none live carry spaces).
  'meeting-prep': /^[A-Za-z0-9_=+/:.@-]{8,600}$/,
});
const KINDS = Object.freeze(Object.keys(ID));

/** The status a resolution can end in, and the HTTP answer for each. */
const STATUS_HTTP = Object.freeze({ open: 200, invalid: 400, missing: 404, stale: 410, unreadable: 503 });

/** Parse `<kind>:<id>` (the decoded `item` value). Never throws. */
function parseItem(value) {
  if (typeof value !== 'string' || !value) return { ok: false, why: 'no item given' };
  if (value.length > 700) return { ok: false, why: 'item is too long' };
  const i = value.indexOf(':');
  if (i <= 0) return { ok: false, why: 'item must be <kind>:<id>' };
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  if (!ID[kind]) return { ok: false, why: `"${kind}" is not a link kind (${KINDS.join(', ')})` };
  if (!ID[kind].test(id)) return { ok: false, kind, why: `that is not a valid ${kind} id` };
  return { ok: true, kind, id };
}

/** The canonical link for one record, or null if the id is not valid for the kind. */
function linkFor(kind, id) {
  const p = parseItem(`${kind}:${id}`);
  return p.ok ? `neuro:?item=${encodeURIComponent(`${p.kind}:${p.id}`)}` : null;
}

/** Read a `neuro:` href back: { view } for a page, { item } for an exact record, or null. */
function parseNeuroHref(href) {
  const m = /^neuro:\?(.*)$/.exec(String(href || ''));
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const keys = [...q.keys()];
  if (keys.length === 1 && keys[0] === 'view' && /^[a-z0-9-]{1,40}$/.test(q.get('view'))) return { view: q.get('view') };
  if (keys.length === 1 && keys[0] === 'item') { const p = parseItem(q.get('item')); return p.ok ? { item: p } : null; }
  return null;
}

module.exports = { KINDS, ID, STATUS_HTTP, parseItem, linkFor, parseNeuroHref };
