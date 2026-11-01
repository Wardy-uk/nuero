import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './RoomOfferCard.css';

/**
 * The router restart question, on Now (1 Nov 2026). Outside the safe hours
 * NEURO asks before restarting the home router; inside them it just does it.
 * Renders `routerRestart` from the attention payload verbatim. NEURO re-checks
 * the router is still wedging before it acts, and answers in its own words.
 */
export function RouterRestartView({ routerRestart, busy = false, note = null, onAnswer = null }) {
  const ask = routerRestart && routerRestart.ask;
  const line = routerRestart && routerRestart.note;
  if (!ask && !line && !note) return null;
  return (
    <div className="room-offer" data-testid="router-restart">
      {ask && (
        <div className="room-offer__row">
          <span className="room-offer__say">{ask.say}</span>
          <span className="room-offer__acts">
            <button type="button" className="room-offer__btn room-offer__btn--lead" disabled={busy || !onAnswer}
              onClick={onAnswer ? () => onAnswer(ask.id, 'approve') : undefined}>{busy ? 'Restarting…' : (ask.acceptLabel || 'Restart now')}</button>
            <button type="button" className="room-offer__btn" disabled={busy || !onAnswer}
              onClick={onAnswer ? () => onAnswer(ask.id, 'decline') : undefined}>{ask.declineLabel || 'Not now'}</button>
          </span>
        </div>
      )}
      {line && <p className="room-offer__line">{line}</p>}
      {note && <p className={`room-offer__note${note.ok ? '' : ' room-offer__note--bad'}`} role="status">{note.text}</p>}
    </div>
  );
}

export default function RouterRestartCard({ routerRestart, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const answer = async (id, decision) => {
    setBusy(true); setNote(null);
    try {
      const r = await apiFetch('/api/router/restart/answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, decision }),
      });
      const j = await r.json().catch(() => ({}));
      setNote({ ok: !!j.ok, text: j.say || (j.ok ? 'Done.' : `Not done — ${j.error || `HTTP ${r.status}`}.`) });
      if (onChanged) onChanged();
    } catch (e) {
      setNote({ ok: false, text: `Not done — ${e.message}.` });
    }
    setBusy(false);
  };
  return <RouterRestartView routerRestart={routerRestart} busy={busy} note={note} onAnswer={answer} />;
}

/** Settings → Router auto-restart: on/off and the safe hours (London time). */
export function RouterAutofixSettings() {
  const [s, setS] = useState(null);
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => apiFetch('/api/router/autofix')
    .then((r) => r.json())
    .then((j) => { setS(j); setDraft(j.settings); })
    .catch((e) => setMsg({ ok: false, text: `Couldn’t read the settings — ${e.message}` }));
  useEffect(() => { load(); }, []);
  const save = async () => {
    setMsg(null);
    try {
      const r = await apiFetch('/api/router/autofix', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setMsg({ ok: true, text: 'Saved.' });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  };
  if (!draft) return msg ? <div className="admin-error">{msg.text}</div> : <div className="admin-ms-desc">Loading…</div>;
  const last = s && Array.isArray(s.restarts) ? s.restarts[0] : null;
  return (
    <div className="admin-ms-section">
      <div className="admin-ms-desc">
        When the router starts to wedge, NEURO restarts it. Inside the safe hours it does it on its own; outside them it asks
        first — on your phone, SAiM, Now and the family wall. One restart per wedge, at least 6 hours apart; Wi-Fi drops for about 2 minutes.
      </div>
      <label className="admin-pin-label">
        <input type="checkbox" checked={!!draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Restart the router automatically
      </label>
      <label className="admin-pin-label">Safe hours from
        <input className="admin-pin-input" type="time" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
      </label>
      <label className="admin-pin-label">to
        <input className="admin-pin-input" type="time" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
      </label>
      <button className="admin-ms-connect-btn" type="button" onClick={save}>Save</button>
      {msg && <div className={msg.ok ? 'admin-ms-desc' : 'admin-error'}>{msg.text}</div>}
      {last && (
        <div className="admin-ms-desc">
          Last restart: {new Date(last.at).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })}
          {' — '}{last.by === 'auto' ? 'automatic' : `approved by ${last.by}`}{' — '}
          {{ verified: 'came back', pending: 'checking', 'not-verified': 'did not come back', failed: `couldn’t get in (${last.why || 'no shell'})` }[last.outcome] || last.outcome}
        </div>
      )}
    </div>
  );
}
