'use strict';

/**
 * "What NEURO did for you" — the weekly report (1 Nov 2026).
 *
 * Everything NEURO did ON ITS OWN in one London week, plus the misfires, so
 * Nick can trust it or rein it in. READ-ONLY, and NOT a new store: every line
 * is counted at read time from a record the feature already keeps:
 *
 *   prepared_actions + action_attempts   1-2-1s booked automatically (+ undone),
 *                                        governed sends on a standing switch
 *   agent_state one_to_one_auto_undone   which automatic bookings Nick undid
 *   external_write_ledger                Outlook archive moves, leave declines,
 *                                        router restarts, and every write whose
 *                                        outcome is failed / uncertain / stuck
 *   waiting_on + personal_ops_events     lapsed items, and Nick reopening them
 *   saim_actions                         Spotted suggestions that expired
 *   watched_ticket_replies / _commitments  ticket drafts, promises confirmed
 *                                        automatically (kept / missed / dismissed)
 *   focus_block_state / _passes, task_blocks, push_log (held)   focus blocks
 *   self_heal_attempts                   safe self-heal retries
 *   push_log                             notifications sent / held back, by type
 *
 * Why not activity-timeline's normalisers: the timeline is a capped (500)
 * stream folded per day for reading line by line; a week of Outlook archive
 * moves alone is 600 rows. This counts the same records instead of listing them.
 *
 * Three honesty rules:
 *   - a table that does not exist yet is "not used yet", never an error and
 *     never a zero (some of these features shipped the day this did);
 *   - a source that exists and cannot be read is a NAMED GAP, never zero;
 *   - "Misfires & things to check" comes first and is ranked, so the thing that
 *     most needs a look is the first line.
 */

const db = require('../db/database');

const ITEMS_MAX = 8;
const STUCK_MINUTES = 10;            // a write still "requested" after this never settled
const SPIKE_WEEKS = 4;               // suppression compared with the 4 weeks before
const SPIKE_MIN = 20;                // fewer than this held back is never a spike
const SPIKE_FACTOR = 3;              // …and it must be 3× the usual week (+1)
const WEEKS_OFFERED = 8;
const DAY_MS = 86400000;

// Ranked: what may have happened twice / not at all, before what Nick undid,
// before noise. Lower = first.
const MISFIRE_RANK = Object.freeze({
  'write-uncertain': 1,
  'write-failed': 2,
  'write-stuck': 3,
  'auto-121-failed': 4,
  'auto-121-undone': 5,
  'promise-dismissed': 6,
  'lapsed-reopened': 7,
  'self-heal-failed': 8,
  'suppression-spike': 9,
});

// ── London week arithmetic (PURE) ────────────────────────────────────────────

function _londonParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
}

/** YYYY-MM-DD of an instant on London's wall clock. PURE. */
function londonDay(ms) {
  const p = _londonParts(ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** The UTC instant of 00:00 London on a YYYY-MM-DD (BST and GMT). PURE. */
function londonMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const p = _londonParts(guess);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess;
  return guess - offset;
}

function _addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function _dow(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

/** The Monday on or before a London day. PURE. */
function mondayOf(ymd) { return _addDays(ymd, -((_dow(ymd) + 6) % 7)); }

/** Is this a real YYYY-MM-DD Monday? PURE. */
function isMonday(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (_addDays(s, 0) !== s) return false; // 2026-02-31 rolls, so is refused
  return _dow(s) === 1;
}

/** The last COMPLETE week's Monday, as of `now`. PURE. */
function lastCompleteWeek(now = Date.now()) { return _addDays(mondayOf(londonDay(now)), -7); }

/** Window for the week starting `monday` (London). PURE. */
function weekWindow(monday) {
  const from = londonMidnight(monday);
  const to = londonMidnight(_addDays(monday, 7));
  return { monday, sunday: _addDays(monday, 6), fromMs: from, toMs: to, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
}

/** The week picker: this week (so far) + the 8 before it, newest first. PURE. */
function weekOptions(now = Date.now()) {
  const thisMonday = mondayOf(londonDay(now));
  const out = [{ monday: thisMonday, label: `This week (so far) — from ${_short(thisMonday)}`, partial: true }];
  for (let i = 1; i <= WEEKS_OFFERED; i += 1) {
    const m = _addDays(thisMonday, -7 * i);
    out.push({ monday: m, label: `${_short(m)} – ${_short(_addDays(m, 6))}`, partial: false });
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function _short(ymd) { const [, m, d] = ymd.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; }

/** "Tue 3 Nov 14:00" from a wall-clock or ISO string — SLICED, never re-zoned. */
function whenWords(s) {
  if (!s) return '';
  const str = String(s);
  const day = str.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const time = /T\d{2}:\d{2}/.test(str) && !/Z$|[+-]\d{2}:?\d{2}$/.test(str) ? ` ${str.slice(11, 16)}` : '';
  return `${DAYS[_dow(day)]} ${_short(day)}${time}`;
}

/** "Tue 3 Nov 14:00" for a true instant, on London's clock. PURE. */
function atWords(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const p = _londonParts(t);
  const day = londonDay(t);
  return `${DAYS[_dow(day)]} ${_short(day)} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

// ── Reading helpers ──────────────────────────────────────────────────────────

function _json(s, f) { try { return s ? JSON.parse(s) : f; } catch { return f; } }

function _tables(d) {
  return new Set(d.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
}
function _cols(d, table) {
  try { return new Set(d.all(`PRAGMA table_info(${table})`).map((r) => r.name)); } catch { return new Set(); }
}

// datetime() normalises both ISO ('…T…Z') and SQLite ('YYYY-MM-DD HH:MM:SS')
// stamps, which these tables mix, so one bound works for every column.
const IN_WEEK = (col) => `datetime(${col}) >= datetime(?) AND datetime(${col}) < datetime(?)`;

function _bound(items) {
  return { items: items.slice(0, ITEMS_MAX), more: Math.max(0, items.length - ITEMS_MAX) };
}

// ── Sources: each one area. `needs` are required tables; a missing one is
//    "not used yet". `read` may throw — that is a named gap. ─────────────────

const SOURCES = [
  {
    id: 'one-to-ones', label: '1-2-1s booked automatically', view: 'people', needs: ['prepared_actions'],
    read(ctx) {
      const { d, w, tables } = ctx;
      const rows = d.all(`SELECT action_id, status, draft_json, target_json, executed_at, updated_at FROM prepared_actions
        WHERE origin = '1to1-auto' AND action_type = 'create_calendar_event' AND ${IN_WEEK('COALESCE(executed_at, updated_at)')}
        ORDER BY COALESCE(executed_at, updated_at)`, [w.fromIso, w.toIso]);
      const items = []; const misfires = [];
      let booked = 0; let undone = 0;
      for (const r of rows) {
        const draft = _json(r.draft_json, {}); const target = _json(r.target_json, {});
        const who = target.person || 'someone';
        if (['executed', 'verified'].includes(r.status)) {
          booked += 1;
          let cancelled = false;
          if (tables.has('action_attempts')) {
            const att = d.get('SELECT draft_id FROM action_attempts WHERE action_id = ? AND draft_id IS NOT NULL ORDER BY attempt DESC LIMIT 1', [r.action_id]);
            if (att && att.draft_id) {
              cancelled = !!d.get(`SELECT 1 FROM prepared_actions WHERE action_type = 'cancel_calendar_event' AND commitment_id = ?
                AND status IN ('executed','verified','execution_uncertain') LIMIT 1`, [`calendar-event:${att.draft_id}`]);
            }
          }
          if (cancelled) undone += 1;
          items.push({ text: `${who} — ${whenWords(draft.start) || 'time not recorded'}${cancelled ? ' (since cancelled)' : ''}`, view: 'people' });
        } else if (['failed', 'execution_uncertain'].includes(r.status)) {
          misfires.push({ kind: 'auto-121-failed', at: r.executed_at || r.updated_at, view: 'actions',
            text: `The automatic 1-2-1 with ${who} ${r.status === 'failed' ? 'failed to book' : 'may or may not have booked'} — check your diary` });
        }
      }
      // Undo record: { [person]: { at, eventId, actionId, start } }. Unreadable = gap.
      const raw = d.getState('one_to_one_auto_undone');
      if (raw) {
        const all = JSON.parse(raw);
        for (const [person, u] of Object.entries(all || {})) {
          const t = Date.parse(u && u.at);
          if (Number.isFinite(t) && t >= w.fromMs && t < w.toMs) {
            misfires.push({ kind: 'auto-121-undone', at: u.at, view: 'people',
              text: `You undid the automatic 1-2-1 with ${person}${u.start ? ` (${whenWords(u.start)})` : ''} — NEURO won’t auto-book them for 45 days` });
          }
        }
      }
      return { acted: booked, stats: [`${booked} booked`, undone ? `${undone} since cancelled` : null], items, misfires };
    },
  },
  {
    id: 'outlook-archive', label: 'Outlook messages archived (muted senders)', view: 'inbox', needs: ['external_write_ledger'],
    read({ d, w }) {
      const rows = d.all(`SELECT target, COUNT(*) AS n FROM external_write_ledger WHERE writer = 'microsoft.mail.archive'
        AND status = 'confirmed' AND ${IN_WEEK('requested_at')} GROUP BY target ORDER BY n DESC, target`, [w.fromIso, w.toIso]);
      const total = rows.reduce((s, r) => s + r.n, 0);
      return { acted: total, stats: [`${total} moved to Archive`, rows.length ? `${rows.length} sender${rows.length === 1 ? '' : 's'}` : null],
        items: rows.map((r) => ({ text: `${r.n} from ${r.target}`, view: 'inbox' })), misfires: [] };
    },
  },
  {
    id: 'waiting-on', label: 'Waiting-on items set aside as lapsed', view: 'people', needs: ['waiting_on'],
    read({ d, w, tables }) {
      const rows = d.all(`SELECT key, person, text, resolved_at FROM waiting_on WHERE status = 'lapsed' AND ${IN_WEEK('resolved_at')} ORDER BY resolved_at`, [w.fromIso, w.toIso]);
      let lapsed = rows.length; const misfires = [];
      if (tables.has('personal_ops_events')) {
        const ev = d.all(`SELECT detail_json FROM personal_ops_events WHERE kind = 'waiting-on-lapsed' AND ${IN_WEEK('at')}`, [w.fromIso, w.toIso]);
        const logged = ev.reduce((s, r) => s + (Number(_json(r.detail_json, {}).count) || 0), 0);
        lapsed = Math.max(lapsed, logged); // a lapsed item since reopened is still counted
        const re = d.all(`SELECT subject_id, at, detail_json FROM personal_ops_events WHERE kind = 'waiting-on-reopened' AND ${IN_WEEK('at')} ORDER BY at`, [w.fromIso, w.toIso]);
        for (const r of re) {
          const det = _json(r.detail_json, {});
          misfires.push({ kind: 'lapsed-reopened', at: r.at, view: 'people',
            text: `You reopened “${det.text || r.subject_id}”${det.person ? ` (${det.person})` : ''} after NEURO set it aside as lapsed` });
        }
      }
      return { acted: lapsed, stats: [`${lapsed} lapsed`], items: rows.map((r) => ({ text: `${r.person}: ${r.text}`, view: 'people' })), misfires };
    },
  },
  {
    id: 'spotted', label: 'Spotted suggestions expired (unanswered 7 days)', view: 'todos', needs: ['saim_actions'],
    read({ d, w }) {
      const rows = d.all(`SELECT payload FROM saim_actions WHERE type = 'capture_todo' AND status = 'expired' AND ${IN_WEEK('resolved_at')} ORDER BY resolved_at`, [w.fromIso, w.toIso]);
      return { acted: rows.length, stats: [`${rows.length} expired`],
        items: rows.map((r) => { const p = _json(r.payload, {}); return { text: p.text || p.title || 'a suggestion', view: 'todos' }; }), misfires: [] };
    },
  },
  {
    id: 'tickets', label: 'Ticket reply drafts and update promises', view: 'escalations', needs: ['watched_ticket_replies'],
    read({ d, w, tables }) {
      const cols = _cols(d, 'watched_ticket_replies');
      const hasDrafts = cols.has('drafted_at') && cols.has('draft_state');
      const hasPromises = tables.has('watched_ticket_commitments') && _cols(d, 'watched_ticket_commitments').has('confirmed_by');
      // Both halves add their columns/table on first write; neither yet = not used yet.
      if (!hasDrafts && !hasPromises) return { notUsedYet: 'not used yet (no ticket drafts or automatic promises recorded)' };
      let prepared = 0; let used = 0; let unavailable = 0;
      const items = []; const misfires = [];
      if (hasDrafts) {
        const rows = d.all(`SELECT ticket_key, draft_state FROM watched_ticket_replies WHERE drafted_at IS NOT NULL AND ${IN_WEEK('drafted_at')} ORDER BY drafted_at`, [w.fromIso, w.toIso]);
        for (const r of rows) {
          if (r.draft_state === 'unavailable') { unavailable += 1; continue; }
          prepared += 1;
          if (r.draft_state === 'used') used += 1;
          items.push({ text: `Draft for ${r.ticket_key}${r.draft_state === 'used' ? ' — you used it' : ''}`, view: 'escalations' });
        }
      }
      let auto = 0; let kept = 0; let missed = 0;
      if (hasPromises) {
        const cs = d.all(`SELECT ticket_key, due_at, state, missed_at, closed_at FROM watched_ticket_commitments
          WHERE confirmed_by = 'auto' AND ${IN_WEEK('confirmed_at')} ORDER BY confirmed_at`, [w.fromIso, w.toIso]);
        for (const c of cs) {
          auto += 1;
          if (c.state === 'kept') kept += 1;
          if (c.missed_at) missed += 1;
          if (c.state === 'dismissed') {
            misfires.push({ kind: 'promise-dismissed', at: c.closed_at || c.due_at, view: 'escalations',
              text: `You dismissed a promise NEURO confirmed automatically on ${c.ticket_key} (due ${atWords(c.due_at)})` });
          }
          items.push({ text: `Promise on ${c.ticket_key} by ${atWords(c.due_at)} — ${c.state === 'kept' ? 'kept' : c.missed_at ? 'missed' : c.state}`, view: 'escalations' });
        }
      }
      return { acted: prepared + auto,
        stats: [`${prepared} draft${prepared === 1 ? '' : 's'} prepared`, used ? `${used} used` : null, unavailable ? `${unavailable} could not be drafted` : null,
          `${auto} promise${auto === 1 ? '' : 's'} confirmed automatically`, auto ? `${kept} kept · ${missed} missed` : null],
        items, misfires };
    },
  },
  {
    id: 'focus-blocks', label: 'Focus blocks', view: 'today', needs: ['focus_block_state'],
    read({ d, w, tables }) {
      const q = (sql) => d.get(sql, [w.fromIso, w.toIso]).n;
      const booked = q(`SELECT COUNT(*) AS n FROM focus_block_state WHERE kind = 'open' AND ${IN_WEEK('created_at')}`);
      const started = q(`SELECT COUNT(*) AS n FROM focus_block_state WHERE chosen_at IS NOT NULL AND ${IN_WEEK('chosen_at')}`);
      const finished = q(`SELECT COUNT(*) AS n FROM focus_block_state WHERE end_answer = 'done' AND ${IN_WEEK('updated_at')}`);
      const slid = q(`SELECT COUNT(*) AS n FROM focus_block_state WHERE slides > 0 AND ${IN_WEEK('updated_at')}`);
      const dropped = tables.has('task_blocks')
        ? q(`SELECT COUNT(*) AS n FROM focus_block_state s JOIN task_blocks b ON b.id = s.block_id WHERE b.status IN ('dropped','released') AND ${IN_WEEK('b.updated_at')}`)
        : null;
      const passes = tables.has('focus_block_passes')
        ? d.all(`SELECT reason, COUNT(*) AS n FROM focus_block_passes WHERE ${IN_WEEK('at')} GROUP BY reason ORDER BY n DESC`, [w.fromIso, w.toIso])
        : [];
      const held = tables.has('push_log')
        ? q(`SELECT COUNT(*) AS n FROM push_log WHERE outcome = 'held' AND ${IN_WEEK('created_at')}`)
        : null;
      return { acted: booked,
        stats: [`${booked} booked`, `${started} started`, `${finished} finished`, `${slid} slid`, dropped == null ? null : `${dropped} dropped`,
          held == null ? null : `${held} notification${held === 1 ? '' : 's'} held during a block`],
        items: passes.map((p) => ({ text: `“${p.reason}” ${p.n}×`, view: 'today' })), misfires: [] };
    },
  },
  {
    id: 'leave-declines', label: 'Meetings declined for your leave', view: 'calendar', needs: ['external_write_ledger'],
    read({ d, w }) {
      const rows = d.all(`SELECT target, requested_at FROM external_write_ledger WHERE writer = 'microsoft.calendar.leave-decline'
        AND status IN ('confirmed','applied-unverified') AND ${IN_WEEK('requested_at')} ORDER BY requested_at`, [w.fromIso, w.toIso]);
      return { acted: rows.length, stats: [`${rows.length} declined`],
        items: rows.map((r) => ({ text: `${r.target} (declined ${atWords(r.requested_at)})`, view: 'calendar' })), misfires: [] };
    },
  },
  {
    id: 'router', label: 'Router restarts', view: 'pi-health', needs: ['external_write_ledger'],
    read({ d, w, tables }) {
      const rows = d.all(`SELECT status, requested_at, initiated_by FROM external_write_ledger WHERE writer = 'router.restart' AND ${IN_WEEK('requested_at')} ORDER BY requested_at`, [w.fromIso, w.toIso]);
      const verified = tables.has('personal_ops_events')
        ? d.get(`SELECT COUNT(*) AS n FROM personal_ops_events WHERE kind = 'router-restart-verified' AND ${IN_WEEK('at')}`, [w.fromIso, w.toIso]).n
        : null;
      const issued = rows.filter((r) => ['confirmed', 'applied-unverified'].includes(r.status)).length;
      return { acted: issued, stats: [`${issued} restart${issued === 1 ? '' : 's'}`, verified == null ? null : `${verified} came back verified`],
        items: rows.map((r) => ({ text: `${atWords(r.requested_at)} — ${r.initiated_by === 'neuro' ? 'on its own' : `asked by ${r.initiated_by}`} (${r.status})`, view: 'pi-health' })),
        misfires: [] };
    },
  },
  {
    id: 'self-heal', label: 'Self-heal retries', view: 'activity', needs: ['self_heal_attempts'],
    read({ d, w }) {
      const rows = d.all(`SELECT source_id, status, requested_at FROM self_heal_attempts WHERE ${IN_WEEK('requested_at')} ORDER BY requested_at`, [w.fromIso, w.toIso]);
      const misfires = rows.filter((r) => ['failed', 'uncertain'].includes(r.status)).map((r) => ({
        kind: 'self-heal-failed', at: r.requested_at, view: 'activity',
        text: `A self-heal retry for ${r.source_id} ${r.status === 'failed' ? 'did not recover it' : 'could not be verified'}` }));
      const recovered = rows.filter((r) => r.status === 'recovered').length;
      return { acted: rows.length, stats: [`${rows.length} tried`, `${recovered} recovered`],
        items: rows.map((r) => ({ text: `${r.source_id} — ${r.status}`, view: 'activity' })), misfires };
    },
  },
  {
    id: 'standing-switch', label: 'Sent on a standing switch (no press)', view: 'actions', needs: ['prepared_actions'],
    read({ d, w }) {
      if (!_cols(d, 'prepared_actions').has('authority_proof')) return { acted: 0, stats: ['0 sent'], items: [], misfires: [] };
      // The 1-2-1 switch is its own area above; this is every OTHER standing switch.
      const rows = d.all(`SELECT action_type, origin, executed_at FROM prepared_actions WHERE authority_proof = 'standing_switch'
        AND COALESCE(origin, '') <> '1to1-auto' AND status IN ('executed','verified') AND ${IN_WEEK('executed_at')} ORDER BY executed_at`, [w.fromIso, w.toIso]);
      return { acted: rows.length, stats: [`${rows.length} sent`],
        items: rows.map((r) => ({ text: `${r.action_type} (${r.origin || 'no origin'}) — ${atWords(r.executed_at)}`, view: 'actions' })), misfires: [] };
    },
  },
  {
    // Informational: every direct write by writer. NOT counted in "acted" (the
    // archive / decline / restart areas above already count theirs) — its job
    // is the misfires: anything whose outcome is failed, uncertain or stuck.
    id: 'external-writes', label: 'Direct writes to other systems', view: 'activity', needs: ['external_write_ledger'], informational: true,
    read({ d, w, nowMs }) {
      const rows = d.all(`SELECT writer, status, COUNT(*) AS n FROM external_write_ledger WHERE ${IN_WEEK('requested_at')} GROUP BY writer, status ORDER BY writer`, [w.fromIso, w.toIso]);
      const by = new Map();
      for (const r of rows) { const o = by.get(r.writer) || {}; o[r.status] = r.n; by.set(r.writer, o); }
      const stuckBefore = new Date(nowMs - STUCK_MINUTES * 60000).toISOString();
      const bad = d.all(`SELECT writer, target, status, requested_at FROM external_write_ledger WHERE ${IN_WEEK('requested_at')}
        AND (status IN ('uncertain','failed') OR (status = 'requested' AND datetime(requested_at) < datetime(?))) ORDER BY requested_at DESC`,
      [w.fromIso, w.toIso, stuckBefore]);
      const misfires = bad.map((r) => ({
        kind: r.status === 'uncertain' ? 'write-uncertain' : r.status === 'failed' ? 'write-failed' : 'write-stuck',
        at: r.requested_at, view: 'activity',
        text: r.status === 'uncertain' ? `${r.writer} on ${r.target}: NEURO does not know if it happened`
          : r.status === 'failed' ? `${r.writer} on ${r.target} failed`
            : `${r.writer} on ${r.target} was asked for and never settled`,
      }));
      return { acted: 0, stats: [`${rows.reduce((s, r) => s + r.n, 0)} writes`],
        items: [...by.entries()].map(([writer, o]) => ({ text: `${writer}: ${Object.entries(o).map(([s, n]) => `${n} ${s}`).join(', ')}`, view: 'activity' })),
        misfires };
    },
  },
  {
    id: 'pushes', label: 'Notifications, by type', view: 'pi-health', needs: ['push_log'], informational: true,
    read({ d, w }) {
      const rows = d.all(`SELECT COALESCE(type, 'untyped') AS type, outcome, COUNT(*) AS n FROM push_log WHERE ${IN_WEEK('created_at')} GROUP BY 1, 2`, [w.fromIso, w.toIso]);
      const by = new Map();
      for (const r of rows) { const o = by.get(r.type) || { sent: 0, suppressed: 0, held: 0, other: 0 }; (r.outcome in o ? o[r.outcome] += r.n : o.other += r.n); by.set(r.type, o); }
      // Suppression baseline: the 4 weeks before, per type.
      const prevFrom = new Date(w.fromMs - SPIKE_WEEKS * 7 * DAY_MS).toISOString();
      const base = new Map(d.all(`SELECT COALESCE(type, 'untyped') AS type, COUNT(*) AS n FROM push_log WHERE outcome = 'suppressed' AND ${IN_WEEK('created_at')} GROUP BY 1`, [prevFrom, w.fromIso])
        .map((r) => [r.type, r.n / SPIKE_WEEKS]));
      const misfires = [];
      for (const [type, o] of by) {
        const usual = base.get(type) || 0;
        if (isSpike(o.suppressed, usual)) {
          misfires.push({ kind: 'suppression-spike', at: w.toIso, view: 'pi-health',
            text: `${o.suppressed} “${type}” notifications held back (usual ~${Math.round(usual)} a week) — something is firing far more than it should` });
        }
      }
      const list = [...by.entries()].sort((a, b) => (b[1].sent + b[1].suppressed) - (a[1].sent + a[1].suppressed));
      const sent = list.reduce((s, [, o]) => s + o.sent, 0);
      const suppressed = list.reduce((s, [, o]) => s + o.suppressed, 0);
      return { acted: 0, sent, stats: [`${sent} sent`, `${suppressed} held back`],
        items: list.map(([type, o]) => ({ text: `${type}: ${o.sent} sent${o.suppressed ? ` · ${o.suppressed} held back` : ''}${o.held ? ` · ${o.held} held in a block` : ''}${o.other ? ` · ${o.other} other` : ''}`, view: 'pi-health' })),
        misfires };
    },
  },
];

/** A suppression count is a spike when it is big AND far above the usual week. PURE. */
function isSpike(count, usualPerWeek) {
  return count >= SPIKE_MIN && count >= SPIKE_FACTOR * ((usualPerWeek || 0) + 1);
}

/** Misfires ranked: kind first (MISFIRE_RANK), newest first within a kind. PURE. */
function rankMisfires(list) {
  return [...list].sort((a, b) => (MISFIRE_RANK[a.kind] || 99) - (MISFIRE_RANK[b.kind] || 99)
    || String(b.at || '').localeCompare(String(a.at || '')));
}

/** The one line for the push and the page. PURE. */
function headlineOf({ acted, toCheck, gaps = 0, partial = false }) {
  const when = partial ? 'this week so far' : 'last week';
  const act = acted === 0 ? `NEURO did nothing on its own ${when}` : `NEURO acted ${acted} time${acted === 1 ? '' : 's'} ${when}`;
  const chk = toCheck ? ` — ${toCheck} to check` : ' — nothing to check';
  return `${act}${chk}${gaps ? ` (${gaps} source${gaps === 1 ? '' : 's'} could not be read)` : ''}`;
}

/**
 * Compose the report for the week starting `week` (a London Monday; default the
 * last complete week). Never throws for a source; throws 400 for a bad week.
 */
function compose({ week = null, now = Date.now(), d = db } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (week != null && !isMonday(week)) { const e = new Error('week must be a Monday, YYYY-MM-DD'); e.status = 400; throw e; }
  const monday = week || lastCompleteWeek(nowMs);
  const w = weekWindow(monday);
  const partial = w.toMs > nowMs;

  let tables;
  try { tables = _tables(d); } catch (e) {
    return { ok: true, known: false, week: _weekOut(w, partial), headline: 'Could not read NEURO’s records.', gaps: [{ area: 'all', label: 'NEURO’s database', why: e.message }],
      misfires: [], areas: [], notUsedYet: [], acted: 0, toCheck: 0, options: weekOptions(nowMs) };
  }
  const ctx = { d, w, tables, nowMs };
  const areas = []; const gaps = []; const notUsedYet = []; let misfires = [];
  for (const s of SOURCES) {
    const missing = s.needs.filter((t) => !tables.has(t));
    if (missing.length) { notUsedYet.push({ area: s.id, label: s.label, why: `not used yet (no ${missing.join(', ')} table)` }); continue; }
    try {
      const r = s.read(ctx);
      if (r && r.notUsedYet) { notUsedYet.push({ area: s.id, label: s.label, why: r.notUsedYet }); continue; }
      const b = _bound(r.items || []);
      areas.push({ id: s.id, label: s.label, view: s.view, informational: !!s.informational, acted: r.acted || 0,
        stats: (r.stats || []).filter(Boolean), items: b.items, more: b.more, sent: r.sent });
      misfires = misfires.concat(r.misfires || []);
    } catch (e) {
      gaps.push({ area: s.id, label: s.label, why: e.message });
    }
  }
  misfires = rankMisfires(misfires);
  const acted = areas.filter((a) => !a.informational).reduce((s, a) => s + a.acted, 0);
  const pushes = areas.find((a) => a.id === 'pushes');
  const mis = _bound(misfires);
  return {
    ok: true, known: true, contract: 'neuro-weekly-v1',
    week: _weekOut(w, partial),
    headline: headlineOf({ acted, toCheck: misfires.length, gaps: gaps.length, partial }),
    acted, toCheck: misfires.length, notificationsSent: pushes ? pushes.sent : null,
    misfires: mis.items, misfiresMore: mis.more,
    areas, gaps, notUsedYet,
    options: weekOptions(nowMs),
    generatedAt: new Date(nowMs).toISOString(),
  };
}

function _weekOut(w, partial) {
  return { monday: w.monday, sunday: w.sunday, from: w.fromIso, to: w.toIso, partial, label: `${_short(w.monday)} – ${_short(w.sunday)}` };
}

/** The briefing's push line. PURE over compose()'s result. */
function pushLine(r) {
  if (!r || r.known === false) return null;
  return r.headline;
}

module.exports = {
  compose, pushLine, headlineOf, rankMisfires, isSpike, weekOptions, weekWindow, lastCompleteWeek, mondayOf, isMonday,
  londonMidnight, londonDay, whenWords, atWords, MISFIRE_RANK, ITEMS_MAX, SOURCES,
};
