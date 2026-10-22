'use strict';

/**
 * Today's prepared-move history (22 Oct 2026) — compact and findable.
 *
 * One row per prepared move touched today (Europe/London), from records that
 * ALREADY exist — no new store:
 *   prepared   prepared_moves rows created today (the latest version per move)
 *   receipts   agent_state `saim_move_receipt:<moveKey>` — the executor's full receipt
 *
 * Each row's stage, from the receipt the EXECUTOR stamped (never a client flag):
 *   verified     live, complete, every read-back held
 *   confirmed    live and complete, but a read-back did not hold
 *   partly-done  live, not every step worked
 *   practice     run against the sandbox — nothing real changed
 *   prepared     prepared today, not confirmed (yet)
 *
 * ⚠ It claims only what the records say: an exact time only when a calendar step
 * carried one, a vault location only for a LIVE note that read back, and an
 * unreadable store is a NAMED gap — never "nothing happened today".
 * Joined by moveKey, never by title. Read-only.
 */

const CONTRACT = 'prepared-move-history-v1';
const STAGE_SAY = {
  verified: 'Done and read back',
  confirmed: 'Confirmed — a read-back did not hold',
  'partly-done': 'Partly done',
  practice: 'Practice run — nothing real changed',
  prepared: 'Prepared — waiting for you',
};

const _wall = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function london(ms) {
  const p = {}; for (const x of _wall.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** PURE. The stage a receipt earns. */
function stageOf(receipt) {
  if (!receipt) return 'prepared';
  if (receipt.practice === true || receipt.target === 'sandbox') return 'practice';
  if (!receipt.complete) return 'partly-done';
  return receipt.verified === true ? 'verified' : 'confirmed';
}

/**
 * PURE. rows: { moves: [{moveKey, title, createdAt}], receipts: [{moveKey, receipt}] }.
 * Only today's (London) entries; newest first.
 */
function compose({ moves = [], receipts = [], now = Date.now(), gaps = [] } = {}) {
  const today = london(now).date;
  const byKey = new Map();
  for (const m of moves) {
    const t = Date.parse(m.createdAt);
    if (!Number.isFinite(t) || london(t).date !== today) continue;
    const cur = byKey.get(m.moveKey);
    if (!cur || Date.parse(cur.preparedAt) < t) byKey.set(m.moveKey, { moveKey: m.moveKey, title: m.title || null, preparedAt: new Date(t).toISOString(), receipt: null });
  }
  for (const { moveKey, receipt } of receipts) {
    const t = Date.parse(receipt && receipt.at);
    if (!Number.isFinite(t) || london(t).date !== today) continue;
    const cur = byKey.get(moveKey) || { moveKey, title: receipt.title || null, preparedAt: null, receipt: null };
    cur.receipt = receipt;
    byKey.set(moveKey, cur);
  }
  const items = [...byKey.values()].map((r) => {
    const stage = stageOf(r.receipt);
    const rc = r.receipt || {};
    const at = rc.at || r.preparedAt;
    const cal = (rc.steps || []).find((s) => s.step === 'calendar');
    const note = (rc.steps || []).find((s) => s.step === 'note');
    const reply = (rc.steps || []).find((s) => s.step === 'reply');
    return {
      moveKey: r.moveKey,
      title: r.title || 'A prepared move',
      stage,
      stageSay: STAGE_SAY[stage],
      at,
      atSay: at ? london(Date.parse(at)).time : null,
      preparedAt: r.preparedAt,
      // Exact time only when the calendar step carried it; a practice block is labelled as such.
      when: cal && cal.when ? { say: cal.when.say, practice: stage === 'practice' } : null,
      // A vault location only for a LIVE note that read back.
      note: note && stage !== 'practice' && (note.status === 'done' || note.status === 'already-done') && note.path
        ? { path: note.path, findIt: note.findIt || null } : null,
      reply: reply ? { status: reply.status, sent: false } : null,
      target: rc.target || null,
    };
  }).sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
  const counts = { prepared: 0, verified: 0, confirmed: 0, 'partly-done': 0, practice: 0 };
  for (const i of items) counts[i.stage] += 1;
  return { contract: CONTRACT, day: today, known: !gaps.length, gaps, items, counts };
}

/** READ. Today's history from the records NEURO already keeps. Never writes. */
function today({ now = Date.now(), db = null } = {}) {
  const d = db || require('../db/database');
  const gaps = [];
  let moves = [];
  let receipts = [];
  try {
    const has = d.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='prepared_moves'`);
    if (has) {
      const since = new Date(now - 36 * 3600 * 1000).toISOString();
      moves = d.all(`SELECT move_key, packet_json, created_at FROM prepared_moves WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200`, [since])
        .map((r) => { let p = null; try { p = JSON.parse(r.packet_json); } catch { p = null; } return { moveKey: r.move_key, title: p ? (p.title || p.headline || null) : null, createdAt: r.created_at }; });
    }
  } catch (e) { gaps.push({ source: 'prepared moves', why: e.message }); }
  try {
    receipts = d.all(`SELECT key, value FROM agent_state WHERE key LIKE 'saim_move_receipt:%'`)
      .map((r) => { let v = null; try { v = JSON.parse(r.value); } catch { v = null; } return v ? { moveKey: r.key.slice('saim_move_receipt:'.length), receipt: v } : null; })
      .filter(Boolean);
  } catch (e) { gaps.push({ source: 'receipts', why: e.message }); }
  // A receipt's title comes from its prepared move when the receipt has none.
  const titles = new Map(moves.map((m) => [m.moveKey, m.title]));
  for (const r of receipts) if (!r.receipt.title && titles.get(r.moveKey)) r.receipt = { ...r.receipt, title: titles.get(r.moveKey) };
  return compose({ moves, receipts, now, gaps });
}

module.exports = { CONTRACT, STAGE_SAY, stageOf, compose, today };
