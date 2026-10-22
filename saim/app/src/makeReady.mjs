// "Make this ready" on Now (22 Oct 2026). PURE apart from the `call` it is handed.
//
// The SERVER decides which Now rows SAiM can genuinely take forward
// (GET /api/prepared-moves/eligible): each eligible item carries its exact
// production ref (what POST /api/prepared-moves/prepare takes) and the Now row
// ids it is drawn as. A row with no entry gets NO button — never a dead or
// generic one. Pressing it runs the same shared planner the scan uses; it
// stores a proposal and writes nothing else.

const BASE = '/api/prepared-moves';

/** PURE. rowId → eligible item, from the server's answer. */
export function eligibleIndex(payload) {
  const map = new Map();
  if (!payload || payload.ok !== true || !Array.isArray(payload.items)) return map;
  for (const it of payload.items) {
    if (!it || typeof it.ref !== 'string' || !Array.isArray(it.rowIds)) continue;
    for (const id of it.rowIds) if (typeof id === 'string' && !map.has(id)) map.set(id, it);
  }
  return map;
}

/** Read which rows can be made ready. A failed read offers nothing. */
export async function loadEligible(call) {
  try {
    const r = await call(`${BASE}/eligible`);
    return r && r.status === 200 ? eligibleIndex(r.body) : new Map();
  } catch { return new Map(); }
}

/** Nick pressed "Make this ready" on one row. */
export async function makeItReady(call, item) {
  let r;
  try { r = await call(`${BASE}/prepare`, { method: 'POST', body: { ref: item.ref } }); } catch {
    return { kind: 'note', message: 'I couldn’t reach NEURO. Nothing was changed.' };
  }
  const b = (r && r.body) || {};
  if (r && r.status === 200 && b.ok && b.move) return { kind: 'prepared', headline: (b.move.prepared && b.move.prepared.headline) || 'It’s ready to review.', plan: b.move.plan || null, recordId: b.move.recordId || null };
  if (r && r.status === 200 && b.ok) return { kind: 'note', message: b.say || 'It is already prepared — it’s in Drafts.' };
  // SAiM already has one move ready: say so, and point at it. Nothing was prepared or changed.
  if (b.outcome === 'already-active') return { kind: 'already', message: b.error || 'SAiM already has something ready for you. It’s in Drafts.' };
  return { kind: 'note', message: b.error || 'SAiM couldn’t take that forward. Nothing was changed.' };
}
