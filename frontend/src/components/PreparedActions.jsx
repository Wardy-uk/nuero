import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './PreparedActions.css';

/**
 * Drafted by NEURO — the governed approval queue (Build 6).
 *
 * Distinct from the cards below it on the Actions screen: those are the legacy
 * queue, whose approve runs an executor directly. These are prepared from a
 * commitment-at-risk finding, and since Build 6 ONE type (a chase) is sent
 * when Nick approves it — exactly the words shown, to exactly the address
 * shown — and then checked in Sent Items.
 *
 * Rules this screen keeps:
 *  1. Everything that would leave is shown verbatim before approval: recipient
 *     address, subject, full body, authority, why, evidence, expiry.
 *  2. Approve sends the payloadHash this screen DISPLAYED. If the draft changed
 *     underneath, the server refuses and the card reloads — you approve what
 *     you read.
 *  3. Edit makes a NEW version that needs its own approval. The recipient is
 *     not editable here.
 *  4. Executed is not verified. The status line says which, in words, and a
 *     send that could not be confirmed says it will not be resent.
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

const ACTIVE = new Set(['prepared', 'approved', 'executing', 'executed', 'execution_uncertain']);

export function age(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((now - t) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function PreparedCard({ action, busy, onApprove, onReject, onEdit }) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(action.draft?.subject || '');
  const [body, setBody] = useState(action.draft?.body || '');
  const to = action.draft?.to?.[0] || {};
  const ev = action.evidence || {};
  const sends = action.executes;
  const open = action.status === 'prepared';
  const canEditFailed = action.status === 'failed' && action.retrySafe === true;

  return (
    <div className="ap-card ap-kind-outbound pa-card">
      <div className="ap-card-head">
        <span className="ap-label">{sends ? 'Chase by email' : 'Holding note (prepare-only)'}</span>
        <span className="pa-authority" title="Consequential external action: needs your explicit approval of the exact message">A4</span>
        {action.version > 1 && <span className="pa-version">v{action.version}</span>}
        <span className="ap-when">prepared {age(action.createdAt)}</span>
      </div>

      <div className={`pa-status pa-status-${action.status}`}>
        {STATUS_WORDS[action.status] || action.status}
        {action.outcomeDetail && action.status !== 'prepared' && <> — {action.outcomeDetail}</>}
        {action.status === 'approved' && action.lastBlock && <> — waiting: {action.lastBlock}</>}
      </div>

      <div className="ap-reason">{action.reason}</div>

      <dl className="ap-fields">
        <div className="ap-field"><dt>To</dt><dd className="mono">{to.name ? `${to.name} <${to.email}>` : to.email}</dd></div>
        <div className="ap-field"><dt>Commitment</dt><dd>{ev.commitment?.description}</dd></div>
        {ev.finding?.summary && <div className="ap-field"><dt>Why now</dt><dd>{ev.finding.summary}</dd></div>}
        {ev.progress?.state && <div className="ap-field"><dt>Progress seen</dt><dd>{ev.progress.state === 'no_evidence' ? 'nothing suggests it moved (your sent mail was checked)' : ev.progress.state}</dd></div>}
        {open && action.expiresAt && <div className="ap-field"><dt>Expires</dt><dd>{new Date(action.expiresAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd></div>}
      </dl>

      {!editing && (
        <>
          <div className="ap-body-label">Subject: <strong>{action.draft?.subject}</strong></div>
          <pre className="ap-body">{action.draft?.body}</pre>
        </>
      )}

      {editing && (
        <div className="pa-edit">
          <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></label>
          <label>Message<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={5000} /></label>
          <p className="pa-note">Saving makes a new version for you to approve. The recipient stays {to.email}.</p>
        </div>
      )}

      {!sends && open && <div className="ap-warn">{action.notExecutableWhy}. Approving records your decision; nothing will be sent.</div>}

      {(open || canEditFailed) && (
        <div className="ap-actions">
          {editing ? (
            <>
              <button className="ap-btn ap-btn-ok" disabled={busy} onClick={() => onEdit({ subject, body }).then((ok) => ok && setEditing(false))}>Save as new version</button>
              <button className="ap-btn ap-btn-ghost" disabled={busy} onClick={() => { setEditing(false); setSubject(action.draft?.subject || ''); setBody(action.draft?.body || ''); }}>Cancel</button>
            </>
          ) : (
            <>
              {open && (
                <button className={`ap-btn ${sends ? 'ap-btn-send' : 'ap-btn-ok'}`} disabled={busy} onClick={onApprove}>
                  {busy ? 'Working…' : sends ? 'Approve & send' : 'Approve (records only)'}
                </button>
              )}
              <button className="ap-btn ap-btn-ghost" disabled={busy} onClick={() => setEditing(true)}>{canEditFailed ? 'Edit & resend…' : 'Edit'}</button>
              {open && <button className="ap-btn ap-btn-ghost" disabled={busy} onClick={onReject}>Reject</button>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function PreparedActions() {
  const [actions, setActions] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [notes, setNotes] = useState([]);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(() => {
    fetch(apiUrl('/api/prepared-actions?limit=50'))
      .then((r) => r.json())
      .then((d) => { if (!d.ok) throw new Error(d.error || 'could not read'); setActions(d.actions || []); setError(null); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (a, verb, body) => {
    setBusyId(a.actionId);
    try {
      const res = await fetch(apiUrl(`/api/prepared-actions/${a.actionId}/${verb}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      const d = await res.json();
      setNotes((n) => [{ ok: !!d.ok, text: d.ok ? (d.detail || d.notice || (verb === 'edit' ? `Saved as version ${d.action?.version}` : 'Done')) : d.error }, ...n].slice(0, 5));
      return !!d.ok;
    } catch (e) {
      setNotes((n) => [{ ok: false, text: e.message }, ...n].slice(0, 5));
      return false;
    } finally {
      setBusyId(null);
      load();
    }
  };

  const approve = (a) => {
    const to = a.draft?.to?.[0]?.email;
    const msg = a.executes
      ? `Send this exact email to ${to}, as you?\n\nSubject: ${a.draft?.subject}\n\nNEURO will then check it arrived in Sent Items. It will not be sent twice.`
      : 'Record your approval? Nothing will be sent.';
    if (!window.confirm(msg)) return;
    post(a, 'approve', { payloadHash: a.payloadHash });
  };

  if (error) return <section className="ap-group pa-section"><div className="ap-error">Drafted actions unavailable: {error}</div></section>;
  if (!actions) return null;
  const live = actions.filter((a) => ACTIVE.has(a.status) || (a.status === 'failed' && a.retrySafe === true));
  const done = actions.filter((a) => !live.includes(a));
  if (!live.length && !done.length) return null;

  return (
    <section className="ap-group pa-section">
      <h3 className="ap-group-title ap-group-outbound">Drafted by NEURO<span className="ap-count">{live.length}</span></h3>
      <p className="ap-group-blurb">
        Prepared from a commitment that looks at risk. A chase is sent only when you approve its exact words, then confirmed in Sent Items.
        Sending a chase does not mark the commitment done.
      </p>
      {notes.map((n, i) => <div key={i} className={`ap-outcome${n.ok ? '' : ' bad'}`}><span className="ap-outcome-mark">{n.ok ? '✓' : '✗'}</span><span className="ap-outcome-text">{n.text}</span></div>)}
      {live.map((a) => (
        <PreparedCard
          key={a.actionId}
          action={a}
          busy={busyId === a.actionId}
          onApprove={() => approve(a)}
          onReject={() => post(a, 'reject', {})}
          onEdit={(fields) => post(a, 'edit', { payloadHash: a.payloadHash, ...fields })}
        />
      ))}
      {done.length > 0 && (
        <>
          <button className="ap-snoozed-toggle" onClick={() => setShowDone((v) => !v)}>
            {showDone ? '▾' : '▸'} {done.length} finished (sent, rejected, expired, cancelled, replaced)
          </button>
          {showDone && done.map((a) => <PreparedCard key={a.actionId} action={a} busy={false} onApprove={() => {}} onReject={() => {}} onEdit={async () => false} />)}
        </>
      )}
    </section>
  );
}
