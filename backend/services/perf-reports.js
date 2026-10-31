'use strict';

/**
 * Reports Nick sent, as performance evidence (31 Oct 2026, Nick: "are my past
 * SOAP and weekly risk reports included in evidence? ... yes — add them").
 *
 * One item per report RECORDED AS SENT: the Weekly Risk & Anomaly Summary to
 * Chris (`weekly_risk_sent_<week>`) and the SOAP debrief (`soap_sent:<week>`).
 * A built or published report that was never sent is not an item — producing
 * a draft is not delivering it.
 *
 * Read-only and judging nothing. The send time is stated as a fact and `hint`
 * stays null. ⚠ There is NO deadline in it (31 Oct 2026, Nick: "the midday
 * Monday deadline for the weekly report is an arbitrary one I set") — a target
 * he chose for himself is not a commitment to anyone, so measuring the send
 * against it would manufacture lateness.
 *
 * The detail carries the sections that say what Nick found and did — headline,
 * escalations, positives, actions (Weekly Risk); success, star, amber, red
 * (SOAP) — never the task or management-log sections, which name colleagues
 * and are carried by their own sources. The feed's employment screen still runs.
 */

const EXCERPT = 900;

const clip = (s, n = EXCERPT) => {
  const t = String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "YYYY-MM-DD HH:MM" on London's wall clock. Pure. */
function londonStamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDay(key) {
  const d = new Date(`${key}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The named `## ` sections of a markdown report, in report order. Pure. */
function sections(markdown, wanted) {
  const out = [];
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = wanted.find((re) => re.test(h[1])) ? { head: h[1].replace(/[^\p{L}\p{N} '’—&()-]/gu, '').trim(), body: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (/^#\s/.test(line)) { cur = null; continue; }
    if (cur) cur.body.push(line);
  }
  return out
    .map((s) => ({ head: s.head, body: s.body.join('\n').replace(/^_.*_$/gm, '').trim() }))
    .filter((s) => s.body && !/^_?(none|nothing)/i.test(s.body));
}

const WR_SECTIONS = [/^Headline/i, /^To escalate/i, /^Positives/i, /^Actions this week/i];
const SOAP_SECTIONS = [/Success/i, /Star of the week/i, /Turning amber/i, /^\W*Red\b/i];

function weeklyRiskItem(rec) {
  const week = rec.week;
  const sent = londonStamp(rec.sentAt);
  const to = (rec.recipients || []).map((r) => r.name || r.email).filter(Boolean);
  const head = [
    sent ? `Sent ${niceDay(sent.slice(0, 10))} ${sent.slice(11)}.` : 'Send time not recorded.',
    to.length ? `To ${to.join(', ')}.` : null,
    rec.reportedByNick ? 'Recorded by Nick as sent by hand.' : null,
  ].filter(Boolean).join(' ');
  const parts = rec.body ? sections(rec.body, WR_SECTIONS) : [];
  const text = parts.map((s) => `${s.head}:\n${s.body}`).join('\n\n');
  return {
    id: `report:weekly-risk:${week}`,
    source: 'reports', kind: 'report-weekly-risk', hint: null,
    at: rec.sentAt,
    title: `Sent the Weekly Risk & Anomaly Summary to Chris — w/c ${niceDay(week)}`,
    detail: clip(`${head}${text ? `\n\n${text}` : rec.body ? '' : '\nThe report text was not kept for this week.'}`),
    _screenText: text,
    ref: `neuro:weekly-risk:${week}`,
  };
}

function soapItem(rec) {
  const week = rec.weekFrom;
  const sent = londonStamp(rec.sentAt);
  const to = (rec.recipients || []).map((r) => (typeof r === 'string' ? r : r.name || r.email)).filter(Boolean);
  const head = [
    sent ? `Sent ${niceDay(sent.slice(0, 10))} ${sent.slice(11)}${rec.kind ? ` (${rec.kind})` : ''}.` : 'Send time not recorded.',
    to.length ? `To ${to.join(', ')}.` : null,
    rec.reportedByNick ? 'Recorded by Nick as sent by hand.' : null,
  ].filter(Boolean).join(' ');
  const parts = rec.body ? sections(rec.body, SOAP_SECTIONS) : [];
  const text = parts.map((s) => `${s.head}:\n${s.body}`).join('\n\n');
  return {
    id: `report:soap:${week}`,
    source: 'reports', kind: 'report-soap', hint: null,
    at: rec.sentAt,
    title: `Sent the SOAP debrief — week of ${niceDay(week)}`,
    detail: clip(`${head}${text ? `\n\n${text}` : ''}`),
    _screenText: text,
    ref: `neuro:soap:${week}`,
  };
}

/** Sent reports whose send falls in the window (London days). */
function itemsFor(db, w) {
  const rows = db.prepare(`SELECT key, value FROM agent_state WHERE key LIKE 'weekly_risk_sent_%' OR key LIKE 'soap_sent:%'`).all();
  const out = [];
  for (const r of rows) {
    let rec;
    try { rec = JSON.parse(r.value); } catch { continue; }
    if (!rec || !rec.sentAt) continue;
    const day = (londonStamp(rec.sentAt) || '').slice(0, 10);
    if (!day || day < w.from || day > w.to) continue;
    if (r.key.startsWith('weekly_risk_sent_')) {
      if (!rec.week) rec.week = r.key.slice('weekly_risk_sent_'.length);
      out.push(weeklyRiskItem(rec));
    } else {
      if (!rec.weekFrom) rec.weekFrom = r.key.slice('soap_sent:'.length);
      out.push(soapItem(rec));
    }
  }
  return out;
}

module.exports = { itemsFor, _internals: { sections, londonStamp, WR_SECTIONS, SOAP_SECTIONS } };
