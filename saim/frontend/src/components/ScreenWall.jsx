import { useCallback, useEffect, useState } from 'react';
import Wall from '../../../../vesta/src/views/Wall';
import Field from '../../../shared-ui/Field';
import './ScreenWall.css';

// The family wall on a SHARED room screen — the living room and the bedroom
// (Nick, 22 Oct 2026): VESTA's cinema view, fused with SAiM.
//
// ⚠ THE WALL ACTS AS THE HOUSEHOLD. It is VESTA's own component, reading and
// writing NEURO's public VESTA mount through `saim/backend`'s household door
// (`/api/v` → src/routes/household.js), which signs in as the household account
// server-side. Whoever is on the sofa sees and changes what the family login
// may — never Nick's work, never his health.
//
// SAiM is in the scene, not beside it:
//  • her FIELD, between the photograph and the panels, calm and amber. It is
//    deliberately NOT driven by his attention feed: a red pulse on the family's
//    screen would announce that his work is pressing, which is his business.
//  • her LINE under the date — the room verdict's own sentence ("In the study."),
//    composed server-side, or nothing.
//  • the ROOM OFFER (warm this room until you leave, a light) while he is in
//    this room — the same offer and the same accept/decline NEURO already makes.

function useRoomOffers(enabled, area) {
  const [offers, setOffers] = useState([]);
  const [note, setNote] = useState(null);
  const load = useCallback(() => {
    if (!enabled) { setOffers([]); return Promise.resolve(); }
    return fetch('/api/rooms')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = (d && Array.isArray(d.offers) ? d.offers : [])
          .filter((o) => !area || !o.area || String(o.area).toLowerCase() === String(area).toLowerCase());
        setOffers(list);
      })
      .catch(() => setOffers([]));
  }, [enabled, area]);
  useEffect(() => {
    load();
    if (!enabled) return undefined;
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [enabled, load]);
  const answer = useCallback(async (key, yes) => {
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(key)}/${yes ? 'accept' : 'decline'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      // A 200 carrying ok:false is a refusal, not a success.
      setNote(d && d.ok === false ? (d.say || d.reason || 'That didn’t go through.') : (yes ? (d.say || 'Done.') : null));
    } catch {
      setNote("Couldn't reach the house.");
    }
    load();
  }, [load]);
  return { offers, answer, note, clearNote: () => setNote(null) };
}

function OfferCard({ offer, onAnswer }) {
  return (
    <div className="screenwall__offer">
      <p className="screenwall__offer-say">{offer.say}</p>
      <div className="screenwall__offer-acts">
        <button type="button" onClick={() => onAnswer(offer.key, true)}>{offer.acceptLabel || 'Yes'}</button>
        <button type="button" className="screenwall__offer-no" onClick={() => onAnswer(offer.key, false)}>{offer.declineLabel || 'Not now'}</button>
      </div>
    </div>
  );
}

export default function ScreenWall({ say = null, nickHere = false, area = null, onWork = null }) {
  const { offers, answer, note, clearNote } = useRoomOffers(nickHere, area);
  useEffect(() => {
    if (!note) return undefined;
    const t = setTimeout(clearNote, 8000);
    return () => clearTimeout(t);
  }, [note]); // eslint-disable-line react-hooks/exhaustive-deps

  const card = offers.length
    ? <OfferCard offer={offers[0]} onAnswer={answer} />
    : note ? <div className="screenwall__offer"><p className="screenwall__offer-say">{note}</p></div> : null;

  const fusion = {
    field: <Field activity="steady" confidenceLevel="high" quiet palette="amber" />,
    line: say || null,
    card,
  };
  return (
    <div className="screenwall">
      <Wall screen fusion={fusion} onSignedOut={() => {}} />
      {/* His work, on the room screen, only while he is in the room and only
          when he asks — it folds back on its own (App.jsx). */}
      {nickHere && onWork && (
        <button type="button" className="screenwall__work" onClick={onWork}>Work</button>
      )}
    </div>
  );
}
