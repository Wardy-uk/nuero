import React, { useState } from 'react';
import { apiFetch } from '../api';
import './MeetingControls.css';

/**
 * The meeting Nick is in, or the next one today, and what he can tell NEURO
 * about it (13 Oct 2026): "It's over" (finished early), "I'm not in it" /
 * "I'm not going" (missed it, or skipping it). Each names an OCCURRENCE by the
 * key the server gave it; the server re-reads the live diary and writes
 * nothing to the calendar. Undo is always offered — a wrong press costs SAiM
 * speaking up in a real meeting.
 */
export default function MeetingControls({ meeting = null, nextMeeting = null, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { key, line }
  const [err, setErr] = useState(null);

  const post = async (path, key, line) => {
    setBusy(true); setErr(null);
    try {
      const r = await apiFetch(`/api/attention/meeting/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setDone(path === 'resume' ? null : { key, line });
      if (onChanged) onChanged();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="mtg-row" data-testid="meeting-controls">
        <span className="mtg-text">{done.line}</span>
        <button type="button" className="mtg-btn" disabled={busy} onClick={() => post('resume', done.key, null)}>Undo</button>
        {err && <span className="mtg-err">Not undone — {err}</span>}
      </div>
    );
  }
  if (!meeting && !nextMeeting) return null;

  return (
    <div className="mtg-row" data-testid="meeting-controls">
      {meeting ? (
        <>
          <span className="mtg-text">In <strong>{meeting.subject || 'a meeting'}</strong></span>
          <button type="button" className="mtg-btn" disabled={busy}
            onClick={() => post('finished', meeting.key, `“${meeting.subject || 'Meeting'}” marked over.`)}>It’s over</button>
          <button type="button" className="mtg-btn" disabled={busy}
            onClick={() => post('not-attending', meeting.key, `Not in “${meeting.subject || 'that meeting'}”.`)}>I’m not in it</button>
        </>
      ) : (
        <>
          <span className="mtg-text">Next: <strong>{nextMeeting.subject || 'a meeting'}</strong>{nextMeeting.time ? ` at ${nextMeeting.time}` : ''}</span>
          <button type="button" className="mtg-btn" disabled={busy}
            onClick={() => post('not-attending', nextMeeting.key, `Not going to “${nextMeeting.subject || 'that meeting'}”.`)}>I’m not going</button>
        </>
      )}
      {err && <span className="mtg-err">Not saved — {err}</span>}
    </div>
  );
}
