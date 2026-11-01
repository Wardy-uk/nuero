import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './MeetingFollowups.css';

/**
 * Meeting follow-ups on Now (1 Nov 2026). Two kinds of row, from
 * /api/meeting-followups:
 *   - a DRAFT NEURO wrote after a team meeting (or after Nick pressed Draft):
 *     who it goes to, who was left off and why, the words, and one Send —
 *     refused while a [details: …] gap is still in it (fill it in Actions);
 *   - an OFFER for any other meeting with people in it: Draft / Not this one.
 *     Nothing is drafted and no model is asked until Draft is pressed.
 * Renders nothing when there is nothing to show.
 */

export function MeetingFollowupsView({ items, onChanged, onNavigate }) {
  const [busy, setBusy] = useState(null);
  const [notes, setNotes] = useState({});
  if (!items || !items.length) return null;

  const say = (id, text, tone = 'ok') => setNotes((n) => ({ ...n, [id]: { text, tone } }));

  const press = async (item, verb) => {
    setBusy(item.id);
    try {
      const res = await apiFetch(`/api/meeting-followups/${item.id}/${verb}`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!d.ok) say(item.id, d.error || 'That did not work.', 'bad');
      onChanged && onChanged();
    } catch (e) { say(item.id, e.message, 'bad'); }
    setBusy(null);
  };

  const send = async (item) => {
    setBusy(item.id);
    const r = await executeDirect(item.action);
    const o = directOutcome(r);
    say(item.id, o.text, o.tone);
    setBusy(null);
    onChanged && onChanged();
  };

  return (
    <section className="mfu">
      <div className="mfu__head">
        <h3>Meeting follow-ups</h3>
        <p>Drafted from the write-up — nothing is sent until you press Send.</p>
      </div>
      <ul className="mfu__list">
        {items.map((i) => {
          const d = i.action && i.action.draft;
          const gaps = d && Array.isArray(d.placeholders) && d.placeholders.length > 0;
          const note = notes[i.id];
          return (
            <li key={i.id} className="mfu__row" data-followup-id={i.id}>
              <div className="mfu__title">
                {i.status === 'drafted' ? <>Follow-up: {i.subject}</> : <>Draft a follow-up to {i.subject}?</>}
                <span className="mfu__when">{String(i.start || '').slice(0, 16).replace('T', ' ')}</span>
              </div>
              <div className="mfu__why">{i.why}</div>
              {i.status === 'drafted' && d && (
                <>
                  <div className="mfu__to">To: {(d.to || []).map((r) => r.name || r.email).join(', ')}</div>
                  {(i.excluded || []).length > 0 && (
                    <div className="mfu__off">Not sent to: {i.excluded.map((e) => `${e.name} (${e.why})`).join(', ')}</div>
                  )}
                  <details className="mfu__body"><summary>Read the email</summary><pre>{d.body}</pre></details>
                  {gaps && <div className="mfu__gap">It still has [details] gaps — fill them in Actions before it can be sent.</div>}
                  <div className="mfu__acts">
                    <button className="btn btn-primary btn-sm" disabled={busy === i.id || gaps} onClick={() => send(i)}>Send</button>
                    {onNavigate && <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('actions')}>Open in Actions</button>}
                  </div>
                </>
              )}
              {i.status !== 'drafted' && (
                <>
                  {i.status === 'failed' && <div className="mfu__gap">Not drafted — {i.error}</div>}
                  {i.status === 'drafting' && <div className="mfu__why">Drafting…</div>}
                  <div className="mfu__acts">
                    <button className="btn btn-primary btn-sm" disabled={busy === i.id || i.status === 'drafting'} onClick={() => press(i, 'draft')}>
                      {i.status === 'failed' ? 'Try again' : 'Draft'}
                    </button>
                    <button className="btn btn-secondary btn-sm" disabled={busy === i.id} onClick={() => press(i, 'decline')}>Not this one</button>
                  </div>
                </>
              )}
              {note && <div className={`mfu__note mfu__note--${note.tone}`}>{note.text}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function MeetingFollowups({ onNavigate }) {
  const [items, setItems] = useState(null);
  const load = () => apiFetch('/api/meeting-followups').then((r) => r.json()).then((d) => setItems(d.ok ? d.items : null)).catch(() => setItems(null));
  useEffect(() => { load(); }, []);
  if (!items) return null;
  return <MeetingFollowupsView items={items} onChanged={load} onNavigate={onNavigate} />;
}
