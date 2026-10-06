import React, { useState } from 'react';
import { useCanonical, postCanonical } from './canonicalUi';

/**
 * The "hike weekly" loop (Build 15S–X), under the goal it serves on Life.
 *
 * Renders only while that goal is active — the server says `active: false`
 * otherwise and this draws nothing. Every line is the server's: planned vs
 * recorded vs "I can't tell" is decided once, there, and is never re-worded.
 * A missing workout is never shown as a missed hike.
 */

const RESULT_WORD = { done: 'done', likely: 'likely — unconfirmed', 'cant-tell': "can't tell", 'none-recorded': 'none recorded', 'in-progress': 'this week' };

export default function HikingLoopCard() {
  const { data, error, reload } = useCanonical('/api/loops/hiking');
  const [day, setDay] = useState('');
  const [msg, setMsg] = useState(null);
  if (error && !data) return <div className="cn-error">Couldn’t read the hiking loop — {error}.</div>;
  if (!data || !data.active) return null;
  const cur = data.current;
  const act = async (kind, d) => {
    setMsg(null);
    try { await postCanonical(`/api/loops/hiking/${kind}`, { day: d }); setDay(''); reload(); } catch (e) { setMsg(e.message); }
  };
  const ask = cur.needsNick && cur.needsNick.kind === 'confirm' ? cur.needsNick.day : null;
  return (
    <div className="cn-hike" aria-label="Weekly hike">
      <div className="cn-k">Hike weekly — this week</div>
      <div className="cn-hike-line">{cur.line}</div>
      {cur.weather && (cur.weather.known
        ? <div className="cn-muted">Forecast for {cur.weather.day}: {cur.weather.condition}{cur.weather.tempHighC != null ? `, ${Math.round(cur.weather.tempHighC)}°C` : ''}{cur.weather.precipitationProbability != null ? `, ${cur.weather.precipitationProbability}% rain` : ''}</div>
        : <div className="cn-muted">No forecast for {cur.weather.day} yet ({cur.weather.why}).</div>)}
      <div className="cn-muted">Recording: {data.reliability.why}.{data.lastConfirmed ? ` Last confirmed hike ${data.lastConfirmed}.` : ''}</div>
      <div className="cn-hike-weeks">
        {data.weeks.slice(1).map((w) => <span key={w.start} className="cn-chip" title={w.line}>w/c {w.start.slice(5)} · {RESULT_WORD[w.result] || w.result}</span>)}
      </div>
      <div className="cn-hike-form">
        {ask && <button type="button" className="cn-btn" onClick={() => act('confirm', ask)}>Yes, I hiked on {ask}</button>}
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
        <button type="button" className="cn-btn" disabled={!day} onClick={() => act('confirm', day)}>I hiked that day</button>
        <button type="button" className="cn-btn" disabled={!day} onClick={() => act('plan', day)}>Plan a hike</button>
      </div>
      {msg && <div className="cn-error">{msg}</div>}
    </div>
  );
}
