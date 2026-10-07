import { useEffect, useState } from 'react';
import Field from '../../../shared-ui/Field';
import HouseholdCard from '../../../shared-ui/HouseholdCard';
import './HomeBoard.css';

// The household board — a HOME screen when Nick is not in its room.
//
// Nick, 2 Oct 2026: "the others are all at home — and if I'm not in the room
// with it — it needs to display generic useful stuff." It replaces the clock on
// home screens; the work Fire keeps its clock, because that one sits in an
// office other people walk through.
//
// ⚠ NOTHING HERE IS HIS DAY. NEURO composes the board (`/api/rooms/board`) and
// redacts the diary exactly as VESTA does — a work event arrives as "Busy" with
// no subject in the payload at all — so whoever is standing in front of this
// (Helen, Isaac, a visitor) sees the house, the weather and the shape of the
// day, never a client or a colleague.
//
// ⚠ A section that could not be read SAYS so in a quiet line. It never renders
// as a reading of nothing: "couldn't see the house" is not "every light is off".

const POLL_MS = 60_000;

function useBoard(area) {
  const [board, setBoard] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch(`/api/rooms/board${area ? `?area=${encodeURIComponent(area)}` : ''}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive) setBoard(d); })
        .catch(() => { if (alive) setBoard(null); });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [area]);
  return board;
}

function roomLine(room) {
  if (!room) return null;
  if (!room.known) return { text: `${room.area || 'This room'} · can't read it right now`, gap: true };
  const bits = [];
  if (typeof room.tempC === 'number') bits.push(`${room.tempC.toFixed(1)}°`);
  const l = room.lights || {};
  if (l.on > 0) bits.push(`${l.on} light${l.on === 1 ? '' : 's'} on`);
  else if (l.off > 0) bits.push('lights off');
  if (l.unreachable > 0) bits.push(`${l.unreachable} off at the wall`);
  return { text: [room.area, ...bits].join(' · '), gap: false };
}

function houseLines(house) {
  if (!house) return [];
  if (!house.known) return [{ text: "Can't see the rest of the house right now.", gap: true }];
  const out = [];
  const on = house.lightsOnElsewhere || [];
  if (on.length) out.push({ text: `Lights on: ${on.join(', ')}` });
  if (house.tvOn === true) out.push({ text: 'TV on' });
  const hh = house.household || {};
  // Who is home is drawn as faces by HouseholdCard below (7 Oct 2026), not a line.
  return out;
}

// Through saim/backend's `household` door; module scope so the card's effects stay put.
const fetchHousehold = () => fetch('/api/household').then((r) => (r.ok ? r.json() : null));
const fetchHouseholdPhoto = async (id, version) => {
  const r = await fetch(`/api/household/photo/${encodeURIComponent(id)}?v=${version}`);
  if (!r.ok) return null;
  return URL.createObjectURL(await r.blob());
};

export default function HomeBoard({ now, area, say, onWork = null }) {
  const board = useBoard(area);
  const d = now instanceof Date ? now : new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const room = roomLine(board && board.room);
  const w = board && board.weather;
  const events = (board && board.diary && board.diary.known && board.diary.events) || [];
  const house = houseLines(board && board.house);
  const message = typeof say === 'string' && say.trim() ? say.trim() : null;

  return (
    <div className="homeboard" aria-label="Household board">
      <Field quiet confidenceLevel="low" />
      <div className="homeboard__main">
        <div className="homeboard__time">{time}</div>
        <div className="homeboard__date">{date}</div>
        {message && <div className="homeboard__say">{message}</div>}
        {room && <div className={`homeboard__room${room.gap ? ' homeboard__gap' : ''}`}>{room.text}</div>}
        {onWork && (
          <button type="button" className="homeboard__work" onClick={onWork}>Work</button>
        )}
      </div>

      <div className="homeboard__side">
        <section className="homeboard__block">
          <h3 className="homeboard__h">Weather</h3>
          {w && w.known ? (
            <>
              <div className="homeboard__wx">
                {typeof w.tempC === 'number' ? `${Math.round(w.tempC)}°` : ''}{' '}
                <span>{w.condition || ''}</span>
              </div>
              {(w.lines || []).map((l) => <div key={l} className="homeboard__line">{l}</div>)}
            </>
          ) : (
            <div className="homeboard__line homeboard__gap">Can't read the weather right now.</div>
          )}
        </section>

        <section className="homeboard__block">
          <h3 className="homeboard__h">Today</h3>
          {board && board.diary && !board.diary.known ? (
            <div className="homeboard__line homeboard__gap">Can't read the diary right now.</div>
          ) : events.length === 0 ? (
            <div className="homeboard__line">Nothing else in the diary today.</div>
          ) : (
            events.map((e, i) => (
              <div key={i} className={`homeboard__line${e.personal ? '' : ' homeboard__busy'}`}>
                <span className="homeboard__when">{e.allDay ? 'All day' : `${e.start}–${e.end}`}</span> {e.title}
              </div>
            ))
          )}
        </section>

        <HouseholdCard fetchJson={fetchHousehold} fetchPhoto={fetchHouseholdPhoto} compact />

        {house.length > 0 && (
          <section className="homeboard__block">
            <h3 className="homeboard__h">House</h3>
            {house.map((l) => (
              <div key={l.text} className={`homeboard__line${l.gap ? ' homeboard__gap' : ''}`}>{l.text}</div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
