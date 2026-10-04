'use strict';

/**
 * Presentation intent (Build 12A) — what SAiM's state MEANS, ranked, and
 * nothing about how it is laid out.
 *
 * Build 10 gave the surfaces one canonical read (`/api/canonical/now`). Every
 * renderer then made its own composition out of it, and they all made the same
 * one: a hero card, a room card, a next-event card, weather, sleep, the laptop
 * and a big "What are you up to?" block — the same dashboard resized three
 * times. This module is the missing middle: the server decides WHAT matters and
 * IN WHAT ORDER; each renderer decides how much of it to show and how.
 *
 * ⚠ IT CONTAINS NO LAYOUT. No pixel, no column, no "card" — a renderer that
 *   needs one of those decides it from its own capability profile
 *   (`saim/shared-ui/presentation/budget.mjs`). What a renderer must NOT do is
 *   rank: `priority` and the order of every list are this file's, and a surface
 *   that re-sorts them is a second opinion about a decision already taken (the
 *   reason `saim/backend`'s inference engine was retired).
 *
 * ⚠ IT ADDS NO JUDGEMENT ABOUT THE WORLD. Everything here is read off the
 *   canonical payload: the attention decision, life-state, the agenda, the
 *   situation sections. It re-PHRASES (bounded templates, never free text) and
 *   it CLASSIFIES into P0–P4. It never invents a candidate, never re-derives
 *   duty or activity, never decides whether something is work.
 *
 * ⚠ PURE. Payload + clock in, presentation out. No DB, no network, no host
 *   timezone: the local day is read in Europe/London through Intl, because the
 *   Pi may run UTC and "Quiet Saturday" on a Sunday morning is the bug the chat
 *   prompt already had once.
 *
 * Priority classes are SEMANTIC, never keyed on domain:
 *   P0 — requires Nick (an approval waiting, a critical item)
 *   P1 — the situation itself, and the one current thing
 *   P2 — near-future relevance (next event, a deadline, a transition, a
 *        question SAiM is asking, a context fact that has become consequential)
 *   P3 — supporting context (place, room, weather, sleep, what he is doing)
 *   P4 — diagnostics (what could not be read, the laptop, held-back counts)
 */

const CONTRACT = 'presentation-v1';
const TZ = process.env.NEURO_TIMEZONE || 'Europe/London';

const MODES = ['degraded', 'in-meeting', 'needs-attention', 'upcoming', 'focus', 'bedtime',
  'travelling', 'working', 'off-duty', 'calm'];

// How soon a timed event has to be before it is the situation rather than the
// next thing. Thirty minutes is the countdown window the Surface already uses
// (`saim-surface.COUNTDOWN_MINUTES`), borrowed rather than re-picked.
const UPCOMING_MINUTES = 30;
// A room outside this band is worth saying out loud; inside it, it is an
// annotation. Not a comfort judgement — 19°C is Nick's comfort number
// (`room-offers`) and lives there. This is "unusual enough to read twice".
const ROOM_PROMOTE_BELOW = 15;
const ROOM_PROMOTE_ABOVE = 27;
// Rain inside this window is consequential (it changes whether he goes out);
// beyond it, it is an annotation on the forecast.
const RAIN_PROMOTE_MINUTES = 180;
const MAX_NEXT = 6;

const TRAVEL = { driving: 'On the road', walking: 'Out walking', exercising: 'Exercising', out: 'Out and about' };
const BEDTIME = new Set(['winding-down', 'sleeping']);

// ── clock (pure, timezone-explicit) ─────────────────────────────────────────

function localParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    key: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

function dayPart(minute) {
  if (minute < 5 * 60) return 'night';
  if (minute < 12 * 60) return 'morning';
  if (minute < 17 * 60) return 'afternoon';
  if (minute < 22 * 60) return 'evening';
  return 'night';
}

function keyDiff(fromKey, toKey) {
  const a = Date.UTC(+fromKey.slice(0, 4), +fromKey.slice(5, 7) - 1, +fromKey.slice(8, 10));
  const b = Date.UTC(+toKey.slice(0, 4), +toKey.slice(5, 7) - 1, +toKey.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Times are SLICED out of the wall-clock string, never parsed into a Date: the
// backend asked Graph for Europe/London already, and re-parsing re-applies an
// offset (the BST bug, which this codebase has paid for three times).
function hhmmOf(s) {
  const m = typeof s === 'string' && s.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}
function minuteOf(s) {
  const t = hhmmOf(s);
  return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null;
}
function dayKeyOf(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
function weekdayOfKey(key) {
  return WEEKDAYS[new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10))).getUTCDay()];
}

/** "in 20 min" / "14:00" / "Tomorrow 09:00" / "Friday" / "9 Oct". PURE. */
function whenLabel(ev, clock) {
  const key = dayKeyOf(ev.start);
  if (!key) return null;
  const diff = keyDiff(clock.key, key);
  const time = ev.allDay ? null : hhmmOf(ev.start);
  if (ev.running) return ev.end && hhmmOf(ev.end) && !ev.allDay ? `Now · until ${hhmmOf(ev.end)}` : 'Now';
  let day;
  if (diff === 0) day = 'Today';
  else if (diff === 1) day = 'Tomorrow';
  else if (diff > 1 && diff < 7) day = weekdayOfKey(key);
  else day = `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;
  if (!time) return day;
  if (diff === 0) {
    const mins = minutesUntil(ev, clock);
    if (mins != null && mins >= 0 && mins <= 60) return mins <= 1 ? 'Starting now' : `in ${mins} min`;
    return time;
  }
  return `${diff > 1 && diff < 7 ? day.slice(0, 3) : day} ${time}`;
}

function minutesUntil(ev, clock) {
  if (Number.isFinite(ev.minutesAway)) return ev.minutesAway;
  const key = dayKeyOf(ev.start);
  if (!key || ev.allDay || keyDiff(clock.key, key) !== 0) return null;
  const m = minuteOf(ev.start);
  return m == null ? null : m - clock.minute;
}

// ── duplicate events (12N) ──────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'with', 's']);

/** Content tokens of a title: apostrophes folded, possessives, ordinals and bare numbers dropped. PURE. */
function titleTokens(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w));
}

/**
 * Are two diary entries the SAME semantic event? PURE.
 *
 * The live case (4 Oct 2026): Outlook's contact birthday "Tracey Allen's
 * birthday" and the phone calendar's "Tracey Allen’s 16th Birthday", both
 * all-day on the same Friday — one event, said twice, from two sources.
 *
 * ⚠ It must not hide genuinely distinct events that share words, so ALL of
 *   these hold: same day; same start minute (or both all-day); and one title's
 *   content tokens contain the other's, with at least two tokens in the smaller
 *   set. "Standup" at 09:00 and "Standup" at 16:00 stay two events; "1-2-1
 *   Hope" and "1-2-1 Zoe" at one time stay two events.
 */
function sameEvent(a, b) {
  if (!a || !b) return false;
  if (dayKeyOf(a.start) == null || dayKeyOf(a.start) !== dayKeyOf(b.start)) return false;
  if (!!a.allDay !== !!b.allDay) return false;
  if (!a.allDay && minuteOf(a.start) !== minuteOf(b.start)) return false;
  const ta = new Set(titleTokens(a.title));
  const tb = new Set(titleTokens(b.title));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size === 0) return false;
  if (small.size < 2 && small.size !== big.size) return false;
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

/** Fold duplicates, keeping the richer (longer) title and recording what folded. PURE. */
function dedupeEvents(events) {
  const out = [];
  for (const ev of events) {
    const hit = out.find((o) => sameEvent(o, ev));
    if (!hit) { out.push({ ...ev, mergedFrom: [] }); continue; }
    if (String(ev.title || '').length > String(hit.title || '').length) {
      hit.mergedFrom.push(hit.title);
      hit.title = ev.title;
      hit.id = hit.id || ev.id;
    } else {
      hit.mergedFrom.push(ev.title);
    }
  }
  return out;
}

// ── items ───────────────────────────────────────────────────────────────────

function eventsFrom(p) {
  const agenda = p.agenda && p.agenda.known !== false ? (p.agenda.events || []) : [];
  const evs = agenda.map((e, i) => ({
    id: e.id || `agenda:${dayKeyOf(e.start) || 'x'}:${minuteOf(e.start) ?? 'allday'}:${i}`,
    title: e.subject || e.title || 'Untitled',
    start: e.start, end: e.end || null, allDay: !!e.allDay, running: !!e.running,
    minutesAway: Number.isFinite(e.minutesAway) ? e.minutesAway : null,
    withPeople: e.attendeesOther === true,
    source: 'agenda',
  }));
  const ne = p.situation && p.situation.sections && p.situation.sections.nextEvent;
  if (ne && ne.start) {
    evs.push({
      id: ne.id || `world:${ne.start}`, title: ne.title || 'Untitled', start: ne.start, end: ne.end || null,
      allDay: ne.entryKind === 'all-day' || /T00:00(:00)?$/.test(ne.start) && /T23:59/.test(ne.end || ''),
      running: false, minutesAway: null, withPeople: Array.isArray(ne.withPeople) && ne.withPeople.length > 0,
      importance: ne.importance || null, source: 'world-model',
    });
  }
  return evs;
}

function eventItem(ev, clock) {
  return {
    id: ev.id,
    kind: 'event',
    priority: 'P2',
    title: ev.title,
    when: whenLabel(ev, clock),
    start: ev.start,
    allDay: ev.allDay,
    minutesAway: minutesUntil(ev, clock),
    withPeople: ev.withPeople || false,
    importance: ev.importance || null,
    mergedFrom: ev.mergedFrom && ev.mergedFrom.length ? ev.mergedFrom : undefined,
  };
}

function attentionItem(card, priority) {
  return {
    id: card.recordId || card.id,
    kind: 'attention',
    priority,
    title: card.title,
    summary: card.say || card.reason || null,
    urgency: card.urgency || null,
    actionRef: { recordId: card.recordId || null, cardId: card.id || null, tab: card.tab || null, actions: card.actions || [] },
  };
}

function primaryPriority(card, p) {
  const u = String(card.urgency || '').toLowerCase();
  if (u === 'critical') return 'P0';
  if (u === 'high' && p.context && p.context.activity === 'firefighting') return 'P0';
  return 'P1';
}

function temp(c) { return Number.isFinite(c) ? `${Math.round(c)}°` : null; }

function hoursPhrase(h) {
  if (!Number.isFinite(h)) return null;
  const hh = Math.floor(h); const mm = Math.round((h - hh) * 60);
  return mm === 60 ? `${hh + 1}h00` : `${hh}h${String(mm).padStart(2, '0')}`;
}

function roomReading(p) {
  const r = p.rooms;
  if (!r || r.known === false || !Array.isArray(r.considered) || !r.considered.length) return null;
  const c = r.considered[0];
  const t = c.temperature && c.temperature.known && c.temperature.reading ? c.temperature.reading.currentC : null;
  return { area: c.area || null, tempC: Number.isFinite(t) ? t : null };
}

// ── the composer ────────────────────────────────────────────────────────────

/**
 * Compose the presentation intent from a canonical Now payload. PURE.
 * @param {object} p   the /api/canonical/now payload (attention decision + situation)
 * @param {{now?: number}} opts
 */
function composePresentation(p, { now = Date.now() } = {}) {
  p = p || {};
  const clock = localParts(now);
  const ctx = p.context || {};
  const life = p.life || {};
  const gaps = Array.isArray(p.gaps) ? p.gaps : [];
  const sections = (p.situation && p.situation.sections) || {};
  const blind = p.poolAvailable === false || p.surface === 'blind' || ctx.activity === 'unknown';

  // ── Needs you (P0) ──
  const needsYou = [];
  const ap = p.approvals;
  if (ap && ap.known !== false && ((ap.needsApproval || 0) + (ap.needsReview || 0)) > 0) {
    const n = (ap.needsApproval || 0) + (ap.needsReview || 0);
    needsYou.push({
      id: 'approvals',
      kind: 'approval',
      priority: 'P0',
      title: ap.say || `${n} draft${n === 1 ? '' : 's'} waiting for your approval`,
      summary: ap.where ? `Review in ${ap.where}.` : null,
      // ⚠ A HAND-OFF, never a button. Approval needs the code and the desktop;
      //   no surface below this approves anything (Build 9).
      handOff: ap.where || null,
      count: n,
    });
  }

  let primary = null;
  if (p.primary && p.primary.kind === 'item') {
    primary = attentionItem(p.primary, primaryPriority(p.primary, p));
  }
  // Build 12.3: every P0 with the card behind it, for the notification policy.
  // Primary first (it is attention's top pick), then Needs you in order.
  const p0Entries = [];
  if (primary && primary.priority === 'P0') p0Entries.push({ item: primary, card: p.primary });
  for (const n of needsYou) p0Entries.push({ item: n, card: null });
  for (const s of p.secondary || []) {
    if (s && s.kind === 'item' && String(s.urgency || '').toLowerCase() === 'critical') {
      const it = attentionItem(s, 'P0');
      needsYou.push(it);
      p0Entries.push({ item: it, card: s });
    }
  }

  // ── Next (P2) ──
  const shown = new Set();
  const seen = (t) => String(t || '').trim().toLowerCase();
  if (primary) shown.add(seen(primary.title));
  const next = [];
  const tr = p.transition;
  const transitionIsPrimary = !!(p.covered && p.covered.transitionIsPrimary);
  if (tr && tr.prompt && !transitionIsPrimary) {
    next.push({ id: `transition:${tr.kind || 'x'}`, kind: 'transition', priority: 'P2', title: tr.prompt,
      summary: tr.question || null, actionRef: { transition: tr.kind || null } });
  }
  const events = dedupeEvents(eventsFrom(p));
  const running = events.find((e) => e.running) || null;
  const upcoming = events.filter((e) => !e.running && !shown.has(seen(e.title)));
  for (const e of upcoming) next.push(eventItem(e, clock));
  for (const c of sections.commitments || []) {
    if (shown.has(seen(c.description))) continue;
    next.push({ id: c.id, kind: 'commitment', priority: 'P2', title: c.description,
      when: c.due ? c.due.label : null, summary: c.counterpart ? `${c.direction === 'owed-to-me' ? 'From' : 'For'} ${c.counterpart}` : null,
      importance: c.importance || null });
  }
  for (const t of sections.tasks || []) {
    const title = t.description || t.title;
    if (shown.has(seen(title))) continue;
    next.push({ id: t.id, kind: 'task', priority: 'P2', title, when: t.due ? t.due.label : null, importance: t.importance || null });
  }
  const offers = ((p.rooms && p.rooms.offers) || []).map((o) => ({
    id: `offer:${o.key}`, kind: 'offer', priority: 'P2', title: o.say, actionRef: { offerKey: o.key },
  }));

  // ── Context (P3) and what became consequential (P2) ──
  const context = [];
  const observations = [];
  const place = life.place || {};
  if (place.kind === 'home') context.push({ id: 'place', kind: 'place', priority: 'P3', label: 'Home' });
  else if (place.kind === 'work') context.push({ id: 'place', kind: 'place', priority: 'P3', label: 'At work' });
  else if (place.kind === 'out') context.push({ id: 'place', kind: 'place', priority: 'P3', label: 'Out' });
  const room = roomReading(p);
  if (room && room.area) {
    context.push({ id: 'room', kind: 'room', priority: 'P3', label: room.area, value: temp(room.tempC) });
    if (room.tempC != null && (room.tempC < ROOM_PROMOTE_BELOW || room.tempC > ROOM_PROMOTE_ABOVE)) {
      observations.push({ id: 'room-temp', kind: 'room', priority: 'P2', promoted: true,
        title: `${room.area} is ${temp(room.tempC)}`,
        summary: room.tempC > ROOM_PROMOTE_ABOVE ? 'Warmer than usual.' : 'Colder than usual.' });
    }
  }
  const doing = life.declared ? life.declared.doing : life.doing;
  if (doing && doing !== 'unknown' && life.label) {
    context.push({ id: 'activity', kind: 'activity', priority: 'P3', label: life.label,
      basis: life.declared ? 'declared' : 'inferred', confidence: life.confidence || null });
  }
  if (life.household && life.household.othersHome && Array.isArray(life.household.who) && life.household.who.length) {
    const who = life.household.who;
    context.push({ id: 'household', kind: 'household', priority: 'P3',
      // A sentence, not a tag (Build 12.1F): "Helen and Isaac are home".
      label: `${who.length === 1 ? `${who[0]} is` : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]} are`} home` });
  }
  const w = p.weather;
  if (w && w.known !== false && Number.isFinite(w.tempC)) {
    context.push({ id: 'weather', kind: 'weather', priority: 'P3', label: `${temp(w.tempC)} outside`,
      detail: Array.isArray(w.outlook) && w.outlook.length ? w.outlook[0] : null });
    if (w.rain && Number.isFinite(w.rain.inMinutes) && w.rain.inMinutes <= RAIN_PROMOTE_MINUTES) {
      observations.push({ id: 'rain', kind: 'weather', priority: 'P2', promoted: true,
        title: w.rain.starts ? `Rain from ${w.rain.starts}` : 'Rain soon', summary: null });
    }
  }
  const ln = p.lastNight;
  if (ln && ln.known !== false && Number.isFinite(ln.asleepHours)) {
    const item = { id: 'sleep', kind: 'sleep', priority: 'P3', label: `Slept ${hoursPhrase(ln.asleepHours)}`, detail: ln.usualLine || null };
    if (ln.notable) observations.push({ ...item, priority: 'P2', promoted: true, title: item.label, summary: item.detail });
    else context.push(item);
  }
  for (const o of (p.ambient && p.ambient.observations) || []) {
    observations.push({ id: `ambient:${o.kind}`, kind: o.kind, priority: 'P3', promoted: false,
      title: o.text, summary: o.suggestion || o.detail || null, caveat: o.caveat || null });
  }

  // ── Diagnostics (P4) ──
  const details = [];
  if (gaps.length) {
    details.push({ id: 'gaps', kind: 'gaps', priority: 'P4',
      label: `Couldn’t read: ${gaps.map((g) => g.input).join(', ')}`, items: gaps.map((g) => ({ input: g.input, why: g.why || null })) });
  }
  const wk = p.work;
  if (wk && wk.deskKnown !== false && wk.atDesk && wk.host) {
    details.push({ id: 'laptop', kind: 'laptop', priority: 'P4', label: `${wk.host}${wk.app ? ` · ${wk.app}` : ''}` });
  } else if (wk && wk.deskKnown === false) {
    details.push({ id: 'laptop', kind: 'laptop', priority: 'P4', label: 'Laptop not visible' });
  }
  const later = sections.laterUnknown;
  if (later && later.count) details.push({ id: 'later-unknown', kind: 'held', priority: 'P4', label: later.say });
  const held = p.situation && p.situation.workHeld;
  if (held && held.count) details.push({ id: 'work-held', kind: 'held', priority: 'P4', label: held.say });
  if (Array.isArray(p.dropped) && p.dropped.length) {
    details.push({ id: 'dropped', kind: 'held', priority: 'P4', label: `${p.dropped.length} held back — ${p.dropped[0].why}` });
  }
  for (const b of sections.blindness || []) {
    details.push({ id: b.id || `source:${b.sourceId}`, kind: 'source', priority: 'P4', label: `${b.label || b.sourceId}: ${b.verdictLabel || b.verdict || 'not seeing'}` });
  }
  const tracked = (p.secondary || []).filter((s) => s && s.kind === 'item' && String(s.urgency || '').toLowerCase() !== 'critical')
    .map((s) => attentionItem(s, 'P3'));

  // ── Mode ──
  const lifeDoing = doing || 'unknown';
  const offDuty = ctx.duty && ctx.duty.onDuty === false;
  const primaryP0 = primary && primary.priority === 'P0';
  const soon = next.find((n) => n.kind === 'event' && Number.isFinite(n.minutesAway) && n.minutesAway >= 0 && n.minutesAway <= UPCOMING_MINUTES);
  const leading = next.find((n) => n.kind === 'transition') || null;
  let mode;
  if (blind) mode = 'degraded';
  else if (ctx.activity === 'in-meeting') mode = 'in-meeting';
  else if (needsYou.length || primaryP0) mode = 'needs-attention';
  else if (leading || soon || ctx.activity === 'pre-meeting') mode = 'upcoming';
  else if (ctx.activity === 'in-focus-session') mode = 'focus';
  else if (BEDTIME.has(lifeDoing)) mode = 'bedtime';
  else if (TRAVEL[lifeDoing] || place.kind === 'out') mode = 'travelling';
  else if (offDuty) mode = 'off-duty';
  else if (ctx.duty && ctx.duty.onDuty) mode = 'working';
  else mode = 'calm';

  // ── Situation (P1): bounded templates, no free text ──
  const partial = gaps.length > 0;
  const nothing = !primary && !needsYou.length;
  const clearLine = partial ? 'Nothing needs you that I can see.' : 'Nothing needs you right now.';
  const firstNext = next.find((n) => n.kind === 'event') || null;
  // A commitment or task due today/tomorrow is not "quiet", even with nothing
  // to do this minute — it is the one thing the day is for. Read off the
  // canonical due context (`days`), never re-dated here.
  const dueSoonSrc = [...(sections.commitments || []), ...(sections.tasks || [])]
    .find((c) => c && c.due && Number.isFinite(c.due.days) && c.due.days >= 0 && c.due.days <= 1) || null;
  const dueSoon = dueSoonSrc ? { title: dueSoonSrc.description || dueSoonSrc.title, day: dueSoonSrc.due.days === 0 ? 'today' : 'tomorrow' } : null;
  let headline; let summary; let tone = 'calm'; let attentionLevel = 'none'; let about = null;
  switch (mode) {
    case 'degraded':
      headline = 'I can’t see clearly';
      summary = p.poolAvailable === false
        ? 'I can’t read your work right now. This isn’t an all-clear.'
        : 'Too little is answering to read your day. This isn’t an all-clear.';
      tone = 'uncertain'; attentionLevel = 'elevated';
      break;
    case 'in-meeting': {
      const m = running || null;
      headline = 'In a meeting';
      summary = m ? `${m.title}${m.end && !m.allDay && hhmmOf(m.end) ? ` · until ${hhmmOf(m.end)}` : ''}` : (ctx.summary || null);
      tone = 'focused'; attentionLevel = 'low';
      break;
    }
    case 'needs-attention': {
      const n = needsYou.length + (primaryP0 ? 1 : 0);
      headline = n === 1 ? 'Something needs you' : `${n} things need you`;
      summary = (primaryP0 ? primary.title : needsYou[0].title) || null;
      about = primaryP0 ? primary.id : needsYou[0].id;
      tone = 'alert'; attentionLevel = 'high';
      break;
    }
    case 'upcoming':
      headline = 'Coming up';
      about = leading ? leading.id : soon ? soon.id : null;
      if (leading) summary = leading.title;
      else if (soon) summary = soon.minutesAway <= 1 ? `${soon.title} is starting.` : `${soon.title} starts in ${soon.minutesAway} minutes.`;
      else summary = ctx.summary || null;
      tone = 'focused'; attentionLevel = 'elevated';
      break;
    case 'focus':
      headline = 'Heads down';
      summary = ctx.summary || (primary ? primary.title : null);
      about = ctx.summary ? null : (primary ? primary.id : null);
      tone = 'focused'; attentionLevel = 'low';
      break;
    case 'bedtime':
      headline = lifeDoing === 'sleeping' ? 'Night' : 'Winding down';
      summary = nothing ? (firstNext && dayKeyOf(firstNext.start) !== clock.key ? `First up: ${firstNext.title}, ${firstNext.when}.` : 'Nothing needs you before morning.') : primary.title;
      about = nothing ? (firstNext && dayKeyOf(firstNext.start) !== clock.key ? firstNext.id : null) : primary.id;
      break;
    case 'travelling':
      headline = TRAVEL[lifeDoing] || 'Out and about';
      summary = nothing ? clearLine : primary.title;
      about = nothing ? null : primary.id;
      break;
    case 'off-duty': {
      // `working-days.nonWorkingReason` says 'weekend' or 'holiday'; a leave
      // day arrives as free text from the People HR feed ("annual leave").
      const reason = String((ctx.duty && ctx.duty.reason) || '').toLowerCase();
      const leave = /leave/.test(reason);
      const dayWord = reason === 'holiday' ? 'bank holiday' : leave ? 'day off' : clock.weekday;
      if (nothing && dueSoon) {
        headline = leave ? 'Day off' : clock.weekday;
        summary = `${dueSoon.title} is due ${dueSoon.day}.`;
        attentionLevel = 'low';
        about = dueSoonSrc.id;
      } else {
        headline = nothing ? `Quiet ${dayWord}` : (leave ? 'Day off' : clock.weekday);
        summary = nothing ? clearLine : primary.title;
        attentionLevel = nothing ? 'none' : 'low';
        about = nothing ? null : primary.id;
      }
      break;
    }
    case 'working':
      headline = nothing ? `${clock.weekday} ${dayPart(clock.minute)}` : 'Working';
      summary = nothing
        ? (dueSoon ? `${dueSoon.title} is due ${dueSoon.day}.` : partial ? 'Nothing pressing that I can see.' : 'Nothing pressing right now.')
        : primary.title;
      attentionLevel = nothing && !dueSoon ? 'none' : 'low';
      about = nothing ? (dueSoon ? dueSoonSrc.id : null) : primary.id;
      break;
    default:
      headline = 'All quiet';
      summary = clearLine;
  }

  // ── What he is doing, and the way to say it is wrong (12F) ──
  const life_ = require('./life-state');
  const placeKind = place.kind && place.kind !== 'unknown' ? place.kind : 'home';
  const options = life_.optionsFor(placeKind).map((d) => ({ doing: d, label: life_.ANSWER_LABEL[d] || life_.LABEL[d] }));
  const inferredActivity = {
    doing: lifeDoing,
    label: lifeDoing !== 'unknown' ? (life.label || life_.LABEL[lifeDoing] || null) : null,
    confidence: life.confidence || 'unknown',
    basis: life.declared ? 'declared' : (lifeDoing === 'unknown' ? 'none' : 'inferred'),
    declaredUntil: life.declared ? life.declared.until : null,
  };
  // ⚠ A CORRECTION, never a panel. When SAiM is sure it is one quiet "Not
  //   quite?"; only when she genuinely cannot tell (life-state's own `ask`) does
  //   the prompt become a question — and even then it is the renderer's call
  //   how loud, which is why `asking` is separate from `options`.
  const correction = {
    asking: !!life.ask,
    prompt: life.ask ? (life.ask.question || 'What are you up to?') : (inferredActivity.basis === 'declared' ? 'Changed?' : 'Not quite?'),
    current: lifeDoing === 'unknown' ? null : lifeDoing,
    options: (life.ask && Array.isArray(life.ask.options) && life.ask.options.length) ? life.ask.options : options,
    declared: life.declared ? { doing: life.declared.doing, until: life.declared.until || null } : null,
  };

  const cannotSee = gaps.map((g) => g.input);
  const out = {
    contract: CONTRACT,
    generatedAt: new Date(now).toISOString(),
    mode,
    situation: {
      headline,
      summary,
      tone,
      attentionLevel,
      // The id of the item the summary is ABOUT, so a renderer that shows that
      // item as an object can drop the sentence rather than say it twice.
      about,
      honesty: { complete: !partial && !blind, cannotSee, say: partial && !blind ? `Couldn’t read: ${cannotSee.join(', ')}.` : null },
    },
    primary,
    needsYou,
    next: next.slice(0, MAX_NEXT),
    offers,
    context,
    observations,
    tracked,
    details,
    ambientState: {
      mode,
      confidence: ctx.confidence ? ctx.confidence.level || null : null,
      inferredActivity,
      location: { kind: place.kind || 'unknown', label: place.label || null, room: room ? room.area : null },
      onDuty: ctx.duty ? ctx.duty.onDuty : null,
      quiet: !!p.quiet,
    },
    correction,
    voicePrompt: { label: 'Ask SAiM', hint: mode === 'needs-attention' ? 'Ask about this' : mode === 'degraded' ? 'Ask what I can see' : 'Ask about your day' },
  };
  // ── Build 12.3: the P0 digest (what the watch counts and the phone may
  //    notify about) and the synthesis (what the calm screen draws). Both are
  //    additive: a renderer that ignores them draws exactly what it drew before.
  //    Each is fenced so a fault in one never costs the presentation.
  try {
    out.p0 = require('./notification-policy').p0Digest(p0Entries, {
      known: !blind,
      complete: !partial && !blind,
      newestApprovalAt: (ap && ap.newestAt) || null,
      asOf: out.generatedAt,
    });
  } catch (e) {
    out.p0 = { known: false, complete: false, count: 0, items: [], asOf: out.generatedAt, why: e.message };
  }
  try {
    out.synthesis = require('./situation-synthesis').synthesise(out, p);
  } catch (e) {
    out.synthesis = null;
  }
  return out;
}

module.exports = {
  CONTRACT, MODES, UPCOMING_MINUTES, ROOM_PROMOTE_BELOW, ROOM_PROMOTE_ABOVE, RAIN_PROMOTE_MINUTES,
  composePresentation, sameEvent, dedupeEvents, titleTokens, whenLabel, localParts, dayPart,
};
