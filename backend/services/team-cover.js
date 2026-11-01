'use strict';

/**
 * Team cover — warn when two or more people on one of Nick's queues are off on
 * the same days, so cover is thin, while there is still time to do something.
 *
 * ⚠ WHY THIS IS IN NEURO AND NOT VANTAGE. NEURO's CLAUDE.md says a new
 * departmental feature goes to VANTAGE "unless there is a reason written down".
 * This is that reason — Nick, 1 Nov 2026: "all in NEURO not VANTAGE". The
 * leave data already lives here (team-availability, NOVA's People HR sync),
 * the card sits beside the leave-guard card on Now and on the People board, and
 * VANTAGE would have had to read it back over the bridge. No VANTAGE finding is
 * made and nothing is written to VANTAGE.
 *
 * SOURCE: team-availability's CACHED snapshot only (refreshed every 30 min by
 * the scheduler). No new NOVA call path. ⚠ People HR's GetHolidayDetail gives
 * APPROVED leave only — NOVA exposes no pending leave anywhere (checked: the
 * bridge's /availability returns `annual_leave` / `other_leave` days, nothing
 * awaiting a manager). So a clash shows once the second booking is APPROVED,
 * never while it is still a request. Said on the card.
 *
 * TEAM = NOVA's `pool` on the roster row (support / customercare /
 * digitaldesign / tpj), READ, never typed. Only pools that hold at least one of
 * Nick's live direct reports (People notes, team-roster) are judged — TPJ is
 * the development team, not his. Nick himself counts only in the pool NOVA
 * places him in (his own lead group); everywhere else he is not a member.
 *
 * RULE (per pool, per working day in the next 8 weeks): flagged when at least
 * `MIN_OFF` (2) people are off OR at least `MIN_SHARE` (40%) of the pool is —
 * both numbers are always stated. Consecutive flagged WORKING days merge into
 * one clash (a weekend or bank holiday between them does not split it).
 *
 * HONESTY: an unread snapshot is `known:false`, never "no clashes". A direct
 * report missing from NOVA, a member with no People HR id (their leave never
 * syncs, so they always look present), a member with no pool, a stale cache and
 * a feed that stops before the window ends are all NAMED gaps.
 *
 * Nothing here writes anything but its own push memory
 * (`agent_state.team_cover_pushed`). It resolves itself: a clash is recomputed
 * from the snapshot every read, so when the overlap disappears so does the card.
 */

const wd = require('../../shared/working-days.cjs');

const WINDOW_DAYS = 56;          // the next 8 weeks
const MIN_OFF = 2;
const MIN_SHARE = 0.4;
const PUSH_WITHIN_DAYS = 14;
const PUSH_KEY = 'team_cover_pushed';

// Teams never judged, whatever the roster says. Nick, 1 Nov 2026: "ignore DD —
// they might not be my team for much longer". Remove the entry to judge them again.
const IGNORED_POOLS = Object.freeze(new Set(['digitaldesign']));

// A report on long leave, as their People note's `status:` says, is away for the
// whole window: not a gap, not a team member (Nick, 1 Nov 2026 — Adele is still
// on maternity leave, so her absence from NOVA's roster is expected).
const LONG_LEAVE = /\b(maternity|paternity|parental|adoption|shared parental|sabbatical|career break|long[- ]term (sick|leave))\b/i;

const POOL_LABELS = Object.freeze({
  support: 'Tier 2',
  customercare: 'Customer Care',
  digitaldesign: 'Digital Design',
  tpj: 'TPJ',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function poolLabel(pool) {
  return POOL_LABELS[pool] || (pool ? String(pool) : 'No queue');
}

/** `YYYY-MM-DD` → a local Date at midnight. Never `new Date('YYYY-MM-DD')`, which is UTC. */
function localDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dayLabel(s) {
  const d = localDate(s);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "12–13 Nov", "12 Nov", "30 Nov – 2 Dec". PURE. */
function rangeLabel(from, to) {
  const a = localDate(from);
  const b = localDate(to);
  if (from === to) return `${a.getDate()} ${MONTHS[a.getMonth()]}`;
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
    return `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]}`;
  }
  return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
}

function listNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Is this day flagged? PURE — the threshold rule, and the half worth pinning. */
function isThin(offCount, size) {
  if (!size || offCount < 1) return false;
  return offCount >= MIN_OFF || offCount / size >= MIN_SHARE;
}

/** The working days of the window, as `YYYY-MM-DD`, in order. PURE. */
function windowDays(now, holidays, days = WINDOW_DAYS) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = [];
  for (let i = 0; i <= days; i++) {
    const d = wd.addDays(start, i);
    if (wd.isWorkingDay(d, holidays)) out.push(wd.toDateStr(d));
  }
  return out;
}

/**
 * Merge flagged days into clashes. PURE. `flags` is [{date, ...}] for ONE pool;
 * `order` is the window's working days, so two flagged days are consecutive
 * when they are adjacent working days — a weekend between does not split.
 */
function mergeDays(flags, order) {
  const idx = new Map(order.map((d, i) => [d, i]));
  const sorted = flags.slice().sort((a, b) => idx.get(a.date) - idx.get(b.date));
  const runs = [];
  for (const f of sorted) {
    const last = runs[runs.length - 1];
    if (last && idx.get(f.date) === idx.get(last[last.length - 1].date) + 1) last.push(f);
    else runs.push([f]);
  }
  return runs;
}

/** First names, unless a first name is shared in the roster — then the full name. */
function displayNamer(roster) {
  const counts = new Map();
  for (const r of roster) {
    const first = String(r.name || '').split(/\s+/)[0].toLowerCase();
    counts.set(first, (counts.get(first) || 0) + 1);
  }
  return (name) => {
    const first = String(name || '').split(/\s+/)[0];
    return counts.get(first.toLowerCase()) === 1 ? first : name;
  };
}

/**
 * The whole judgement. PURE — snapshot, People-note reports, holidays and the
 * clock in; clashes and named gaps out.
 *
 *   snap       team-availability.snapshot()
 *   reports    team-roster.directReports() — [{name, group}]; [] = unreadable
 *   holidays   Set of bank-holiday dates
 *   isSelf     (rosterRow) => boolean
 */
function assess({ snap, reports = [], holidays = new Set(), now = new Date(), isSelf = () => false } = {}) {
  const out = {
    known: false,
    approvedOnly: true,
    rule: { minOff: MIN_OFF, minShare: MIN_SHARE, windowDays: WINDOW_DAYS },
    from: null, to: null,
    teams: [], clashes: [], gaps: [],
  };
  if (!snap || !snap.known) {
    out.reason = snap?.reason || 'no availability data';
    out.gaps.push(`Leave could not be read from NOVA (${out.reason}) — this is not "no clashes".`);
    return out;
  }
  const roster = snap.roster || [];
  if (!snap.rosterCount || !roster.length) {
    out.reason = 'roster empty';
    out.gaps.push('NOVA returned an empty roster — cover cannot be checked.');
    return out;
  }
  out.known = true;
  if (snap.stale) out.gaps.push(`Leave data is ${snap.ageHours}h old — NOVA has not answered since.`);

  const byName = new Map(roster.map(r => [String(r.name || '').trim().toLowerCase(), r]));
  const me = roster.find(r => isSelf(r)) || null;

  // Which pools are Nick's: any pool holding a live direct report.
  const scoped = new Set();
  if (!reports.length) {
    out.gaps.push('People notes could not be read, so NEURO cannot tell which queues are yours — every NOVA queue is checked.');
    for (const r of roster) if (r.pool && !(me && r.rosterId === me.rosterId)) scoped.add(r.pool);
  }
  out.away = [];
  for (const p of reports) {
    if (LONG_LEAVE.test(String(p.status || ''))) { out.away.push({ name: p.name, status: p.status }); continue; }
    const row = byName.get(String(p.name || '').trim().toLowerCase());
    if (!row) { out.gaps.push(`${p.name} is not in NOVA's roster — their leave cannot be counted.`); continue; }
    if (!row.pool) { out.gaps.push(`${p.name} has no queue in NOVA — not counted in any team.`); continue; }
    if (IGNORED_POOLS.has(row.pool)) continue;
    scoped.add(row.pool);
  }

  const days = windowDays(now, holidays);
  const end = days[days.length - 1] || null;
  let usable = days;
  if (snap.to && end && snap.to < end) {
    usable = days.filter(d => d <= snap.to);
    out.gaps.push(`NOVA's leave feed stops at ${snap.to}; days after that are not checked.`);
  }
  out.from = usable[0] || null;
  out.to = usable[usable.length - 1] || null;

  const nameOf = displayNamer(roster);
  const offOn = new Map(); // date → Set(rosterId)
  const reasonOf = new Map(); // `${rosterId}|${date}` → status
  for (const a of snap.absences || []) {
    if (!offOn.has(a.date)) offOn.set(a.date, new Set());
    offOn.get(a.date).add(Number(a.rosterId));
    reasonOf.set(`${Number(a.rosterId)}|${a.date}`, a.status || null);
  }

  const todayStr = wd.toDateStr(now);
  for (const pool of [...scoped].sort()) {
    // Nick counts only in the pool NOVA puts him in — his own lead group. The
    // pool filter alone enforces that (a roster row has one pool); he is never
    // added to a team he is not in.
    // Someone on long leave is not part of today's cover, roster or not.
    const awayNames = new Set(out.away.map(x => String(x.name).trim().toLowerCase()));
    const members = roster.filter(r => r.pool === pool && !awayNames.has(String(r.name || '').trim().toLowerCase()));
    const unsynced = members.filter(r => r.syncable === false).map(r => r.name);
    for (const n of unsynced) out.gaps.push(`${n} (${poolLabel(pool)}) has no People HR id — their leave never syncs, so ${poolLabel(pool)} may be thinner than shown.`);
    const team = {
      pool, label: poolLabel(pool), size: members.length,
      members: members.map(r => r.name),
      includesYou: Boolean(me && members.some(r => r.rosterId === me.rosterId)),
      incomplete: unsynced.length > 0,
    };
    out.teams.push(team);

    const flags = [];
    for (const date of usable) {
      const ids = offOn.get(date);
      if (!ids) continue;
      const off = members.filter(r => ids.has(Number(r.rosterId)));
      if (!isThin(off.length, members.length)) continue;
      flags.push({
        date,
        off: off.map(r => r.name),
        offCount: off.length,
        size: members.length,
        share: Math.round((off.length / members.length) * 100),
        remaining: members.length - off.length,
        statuses: off.map(r => reasonOf.get(`${Number(r.rosterId)}|${date}`)),
      });
    }

    for (const run of mergeDays(flags, usable)) {
      const from = run[0].date;
      const to = run[run.length - 1].date;
      const people = [...new Set(run.flatMap(f => f.off))];
      const maxOff = Math.max(...run.map(f => f.offCount));
      const minRemaining = Math.min(...run.map(f => f.remaining));
      const maxShare = Math.max(...run.map(f => f.share));
      const startsInDays = Math.round((localDate(from) - localDate(todayStr)) / 86400000);
      const thin = minRemaining <= 1 || maxShare >= 50;
      const soon = startsInDays <= PUSH_WITHIN_DAYS;
      const range = rangeLabel(from, to);
      const shortNames = people.map(nameOf);
      out.clashes.push({
        key: `${pool}:${from}`,
        pool, team: team.label, from, to, range,
        days: run.map(f => ({ ...f, label: dayLabel(f.date) })),
        people,
        maxOff, size: members.length, maxShare, minRemaining,
        includesYou: Boolean(me && people.includes(me.name)),
        startsInDays,
        severity: thin && soon ? 'high' : (thin || soon ? 'medium' : 'low'),
        title: `Cover is thin: ${team.label} — ${listNames(shortNames)} off ${range}`,
        say: run.map(f => `${f.offCount} of ${f.size} off (${f.share}%) on ${dayLabel(f.date)}`).join('; '),
        action: `Check cover for ${team.label} on ${range}`,
      });
    }
  }
  out.clashes.sort((a, b) => a.from.localeCompare(b.from) || a.team.localeCompare(b.team));
  return out;
}

// ── live read ────────────────────────────────────────────────────────────────

function read(now = new Date()) {
  const availability = require('./team-availability');
  let reports = [];
  try { reports = require('./team-roster').directReports(); } catch { reports = []; }
  let holidays = new Set();
  try { holidays = require('./working-days').holidaySet(); } catch { /* weekdays only */ }
  const matcher = availability.selfMatcher();
  return assess({
    snap: availability.snapshot(now),
    reports,
    holidays,
    now,
    isSelf: (r) => availability.isSelf(r, matcher),
  });
}

// ── once-per-clash push ──────────────────────────────────────────────────────

/**
 * Which clashes are NEW enough to push. PURE. A clash is pushed once, when it
 * is within `PUSH_WITHIN_DAYS` and shares no day with a clash already pushed
 * for the same pool (so a clash that grows by a day, or loses its first day,
 * is still the same clash). The first run is a BASELINE: what is already
 * there is remembered, never announced.
 */
function planPush(clashes, memory, todayStr) {
  const mem = memory && Array.isArray(memory.seen) ? memory : { baselined: false, seen: [] };
  const seen = mem.seen.filter(s => s && s.days && s.days.some(d => d >= todayStr));
  const near = clashes.filter(c => c.startsInDays <= PUSH_WITHIN_DAYS);
  const overlaps = (c) => seen.some(s => s.pool === c.pool && c.days.some(d => s.days.includes(d.date)));
  const fresh = mem.baselined ? near.filter(c => !overlaps(c)) : [];
  // A remembered clash ABSORBS the days of the clash it overlaps, so one that
  // grows and then loses its first day is still recognised as the same clash.
  const nextSeen = seen.map(s => ({ pool: s.pool, days: s.days.slice() }));
  for (const c of near) {
    const dates = c.days.map(d => d.date);
    const hit = nextSeen.find(s => s.pool === c.pool && dates.some(d => s.days.includes(d)));
    if (hit) hit.days = [...new Set(hit.days.concat(dates))].sort();
    else nextSeen.push({ pool: c.pool, days: dates });
  }
  return { push: fresh, memory: { baselined: true, seen: nextSeen } };
}

async function check({ now = new Date(), deps = {} } = {}) {
  const db = deps.db || require('../db/database');
  const result = read(now);
  if (!result.known) return { ok: false, reason: result.reason, pushed: 0 };
  let memory = null;
  try { memory = JSON.parse(db.getState(PUSH_KEY) || 'null'); } catch { memory = null; }
  const plan = planPush(result.clashes, memory, wd.toDateStr(now));
  // Remember BEFORE sending: a lost push beats one repeated every half hour.
  db.setState(PUSH_KEY, JSON.stringify(plan.memory));
  if (!deps.push) deps = { ...deps, push: (t, b, d) => require('./webpush').sendToAll(t, b, d) };
  let pushed = 0;
  for (const c of plan.push) {
    try {
      await deps.push(c.title, `${c.say}. ${c.action}.`.slice(0, 300), {
        type: 'team_cover', url: '/?view=people', key: `team_cover:${c.key}`,
      });
      pushed++;
    } catch (e) { console.warn('[TeamCover] push failed:', e.message); }
  }
  if (pushed) console.log(`[TeamCover] pushed ${pushed} new clash(es)`);
  return { ok: true, clashes: result.clashes.length, pushed, baselined: !(memory && memory.baselined) };
}

module.exports = {
  WINDOW_DAYS, MIN_OFF, MIN_SHARE, PUSH_WITHIN_DAYS, POOL_LABELS, IGNORED_POOLS,
  assess, read, check,
  // pure, pinned
  isThin, mergeDays, windowDays, rangeLabel, planPush,
};
