import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './CapabilityGaps.css';

// "I could do X for you, but I need Y" — capability suggestions
// (services/capability-gaps.js). Every card shows the three answers that let it
// exist at all: what it is anchored to (something Nick cares about, quoted from
// the evidence), what it would unlock, and what he would do differently — plus
// what is needed. Nothing here acts by itself: Yes files a build in the Feature
// Tracker or makes one task; No keeps his reason, which is taught back.

const KIND_WORD = { build: 'Build', sensor: 'Sensor', setup: 'Set up', purchase: 'Buy', integration: 'Connect' };
const ANCHOR_WORD = { goal: 'Your goal', profile: 'About you', health: 'Your health', asked: 'You asked', miss: 'I couldn’t answer', sense: 'A sense', setup: 'Set-up' };

async function api(path, options = {}) {
  const res = await apiFetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
  return body;
}

export function CapabilityCard({ item, onDecide, busy }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const need = item.need || {};
  return (
    <li className="capgap__card">
      <div className="capgap__head">
        <span className={`capgap__kind capgap__kind--${need.kind}`}>{KIND_WORD[need.kind] || need.kind}</span>
        {need.effort && <span className="capgap__effort">{need.effort}</span>}
        <h4 className="capgap__title">{item.title}</h4>
      </div>
      <p className="capgap__line"><strong>I could:</strong> {item.unlocks}</p>
      <p className="capgap__line"><strong>So you could:</strong> {item.changes}</p>
      <p className="capgap__line"><strong>I need:</strong> {need.what}{need.how ? ` — ${need.how}` : ''}</p>
      <ul className="capgap__anchors" aria-label="Why I think this matters to you">
        {(item.anchorText || []).map((a) => (
          <li key={a.id}><span className="capgap__anchorkind">{ANCHOR_WORD[a.kind] || a.kind}</span> {a.text}</li>
        ))}
      </ul>
      {item.reopenedBecause && (
        <p className="capgap__muted">Back because {item.reopenedBecause}{item.previousRejection ? ` (you said: “${item.previousRejection}”)` : ''}.</p>
      )}
      {rejecting ? (
        <div className="capgap__reject">
          <input
            type="text"
            value={reason}
            placeholder="Why not? (I learn from this)"
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
          />
          <button type="button" disabled={busy} onClick={() => onDecide(item.id, 'reject', reason)}>Not useful</button>
          <button type="button" className="capgap__quiet" onClick={() => setRejecting(false)}>Cancel</button>
        </div>
      ) : (
        <div className="capgap__actions">
          <button type="button" disabled={busy} onClick={() => onDecide(item.id, 'accept')}>
            {need.kind === 'build' ? 'Yes — add to the tracker' : 'Yes — make it a task'}
          </button>
          <button type="button" className="capgap__quiet" disabled={busy} onClick={() => setRejecting(true)}>No</button>
          <button type="button" className="capgap__quiet" disabled={busy} onClick={() => onDecide(item.id, 'done')}>Already have it</button>
        </div>
      )}
    </li>
  );
}

export function CapabilityView({ data, error, busy, note, onRefresh, onDecide }) {
  if (!data) {
    return (
      <section className="capgap">
        <h3 className="capgap__h">What I could do for you</h3>
        <p className="capgap__muted">{error ? `Couldn’t read the suggestions: ${error}. This is not “nothing to suggest”.` : 'Reading…'}</p>
      </section>
    );
  }
  if (data.known === false) {
    return (
      <section className="capgap">
        <h3 className="capgap__h">What I could do for you</h3>
        <p className="capgap__warn">Couldn’t read the suggestions: {data.why}.</p>
      </section>
    );
  }
  const run = data.lastRun;
  return (
    <section className="capgap" aria-label="What I could do for you">
      <header className="capgap__top">
        <div>
          <h3 className="capgap__h">What I could do for you</h3>
          <p className="capgap__muted">
            Things I can’t do yet, and what I’d need. Each one is tied to something you care about, never a generic gadget.
          </p>
        </div>
        <button type="button" className="capgap__again" onClick={onRefresh} disabled={busy}>
          {busy ? 'Thinking…' : 'Think again'}
        </button>
      </header>
      {note && <p className="capgap__note">{note}</p>}
      {error && <p className="capgap__warn">{error}</p>}
      {run && !run.ok && <p className="capgap__warn">Last attempt ({String(run.at).slice(0, 16).replace('T', ' ')}) didn’t finish: {run.why}</p>}
      {data.open.length === 0 ? (
        <p className="capgap__muted">
          {run ? 'Nothing open right now.' : 'I haven’t thought about this yet — press Think again (one cloud AI call).'}
        </p>
      ) : (
        <ul className="capgap__list">
          {data.open.map((i) => <CapabilityCard key={i.id} item={i} busy={busy} onDecide={onDecide} />)}
        </ul>
      )}
      {data.held > 0 && (
        <p className="capgap__muted capgap__foot">
          {data.held} more held back so this stays a shortlist — they come back if a later pass still thinks they’re among the best.
        </p>
      )}
      {run && run.ok && (
        <p className="capgap__muted capgap__foot">
          Last thought {String(run.at).slice(0, 16).replace('T', ' ')}: {run.proposed} ideas, {run.kept} passed the test
          {run.refused && run.refused.length ? `, ${run.refused.length} refused` : ''}
          {run.folded && run.folded.length ? `, ${run.folded.length} folded into ones already on the list` : ''}.
          {run.gaps && run.gaps.length ? ` Couldn’t read: ${run.gaps.join('; ')}.` : ''}
        </p>
      )}
      {data.decided.length > 0 && (
        <details className="capgap__decided">
          <summary>{data.decided.length} decided</summary>
          <ul>
            {data.decided.map((d) => (
              <li key={d.id}>
                <span className={`capgap__status capgap__status--${d.status}`}>{d.status}</span> {d.title}
                {d.reason ? ` — “${d.reason}”` : ''}
                {d.filed && d.filed.kind === 'tracker' ? ` (tracker #${d.filed.number})` : ''}
                {' '}<button type="button" className="capgap__link" disabled={busy} onClick={() => onDecide(d.id, 'reopen')}>Undo</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export default function CapabilityGaps() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api('/api/setup/capabilities')); setError(null); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api('/api/setup/capabilities/refresh', { method: 'POST' });
      setNote(r.ok ? `${r.added} new, ${r.kept} passed the test${r.refused?.length ? `, ${r.refused.length} refused` : ''}.` : `Didn’t finish: ${r.why}`);
    } catch (e) { setError(e.message); }
    await load();
    setBusy(false);
  };

  const onDecide = async (id, decision, reason) => {
    setBusy(true); setNote(null);
    try {
      const r = await api(`/api/setup/capabilities/${encodeURIComponent(id)}/decide`, { method: 'POST', body: JSON.stringify({ decision, reason }) });
      if (r.filed?.kind === 'tracker') setNote(`Added to the Feature Tracker as #${r.filed.number}.`);
      else if (r.filed?.kind === 'task') setNote('Made it a task.');
    } catch (e) { setError(e.message); }
    await load();
    setBusy(false);
  };

  return <CapabilityView data={data} error={error} busy={busy} note={note} onRefresh={onRefresh} onDecide={onDecide} />;
}
