import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './CalendarCare.css';

/**
 * Calendar care (1 Nov 2026) on Now — three offers, each answered with a press:
 *   • the week is over 60% meetings → protect an afternoon (Protect / Not this week)
 *   • a meeting Nick organises has no agenda → the drafted agenda, editable,
 *     Add agenda (attendees get Outlook's update) / Dismiss
 *   • a series he missed the last three times → Decline future occurrences (or
 *     Cancel the series, his own) / Keep / Remind me in a month
 * Renders nothing when there is nothing to offer.
 */

function when(stamp) {
  if (!stamp) return '';
  const d = new Date(`${stamp.slice(0, 10)}T12:00:00`);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return stamp.length > 10 ? `${day} ${stamp.slice(11, 16)}` : day;
}

async function post(path, body) {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  try { return await res.json(); } catch { return { ok: false, error: `HTTP ${res.status}` }; }
}

function WeekOffer({ week, onDone }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  if (!week || !week.ok || !week.offer) return null;
  const go = async (path) => {
    setBusy(true); setNote(null);
    const r = await post(path, { weekKey: week.week.key });
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.error || 'Not done.' }); return; }
    setNote({ tone: 'ok', text: path.endsWith('protect') ? `Protected ${when(r.decided?.start)}–${(r.decided?.end || '').slice(11, 16)}.` : 'Not this week.' });
    onDone();
  };
  return (
    <div className="cc__item">
      <div className="cc__say">{week.offer.say}</div>
      <div className="cc__sub">
        {when(week.offer.start)}–{week.offer.end.slice(11, 16)} · an attendee-free block called “{week.offer.title}” · nobody is told
        {(week.gaps || []).map((g) => <div key={g} className="cc__gap">{g}</div>)}
      </div>
      <div className="cc__acts">
        <button className="btn btn-primary btn-small" disabled={busy} onClick={() => go('/api/calendar-care/week/protect')}>Protect</button>
        <button className="btn btn-small" disabled={busy} onClick={() => go('/api/calendar-care/week/dismiss')}>Not this week</button>
      </div>
      {note && <div className={`cc__note cc__note--${note.tone}`}>{note.text}</div>}
    </div>
  );
}

export function AgendaOffer({ offer, onDone }) {
  const [text, setText] = useState(offer.text);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const gaps = (text.match(/\[[^\]\n]{1,80}\]/g) || []);
  const add = async () => {
    setBusy(true); setNote(null);
    const r = await post('/api/calendar-care/agenda/add', { key: offer.key, text });
    if (!r.ok || !r.action) { setBusy(false); setNote({ tone: 'bad', text: r.error || 'Nothing was added.' }); return; }
    const x = await executeDirect(r.action);
    const out = directOutcome(x);
    if (x.executed) await post('/api/calendar-care/agenda/done', { key: offer.key });
    setBusy(false);
    setNote(out);
    if (x.executed) onDone();
  };
  const dismiss = async () => { await post('/api/calendar-care/agenda/dismiss', { key: offer.key }); onDone(); };
  return (
    <div className="cc__item">
      <div className="cc__say">{offer.say}</div>
      <div className="cc__sub">
        {when(offer.start)} · {offer.source === 'write-up' ? `from the write-up of ${when(offer.previous?.start)}` : 'no write-up of the last one — a template to fill in'} · every attendee gets Outlook’s update
      </div>
      <textarea className="cc__text" value={text} rows={Math.min(10, text.split('\n').length + 1)} onChange={(e) => setText(e.target.value)} />
      {gaps.length > 0 && <div className="cc__gap">Fill in or delete {gaps.join(', ')} before it can be added.</div>}
      <div className="cc__acts">
        <button className="btn btn-primary btn-small" disabled={busy || gaps.length > 0 || !text.trim()} onClick={add}>{busy ? 'Adding…' : 'Add agenda'}</button>
        <button className="btn btn-small" disabled={busy} onClick={dismiss}>Not this one</button>
      </div>
      {note && <div className={`cc__note cc__note--${note.tone}`}>{note.text}</div>}
    </div>
  );
}

function SeriesOffer({ offer, onDone }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const answer = async (a) => { setBusy(true); await post('/api/calendar-care/series/answer', { key: offer.key, answer: a }); setBusy(false); onDone(); };
  const decline = async () => {
    setBusy(true); setNote(null);
    const r = await post('/api/calendar-care/series/decline', { key: offer.key });
    setBusy(false);
    setNote(r.ok ? { tone: 'ok', text: r.say } : { tone: 'bad', text: r.error || 'Not declined.' });
    if (r.ok) onDone();
  };
  const cancel = async () => {
    setBusy(true); setNote(null);
    const r = await post('/api/calendar-care/series/cancel', { key: offer.key });
    if (!r.ok || !r.action) { setBusy(false); setNote({ tone: 'bad', text: r.error || 'Nothing was prepared.' }); return; }
    const x = await executeDirect(r.action);
    if (x.executed) await post('/api/calendar-care/series/answer', { key: offer.key, answer: 'cancelled' });
    setBusy(false);
    setNote(directOutcome(x));
    if (x.executed) onDone();
  };
  return (
    <div className="cc__item">
      <div className="cc__say">{offer.say}</div>
      <ul className="cc__evidence">
        {offer.last.map((o) => <li key={o.start}>{when(o.start)} — {o.evidence?.detail}</li>)}
      </ul>
      <div className="cc__sub">Next: {when(offer.next)}{offer.cannotWhy ? ` · ${offer.cannotWhy}` : ''}</div>
      <div className="cc__acts">
        {offer.can === 'decline' && <button className="btn btn-primary btn-small" disabled={busy} onClick={decline}>Decline future occurrences</button>}
        {offer.can === 'cancel' && <button className="btn btn-primary btn-small" disabled={busy} onClick={cancel}>Cancel the series</button>}
        <button className="btn btn-small" disabled={busy} onClick={() => answer('keep')}>Keep</button>
        <button className="btn btn-small" disabled={busy} onClick={() => answer('remind')}>Remind me in a month</button>
      </div>
      {note && <div className={`cc__note cc__note--${note.tone}`}>{note.text}</div>}
    </div>
  );
}

export function CalendarCareView({ data, reload }) {
  const week = data.week;
  const agendas = (data.agendas && data.agendas.offers) || [];
  const series = (data.series && data.series.offers) || [];
  const hasWeek = !!(week && week.ok && week.offer);
  if (!hasWeek && !agendas.length && !series.length) return null;
  return (
    <section className="cc">
      <h3 className="cc__h">Your calendar</h3>
      {hasWeek && <WeekOffer week={week} onDone={reload} />}
      {agendas.map((o) => <AgendaOffer key={o.key} offer={o} onDone={reload} />)}
      {series.map((o) => <SeriesOffer key={o.key} offer={o} onDone={reload} />)}
    </section>
  );
}

export default function CalendarCare() {
  const [data, setData] = useState(null);
  const load = () => apiFetch('/api/calendar-care').then((r) => r.json()).then((d) => setData(d && d.ok ? d : null)).catch(() => setData(null));
  useEffect(() => { load(); }, []);
  if (!data) return null;
  return <CalendarCareView data={data} reload={load} />;
}
