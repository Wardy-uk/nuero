import { useEffect, useState } from 'react';
import { sendPrepared, sendOutcome } from './sendPrepared.mjs';
import { SWITCH_LABEL, gateOf, isSwitchedOff, switchFor, turnOnAndSend } from './turnOnAndSend.mjs';
import './PreparedSend.css';

/**
 * ONE prepared action, finished where Nick is looking (7 Nov 2026).
 *
 * The exact words and recipients, then Send — a one-use intent grant bound to
 * the version and payload hash on screen (sendPrepared.mjs) — with Edit (a new
 * version) and Reject in place. Used by SAiM's home "Needs you", the Drafts
 * page, Commitments / People chases and Meeting prep, on the phone and the
 * desktop alike, so "approve it at the desk" is never the only way to finish.
 *
 * Rules kept from the Actions card:
 *  • What leaves is shown verbatim before the press (to, subject, body).
 *  • Sent is not verified: the outcome line says which, from the server.
 *  • A send blocked only by its switch offers to turn that switch on and send.
 *  • `call` null (the kiosk) → the draft is shown and nothing can be pressed.
 */

const TYPE_WORDS = {
  chase_commitment: 'Chase',
  reply_email: 'Reply',
  compose_email: 'Email',
  chase_agenda: 'Agenda request',
  send_weekly_risk_report: 'Weekly risk report',
  send_soap_report: 'SOAP report',
  create_calendar_event: 'Invite',
  reschedule_calendar_event: 'Move a meeting',
  cancel_calendar_event: 'Cancel a meeting',
};
const CALENDAR = /^(create|reschedule|cancel)_calendar_event$/;
const GENERATED = new Set(['send_weekly_risk_report', 'send_soap_report']);

const who = (list) => (Array.isArray(list) ? list : []).map((r) => (r && (r.name || r.email)) || (typeof r === 'string' ? r : null)).filter(Boolean);
const slot = (s) => (s ? `${String(s).slice(0, 10)} ${String(s).slice(11, 16)}` : '');

export default function PreparedSend({
  action,
  call = null,
  sending = null,
  surface = 'neuro-web',
  onChanged = null,
  allowEdit = true,
  allowReject = true,
  compact = false,
  sendLabel = null,
}) {
  const [cur, setCur] = useState(action);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // { tone, text, sent? }
  const [off, setOff] = useState(null);         // the switch the server said is off
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState((action && action.draft && action.draft.subject) || '');
  const [body, setBody] = useState((action && action.draft && action.draft.body) || '');
  useEffect(() => {
    setCur(action);
    setSubject((action && action.draft && action.draft.subject) || '');
    setBody((action && action.draft && action.draft.body) || '');
  }, [action && action.actionId, action && action.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cur) return null;

  const d = cur.draft || {};
  const type = cur.actionType;
  const calendar = CALENDAR.test(String(type || ''));
  const to = who(d.to);
  const cc = who(d.cc);
  const open = cur.status === 'prepared';
  const canAct = Boolean(call) && open && !(outcome && outcome.sent);
  const editable = allowEdit && !calendar && !GENERATED.has(type);
  const gate = gateOf(sending, cur) || (off ? { key: off, label: SWITCH_LABEL[off] } : null);
  const label = sendLabel || (calendar ? (type === 'create_calendar_event' ? 'Book & send invite' : 'Send the change') : 'Send');

  const reload = async () => {
    try {
      const r = await call(`/api/prepared-actions/${encodeURIComponent(cur.actionId)}`);
      if (r && r.status === 200 && r.body && r.body.action) setCur(r.body.action);
    } catch { /* the outcome line already says what happened */ }
  };

  const send = async (turnOn = false) => {
    if (busy) return;
    setBusy(true); setOutcome(null);
    try {
      const r = turnOn ? await turnOnAndSend(call, cur, { surface }) : await sendPrepared(call, cur, { surface });
      if (isSwitchedOff(r)) {
        setOff(switchFor(cur));
        setOutcome({ tone: 'warn', text: `“${SWITCH_LABEL[switchFor(cur)]}” is switched off, so nothing was sent.` });
      } else {
        const o = sendOutcome(r);
        setOutcome({ ...o, sent: Boolean(r && r.ok) });
        if (r && r.ok) { setOff(null); if (r.action) setCur(r.action); if (onChanged) onChanged(r); }
        if (r && r.needsConfirm) await reload();
      }
    } catch (e) { setOutcome({ tone: 'bad', text: `Not sent — ${e.message || 'unknown error'}` }); }
    setBusy(false);
  };

  const reject = async () => {
    if (busy) return;
    setBusy(true); setOutcome(null);
    try {
      const r = await call(`/api/prepared-actions/${encodeURIComponent(cur.actionId)}/reject`, { method: 'POST', body: {} });
      if (r && r.body && r.body.ok) {
        if (r.body.action) setCur(r.body.action);
        setOutcome({ tone: 'ok', text: 'Rejected — nothing was sent.', sent: true });
        if (onChanged) onChanged(r.body);
      } else setOutcome({ tone: 'bad', text: `Not rejected — ${(r && r.body && r.body.error) || `HTTP ${r && r.status}`}` });
    } catch (e) { setOutcome({ tone: 'bad', text: `Not rejected — ${e.message}` }); }
    setBusy(false);
  };

  const saveEdit = async () => {
    if (busy) return;
    setBusy(true); setOutcome(null);
    try {
      const r = await call(`/api/prepared-actions/${encodeURIComponent(cur.actionId)}/edit`, { method: 'POST', body: { payloadHash: cur.payloadHash, subject, body } });
      if (r && r.body && r.body.ok && r.body.action) {
        setCur(r.body.action); setEditing(false);
        setOutcome({ tone: 'ok', text: `Saved as version ${r.body.action.version} — press ${label} to send it.` });
        if (onChanged) onChanged(r.body);
      } else setOutcome({ tone: 'bad', text: `Not saved — ${(r && r.body && r.body.error) || `HTTP ${r && r.status}`}` });
    } catch (e) { setOutcome({ tone: 'bad', text: `Not saved — ${e.message}` }); }
    setBusy(false);
  };

  return (
    <div className={`psend${compact ? ' psend--compact' : ''}`} data-action-id={cur.actionId} data-status={cur.status}>
      <div className="psend__head">
        <span className="psend__type">{TYPE_WORDS[type] || 'Draft'}</span>
        <span className="psend__to">{calendar ? '' : 'to '}{to.join(', ') || 'nobody named'}{cc.length ? ` · cc ${cc.join(', ')}` : ''}</span>
      </div>
      {calendar ? (
        <p className="psend__line">“{d.subject || 'Untitled'}” · {slot(d.start)}–{String(d.end || '').slice(11, 16)}</p>
      ) : editing ? (
        <div className="psend__edit">
          <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></label>
          <label>Message<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} maxLength={5000} /></label>
          <p className="psend__note">Saving makes a new version. The recipients stay {[...to, ...cc].join(', ') || 'as they are'}.</p>
        </div>
      ) : (
        <>
          <p className="psend__subject">{d.subject || '(no subject)'}</p>
          {d.body && (compact
            ? <details className="psend__more"><summary>Read it</summary><pre className="psend__body">{d.body}</pre></details>
            : <pre className="psend__body">{d.body}</pre>)}
        </>
      )}
      {!open && !(outcome && outcome.sent) && <p className="psend__note">{cur.status === 'verified' ? 'Already sent — checked in Sent Items.' : `It is ${String(cur.status || 'not waiting').replace(/_/g, ' ')} — nothing to send here.`}</p>}
      {outcome && <p className={`psend__outcome psend__outcome--${outcome.tone}`} role="status">{outcome.text}</p>}
      {canAct && (
        <div className="psend__acts">
          {editing ? (
            <>
              <button type="button" className="psend__go" disabled={busy} onClick={saveEdit}>Save as new version</button>
              <button type="button" className="psend__quiet" disabled={busy} onClick={() => { setEditing(false); setSubject(d.subject || ''); setBody(d.body || ''); }}>Cancel</button>
            </>
          ) : (
            <>
              {gate
                ? <button type="button" className="psend__go" disabled={busy} onClick={() => send(true)} data-turn-on={gate.key}>{busy ? 'Sending…' : `Turn on “${gate.label}” and send`}</button>
                : <button type="button" className="psend__go" disabled={busy} onClick={() => send(false)}>{busy ? 'Sending…' : (outcome && /press again/.test(outcome.text) ? `${label} this version` : label)}</button>}
              {editable && <button type="button" className="psend__quiet" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
              {allowReject && <button type="button" className="psend__quiet" disabled={busy} onClick={reject}>Reject</button>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
