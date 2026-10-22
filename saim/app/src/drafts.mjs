// Drafts (22 Oct 2026) — the client half. PURE apart from the `call` it is handed.
// The SERVER decides each item's status and its one action
// (GET /api/prepared-moves/drafts); this only reads it and finds the entry a
// link asked for. Nothing here prepares, saves, books or sends.

const BASE = '/api/prepared-moves';

/** Read Drafts. "Couldn't read" is never the same as "there are none". */
export async function loadDrafts(call) {
  let r;
  try { r = await call(`${BASE}/drafts`); } catch { return { ok: false, why: 'NEURO didn’t answer' }; }
  const b = (r && r.body) || {};
  if (!r || r.status !== 200 || b.ok !== true || !Array.isArray(b.items)) return { ok: false, why: b.error || (b.gaps || [])[0] || `NEURO answered ${r ? r.status : 'nothing'}` };
  return { ok: true, items: b.items, counts: b.counts || {}, gaps: b.gaps || [] };
}

/**
 * PURE. The entry a link asked for: by its record id, or by its move (an answer
 * makes a new version, so a link can name an older record of the same move).
 *   focus = { recordId?, moveKey?, open? } → { row, open } | null
 */
export function focusRow(items, focus) {
  if (!focus || !Array.isArray(items)) return null;
  const row = items.find((r) => focus.recordId && r.recordId === focus.recordId)
    || items.find((r) => focus.moveKey && r.moveKey === focus.moveKey);
  if (!row) return null;
  return { row, open: row.action ? row.action.open : null };
}

/** PURE. The tab bar's one line about Drafts ("2 need you"), or null when nothing waits on Nick. */
export function draftsLine(counts) {
  const c = counts || {};
  const needs = (c['needs-answer'] || 0) + (c['ready-to-save'] || 0) + (c['ready-to-confirm'] || 0) + (c['waiting-allowance'] || 0);
  return needs ? `${needs} waiting on you` : null;
}
