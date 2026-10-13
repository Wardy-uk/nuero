import React, { useState } from 'react';
import { useCanonical, postCanonical, Headline, TileGrid, Tile, Group, Fold, PrimaryAction, dayLabel } from './canonicalUi';

/**
 * The "hike weekly" loop (Build 15S–X), under the goal it serves on Life.
 *
 * Renders only while that goal is active — the server says `active: false`
 * otherwise and this draws nothing. Every line is the server's: planned vs
 * recorded vs "I can't tell" is decided once, there, and is never re-worded.
 * A missing workout is never shown as a missed hike.
 *
 * 13 Oct 2026 (docs/design-rules.md): headline = this week's verdict, the
 * weeks as tiles (the server's line on hover), the rule said once, the
 * record-a-day form folded.
 */

// Build 17A: no "likely" — a day is confirmed (GPS track or you), not a hike,
// can't tell (recording unavailable), or pending inside its 24-hour window.
const RESULT_WORD = { done: 'hike confirmed', pending: 'waiting on a GPS track', 'cant-tell': "can't tell", 'none-recorded': 'no hike recorded', 'in-progress': 'this week' };
// A tone is a meaning: done is good, waiting/can't-tell needs a look. "No hike
// recorded" is neutral — never a guilt colour for something not done.
const RESULT_TONE = { done: 'good', pending: 'warn', 'cant-tell': 'warn' };

export default function HikingLoopCard() {
  // Build 16M: earlier weeks on demand, so a past Saturday can be confirmed.
  const [earlier, setEarlier] = useState(false);
  const { data, error, reload } = useCanonical(earlier ? '/api/loops/hiking?weeks=17' : '/api/loops/hiking');
  const [day, setDay] = useState('');
  const [msg, setMsg] = useState(null);
  if (error && !data) return <div className="cn-error">Couldn’t read the hiking loop — {error}.</div>;
  if (!data || !data.active) return null;
  const cur = data.current;
  const act = async (kind, d) => {
    setMsg(null);
    try { await postCanonical(`/api/loops/hiking/${kind}`, { day: d }); setDay(''); reload(); } catch (e) { setMsg(e.message); }
  };
  const undo = async (id, denial = false) => {
    setMsg(null);
    try { await postCanonical(denial ? `/api/loops/hiking/denials/${id}/withdraw` : `/api/loops/hiking/entries/${id}/withdraw`, {}); reload(); } catch (e) { setMsg(e.message); }
  };
  const denialFor = (d) => (data.entries || []).find((e) => e.kind === 'deny' && e.day === d);
  const ask = cur.needsNick && cur.needsNick.kind === 'confirm' ? cur.needsNick.day : null;
  const w = cur.weather;
  const forecast = w ? (w.known
    ? `Forecast for ${w.day}: ${w.condition}${w.tempHighC != null ? `, ${Math.round(w.tempHighC)}°C` : ''}${w.precipitationProbability != null ? `, ${w.precipitationProbability}% rain` : ''}`
    : `No forecast for ${w.day} yet (${w.why}).`) : null;
  return (
    <div className="cn-hike" aria-label="Weekly hike">
      <Headline tone={RESULT_TONE[cur.result]} pill={RESULT_WORD[cur.result] || 'this week'} detail={forecast}>{cur.line}</Headline>
      {ask && <div className="cn-actions"><PrimaryAction onClick={() => act('confirm', ask)}>Yes, I hiked on {dayLabel(ask)}</PrimaryAction></div>}
      <Group label="Earlier weeks" meta={data.lastConfirmed ? `last confirmed hike ${dayLabel(data.lastConfirmed)}` : null} why={data.rule}>
        <TileGrid>
          {data.weeks.slice(1).map((wk) => {
            const asks = wk.needsNick && wk.needsNick.kind === 'confirm' ? wk.needsNick.day : null;
            const mine = (wk.confirmed || []).find((c) => c.by === 'you' && c.entryId);
            const tracked = (wk.confirmed || []).find((c) => c.by === 'gps-track');
            const denied = (wk.days || []).map((v) => v.by === 'you' && v.state === 'not_hike' && denialFor(v.day)).find(Boolean);
            const buttons = asks || mine || tracked || denied;
            return (
              <Tile key={wk.start} title={`w/c ${dayLabel(wk.start)}`} sub={RESULT_WORD[wk.result] || wk.result} why={wk.line}
                foot={buttons ? <>
                  {asks && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => act('confirm', asks)}>Yes, {dayLabel(asks)}</button>}
                  {mine && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => undo(mine.entryId)}>Undo</button>}
                  {tracked && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => act('deny', tracked.day)}>Not a hike</button>}
                  {denied && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => undo(denied.id, true)}>Undo</button>}
                </> : null} />
            );
          })}
        </TileGrid>
        <div className="cn-actions"><button type="button" className="cn-btn cn-btn--tiny" onClick={() => setEarlier((v) => !v)}>{earlier ? 'Fewer weeks' : 'Earlier weeks'}</button></div>
      </Group>
      <Fold title="Record or plan a day">
        <div className="cn-hike-form">
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
          <button type="button" className="cn-btn" disabled={!day} onClick={() => act('confirm', day)}>I hiked that day</button>
          <button type="button" className="cn-btn" disabled={!day} onClick={() => act('deny', day)}>Not a hike</button>
          <button type="button" className="cn-btn" disabled={!day} onClick={() => act('plan', day)}>Plan a hike</button>
        </div>
      </Fold>
      {msg && <div className="cn-error">{msg}</div>}
    </div>
  );
}
