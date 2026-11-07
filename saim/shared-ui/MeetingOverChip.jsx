import { useState } from 'react';
import './MeetingOverChip.css';

/**
 * "It’s over" on SAiM (7 Nov 2026) — the meeting Nick is in ended early.
 *
 * Mirrors NEURO desktop's MeetingControls (frontend/src/components/MeetingControls.jsx):
 * the chip names the OCCURRENCE by the key the server put on the attention
 * payload (`payload.meeting.key`), posts the existing
 * POST /api/attention/meeting/finished { key }, and always offers Undo
 * (POST /api/attention/meeting/resume { key }) — a wrong press costs SAiM
 * speaking up in a real meeting. The server re-reads the live diary, refuses a
 * stale key, refuses a solo block, and writes nothing to the calendar.
 *
 * Props:
 *   meeting   — `payload.meeting` ({ key, subject }) or null → renders nothing.
 *   call      — the shell's transport: call(path, { method, body }) → { status, body }.
 *   readOnly  — the kiosk: renders nothing (it never writes).
 *   onChanged — called after a press landed (re-read the feed).
 */

export const OVER_LABEL = 'It’s over';

/** What SAiM recorded, in plain words — and what it did NOT do. PURE. */
export function overLine(meeting) {
  const name = (meeting && typeof meeting.subject === 'string' && meeting.subject.trim()) || 'the meeting';
  return `“${name}” marked over — SAiM won’t keep quiet for it any more. Nothing was changed in anyone’s calendar.`;
}

/** PURE view. */
export function MeetingOverChipView({ meeting = null, done = null, busy = false, error = null, readOnly = false, onOver, onUndo }) {
  if (readOnly) return null;
  if (done) {
    return (
      <div className="moc" role="status" data-testid="meeting-over-chip">
        <span className="moc__text">{done.line}</span>
        <button type="button" className="moc__btn" disabled={busy} onClick={onUndo}>Undo</button>
        {error && <span className="moc__err">Not undone — {error}</span>}
      </div>
    );
  }
  if (!meeting || !meeting.key) return null;
  return (
    <div className="moc" data-testid="meeting-over-chip">
      <button type="button" className="moc__btn moc__btn--go" disabled={busy} onClick={onOver}
        title={`Tell SAiM “${(meeting.subject || 'this meeting').trim()}” ended early`}>{OVER_LABEL}</button>
      {error && <span className="moc__err">Not saved — {error}</span>}
    </div>
  );
}

/** One press each way. Nothing is retried or done on its own. */
export async function postMeeting(call, path, key) {
  let r;
  try { r = await call(`/api/attention/meeting/${path}`, { method: 'POST', body: { key } }); } catch {
    return { ok: false, error: 'couldn’t reach NEURO' };
  }
  const b = (r && r.body) || {};
  if (r && r.status === 200 && b.ok) return { ok: true, body: b };
  return { ok: false, error: b.error || `HTTP ${r ? r.status : '?'}` };
}

export default function MeetingOverChip({ meeting = null, call, readOnly = false, onChanged = null }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { key, line }
  const [error, setError] = useState(null);
  const run = async (path, key, line) => {
    if (!call || !key) return;
    setBusy(true); setError(null);
    const r = await postMeeting(call, path, key);
    if (r.ok) { setDone(path === 'resume' ? null : { key, line }); if (onChanged) onChanged(); } else setError(r.error);
    setBusy(false);
  };
  return (
    <MeetingOverChipView
      meeting={meeting}
      done={done}
      busy={busy}
      error={error}
      readOnly={readOnly || !call}
      onOver={() => run('finished', meeting && meeting.key, overLine(meeting))}
      onUndo={() => run('resume', done && done.key, null)}
    />
  );
}
