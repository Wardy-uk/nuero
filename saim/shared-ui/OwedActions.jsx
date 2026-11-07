import { useState } from 'react';
import PreparedSend from './PreparedSend.jsx';
import './OwedActions.css';

/**
 * What Nick can do about something somebody owes him — Chase · Done · Drop ·
 * Snooze — ONE component for People's waiting-on rows, Commitments' "owed to
 * me" rows and SAiM's Meeting prep (7 Nov 2026). Before this the three said
 * different things (People: Chase/Done/Drop/Snooze; Commitments: Done/Not owed
 * behind an Evidence panel; Meeting prep: read-only, "chasing lives in NEURO").
 *
 * Chase PREPARES the governed chase (POST /api/waiting-on/:key/chase) and shows
 * the exact email right here with Send — one press, intent grant, Sent Items
 * check. Nothing leaves without that press.
 *
 * Props:
 *  call       (path, {method, body}) → {status, body}; null = nothing offered
 *  waitingKey the waiting-on key, or getKey: async () => key (read on press)
 *  resolve    optional async (status 'done'|'dropped') → {ok, error} — a screen
 *             that closes through its own owner (Commitments → canonical) passes it
 *  only       which actions to show (default all four)
 *  onChanged  (action) after done / drop / snooze / a sent chase
 */
const SNOOZE_PRESETS = [
  { label: 'Tomorrow', days: 1 },
  { label: 'Next week', days: 7 },
  { label: '2 weeks', days: 14 },
];

/** YYYY-MM-DD n days out, from local getters (toISOString shifts the day in BST). PURE. */
export function isoDaysFrom(days, now = new Date()) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function OwedActions({
  call = null,
  waitingKey = null,
  getKey = null,
  resolve = null,
  only = ['chase', 'done', 'drop', 'snooze'],
  onChanged = null,
  surface = 'neuro-web',
  compact = false,
}) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null); // { tone, text }
  const [draft, setDraft] = useState(null); // the prepared chase
  const [snoozing, setSnoozing] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const [closed, setClosed] = useState(false);
  if (!call) return null;
  const has = (a) => only.includes(a);
  const keyOf = async () => waitingKey || (getKey ? await getKey() : null);
  const post = (path, body) => call(path, { method: 'POST', body: body || {} });
  const failText = (r) => (r && r.body && (r.body.error || r.body.notice)) || `NEURO answered ${r && r.status}`;

  const run = async (fn) => {
    if (busy) return;
    setBusy(true); setFlash(null);
    try { await fn(); } catch (e) { setFlash({ tone: 'bad', text: `Nothing changed — ${e.message || 'NEURO didn’t answer'}` }); }
    setBusy(false);
  };

  const chase = () => run(async () => {
    const key = await keyOf();
    if (!key) { setFlash({ tone: 'bad', text: 'Couldn’t find the waiting-on item behind this — nothing was drafted.' }); return; }
    const r = await post(`/api/waiting-on/${encodeURIComponent(key)}/chase`);
    if (r && r.status === 200 && r.body && r.body.ok && r.body.action) {
      setDraft(r.body.action);
      setFlash(r.body.already ? { tone: 'ok', text: 'A chase for this was already drafted — here it is.' } : null);
    } else setFlash({ tone: 'bad', text: `No chase drafted — ${failText(r)}` });
  });

  const close = (status) => run(async () => {
    let ok; let err;
    if (resolve) { const r = await resolve(status); ok = r && r.ok; err = r && r.error; }
    else {
      const key = await keyOf();
      if (!key) { setFlash({ tone: 'bad', text: 'Couldn’t find the waiting-on item behind this — nothing changed.' }); return; }
      const r = await post(`/api/waiting-on/${encodeURIComponent(key)}/resolve`, { status });
      ok = r && r.status === 200 && r.body && r.body.ok; err = ok ? null : failText(r);
    }
    if (ok) { setClosed(true); setFlash({ tone: 'ok', text: status === 'done' ? 'Marked done.' : 'Dropped.' }); if (onChanged) onChanged(status); }
    else setFlash({ tone: 'bad', text: `Nothing changed — ${err || 'refused'}` });
  });

  const snooze = (until) => run(async () => {
    setSnoozing(false);
    const key = await keyOf();
    if (!key) { setFlash({ tone: 'bad', text: 'Couldn’t find the waiting-on item behind this — nothing changed.' }); return; }
    const r = await post(`/api/waiting-on/${encodeURIComponent(key)}/snooze`, { until });
    if (r && r.status === 200 && r.body && r.body.ok) { setClosed(true); setFlash({ tone: 'ok', text: `Snoozed until ${until}.` }); if (onChanged) onChanged('snooze'); }
    else setFlash({ tone: 'bad', text: `Not snoozed — ${failText(r)}` });
  });

  return (
    <div className={`owed${compact ? ' owed--compact' : ''}`} onClick={(e) => e.stopPropagation()}>
      {!closed && (snoozing ? (
        <div className="owed__acts">
          {SNOOZE_PRESETS.map((p) => (
            <button key={p.days} type="button" className="owed__btn" disabled={busy} onClick={() => snooze(isoDaysFrom(p.days))}>{p.label}</button>
          ))}
          <input type="date" className="owed__date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} aria-label="Snooze until" />
          <button type="button" className="owed__btn" disabled={busy || !customDate} onClick={() => snooze(customDate)}>Until</button>
          <button type="button" className="owed__btn owed__btn--ghost" onClick={() => setSnoozing(false)}>Cancel</button>
        </div>
      ) : (
        <div className="owed__acts">
          {has('chase') && !draft && <button type="button" className="owed__btn" disabled={busy} onClick={chase} title="Draft the chase — you read it, then press Send">Chase</button>}
          {has('done') && <button type="button" className="owed__btn owed__btn--ok" disabled={busy} onClick={() => close('done')} title="They delivered">Done</button>}
          {has('drop') && <button type="button" className="owed__btn owed__btn--ghost" disabled={busy} onClick={() => close('dropped')} title="Never owed, a misread, or overtaken by events">Drop</button>}
          {has('snooze') && <button type="button" className="owed__btn owed__btn--ghost" disabled={busy} onClick={() => setSnoozing(true)} title="Hide until a date — it keeps ageing">Snooze</button>}
        </div>
      ))}
      {flash && <p className={`owed__flash owed__flash--${flash.tone}`} role="status">{flash.text}</p>}
      {draft && <PreparedSend action={draft} call={call} surface={surface} compact={compact} onChanged={() => { if (onChanged) onChanged('chase-sent'); }} />}
    </div>
  );
}
