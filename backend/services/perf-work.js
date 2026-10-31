'use strict';

/**
 * More of Nick's own work as performance evidence (31 Oct 2026, after the
 * evidence audit: "add it all in then"). Five sources, all READ-ONLY, all
 * judging nothing, all work-only:
 *
 *  - sends:     emails and calendar changes NEURO sent for him through Actions
 *               (prepared_actions, verified/executed). Work mailbox only.
 *               Replies and the Weekly Risk send have their own sources and are
 *               not repeated; UAT invites are told by the workforce source as a
 *               round; 1-2-1 bookings and moves fold to one item per day.
 *  - tickets:   ticket update promises he made and kept or missed
 *               (watched_ticket_commitments), Jira replies posted from NEURO
 *               (ledger writer jira.comment) and Tier 2 rejection approvals he
 *               decided (jira.approval).
 *  - workforce: the five-step overtime checks (overtime_approvals), payroll
 *               files sent (overtime_payroll_sends) and UAT volunteer rounds run.
 *  - people:    management-log actions closed, and chases of what others owe
 *               him — COUNTS per day only, never what was owed.
 *  - work-notes: notes he wrote in the work project folders of the vault, by
 *               the dates in their own frontmatter (never file mtime — sync
 *               rewrites it). An allow-list, so Projects/PIP (his OH report)
 *               and personal projects can never be read.
 *
 * The feed's employment screen runs over every source here except `people`,
 * which carries no content.
 */

const fs = require('fs');
const path = require('path');

const EXCERPT = 700;
const clip = (s, n = EXCERPT) => {
  const t = String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const json = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };

/** London calendar day of an instant. Pure. */
function londonDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
const inWindow = (iso, w) => { const d = londonDay(iso); return !!d && d >= w.from && d <= w.to; };
const names = (to) => (to || []).map((x) => x.name || x.email).filter(Boolean);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── sends ────────────────────────────────────────────────────────────────────

const SEND_TYPES = new Set(['compose_email', 'chase_commitment', 'chase_agenda', 'create_calendar_event', 'reschedule_calendar_event', 'cancel_calendar_event']);
const ONE_TO_ONE = new Set(['1to1-book', '1to1-move', '1to1-cancel']);

function sends(db, w) {
  const rows = db.prepare(`
    SELECT action_id, action_type, origin, target_json, draft_json, evidence_json, executed_at, verified_at
      FROM prepared_actions WHERE status IN ('verified','executed')
  `).all();
  const out = [];
  const folds = new Map();
  for (const r of rows) {
    if (!SEND_TYPES.has(r.action_type)) continue;
    if (r.origin === 'uat-volunteers' || r.origin === 'overtime-payroll' || r.origin === 'machine-client') continue;
    const at = r.verified_at || r.executed_at;
    if (!at || !inWindow(at, w)) continue;
    const target = json(r.target_json, {}) || {};
    if (target.mailbox && target.mailbox !== 'work') continue; // work only
    const draft = json(r.draft_json, {}) || {};
    const evidence = json(r.evidence_json, {}) || {};
    if (/safe to delete|governed .* proof/i.test(draft.subject || '')) continue; // NEURO's own build proofs
    const to = names(draft.to);
    if (ONE_TO_ONE.has(r.origin)) {
      const day = londonDay(at);
      const key = `${day}:${r.origin}`;
      const f = folds.get(key) || { day, origin: r.origin, people: [], reasons: [], at };
      f.people.push(target.person || to[0] || 'someone');
      const why = evidence.context && evidence.context.reason;
      if (why) f.reasons.push(`${target.person || to[0]}: ${why}`);
      if (at > f.at) f.at = at;
      folds.set(key, f);
      continue;
    }
    const ticket = evidence.ticket || null;
    let title;
    if (r.action_type === 'compose_email' && ticket) title = `Escalated ${ticket} by email to ${to.join(', ') || 'someone'}`;
    else if (r.action_type.endsWith('calendar_event')) title = `${r.action_type.startsWith('create') ? 'Booked' : r.action_type.startsWith('reschedule') ? 'Moved' : 'Cancelled'} "${draft.subject || 'a meeting'}"${to.length ? ` with ${to.slice(0, 4).join(', ')}` : ''}`;
    else if (r.action_type.startsWith('chase')) title = `Chased ${to.join(', ') || 'someone'}: ${draft.subject || ''}`.trim();
    else title = `Emailed ${to.slice(0, 4).join(', ') || 'someone'}: ${draft.subject || '(no subject)'}`;
    const text = `${draft.subject || ''}\n${draft.body || ''}`;
    out.push({
      id: `send:${r.action_id}`,
      source: 'sends', kind: `send:${r.action_type}`, hint: null,
      at, title: clip(title, 200),
      detail: clip(`${to.length ? `To ${to.join(', ')}. ` : ''}${draft.body ? draft.body : ''}`),
      _screenText: text,
      ref: `neuro:actions:${r.action_id}`,
    });
  }
  for (const f of folds.values()) {
    const verb = f.origin === '1to1-book' ? 'Booked' : f.origin === '1to1-move' ? 'Moved' : 'Cancelled';
    out.push({
      id: `send:${f.origin}:${f.day}`,
      source: 'sends', kind: `send:${f.origin}`, hint: null,
      at: f.at,
      title: `${verb} ${plural(f.people.length, '1-2-1')} with ${f.people.join(', ')}`,
      detail: f.reasons.length ? `Why: ${f.reasons.join('; ')}` : `${verb} through NEURO; the invite went from Outlook.`,
      _screenText: f.reasons.join('\n'),
      ref: null,
    });
  }
  return out;
}

// ── tickets ──────────────────────────────────────────────────────────────────

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function tickets(db, w) {
  const out = [];
  if (tableExists(db, 'watched_ticket_commitments')) {
    // A missed promise is not a state of its own: it stays open (or is later
    // dismissed) with missed_at set, and one kept after its time is kept_late.
    for (const raw of db.prepare(`SELECT id, ticket_key, due_at, state, made_at, closed_at, missed_at, kept_late FROM watched_ticket_commitments
                                 WHERE state = 'kept' OR missed_at IS NOT NULL`).all()) {
      const r = { ...raw, state: raw.state === 'kept' ? 'kept' : 'missed' };
      const at = r.state === 'kept' ? r.closed_at : r.missed_at;
      if (!at || !inWindow(at, w)) continue;
      const due = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(r.due_at));
      out.push({
        id: `ticket-promise:${r.id}`,
        source: 'tickets', kind: `ticket-promise-${r.state}`, hint: null,
        at,
        title: r.state === 'kept'
          ? `Kept a promised update on ${r.ticket_key}${r.kept_late ? ' (late)' : ''}`
          : `Missed a promised update on ${r.ticket_key}`,
        detail: `Promised the customer an update by ${due}. ${r.state === 'kept' ? (r.kept_late ? 'Updated after that time.' : 'Updated in time.') : 'No update was posted by then.'}`,
        ref: `jira:${r.ticket_key}`,
      });
    }
  }
  if (tableExists(db, 'external_write_ledger')) {
    const rows = db.prepare(`SELECT id, writer, request_json, settled_at FROM external_write_ledger
      WHERE writer IN ('jira.comment','jira.approval') AND status IN ('confirmed','applied-unverified')`).all();
    for (const r of rows) {
      if (!r.settled_at || !inWindow(r.settled_at, w)) continue;
      const q = json(r.request_json, {}) || {};
      if (r.writer === 'jira.approval') {
        out.push({
          id: `ticket-approval:${r.id}`,
          source: 'tickets', kind: 'ticket-approval', hint: null,
          at: r.settled_at,
          title: `${q.decision === 'approve' ? 'Approved' : 'Declined'} "${q.name || 'an approval'}" on ${q.key || 'a ticket'}`,
          detail: `Decided in NEURO; Jira confirmed it.${q.reason ? ` Reason: ${clip(q.reason, 300)}` : ''}`,
          _screenText: q.reason || '',
          ref: q.key ? `jira:${q.key}` : null,
        });
      } else {
        const pub = q.visibility === 'public' || q.public === true;
        out.push({
          id: `ticket-reply:${r.id}`,
          source: 'tickets', kind: pub ? 'ticket-reply-public' : 'ticket-reply-internal', hint: null,
          at: r.settled_at,
          title: `${pub ? 'Replied to the customer' : 'Added an internal note'} on ${q.key || 'a ticket'}`,
          detail: 'Posted from NEURO and read back from Jira. The words are on the ticket.',
          ref: q.key ? `jira:${q.key}` : null,
        });
      }
    }
  }
  return out;
}

// ── workforce ────────────────────────────────────────────────────────────────

function workforce(db, w) {
  const out = [];
  if (tableExists(db, 'overtime_approvals')) {
    for (const r of db.prepare(`SELECT id, person, work_date, hours, outcome, approved_at, updated_at, chk_activity, chk_48h, chk_optout, chk_rest, chk_recorded FROM overtime_approvals WHERE outcome IS NOT NULL`).all()) {
      const at = r.approved_at || r.updated_at;
      if (!at || !inWindow(at, w)) continue;
      const checks = ['chk_activity', 'chk_48h', 'chk_optout', 'chk_rest', 'chk_recorded'].filter((k) => r[k] !== null && r[k] !== undefined && r[k] !== '').length;
      out.push({
        id: `overtime-check:${r.id}`,
        source: 'workforce', kind: 'overtime-check', hint: null,
        at,
        title: `${String(r.outcome).replace(/^\w/, (c) => c.toUpperCase())} overtime for ${r.person} (${r.hours}h on ${r.work_date})`,
        detail: `Five-step working-time check: ${checks} of 5 steps recorded.`,
        ref: null,
      });
    }
  }
  if (tableExists(db, 'overtime_payroll_sends')) {
    for (const r of db.prepare(`SELECT id, month, claim_ids, total_hours, marked_at FROM overtime_payroll_sends WHERE marked_at IS NOT NULL`).all()) {
      if (!inWindow(r.marked_at, w)) continue;
      const n = (json(r.claim_ids, []) || []).length;
      out.push({
        id: `overtime-payroll:${r.id}`,
        source: 'workforce', kind: 'overtime-payroll-sent', hint: null,
        at: r.marked_at,
        title: `Sent the ${r.month} overtime file to payroll`,
        detail: `${plural(n, 'approved claim')}, ${r.total_hours} hours in total.`,
        ref: null,
      });
    }
  }
  if (tableExists(db, 'uat_rounds')) {
    const sel = tableExists(db, 'uat_selections') ? db.prepare(`SELECT status FROM uat_selections WHERE round_id = ?`) : null;
    for (const r of db.prepare(`SELECT id, feature, uat_date, from_name, closed_at FROM uat_rounds WHERE status = 'done' AND closed_at IS NOT NULL`).all()) {
      if (!inWindow(r.closed_at, w)) continue;
      const s = sel ? sel.all(r.id) : [];
      const asked = s.filter((x) => ['sent', 'confirmed', 'accepted', 'declined'].includes(x.status)).length;
      const going = s.filter((x) => x.status === 'confirmed' || x.status === 'accepted').length;
      out.push({
        id: `uat-round:${r.id}`,
        source: 'workforce', kind: 'uat-round', hint: null,
        at: r.closed_at,
        title: `Put forward UAT volunteers for "${r.feature}" (${r.uat_date})`,
        detail: `Asked by ${r.from_name}. ${plural(asked, 'person', 'people')} invited from the rota, ${going} going; reply sent.`,
        ref: null,
      });
    }
  }
  return out;
}

// ── people (counts only) ─────────────────────────────────────────────────────

function people(db, w) {
  const out = [];
  if (tableExists(db, 'management_log')) {
    const byDay = new Map();
    for (const r of db.prepare(`SELECT resolved_date, type FROM management_log WHERE resolved_date IS NOT NULL AND substr(resolved_date,1,10) BETWEEN ? AND ?`).all(w.from, w.to)) {
      const d = String(r.resolved_date).slice(0, 10);
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    for (const [d, n] of byDay) {
      out.push({
        id: `mlog-closed:${d}`, source: 'people', kind: 'mlog-closed', hint: null,
        at: `${d}T17:00:00`,
        title: `Closed ${plural(n, 'management-log action')}`,
        detail: 'Counted from the management log; the actions themselves are in the log.',
        ref: 'neuro:management-log',
      });
    }
  }
  if (tableExists(db, 'waiting_on')) {
    const byDay = new Map();
    for (const r of db.prepare(`SELECT asked_at FROM waiting_on WHERE asked_at IS NOT NULL`).all()) {
      const d = londonDay(r.asked_at);
      if (!d || d < w.from || d > w.to) continue;
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    for (const [d, n] of byDay) {
      out.push({
        id: `chased:${d}`, source: 'people', kind: 'chased-owed', hint: null,
        at: `${d}T17:00:00`,
        title: `Chased ${plural(n, 'thing')} people owed you`,
        detail: 'Counted from Waiting on; what was owed is not carried.',
        ref: 'neuro:waiting-on',
      });
    }
  }
  return out;
}

// ── work notes ───────────────────────────────────────────────────────────────

/** Work project folders whose notes can be evidence. An allow-list: PIP and personal projects are never read. */
const WORK_FOLDERS = ['Support Improvement Plan', 'TOM', 'Jira Support Unification', 'KPI revision', '90 Day Plan', 'Fixes Log', 'NOVA'];
const SKIP_TYPES = /claude-code-brief|build-brief|handoff/i;

function frontmatter(content) {
  const m = String(content).replace(/\r/g, '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(content) };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}
const dateOf = (v) => (String(v || '').match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || null;

function workNotes(vaultRoot, w) {
  if (!vaultRoot) throw new Error('vault not configured');
  const root = path.join(vaultRoot, 'Projects');
  if (!fs.existsSync(root)) throw new Error('Projects/ not found in the vault');
  const out = [];
  for (const folder of WORK_FOLDERS) {
    const dir = path.join(root, folder);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md') || / 2\.md$/.test(f) || /sync-conflict/.test(f)) continue;
      let content;
      try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const { meta, body } = frontmatter(content);
      if (SKIP_TYPES.test(meta.type || '')) continue;
      if (folder === 'Fixes Log' && meta.status !== 'included') continue;
      const rel = `Projects/${folder}/${f}`;
      const name = f.replace(/\.md$/, '');
      const text = body.replace(/^#.*$/m, '').trim();
      const created = dateOf(meta.created) || dateOf(meta.date);
      const updated = dateOf(meta.updated);
      const marks = [];
      if (created && created >= w.from && created <= w.to) marks.push(['written', created]);
      if (updated && updated !== created && updated >= w.from && updated <= w.to) marks.push(['updated', updated]);
      for (const [what, day] of marks) {
        const fix = folder === 'Fixes Log';
        out.push({
          id: `note:${what}:${rel}`,
          source: 'work-notes', kind: fix ? 'report-fix' : `note-${what}`, hint: null,
          at: `${day}T12:00:00`,
          title: fix ? `Recorded a fix: ${name.replace(/^\d{4}-\d{2}-\d{2}\s*/, '').replace(/\s*\(fx-[0-9a-f]+\)$/, '')}`
            : `${what === 'written' ? 'Wrote' : 'Updated'} "${name}" (${folder})`,
          detail: clip(text),
          _screenText: text,
          ref: `vault:${rel}`,
        });
      }
    }
  }
  return out;
}

module.exports = { sends, tickets, workforce, people, workNotes, WORK_FOLDERS, _internals: { londonDay, frontmatter } };
