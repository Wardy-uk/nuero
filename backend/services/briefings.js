'use strict';

/**
 * Daily and weekly briefings — build, store, deliver, serve (12 Oct 2026).
 *
 * Daily at 08:00 every day; weekly at 08:00 on Mondays, ahead of the 09:00 tech
 * leadership meeting. Each goes three ways: a push, an email to Nick, and the
 * Briefings screen in NEURO.
 *
 * ⚠ THE EMAIL LEAVES THE BUILDING. It is sent through Nurtur's tenant (Graph
 * Mail, Nurtur's retention), so it carries WORK only: personal and health items
 * never go in it, and a day-off briefing — which by definition has no work in
 * it — sends no email at all and records why. The same rule briefing.js has
 * always kept (mayLeaveTheBuilding), applied by sphere rather than by task.
 * The push and the NEURO screen carry everything.
 *
 * ⚠ DELIVERY IS ONCE PER DAY. The row is written first; a scheduled run finding
 * today's briefing already delivered returns it untouched, so a retry or a
 * restart cannot push the same morning twice.
 */

const db = require('../db/database');
const select = require('./briefing-select');
const gather = require('./briefing-gather');
const weekly = require('./briefing-weekly');

const FEEDBACK_KEY = 'briefing_feedback';
const FEEDBACK_KEEP_DAYS = 60;

// ── Store ────────────────────────────────────────────────────────────────────

function _row(r) {
  if (!r) return null;
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return {
    id: r.id, kind: r.kind, date: r.date_key, dayType: r.day_type,
    payload: parse(r.payload), delivery: parse(r.delivery),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function get(kind, date) {
  return _row(db.get('SELECT * FROM briefings WHERE kind = ? AND date_key = ?', [kind, date]));
}

function getById(id) {
  return _row(db.get('SELECT * FROM briefings WHERE id = ?', [id]));
}

function list({ kind = null, limit = 30 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 30));
  const rows = kind
    ? db.all('SELECT * FROM briefings WHERE kind = ? ORDER BY date_key DESC LIMIT ?', [kind, n])
    : db.all('SELECT * FROM briefings ORDER BY date_key DESC, kind ASC LIMIT ?', [n]);
  return rows.map(_row);
}

function _save(kind, date, dayType, payload) {
  const at = new Date().toISOString();
  db.run(
    `INSERT INTO briefings (kind, date_key, day_type, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, date_key) DO UPDATE SET day_type = excluded.day_type, payload = excluded.payload, updated_at = excluded.updated_at`,
    [kind, date, dayType || null, JSON.stringify(payload), at, at],
  );
  return get(kind, date);
}

function _recordDelivery(kind, date, delivery) {
  db.run('UPDATE briefings SET delivery = ?, updated_at = ? WHERE kind = ? AND date_key = ?',
    [JSON.stringify(delivery), new Date().toISOString(), kind, date]);
}

// ── Feedback: "not useful" teaches the ranking, bounded ─────────────────────

function readFeedback() {
  try {
    const raw = db.getState(FEEDBACK_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function recordFeedback({ kind, undo = false, today = gather.todayLocal() }) {
  if (typeof kind !== 'string' || !/^[a-z0-9:_-]{1,60}$/i.test(kind)) {
    const e = new Error('kind is required'); e.status = 400; throw e;
  }
  const fb = readFeedback();
  const dates = Array.isArray(fb[kind]) ? fb[kind] : [];
  if (undo) dates.pop(); else dates.push(today);
  fb[kind] = dates.filter((d) => {
    const n = select.daysBetween(d, today);
    return n !== null && n >= 0 && n <= FEEDBACK_KEEP_DAYS;
  });
  if (!fb[kind].length) delete fb[kind];
  db.setState(FEEDBACK_KEY, JSON.stringify(fb));
  return { kind, count: (fb[kind] || []).length, penalty: select.penaltyFor(kind, fb, today) };
}

// ── Compose ──────────────────────────────────────────────────────────────────

function _dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

async function composeDaily({ now = new Date(), overrides = {} } = {}) {
  const g = await gather.gatherDaily({ now, overrides });
  const sel = select.select({
    candidates: g.candidates, dayType: g.dayType, today: g.today,
    feedback: readFeedback(), gaps: g.gaps,
  });
  const { title, body } = select.pushText(sel, { kind: 'daily', dayLabel: _dayLabel(g.today) });
  return {
    kind: 'daily',
    date: g.today,
    dayLabel: _dayLabel(g.today),
    dayType: g.dayType,
    dayReason: g.reason,
    context: g.context,
    sections: sel.sections,
    needsYouCount: sel.needsYouCount,
    held: sel.held,
    adjusted: sel.adjusted,
    gaps: sel.gaps,
    close: sel.close,
    push: { title, body, keys: sel.push },
    generatedAt: now.toISOString(),
  };
}

function _pct(v) { return v == null ? '—' : `${Math.round(v)}%`; }

/** The weekly's push: the four numbers worth glancing at. PURE. */
function weeklyPush(w) {
  const lines = [];
  const csat = (w.csatRows || []).find((r) => r.key === 'csat-score');
  if (csat) lines.push(`CSAT ${csat.now}${csat.delta && csat.delta !== '—' ? ` (${csat.delta})` : ''}`);
  // The Support team's pooled figure (CC + T2 + Prod) is the headline Nick
  // asked for. Falls back to the whole-desk rows — a compliance KPI with no
  // queue in brackets, matched by the ABSENCE of a queue, never by its name.
  const ss = w.supportSla;
  if (ss && (ss.frt?.now?.pct != null || ss.res?.now?.pct != null)) {
    lines.push(`Support SLA: FRT ${_pct(ss.frt?.now?.pct)} · Resolution ${_pct(ss.res?.now?.pct)}`);
  } else {
    const headline = (w.sla || []).filter((r) => r.measured && !/\([^)]+\)\s*$/.test(r.kpi));
    if (headline.length) lines.push(headline.map((r) => `${r.kpi.replace(/\s*compliance.*$/i, '')} ${_pct(r.now)}`).join(' · '));
  }
  const v = Object.fromEntries((w.volumes || []).map((r) => [r.name, r]));
  if (v.raised && v.closed && (v.raised.now != null || v.closed.now != null)) {
    lines.push(`${v.raised.now ?? '?'} raised · ${v.closed.now ?? '?'} closed`);
  }
  if (w.leaderboard?.top) lines.push(`Top: ${w.leaderboard.top.agentName}`);
  if (!lines.length) lines.push('Could not read the week’s KPIs — open the briefing for what is missing.');
  return { title: `Weekly briefing — week to ${_shortDate(w.weeks.report.to)}`, body: lines.join('\n') };
}

function _shortDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

async function composeWeekly({ now = new Date(), overrides = {} } = {}) {
  const w = await weekly.gatherWeekly({ now, overrides });
  const { title, body } = weeklyPush(w);
  const blind = w.gaps.map((g) => g.source);
  return {
    kind: 'weekly',
    date: w.today,
    dayLabel: _dayLabel(w.today),
    weeks: w.weeks,
    sla: w.sla,
    supportSla: w.supportSla || null,
    csatRows: w.csatRows,
    volumes: w.volumes,
    leaderboard: w.leaderboard,
    slm: w.slm,
    bp: w.bp,
    gaps: w.gaps,
    close: blind.length ? `I couldn’t read ${blind.join(', ')}, so this isn’t the whole picture.` : 'Everything above was read.',
    push: { title, body },
    generatedAt: now.toISOString(),
  };
}

// ── Email (work only) ────────────────────────────────────────────────────────

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Daily email HTML, WORK items only. Returns null when nothing work-related remains. PURE. */
function dailyEmailHtml(p) {
  const sections = (p.sections || [])
    .map((s) => ({ ...s, items: s.items.filter((i) => i.sphere === 'work') }))
    .filter((s) => s.items.length);
  if (!sections.length) return null;
  const body = sections.map((s) => `<h3 style="margin:18px 0 6px">${_esc(s.label)}</h3><ul style="padding-left:18px;margin:0">${
    s.items.map((i) => `<li style="margin:4px 0"><strong>${_esc(i.title)}</strong>${i.detail ? ` <span style="color:#777">— ${_esc(i.detail)}</span>` : ''}${
      i.items && i.items.length ? `<ul style="margin:2px 0;color:#444">${i.items.map((x) => `<li>${_esc(x)}</li>`).join('')}</ul>` : ''}</li>`).join('')
  }</ul>`).join('');
  const workGaps = (p.gaps || []).filter((g) => !/health|sleep|recovery|radar/i.test(g.source));
  const foot = workGaps.length ? `<p style="color:#a15c00">Couldn’t read: ${_esc(workGaps.map((g) => g.source).join(', '))}.</p>` : '';
  return _wrap(`Daily briefing — ${p.dayLabel}`, `${body}${foot}<p style="color:#888;font-size:12px">Work items only. Personal and health items are in NEURO, never in this mailbox.</p>`);
}

/** Weekly email HTML: KPIs and the SLM points. No health. PURE. */
function weeklyEmailHtml(p) {
  const parts = [];
  const csat = p.csatRows || [];
  const sla = p.sla || [];
  const team = supportRows(p.supportSla);
  if (sla.length || csat.length || team.length) {
    const teamRows = team.map((r) => `<tr><td><strong>${_esc(r.label)}</strong></td><td><strong>${_pct(r.now)}</strong>${r.nowDetail ? ` <span style="color:#777">(${_esc(r.nowDetail)})</span>` : ''}</td><td>${_pct(r.was)}</td><td>${r.delta == null ? '—' : (r.delta > 0 ? '+' : '') + r.delta}</td><td>95%</td></tr>`);
    const rows = teamRows.concat(sla.map((r) => `<tr><td>${_esc(r.kpi)}</td><td>${r.measured ? _pct(r.now) : `not measured${r.lastSeen ? ` (last ${_esc(r.lastSeen)})` : ''}`}</td><td>${_pct(r.was)}</td><td>${r.delta == null ? '—' : (r.delta > 0 ? '+' : '') + r.delta}</td><td>${r.target == null ? '—' : `${r.target}%`}</td></tr>`)
      .concat(csat.map((r) => `<tr><td>${_esc(r.label)}</td><td>${_esc(r.now)}</td><td>${_esc(r.was)}</td><td>${_esc(r.delta)}</td><td>—</td></tr>`)));
    parts.push(`<h3>CSAT and SLAs</h3><table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr style="text-align:left"><th>KPI</th><th>Week to ${_esc(_shortDate(p.weeks.report.to))}</th><th>Week before</th><th>Δ</th><th>Target</th></tr>${rows.join('')}</table>`);
  }
  if (p.volumes) {
    const rows = p.volumes.map((r) => `<tr><td>${_esc(volumeLabel(r.name))}</td><td>${r.now ?? '—'}${r.flow && r.nowDays && r.nowDays < 7 ? ` <span style="color:#a15c00">(${r.nowDays}/7 days)</span>` : ''}</td><td>${r.was ?? '—'}</td><td>${r.delta == null ? '—' : (r.delta > 0 ? '+' : '') + r.delta}</td></tr>`);
    parts.push(`<h3>Volumes and backlog</h3><table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr style="text-align:left"><th></th><th>Last week</th><th>Week before</th><th>Δ</th></tr>${rows.join('')}</table>`);
  }
  if (p.leaderboard) {
    const lb = p.leaderboard;
    // No "days worked": NOVA's `days` counts days the agent has a ROW on the
    // board (weekends included — every agent read 7), not days worked.
    const line = (a) => `${_esc(a.agentName)} — score ${Math.round(a.compositeScore)}, ${a.solved} solved, SLA ${_pct(a.slaCompliancePct)}`;
    parts.push(`<h3>Leaderboard</h3>${lb.top ? `<p>Top: ${line(lb.top)}</p>` : '<p>No one ranked.</p>'}${lb.weakest ? `<p>Weakest: ${line(lb.weakest)}</p>` : ''}`);
  }
  if (p.slm?.known) {
    const ul = (xs) => (xs.length ? `<ul>${xs.map((x) => `<li>${_esc(x)}</li>`).join('')}</ul>` : '<p style="color:#777">Nothing recorded.</p>');
    parts.push(`<h3>Friday Support Leadership Meeting</h3><p style="color:#777">From “${_esc(p.slm.note.name)}”</p><h4>Highlights</h4>${ul(p.slm.highlights)}<h4>Lowlights</h4>${ul(p.slm.lowlights)}<h4>Blockers &amp; escalations</h4>${ul(p.slm.blockers)}`);
  }
  const workGaps = (p.gaps || []).filter((g) => !/blood pressure/i.test(g.source));
  if (workGaps.length) parts.push(`<p style="color:#a15c00">Couldn’t read: ${_esc(workGaps.map((g) => `${g.source} (${g.why})`).join('; '))}.</p>`);
  return _wrap(`Weekly briefing — week to ${_shortDate(p.weeks.report.to)}`, parts.join(''));
}

/** The two Support-team rows, shaped once for the email and the screen. PURE. */
function supportRows(ss) {
  if (!ss) return [];
  return ['frt', 'res'].filter((m) => ss[m]).map((m) => {
    const r = ss[m];
    const total = r.now.met + r.now.breached;
    return {
      key: `support-${m}`,
      label: r.label,
      now: r.now.pct,
      was: r.was.pct,
      delta: r.delta,
      target: r.target,
      nowDetail: total ? `${r.now.met} of ${total} tickets${r.now.days < 7 ? `, ${r.now.days}/7 days captured` : ''}` : 'no tickets solved',
    };
  });
}

function volumeLabel(name) {
  return {
    raised: 'Tickets raised', closed: 'Tickets closed',
    backlogSupport: 'Backlog — Support', backlogDevelopment: 'Backlog — Development (Tier 3 + Dev)', backlogTotal: 'Backlog — total open',
  }[name] || name;
}

function _wrap(title, inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#222">
<h2 style="margin:0 0 4px">${_esc(title)}</h2>${inner}
<hr style="margin:24px 0;border:none;border-top:1px solid #eee"><p style="font-size:12px;color:#999">From NEURO · the full briefing is on the Briefings screen.</p></body></html>`;
}

// ── Deliver ──────────────────────────────────────────────────────────────────

async function _deliver(payload, { send = null } = {}) {
  const webpush = send?.push || require('./webpush');
  const emailSender = send?.email || require('./email-sender');
  const delivery = { at: new Date().toISOString(), push: null, email: null };

  // ⚠ sendToAll returns nothing and swallows its own failures, so "it did not
  // throw" is not "it arrived". The truth is the push_log row THIS send wrote
  // (the /api/push/test rule): read it back, and say "unknown" without one.
  try {
    const before = (db.getPushLog(1)[0] || {}).id || 0;
    await webpush.sendToAll(payload.push.title, payload.push.body, {
      type: 'brief', key: `briefing:${payload.kind}:${payload.date}`, url: `/?view=briefings&kind=${payload.kind}`,
    });
    const row = db.getPushLog(20).find((r) => r.id > before && r.type === 'brief');
    delivery.push = row
      ? { sent: row.outcome === 'sent' && row.sent_count > 0, outcome: row.outcome, reason: row.reason || null }
      : { sent: false, outcome: 'unknown', reason: 'NEURO recorded no outcome for the push' };
  } catch (e) {
    delivery.push = { sent: false, outcome: 'error', reason: e.message };
  }

  const html = payload.kind === 'weekly'
    ? weeklyEmailHtml(payload)
    : payload.dayType === 'off' ? null : dailyEmailHtml(payload);
  if (!html) {
    delivery.email = {
      sent: false,
      reason: payload.dayType === 'off'
        ? 'day off — nothing work-related, and personal items never go to the Nurtur mailbox'
        : 'nothing work-related to send',
    };
  } else {
    const subject = payload.kind === 'weekly' ? payload.push.title : `Daily briefing — ${payload.dayLabel}`;
    try {
      const r = await emailSender.sendBriefEmail(subject, html);
      delivery.email = r && r.sent ? { sent: true } : { sent: false, reason: r?.reason || 'not sent' };
    } catch (e) {
      delivery.email = { sent: false, reason: e.message };
    }
  }
  return delivery;
}

/**
 * Build (and, unless `deliver:false`, deliver) one briefing.
 *   force  — rebuild AND re-deliver even if today's already went out
 */
async function run(kind, { now = new Date(), deliver = true, force = false, overrides = {}, send = null } = {}) {
  if (kind !== 'daily' && kind !== 'weekly') { const e = new Error('kind must be daily or weekly'); e.status = 400; throw e; }
  const today = gather.todayLocal(now);
  const existing = get(kind, today);
  // Any recorded delivery ATTEMPT counts: a push the governor refused is not a
  // reason to try again on the next tick and interrupt twice.
  if (deliver && !force && existing?.delivery) {
    return { ...existing, skipped: 'already delivered today' };
  }
  const payload = kind === 'weekly'
    ? await composeWeekly({ now, overrides })
    : await composeDaily({ now, overrides });
  _save(kind, today, payload.dayType || null, payload);
  if (deliver) {
    const delivery = await _deliver(payload, { send });
    _recordDelivery(kind, today, delivery);
    console.log(`[Briefings] ${kind} ${today} — push ${delivery.push?.sent ? 'sent' : `not sent (${delivery.push?.reason})`}, email ${delivery.email?.sent ? 'sent' : `not sent (${delivery.email?.reason})`}`);
  }
  return get(kind, today);
}

module.exports = {
  run, get, getById, list, composeDaily, composeWeekly, weeklyPush, dailyEmailHtml, weeklyEmailHtml,
  readFeedback, recordFeedback, volumeLabel, supportRows,
};
