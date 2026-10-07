'use strict';

/**
 * Meeting intelligence — ONE finding per upcoming meeting (Build 5A, 3 Oct 2026).
 *
 * Before this build three things looked at a meeting before it started:
 *
 *   meeting-prep        LIVE. A push 15–25 min before any event whose title
 *                       contains part of a People note's name (so "Nick" in a
 *                       title matched Nick), with that note's role. Its own
 *                       sendToAll, in ALWAYS_DELIVER: bypasses quiet hours,
 *                       the hourly cap and Focus.
 *   meeting-context     SHADOW. Open actions and owed items from the last
 *                       occurrence's write-up, and urgent email about it.
 *   commitment-risk     SHADOW. A commitment from the last occurrence when the
 *                       next is within 24h — a second finding about the same
 *                       meeting, asked about separately.
 *
 * This replaces the two shadow paths with one pipeline:
 *
 *   Meeting projection → gather (meeting-context's bounded readers)
 *     → progress state per prior commitment (Build 5D)
 *     → linked commitment-risk findings (by id, never restated)
 *     → ONE finding → ONE attention question (the existing policy)
 *
 * Consolidation rules:
 *   • A risk that matters BECAUSE this meeting is coming lives on this finding.
 *     commitment-risk keeps the obligation finding (it is the authority on
 *     whether a promise is at risk) and defers its attention question here.
 *   • A risk that matters on its own (a stated deadline today) stays a
 *     commitment-risk finding and is asked there; this finding lists it under
 *     `linked.elsewhere` and does not count it, so it is not raised twice.
 *   • A prior commitment that progress evidence says is LIKELY DONE is listed,
 *     marked so, and does not count towards making this a finding.
 *
 * Old meeting-prep is NOT retired here: it stays the live path, and both sides
 * write meeting_prep_comparisons so parity can be judged on real meetings.
 * This pipeline never sends — MEETING_INTELLIGENCE_MODE is shadow or off, and
 * 'live' reads as shadow.
 */

const crypto = require('crypto');
const db = require('../db/database');
const wm = require('./world-model');
const mc = require('./meeting-context');

const RECOMMEND_BEFORE_MIN = mc.RECOMMEND_BEFORE_MIN; // 20
const RISK_LEAD_MIN = 60;                              // an at-risk prior commitment wants the hour before
const OLD_PREP_WINDOW = [15, 25];                      // meeting-prep's own window, for the comparison
const DONE_STATES = new Set(['likely_fulfilled', 'fulfilled']);

function mode() {
  const m = String(process.env.MEETING_INTELLIGENCE_MODE || 'shadow').toLowerCase();
  return m === 'off' ? 'off' : 'shadow';
}

const fp = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };

const DEFAULT_DEPS = {
  progress: (commitmentId) => require('./progress-evidence').progressFor(commitmentId),
  riskFindings: () => require('./commitment-risk').findings({ status: 'active', limit: 500 }),
  waitingCommitmentId: (key) => require('./world-obligations').waitingCommitmentId(key),
  preparedFor: (findingId) => require('./prepared-actions').forFinding(findingId),
  personContext: (name) => readPersonContext(name),
};

/**
 * Build 14T: the two things the old meeting-prep push carried that this
 * pipeline did not — a People note's ROLE and the LAST 1-2-1. Read from the
 * person's own note (People/<name>.md), the last 1-2-1 folded with what
 * one-to-one-detect has seen written up since (the stamp lags by a day).
 * Unknown stays null; nothing is inferred.
 */
function readPersonContext(name) {
  const fs = require('fs');
  const path = require('path');
  const root = process.env.OBSIDIAN_VAULT_PATH;
  if (!root || !name || /[\\/]|\.\./.test(name)) return null;
  let content;
  try { content = fs.readFileSync(path.join(root, 'People', `${name}.md`), 'utf8'); } catch { return null; }
  const fm = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  let last121 = fm['last-1-2-1'] || null;
  try { last121 = require('./one-to-one-detect').effectiveCadenceFields(name, fm)['last-1-2-1'] || last121; } catch { /* the stamp stands */ }
  return { role: fm.role || fm.title || null, team: fm.team || null, last121: /^\d{4}-\d{2}-\d{2}$/.test(String(last121 || '')) ? last121 : null };
}

/** PURE. Role / team / last 1-2-1 for each person in the meeting. */
function attendeeContext(people, personContext) {
  return (people || []).filter((p) => p.displayName).map((p) => {
    let c = null;
    try { c = personContext ? personContext(p.displayName) : null; } catch { c = null; }
    return { personId: p.personId, name: p.displayName, role: c ? c.role : null, team: c ? c.team : null, last121: c ? c.last121 : null, known: !!c };
  });
}

/**
 * Build the sections and the decision for one meeting. PURE over its inputs
 * (gathered evidence, progress lookups and the risk findings passed in).
 */
function compose(meeting, gathered, { progressOf, risks, waitingIdOf, preparedOf, personContext = null }) {
  const e = gathered.evidence;
  const atRiskByCommitment = new Map();
  const linkedHere = []; const linkedElsewhere = [];
  for (const r of risks) {
    const rm = r.relatedMeeting;
    if (!rm || rm.meetingId !== meeting.meetingId) continue;
    const meetingOnly = (r.triggers || []).length > 0 && r.triggers.every((t) => t.kind === 'meeting-near');
    const prepared = preparedOf ? preparedOf(r.findingId) : null;
    const link = { findingId: r.findingId, commitmentId: r.commitmentId, level: r.level, triggers: (r.triggers || []).map((t) => t.kind),
      summary: r.summary, preparedActionId: prepared ? prepared.actionId : null };
    if (meetingOnly) { linkedHere.push(link); atRiskByCommitment.set(r.commitmentId, r.findingId); }
    else linkedElsewhere.push({ ...link, why: 'it matters on its own (a deadline), so it is raised as its own finding, not here' });
  }

  const withProgress = (commitmentId) => {
    const p = progressOf(commitmentId);
    return p ? { state: p.state, basis: p.basis, reasons: p.reasons } : { state: 'unknown', basis: 'none', reasons: ['progress unreadable'] };
  };
  const yourActions = e.commitments.map((t) => {
    const commitmentId = `commitment:task:${t.taskId}`;
    return { ...t, commitmentId, progress: withProgress(commitmentId), atRiskFindingId: atRiskByCommitment.get(commitmentId) || null };
  });
  const owedToYou = e.owedFromPrevious.map((w) => {
    const commitmentId = waitingIdOf(w.key);
    return { ...w, commitmentId, progress: withProgress(commitmentId), atRiskFindingId: atRiskByCommitment.get(commitmentId) || null };
  });
  // A linked risk not already among the prior-occurrence items keeps its own line.
  const listed = new Set([...yourActions, ...owedToYou].map((x) => x.commitmentId));
  const atRiskOther = linkedHere.filter((l) => !listed.has(l.commitmentId));

  const stillOpen = (x) => !DONE_STATES.has(x.progress.state);
  const triggers = [];
  if (yourActions.some(stillOpen)) triggers.push('open-commitments-from-previous');
  if (owedToYou.some(stillOpen)) triggers.push('owed-from-previous');
  if (e.emails.length) triggers.push('urgent-email-from-attendee');
  if (linkedHere.length) triggers.push('linked-commitment-risk');

  const sections = {
    previous: e.previous,
    yourActions, owedToYou, atRiskOther,
    emails: e.emails,
    supporting: { attendeeOwed: e.attendeeOwed, otherUrgentEmails: e.otherEmails,
      people: (meeting.people || []).map((p) => ({ personId: p.personId, displayName: p.displayName })),
      // Build 14T: context, never a trigger — a role is not a reason to interrupt.
      attendeeContext: attendeeContext(meeting.people, personContext) },
  };
  return { triggers, sections, linked: { here: linkedHere, elsewhere: linkedElsewhere } };
}

const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

/** One or two sentences, deterministic. States the evidence; draws no conclusion. */
function summarise(meeting, c) {
  const s = c.sections;
  const parts = [`${meeting.title} starts at ${meeting.start.slice(11, 16)}.`];
  const prevDay = s.previous ? s.previous.start.slice(0, 10) : null;
  const openMine = s.yourActions.filter((x) => !DONE_STATES.has(x.progress.state));
  const doneMine = s.yourActions.length - openMine.length;
  if (openMine.length) parts.push(`${plural(openMine.length, 'action', 'actions')} you took from the last one${prevDay ? ` (${prevDay})` : ''} ${openMine.length === 1 ? 'is' : 'are'} still open${openMine.some((x) => x.atRiskFindingId) ? ' and at risk' : ''}.`);
  if (doneMine) parts.push(`${plural(doneMine, 'other looks', 'others look')} already done (not confirmed).`);
  const openOwed = s.owedToYou.filter((x) => !DONE_STATES.has(x.progress.state));
  if (openOwed.length) {
    const who = [...new Set(openOwed.map((w) => w.person))].join(', ');
    parts.push(`${who} still ${openOwed.length === 1 ? 'owes' : 'owe'} you ${plural(openOwed.length, 'item', 'items')} from it.`);
  }
  if (s.atRiskOther.length) parts.push(`${plural(s.atRiskOther.length, 'commitment', 'commitments')} tied to this meeting ${s.atRiskOther.length === 1 ? 'is' : 'are'} at risk.`);
  if (s.emails.length) parts.push(`${plural(s.emails.length, 'urgent email', 'urgent emails')} from people in it ${s.emails.length === 1 ? 'is' : 'are'} unanswered.`);
  return parts.join(' ');
}

function _row(id) { return db.get('SELECT * FROM meeting_intelligence_findings WHERE finding_id = ?', [id]); }

function activeFindingFor(meetingId, startLocal) {
  const r = startLocal
    ? db.get(`SELECT finding_id FROM meeting_intelligence_findings WHERE meeting_id = ? AND start_local = ? AND status = 'active'`, [meetingId, startLocal])
    : db.get(`SELECT finding_id FROM meeting_intelligence_findings WHERE meeting_id = ? AND status = 'active' ORDER BY start_local LIMIT 1`, [meetingId]);
  return r ? { findingId: r.finding_id } : null;
}

/** Record what THIS pipeline says about a meeting, beside what meeting-prep did. */
function recordComparison(meeting, newSide, iso) {
  const key = `${meeting.meetingId}@${meeting.start}`;
  db.run(`INSERT INTO meeting_prep_comparisons (meeting_key, title, start_local, new_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(meeting_key) DO UPDATE SET new_json = excluded.new_json, updated_at = excluded.updated_at`,
  [key, meeting.title, meeting.start, JSON.stringify(newSide), iso, iso]);
}

/**
 * One pass, from the durable runtime every five minutes. Returns counts.
 */
async function evaluate({ now = Date.now(), deps = {} } = {}) {
  const d = { ...mc.DEFAULT_DEPS, ...DEFAULT_DEPS, ...deps };
  if (!Array.isArray(d.self)) {
    try { d.self = await Promise.resolve(d.selfEmails()); } catch { d.self = []; }
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const nowLocal = wm.localMinute(nowMs);
  const iso = new Date(nowMs).toISOString();
  const out = { mode: mode(), considered: 0, created: 0, updated: 0, withdrawn: 0, expired: 0, decided: 0, compared: 0, skipped: [] };
  if (out.mode === 'off') return out;

  out.expired = db.run(`UPDATE meeting_intelligence_findings SET status = 'expired', updated_at = ?
                         WHERE status = 'active' AND start_local <= ?`, [iso, nowLocal]).changes;

  let risks = [];
  try { risks = d.riskFindings(); } catch (e) { out.riskReadError = e.message; }

  const candidates = wm.nextMeetings({ now: nowMs, limit: 20, withinMinutes: mc.WINDOW_MAX })
    .filter((m) => wm.minutesBetween(nowLocal, m.start) >= mc.WINDOW_MIN);
  for (const meeting of candidates) {
    out.considered += 1;
    const id = `meeting-intelligence:${meeting.meetingId}:${meeting.start}`;
    const existing = _row(id);
    const minsAway = wm.minutesBetween(nowLocal, meeting.start);
    let composed = null;
    let why = mc.gate(meeting); // not a real meeting / declined / broadcast
    const gathered = why ? { evidence: null, missing: [] } : mc.gather(meeting, d);
    if (!why) {
      composed = compose(meeting, gathered, {
        progressOf: (cid) => { try { return d.progress(cid); } catch { return null; } },
        risks, waitingIdOf: d.waitingCommitmentId,
        preparedOf: (fid) => { try { return d.preparedFor(fid); } catch { return null; } },
        personContext: d.personContext,
      });
      if (!composed.triggers.length) why = 'nothing NEURO holds is specific to this meeting (or what it holds looks already done)';
    }

    if (minsAway >= OLD_PREP_WINDOW[0] && minsAway <= OLD_PREP_WINDOW[1]) {
      // Build 14T: the attendee context travels on the comparison either way,
      // so a divergence can say whether the new side HOLDS what the old pushed.
      const context = composed ? composed.sections.supporting.attendeeContext : attendeeContext(meeting.people, d.personContext);
      recordComparison(meeting, why
        ? { finding: false, why, context }
        : { finding: true, findingId: id, triggers: composed.triggers, summary: summarise(meeting, composed), context }, iso);
      out.compared += 1;
    }

    if (why) {
      out.skipped.push({ meetingId: meeting.meetingId, why });
      if (existing && existing.status === 'active') {
        db.run(`UPDATE meeting_intelligence_findings SET status = 'withdrawn', updated_at = ? WHERE finding_id = ?`, [iso, id]);
        out.withdrawn += 1;
      }
      continue;
    }

    const lead = composed.linked.here.length ? RISK_LEAD_MIN : RECOMMEND_BEFORE_MIN;
    const rec = mc.shiftLocal(meeting.start, -lead);
    const recommended = rec < nowLocal ? nowLocal : rec;
    const confidence = Math.max(0.3, Math.min(0.9, 0.5 + 0.1 * composed.triggers.length
      - 0.05 * gathered.missing.filter((m) => /unreadable/.test(m.why)).length));
    const summary = summarise(meeting, composed);
    const evFp = fp([composed.triggers, composed.sections, composed.linked, gathered.missing]);
    const fields = [meeting.meetingId, meeting.title, meeting.start, JSON.stringify(composed.triggers), JSON.stringify(composed.sections),
      JSON.stringify(composed.linked), JSON.stringify(gathered.missing), Math.round(confidence * 100) / 100, recommended, summary, evFp, iso];
    if (!existing) {
      db.run(`INSERT INTO meeting_intelligence_findings (meeting_id, title, start_local, triggers_json, sections_json, linked_json,
                missing_json, confidence, recommended_at_local, summary, evidence_fingerprint, updated_at, finding_id, status,
                first_created_at, decisions)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0)`, [...fields, id, iso]);
      out.created += 1;
      console.log(`[MeetingIntelligence] (shadow) ${summary}`);
    } else if (existing.evidence_fingerprint !== evFp || existing.status !== 'active') {
      db.run(`UPDATE meeting_intelligence_findings SET meeting_id = ?, title = ?, start_local = ?, triggers_json = ?, sections_json = ?,
                linked_json = ?, missing_json = ?, confidence = ?, recommended_at_local = ?, summary = ?, evidence_fingerprint = ?,
                updated_at = ?, status = 'active' WHERE finding_id = ?`, [...fields, id]);
      out.updated += 1;
    }
  }

  // ONE attention question per meeting finding, at the recommended moment,
  // through the existing policy (the meeting-context rule: shadow, never
  // offered by deliver()). Recorded, never sent.
  const due = db.all(`SELECT * FROM meeting_intelligence_findings WHERE status = 'active' AND attention_decided_at IS NULL
                       AND recommended_at_local <= ?`, [nowLocal]);
  let moment = null; let momentErr = null;
  if (due.length) { try { ({ moment } = await d.readMoment(nowMs)); } catch (e) { momentErr = e.message; } }
  for (const f of due) {
    let decision;
    if (!moment) decision = { push: false, why: `could not read the moment: ${momentErr}` };
    else {
      const linked = parse(f.linked_json) || { here: [] };
      const v = require('./ambient-push').worthInterrupting({ kind: 'meeting-context', text: f.summary, findingId: f.finding_id,
        linkedRiskFindingIds: (linked.here || []).map((l) => l.findingId),
        preparedActionIds: (linked.here || []).map((l) => l.preparedActionId).filter(Boolean) }, moment);
      decision = { push: !!v.push, why: v.why || null, urgency: v.urgency || null, wouldSay: v.push ? v.message : null };
    }
    db.run(`UPDATE meeting_intelligence_findings SET attention_decided_at = ?, attention_json = ?, decisions = decisions + 1,
              updated_at = ? WHERE finding_id = ?`,
    [iso, JSON.stringify({ ...decision, shadow: true, sent: false }), iso, f.finding_id]);
    out.decided += 1;
  }
  return out;
}

function findings({ status = null, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const rows = status
    ? db.all('SELECT * FROM meeting_intelligence_findings WHERE status = ? ORDER BY start_local DESC LIMIT ?', [status, lim])
    : db.all('SELECT * FROM meeting_intelligence_findings ORDER BY start_local DESC LIMIT ?', [lim]);
  return rows.map((r) => ({
    findingId: r.finding_id, meetingId: r.meeting_id, title: r.title, start: r.start_local, status: r.status,
    summary: r.summary, confidence: r.confidence, recommendedAt: r.recommended_at_local, triggers: parse(r.triggers_json),
    sections: parse(r.sections_json), linked: parse(r.linked_json), missing: parse(r.missing_json),
    attention: r.attention_json ? { decidedAt: r.attention_decided_at, ...parse(r.attention_json) } : null,
    firstCreatedAt: r.first_created_at, updatedAt: r.updated_at,
  }));
}

// ── parity with the live meeting-prep push ──────────────────────────────────

/** Classify one comparison row. PURE. */
function classifyComparison(row) {
  const o = parse(row.old_json); const n = parse(row.new_json);
  const oldSaid = !!(o && o.wouldNotify);
  const newSaid = !!(n && n.finding);
  let kind;
  if (!o) kind = 'old-not-recorded';
  // Build 16H: the old push looked and said NOTHING, and the new pipeline never
  // evaluated it (the 8 such rows on 5-7 Oct were all free entries it filtered
  // out). Both sides were silent, so there is no old value the new side lacks:
  // that is agreement, not a one-sided gap that blocks retirement.
  else if (!n && !oldSaid) kind = 'neither';
  else if (!n) kind = 'new-not-recorded';
  else if (oldSaid && newSaid) kind = 'both';
  else if (oldSaid) {
    const matched = o.matchedPeople || [];
    if (matched.every((p) => /^nick\b/i.test(p))) kind = 'old-only-self-match';
    else {
      // Build 14T: the new side HOLDS the old push's content (role and/or last
      // 1-2-1 for every person the old path matched) but chose not to raise a
      // finding. Still a divergence — whether that content earns a push is
      // Nick's call — but a different one from "the new side knows nothing".
      const ctx = new Map(((n && n.context) || []).map((c) => [String(c.name).toLowerCase(), c]));
      const covered = matched.length > 0 && matched.filter((p) => !/^nick\b/i.test(p)).every((p) => {
        const c = ctx.get(String(p).toLowerCase());
        return c && (c.role || c.last121);
      });
      kind = covered ? 'old-only-covered' : 'old-only';
    }
  }
  else if (newSaid) kind = 'new-only';
  else kind = 'neither';
  return { meetingKey: row.meeting_key, title: row.title, start: row.start_local, kind, pushValue: pushValue(kind, o, n), old: o, new: n };
}

/**
 * Build 17S — what an old-only push was WORTH as an interruption. PURE.
 *
 * Nick, 7 Oct 2026: "context belongs in prep; risk/actionability earns
 * interruption." The legacy push body is, by construction, a People note's
 * role, its last 1-2-1 date and a note excerpt (meeting-prep.js
 * `OLD_PUSH_FIELDS`) — it carries no risk and no action, so an old-only push
 * can be noise or context, never actionable. Parity is judged on that, not on
 * how much text either side produced.
 *   noise        the old path matched Nick's own name, or fired on a solo block
 *   context-only role / last 1-2-1 / excerpt — belongs in prep, earns no push
 *   duplicate    both sides raised it
 *   actionable   reserved; the legacy body cannot carry it
 */
function pushValue(kind, o, n) {
  if (kind === 'both') return 'duplicate';
  if (!['old-only', 'old-only-covered', 'old-only-self-match'].includes(kind)) return null;
  if (kind === 'old-only-self-match') return 'noise';
  if (n && /not a meeting with other people/.test(n.why || '')) return 'noise';
  const fields = Object.keys((o && o.content) || {});
  if (fields.some((f) => !OLD_PUSH_FIELDS.includes(f))) return 'actionable';
  return 'context-only';
}
const OLD_PUSH_FIELDS = Object.freeze(['role', 'last121', 'notes']);

/**
 * Can meeting-prep be retired? PURE over the comparison rows. Retirement needs
 * a long enough record AND no case where the old push said something the new
 * pipeline would not have — other than the old path matching Nick's own name.
 * 'old-only' is content the new pipeline does not carry (a People note's role
 * and last 1-2-1); deciding that is not worth a push is Nick's call, so any
 * such row blocks the automatic verdict.
 */
/**
 * Can meeting-prep be retired? PURE over the comparison rows (Build 17R/U —
 * interruption parity, replacing Build 5A's text parity).
 *
 * Retire-safe when, over at least `minDays` days of real meetings:
 *   • no old-only push was ACTIONABLE (the unified pipeline would have missed
 *     a risk the old one raised);
 *   • every person a CONTEXT-ONLY old push named still has that context in
 *     prep (`contextAvailable(name)` — the People note's role / last 1-2-1,
 *     which the prep view and the unified finding both read);
 *   • the old path no longer fires on solo blocks since the Build 16K fix;
 *   • no meeting was seen by only ONE side while the old side spoke.
 * Byte-for-byte parity is NOT required: context-only and noise rows do not
 * count as missing push parity.
 */
function parityVerdict(rows, { minDays = 3, contextAvailable = null, soloFixedFrom = '2026-10-07' } = {}) {
  const classified = rows.map(classifyComparison);
  const days = new Set(classified.map((c) => String(c.start || '').slice(0, 10)).filter(Boolean));
  const count = (k) => classified.filter((c) => c.kind === k).length;
  const value = (v) => classified.filter((c) => c.pushValue === v);
  const reasons = [];
  if (days.size < minDays) reasons.push(`only ${days.size} day(s) of comparisons; ${minDays} needed`);
  const actionable = value('actionable');
  if (actionable.length) reasons.push(`${actionable.length} old-only push(es) carried more than context — the unified pipeline would have missed them`);
  const contextRows = value('context-only');
  const missingContext = [];
  for (const c of contextRows) {
    for (const p of (c.old && c.old.matchedPeople) || []) {
      if (/^nick\b/i.test(p)) continue;
      const ok = contextAvailable ? contextAvailable(p) : false;
      if (!ok) missingContext.push({ meeting: c.title, start: c.start, person: p });
    }
  }
  if (missingContext.length) reasons.push(`${missingContext.length} person(s) the old push named have no role / last 1-2-1 in prep`);
  const soloAfterFix = classified.filter((c) => c.pushValue === 'noise' && c.old && c.old.sent && String(c.start) >= soloFixedFrom
    && c.new && /not a meeting with other people/.test(c.new.why || ''));
  if (soloAfterFix.length) reasons.push(`${soloAfterFix.length} solo block(s) still pushed after the fix`);
  const oneSidedSpoke = classified.filter((c) => (c.kind === 'new-not-recorded' && c.old && c.old.wouldNotify) || c.kind === 'old-not-recorded');
  if (oneSidedSpoke.length) reasons.push(`${oneSidedSpoke.length} meeting(s) seen by only one side while it spoke`);
  return {
    retireSafe: reasons.length === 0, reasons, days: days.size, methodology: 'interruption-value',
    counts: { both: count('both'), oldOnly: count('old-only'), oldOnlyCovered: count('old-only-covered'), oldOnlySelfMatch: count('old-only-self-match'),
      newOnly: count('new-only'), neither: count('neither'), oneSided: count('old-not-recorded') + count('new-not-recorded') },
    pushValue: { actionable: actionable.length, contextOnly: contextRows.length, noise: value('noise').length, duplicate: value('duplicate').length },
    newOnlyMaterial: classified.filter((c) => c.kind === 'new-only').map((c) => ({ title: c.title, start: c.start, triggers: ((c.new && c.new.triggers) || []).map((t) => t.kind || t) })),
    missingContext, soloAfterFix: soloAfterFix.length,
    rows: classified,
  };
}

function parity({ sinceDays = 30, now = Date.now(), personContext = readPersonContext } = {}) {
  const since = new Date(now - sinceDays * 86400000).toISOString().slice(0, 10);
  // Context is "available in prep" when the person's own note gives a role or a last 1-2-1.
  const contextAvailable = (name) => { try { const c = personContext(name); return !!(c && (c.role || c.last121)); } catch { return false; } };
  return parityVerdict(db.all('SELECT * FROM meeting_prep_comparisons WHERE start_local >= ? ORDER BY start_local', [since]), { contextAvailable });
}

module.exports = {
  mode, compose, summarise, evaluate, findings, activeFindingFor, recordComparison,
  classifyComparison, parityVerdict, parity, pushValue, OLD_PUSH_FIELDS, OLD_PREP_WINDOW, attendeeContext, readPersonContext,
};
