import { useState } from 'react';
import { sendPrepared, sendOutcome } from './sendPrepared.mjs';
import { SWITCH_LABEL, isSwitchedOff, switchFor, turnOnAndSend } from './turnOnAndSend.mjs';
import './ChatProposal.css';

/**
 * An exact action SAiM prepared in this chat (9 Oct 2026; shared 7 Nov 2026):
 * a meeting invite or an email reply, shown in full, sent only when Nick
 * presses the button — a one-use intent grant bound to exactly what is shown.
 * No Actions card. ONE component for the NEURO desktop chat and SAiM's Chat on
 * the phone, so asking her by voice can finish the job where he asked.
 *
 * `call(path, {method, body}) → {status, body}` is the shell's authenticated
 * client; null renders the proposal with no button.
 */
export default function ChatProposal({ action, call = null, surface = 'neuro-web' }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { x, o }
  const [off, setOff] = useState(false);
  const d = (action && action.draft) || {};
  const calendar = /calendar/.test((action && action.actionType) || '');
  const who = (d.to || []).map((r) => (r && (r.name || r.email)) || r).filter(Boolean).join(', ');
  const go = async (turnOn = false) => {
    setBusy(true);
    try {
      const x = turnOn ? await turnOnAndSend(call, action, { surface }) : await sendPrepared(call, action, { surface });
      if (isSwitchedOff(x)) { setOff(true); setResult({ x, o: { tone: 'warn', text: `“${SWITCH_LABEL[switchFor(action)]}” is switched off, so nothing was sent.` } }); }
      else { if (x.ok) setOff(false); setResult({ x, o: sendOutcome(x) }); }
    } catch (e) { setResult({ x: { ok: false }, o: { tone: 'bad', text: e.message } }); }
    setBusy(false);
  };
  if (!action) return null;
  const done = result && result.x.ok;
  const label = busy ? (calendar ? 'Booking…' : 'Sending…')
    : off ? `Turn on “${SWITCH_LABEL[switchFor(action)]}” and ${calendar ? 'book' : 'send'}`
      : result && result.x && result.x.needsConfirm ? 'Confirm again & send'
        : calendar ? 'Book & send invite' : 'Send reply';
  return (
    <div className="chat-proposal" data-action-id={action.actionId}>
      <div className="chat-proposal-head">{calendar ? 'Invite' : 'Reply'} — {d.subject}</div>
      {calendar
        ? <div className="chat-proposal-line">{String(d.start || '').slice(0, 10)} {String(d.start || '').slice(11, 16)}–{String(d.end || '').slice(11, 16)} · {who}</div>
        : <><div className="chat-proposal-line">To {who}</div><pre className="chat-proposal-body">{d.body}</pre></>}
      {result && <div className={`chat-proposal-outcome chat-proposal-${result.o.tone}`} role="status">{result.o.text}</div>}
      {!done && call && (
        <button type="button" className="btn btn-primary chat-proposal-btn" onClick={() => go(off)} disabled={busy}>{label}</button>
      )}
    </div>
  );
}
