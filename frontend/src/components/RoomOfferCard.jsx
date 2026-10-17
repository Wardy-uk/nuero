import React, { useState } from 'react';
import { apiFetch } from '../api';
import './RoomOfferCard.css';

/**
 * The room Nick is in, on Now (17 Oct 2026). Nick: "when I'm in a room that is
 * below comfort — give me a mechanism to turn the heating on in that room".
 * NEURO had been composing the offer for a month and only the phone/kiosk
 * surface drew it.
 *
 * Renders `rooms` from /api/canonical/now verbatim: each offer's own sentence
 * and button words, what NEURO is already doing in a room ("Warming the living
 * room to 20°C until you leave"), what it will not offer because it is already
 * happening ("…already warming to 24°C"), and a yes the house refused. A press
 * sends the offer's KEY and nothing else — NEURO re-reads the house, re-derives
 * the offer, and answers with one sentence about what actually happened.
 */
export function RoomOfferView({ rooms, busy = false, note = null, onAnswer = null }) {
  if (!rooms || rooms.known !== true) return null;
  const offers = Array.isArray(rooms.offers) ? rooms.offers.filter((o) => o && o.key && o.say) : [];
  const lines = [
    ...(rooms.heating || []).map((h) => h && h.say),
    ...(rooms.notes || []).map((n) => n && n.say),
    ...(rooms.decided || []).filter((d) => d && d.decision === 'accepted' && d.outcome && d.outcome.ok === false)
      .map((d) => `Tried, but it didn’t take — ${d.outcome.reason || 'Home Assistant refused it'}.`),
  ].filter(Boolean);
  if (!offers.length && !lines.length && !note) return null;
  return (
    <div className="room-offer" data-testid="room-offer">
      {offers.map((o) => (
        <div key={o.key} className="room-offer__row">
          <span className="room-offer__say">{o.say}</span>
          <span className="room-offer__acts">
            <button type="button" className="room-offer__btn room-offer__btn--lead" disabled={busy || !onAnswer}
              onClick={onAnswer ? () => onAnswer(o.key, 'accept') : undefined}>{o.acceptLabel || 'Yes'}</button>
            <button type="button" className="room-offer__btn" disabled={busy || !onAnswer}
              onClick={onAnswer ? () => onAnswer(o.key, 'decline') : undefined}>{o.declineLabel || 'Not now'}</button>
          </span>
        </div>
      ))}
      {lines.map((l) => <p key={l} className="room-offer__line">{l}</p>)}
      {note && <p className={`room-offer__note${note.ok ? '' : ' room-offer__note--bad'}`} role="status">{note.text}</p>}
    </div>
  );
}

export default function RoomOfferCard({ rooms, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const answer = async (key, verb) => {
    setBusy(true); setNote(null);
    try {
      const r = await apiFetch(`/api/rooms/${encodeURIComponent(key)}/${verb}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (verb === 'accept') {
        // NEURO's own sentence — "Warming…" or "Not done — …", never "done" over a refusal.
        setNote({ ok: !!j.ok, text: j.say || (j.ok ? 'Done.' : `Not done — ${j.reason || j.error || `HTTP ${r.status}`}.`) });
      } else if (!j.ok) {
        setNote({ ok: false, text: `Not saved — ${j.reason || j.error || `HTTP ${r.status}`}.` });
      }
      if (onChanged) onChanged();
    } catch (e) {
      setNote({ ok: false, text: `Not done — ${e.message}.` });
    }
    setBusy(false);
  };

  return <RoomOfferView rooms={rooms} busy={busy} note={note} onAnswer={answer} />;
}
