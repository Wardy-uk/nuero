import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './ActionsPanel.css'; // .ap-btn lives there; without it this card is unstyled anywhere but Actions
import './PreparedActions.css';

/**
 * Drafted by NEURO — THE queue for chases and drafted emails (Builds 6–7).
 *
 * One backend truth (`prepared_actions`), shown here on the Actions screen and,
 * filtered to chases, beside the waiting-on list on the People board — the same
 * card, the same approval step, never a second queue. Since Build 7 the Chase
 * button lands here too; the old queue's chase sender is retired.
 *
 * Rules this screen keeps:
 *  1. Everything that would leave is shown verbatim before approval: recipient
 *     address, subject, full body, authority, why, evidence, expiry.
 *  2. Approving takes TWO steps that only Nick can complete: NEURO issues a
 *     single-use challenge for this exact version, and he types his approval
 *     code. The code lives in a password field, is sent once, and is cleared
 *     whatever happens — it is never stored by this app.
 *  3. Approve sends the payloadHash this screen DISPLAYED; a changed draft is
 *     refused and the card reloads — you approve what you read.
 *  4. Edit makes a NEW version that needs its own approval. The recipient is
 *     not editable here.
 *  5. Executed is not verified. The status line says which, in words.
 */

const STATUS_WORDS = {
  prepared: 'Waiting for your approval',
  approved: 'Approved — not sent yet',
  executing: 'Sending…',
  executed: 'Sent by Microsoft — not yet confirmed in Sent Items',
  verified: 'Sent and confirmed in Sent Items',
  execution_uncertain: 'Outcome unclear — will NOT be resent automatically',
  failed: 'Did not send',
  rejected: 'Rejected',
  expired: 'Expired',
  cancelled: 'Cancelled',
  superseded: 'Replaced by an edited version',
};

// The five views of one queue (Build 7I). Order is the reading order.
const SECTIONS = [
  ['needsApproval', 'Needs approval'],
  ['approved', 'Approved — waiting to send'],
  ['executing', 'Sending / checking Sent Items'],
  ['needsReview', 'Needs your review'],
];

export function age(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((now - t) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const ORIGIN_WORDS = {
  'chase-button': 'You pressed Chase',
  risk: 'NEURO saw it was at risk',
  composer: 'You wrote it in the Inbox',
  drafted: 'Drafted from an email card',
  'meeting-triage': 'The invite has no agenda',
  'weekly-risk': 'Queued from Weekly Risk',
  // Build 11K: calendar changes.
  '1to1-book': 'You pressed Book on a 1-2-1',
  '1to1-move': 'You pressed Move on a 1-2-1',
  'event-composer': 'You made it in Calendar',
  chat: 'Asked for in chat',
  'machine-client': 'Prepared by a connected tool',
};

// Build 8: every email NEURO can send is one of these, approved here.
const TYPE_WORDS = {
  chase_commitment: 'Chase by email',
  reply_email: 'Reply to an email',
  chase_agenda: 'Ask an organiser for the agenda',
  send_weekly_risk_report: 'Weekly risk report',
  create_calendar_event: 'Calendar invite',
  reschedule_calendar_event: 'Move a meeting',
  cancel_calendar_event: 'Cancel a meeting',
};

const CALENDAR_TYPES = new Set(['create_calendar_event', 'reschedule_calendar_event', 'cancel_calendar_event']);
// 9 Oct 2026: anything Nick started himself (or NEURO proposed on the screen
// he was using) sends on his click — a one-use intent grant, no code. Must
// match services/intent-grants.js HUMAN_ORIGINS (pinned by a test).
const DIRECT_ORIGINS = new Set(['1to1-book', '1to1-move', '1to1-cancel', 'event-composer', 'composer', 'chase-button', 'weekly-risk', 'chat-attended']);
const INITIATOR_WORDS = {
  human_direct: 'you',
  human_assisted: 'you, from something NEURO drafted',
  neuro_autonomous: 'NEURO',
  scheduler: 'a scheduled job',
  'machine:client': 'a machine client',
};
const PROOF_WORDS = {
  intent_grant: 'your click (one-use)',
  approval_code: 'your approval code',
};
// Approvals given before 9 Oct 2026 by a trusted browser: shown, never produced.
const LEGACY_PROOF = { 'trusted-device': 'Legacy trusted-device confirmation' };
// Wall-clock "YYYY-MM-DDTHH:MM" sliced, never parsed into a Date (the BST bug).
const when = (s) => (s ? `${String(s).slice(0, 10)} ${String(s).slice(11, 16)}` : '—');

const addr = (r) => (r?.name && r.name !== r.email ? `${r.name} <${r.email}>` : r?.email);

// Sends made before the governed path existed: history, never verified.
const LEGACY_WORDS = {
  legacy_chase: 'Chase',
  legacy_reply_email: 'Email reply',
  legacy_chase_agenda: 'Agenda request',
  legacy_weekly_risk_report: 'Weekly risk report',
};

/** Why approval is not possible right now, or null. Shared with the Inbox and Weekly Risk screens. */
export function gateFor(data, a) {
  if (!data) return 'Checking whether approval is possible…';
  // What Nick started needs no code — only the switch for its kind.
  if (DIRECT_ORIGINS.has(a.origin) && a.executes) {
    if (CALENDAR_TYPES.has(a.actionType)) return data.sending?.calendar ? null : 'Calendar changes are switched off (Settings → Switches → "Send approved calendar changes"). Turn it on to send this.';
    return data.sending?.enabled ? null : 'Sending is switched off (Settings → Switches → "Send approved emails"). Turn it on to send this.';
  }
  if (data.approvalLock?.locked) return `Approval is locked after too many wrong codes, until ${String(data.approvalLock.lockedUntil).slice(11, 16)} UTC.`;
  if (!data.approvalCode?.set) return 'No approval code is set yet, so nothing can be approved. Set one in Settings → Approval code.';
  if (a.executes && CALENDAR_TYPES.has(a.actionType) && !data.sending?.calendar) return 'Calendar changes are switched off (Settings → Switches → "Send approved calendar changes"). You can read or reject this; approving is off until that switch is on.';
  if (a.executes && !CALENDAR_TYPES.has(a.actionType) && !data.sending?.enabled) return 'Sending is switched off (Settings → Switches → "Send approved emails"). You can read, edit or reject this; approving is off until sending is on.';
  return null;
}

async function postVerb(a, verb, body) {
  const res = await fetch(apiUrl(`/api/prepared-actions/${a.actionId}/${verb}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return res.json();
}

/**
 * Approve exactly what is on screen: a fresh challenge for this version and
 * hash, then the code. Returns the route's answer ({ ok, error, status, ... }).
 * The ONE approval path every screen uses — Actions, the Inbox composer, the
 * Weekly Risk panel — so none can drift into a second way to send.
 */
export async function approveWithCode(a, code) {
  const ch = await postVerb(a, 'approval-challenge', {});
  if (!ch.ok) return ch;
  return postVerb(a, 'approve', { payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: code });
}

/** The approval gate state (code set, sending switch, lock) from the queue route. */
export async function fetchApprovalState() {
  const d = await fetch(apiUrl('/api/prepared-actions?limit=1')).then((r) => r.json());
  if (!d.ok) throw new Error(d.error || 'could not read');
  return d;
}

/**
 * One drafted action. `gate` — when set — is the reason approval is not
 * possible right now (sending off, no approval code, locked); the card says it
 * instead of offering a button that would be refused.
 */
export function PreparedCard({ action, busy, onApprove, onReject, onEdit, onSendDirect = null, gate = null }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [code, setCode] = useState('');
  const [subject, setSubject] = useState(action.draft?.subject || '');
  const [body, setBody] = useState(action.draft?.body || '');
  const to = action.draft?.to?.[0] || {};
  const toAll = (action.draft?.to || []).map(addr).filter(Boolean);
  const ccAll = (action.draft?.cc || []).map(addr).filter(Boolean);
  const ev = action.evidence || {};
  const t = action.target || {};
  const type = action.actionType;
  const sends = action.executes;
  const open = action.status === 'prepared';
  // The weekly report is generated: it is regenerated on its panel, never
  // hand-edited here (that would break the markdown/HTML the approval binds).
  const calendar = CALENDAR_TYPES.has(type);
  const editable = type !== 'send_weekly_risk_report' && !calendar;
  const d = action.draft || {};
  const canEditFailed = editable && action.status === 'failed' && action.retrySafe === true;
  const direct = !!onSendDirect && sends && DIRECT_ORIGINS.has(action.origin);
  const who = toAll.length + ccAll.length > 1 ? `${toAll.length + ccAll.length} people` : (to.email || 'them');

  const confirm = async () => {
    const typed = code;
    setCode('');                       // cleared before the request, whatever it answers
    const ok = await onApprove(typed);
    if (ok) setConfirming(false);
  };

  return (
    <div className="ap-card ap-kind-outbound pa-card">
      <div className="ap-card-head">
        <span className="ap-label">{sends ? (TYPE_WORDS[type] || type) : 'Holding note (prepare-only)'}</span>
        <span className="pa-authority" title="Consequential external action: needs your explicit approval of the exact message">A4</span>
        {action.version > 1 && <span className="pa-version">v{action.version}</span>}
        {ORIGIN_WORDS[action.origin] && <span className="pa-origin">{ORIGIN_WORDS[action.origin]}</span>}
        <span className="ap-when">prepared {age(action.createdAt)}</span>
      </div>

      <div className={`pa-status pa-status-${action.status}`}>
        {STATUS_WORDS[action.status] || action.status}
        {action.outcomeDetail && action.status !== 'prepared' && <> — {action.outcomeDetail}</>}
        {action.status === 'approved' && action.lastBlock && <> — waiting: {action.lastBlock}</>}
      </div>
      {action.approval?.initiatedBy && (
        // Provenance, as the server recorded it — never re-derived here.
        <div className="pa-note pa-provenance">
          Started by {INITIATOR_WORDS[action.approval.initiatedBy] || action.approval.initiatedBy}
          {' · '}confirmed by {PROOF_WORDS[action.approval.authorityProof] || action.approval.authorityProof || 'unknown'}
        </div>
      )}
      {!action.approval?.initiatedBy && LEGACY_PROOF[action.approval?.mechanism] && (
        <div className="pa-note pa-provenance">{LEGACY_PROOF[action.approval.mechanism]}</div>
      )}

      <div className="ap-reason">{action.reason}</div>

      <dl className="ap-fields">
        <div className="ap-field"><dt>{calendar ? 'Attendees' : 'To'}</dt><dd className="mono">{toAll.join(', ')}</dd></div>
        {calendar && (
          <>
            <div className="ap-field"><dt>Title</dt><dd>{d.subject}</dd></div>
            {type === 'reschedule_calendar_event' && <div className="ap-field"><dt>From</dt><dd>{when(t.fromStart)}–{String(t.fromEnd || '').slice(11, 16)}</dd></div>}
            <div className="ap-field"><dt>{type === 'reschedule_calendar_event' ? 'To' : 'When'}</dt><dd>{when(d.start)}–{String(d.end || '').slice(11, 16)} <span className="pa-tz">({d.timeZone || 'Europe/London'})</span></dd></div>
            <div className="ap-field"><dt>Calendar</dt><dd>{d.calendar?.name || 'Outlook (your default calendar)'}</dd></div>
            {d.location && <div className="ap-field"><dt>Location</dt><dd>{d.location}</dd></div>}
            {type === 'create_calendar_event' && <div className="ap-field"><dt>Online</dt><dd>{d.isOnline ? 'Teams link added' : 'No online link'}</dd></div>}
            {d.recurrence && <div className="ap-field"><dt>Repeats</dt><dd>{typeof d.recurrence === 'string' ? d.recurrence : JSON.stringify(d.recurrence)}</dd></div>}
          </>
        )}
        {ccAll.length > 0 && <div className="ap-field"><dt>Cc</dt><dd className="mono">{ccAll.join(', ')}</dd></div>}
        {ev.commitment?.description && <div className="ap-field"><dt>Commitment</dt><dd>{ev.commitment.description}</dd></div>}
        {type === 'reply_email' && <div className="ap-field"><dt>In reply to</dt><dd>{t.fromName || t.from} — “{t.originalSubject || '(no subject)'}”{action.draft?.mode === 'replyAll' ? ' · reply-all' : ''}</dd></div>}
        {type === 'reply_email' && ev.recipientsFrom && <div className="ap-field"><dt>Recipients from</dt><dd>{ev.recipientsFrom}</dd></div>}
        {type === 'chase_agenda' && <div className="ap-field"><dt>Meeting</dt><dd>{t.subject} · {String(t.start || '').slice(0, 16).replace('T', ' ')}</dd></div>}
        {type === 'send_weekly_risk_report' && <div className="ap-field"><dt>Report</dt><dd>w/c {t.week} · version {t.reportVersion}{t.snapshotDate ? ` · data as at ${t.snapshotDate}` : ''}{t.recipientSource === 'manual' ? ' · address typed by hand' : ''}</dd></div>}
        {ev.finding?.summary && <div className="ap-field"><dt>Why now</dt><dd>{ev.finding.summary}</dd></div>}
        {ev.progress?.state && <div className="ap-field"><dt>Progress seen</dt><dd>{ev.progress.state === 'no_evidence' ? 'nothing suggests it moved (your sent mail was checked)' : ev.progress.state}</dd></div>}
        {open && action.expiresAt && <div className="ap-field"><dt>Expires</dt><dd>{new Date(action.expiresAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd></div>}
        {action.approval?.mechanism && <div className="ap-field"><dt>Approved</dt><dd>{action.approval.by} · {action.approval.mechanism}</dd></div>}
      </dl>

      {!editing && !calendar && (
        <>
          <div className="ap-body-label">Subject: <strong>{action.draft?.subject}</strong></div>
          <pre className="ap-body">{action.draft?.body}</pre>
        </>
      )}
      {!editing && calendar && d.body && (
        <>
          <div className="ap-body-label">{type === 'cancel_calendar_event' ? 'Cancellation note' : 'Agenda / body'} sent to attendees</div>
          <pre className="ap-body">{d.body}</pre>
        </>
      )}

      {editing && (
        <div className="pa-edit">
          <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></label>
          <label>Message<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={5000} /></label>
          <p className="pa-note">Saving makes a new version for you to approve. The recipients stay {[...toAll, ...ccAll].join(', ')}.</p>
        </div>
      )}

      {!sends && open && <div className="ap-warn">{action.notExecutableWhy}. Approving records your decision; nothing will be sent.</div>}
      {open && gate && <div className="ap-warn pa-gate">{gate}</div>}

      {confirming && open && (
        <div className="pa-confirm">
          <p className="pa-note">
            {sends && calendar
              ? <>This makes <strong>exactly the calendar change above</strong> as you — Microsoft tells <span className="mono">{who}</span> — then reads the event back to confirm it. It is never done twice.</>
              : sends
                ? <>This sends <strong>exactly the {type === 'send_weekly_risk_report' ? 'report' : 'email'} above</strong> to <span className="mono">{who}</span>, as you, then checks Sent Items. It is never sent twice.</>
                : 'This records your approval. Nothing will be sent.'}
          </p>
          <label className="pa-code">
            Approval code
            <input
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && code) confirm(); }}
            />
          </label>
          <div className="ap-actions">
            <button className={`ap-btn ${sends ? 'ap-btn-send' : 'ap-btn-ok'}`} disabled={busy || !code} onClick={confirm}>
              {busy ? 'Working…' : sends ? 'Approve & send' : 'Approve'}
            </button>
            <button className="ap-btn ap-btn-ghost" disabled={busy} onClick={() => { setConfirming(false); setCode(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {(open || canEditFailed) && !confirming && (
        <div className="ap-actions">
          {editing ? (
            <>
              <button className="ap-btn ap-btn-ok" disabled={busy} onClick={() => onEdit({ subject, body }).then((ok) => ok && setEditing(false))}>Save as new version</button>
              <button className="ap-btn ap-btn-ghost" disabled={busy} onClick={() => { setEditing(false); setSubject(action.draft?.subject || ''); setBody(action.draft?.body || ''); }}>Cancel</button>
            </>
          ) : (
            <>
              {open && direct && (
                // 9 Oct 2026: Nick started this himself (Book / Move / the
                // composer), so the press is the decision — one-use grant, no code.
                <button className="ap-btn ap-btn-send" disabled={busy || !!gate} onClick={onSendDirect}>Send</button>
              )}
              {open && !direct && (
                <button className={`ap-btn ${sends ? 'ap-btn-send' : 'ap-btn-ok'}`} disabled={busy || !!gate} onClick={() => setConfirming(true)}>
                  {sends ? 'Approve & send…' : 'Approve (records only)…'}
                </button>
              )}
              {(editable && (open || canEditFailed)) && <button className="ap-btn ap-btn-ghost" disabled={busy} onClick={() => setEditing(true)}>{canEditFailed ? 'Edit & resend…' : 'Edit'}</button>}
              {open && <button className="ap-btn ap-btn-ghost" disabled={busy} onClick={onReject}>Reject</button>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A chase the retired old queue sent: history, never verified. */
export function LegacyCard({ item }) {
  return (
    <div className="ap-card pa-card pa-legacy">
      <div className="ap-card-head">
        <span className="ap-label">{LEGACY_WORDS[item.actionType] || 'Old queue send'} ({item.provenance === 'inbox_composer' ? 'sent straight from the Inbox' : 'old queue'})</span>
        <span className="pa-legacy-tag">legacy · unverified · pre-ledger</span>
        <span className="ap-when">{item.occurredAt ? String(item.occurredAt).slice(0, 16) : 'date unknown'}</span>
      </div>
      <dl className="ap-fields">
        <div className="ap-field"><dt>To</dt><dd className="mono">{item.target?.email || 'not recorded'}{item.target?.source === 'manual' ? ' (typed by hand)' : ''}</dd></div>
        <div className="ap-field"><dt>About</dt><dd>{item.target?.name || '—'}</dd></div>
      </dl>
      <p className="pa-note">{item.note}</p>
    </div>
  );
}

/**
 * The queue. Props let the People board show the same queue filtered to its
 * chases: `filter(action)`, `title`, `showLegacy`.
 */
export default function PreparedActions({ filter = null, title = 'Drafted by NEURO', showLegacy = true, blurb = true }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [notes, setNotes] = useState([]);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(() => {
    fetch(apiUrl('/api/prepared-actions?limit=50'))
      .then((r) => r.json())
      .then((d) => { if (!d.ok) throw new Error(d.error || 'could not read'); setData(d); setError(null); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const say = (ok, text) => setNotes((n) => [{ ok, text }, ...n].slice(0, 5));

  const post = postVerb;

  const act = async (a, verb, body) => {
    setBusyId(a.actionId);
    try {
      const d = await post(a, verb, body);
      say(!!d.ok, d.ok ? (d.detail || d.notice || (verb === 'edit' ? `Saved as version ${d.action?.version}` : 'Done')) : d.error);
      return !!d.ok;
    } catch (e) {
      say(false, e.message);
      return false;
    } finally {
      setBusyId(null);
      load();
    }
  };

  // 9 Oct 2026: one click on something Nick started — grant, then send.
  const sendDirect = async (a) => {
    setBusyId(a.actionId);
    try {
      const o = directOutcome(await executeDirect(a));
      say(o.tone === 'ok', o.text);
    } catch (e) {
      say(false, e.message);
    } finally {
      setBusyId(null);
      load();
    }
  };

  // Approval: a fresh challenge for exactly what is on screen, then the code.
  const approve = async (a, code) => {
    setBusyId(a.actionId);
    try {
      const d = await approveWithCode(a, code);
      say(!!d.ok, d.ok ? (d.detail || d.notice || 'Approved') : d.error);
      return !!d.ok;
    } catch (e) {
      say(false, e.message);
      return false;
    } finally {
      setBusyId(null);
      load();
    }
  };

  if (error) return <section className="ap-group pa-section"><div className="ap-error">Drafted actions unavailable: {error}</div></section>;
  if (!data) return null;

  const all = (data.actions || []).filter((a) => (filter ? filter(a) : true));
  const byId = new Map(all.map((a) => [a.actionId, a]));
  const buckets = data.buckets || {};
  const pick = (k) => (buckets[k] || []).map((id) => byId.get(id)).filter(Boolean);
  const history = pick('history');
  const legacy = showLegacy ? (data.legacy || []) : [];
  const liveCount = SECTIONS.reduce((n, [k]) => n + pick(k).length, 0);
  if (!liveCount && !history.length && !legacy.length && !notes.length) return null;

  return (
    <section className="ap-group pa-section">
      <h3 className="ap-group-title ap-group-outbound">{title}<span className="ap-count">{liveCount}</span></h3>
      {blurb && (
        <p className="ap-group-blurb">
          Every email NEURO can send as you: chases, replies you wrote in the Inbox, agenda requests and the weekly risk report.
          What NEURO drafted is sent only when you approve its exact words and recipients with your approval code; what you started yourself sends on your click. Either way it is confirmed in Sent Items.
          Sending never marks anything done.
        </p>
      )}
      {notes.map((n, i) => <div key={i} className={`ap-outcome${n.ok ? '' : ' bad'}`}><span className="ap-outcome-mark">{n.ok ? '✓' : '✗'}</span><span className="ap-outcome-text">{n.text}</span></div>)}
      {SECTIONS.map(([k, label]) => {
        const items = pick(k);
        if (!items.length) return null;
        return (
          <div key={k} className="pa-bucket">
            <h4 className="pa-bucket-title">{label}<span className="ap-count">{items.length}</span></h4>
            {items.map((a) => (
              <PreparedCard
                key={a.actionId}
                action={a}
                busy={busyId === a.actionId}
                gate={gateFor(data, a)}
                onApprove={(code) => approve(a, code)}
                onSendDirect={() => sendDirect(a)}
                onReject={() => act(a, 'reject', {})}
                onEdit={(fields) => act(a, 'edit', { payloadHash: a.payloadHash, ...fields })}
              />
            ))}
          </div>
        );
      })}
      {(history.length > 0 || legacy.length > 0) && (
        <>
          <button className="ap-snoozed-toggle" onClick={() => setShowDone((v) => !v)}>
            {showDone ? '▾' : '▸'} History — {history.length} finished{legacy.length ? `, ${legacy.length} from the old queue (unverified)` : ''}
          </button>
          {showDone && history.map((a) => <PreparedCard key={a.actionId} action={a} busy={false} onApprove={async () => false} onReject={() => {}} onEdit={async () => false} />)}
          {showDone && legacy.map((l) => <LegacyCard key={l.legacyRef} item={l} />)}
        </>
      )}
    </section>
  );
}
