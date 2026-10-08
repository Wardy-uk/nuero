import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks } from './canonicalUi';

/**
 * Build 20K — a companion's care, compact, under Life → Companions.
 *
 * Only what Nick told NEURO: care items he added, items he linked to her, and
 * his own word about a day's walk. Nothing is scheduled for her by itself — a
 * next date comes only from a repeat he set — and nothing here reminds him.
 * A task that merely MENTIONS her is shown as a mention, never as her care.
 * Every word about state is the server's; this renders and never ranks.
 */

const KINDS = [
  ['walk', 'Walk'], ['vet', 'Vet appointment'], ['vaccination', 'Vaccination'], ['flea', 'Flea treatment'],
  ['worm', 'Worm treatment'], ['medication', 'Medication'], ['grooming', 'Grooming'], ['insurance', 'Insurance / admin'], ['other', 'Other'],
];
const WALK_WORDS = {
  confirmed: 'Walked', planned: 'Walk planned', no_evidence: 'No walk recorded', recording_gap: 'Can’t tell', not_applicable: 'Not applicable',
};
const ACTION_WORDS = { needs_you: 'Needs you', preparation_open: 'Coming up', planned: 'Planned', unknown: 'Date passed', none: '' };

export default function CompanionCareCard({ companion }) {
  const path = `/api/canonical/companions/${encodeURIComponent(companion.id)}/care`;
  const { data, error, reload } = useCanonical(path);
  const tasks = useCanonical('/api/canonical/tasks?status=open');
  const radar = useCanonical('/api/canonical/radar?days=30');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [form, setForm] = useState({ kind: 'vet', title: '', dueDate: '', every: '', unit: 'week' });
  const [linkTo, setLinkTo] = useState('');
  const [linkKind, setLinkKind] = useState('other');

  const act = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  if (error && !data) return <div className="cn-error">Couldn’t read {companion.name}’s care — {error}</div>;
  if (!data) return <div className="cn-muted">Reading {companion.name}’s care…</div>;

  const name = data.companion.name;
  const walk = data.walk.today;
  const linkedIds = new Set(data.linked.map((l) => l.entityId));
  const candidates = [
    ...((tasks.data && tasks.data.items) || []).map((t) => ({ id: t.id, label: `${t.description}${t.sourceLabel ? ` (${t.sourceLabel})` : ''}` })),
    ...((radar.data && radar.data.items) || []).filter((i) => i.kind === 'event' || i.kind === 'hike')
      .map((i) => ({ id: `meeting:${i.sourceRefs[0]}`, label: `${i.when} — ${i.title} (calendar)` })),
    ...((radar.data && radar.data.items) || []).filter((i) => /^pd:/.test(i.id)).map((i) => ({ id: i.id, label: `${i.when} — ${i.title} (date)` })),
  ].filter((c) => !linkedIds.has(c.id));

  const add = (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    const recurrence = form.every ? { every: Number(form.every), unit: form.unit } : null;
    act(async () => {
      await postCanonical(path, { kind: form.kind, title: form.title, dueDate: form.dueDate || null, recurrence });
      setForm({ ...form, title: '', dueDate: '', every: '' });
    });
  };

  return (
    <div className="cn-care">
      {note && <div className="cn-error">{note}</div>}

      <div className="cn-care-row">
        <span className="cn-now-k">Walk today</span>
        <span className={`cn-chip ${walk.state === 'confirmed' ? 'cn-chip--firm' : 'cn-chip--soft'}`}>{WALK_WORDS[walk.state] || walk.state}</span>
        {walk.state !== 'not_applicable' && <span className="cn-muted cn-small">{walk.why}</span>}
        {walk.state !== 'confirmed' && <button type="button" className="cn-btn" disabled={busy} onClick={() => act(() => postCanonical(`${path.replace('/care', '/walks')}`, { mark: 'walked' }))}>Walked</button>}
        {walk.state !== 'not_applicable' && walk.state !== 'confirmed' && data.walk.setUp && (
          <button type="button" className="cn-btn" disabled={busy} onClick={() => act(() => postCanonical(`${path.replace('/care', '/walks')}`, { mark: 'not-applicable' }))}>No walk needed</button>
        )}
        {(walk.evidence || []).some((e) => e.kind === 'confirmation') && (
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`${path.replace('/care', '/walks/remove')}`, { day: data.today }))}>Undo</button>
        )}
      </div>
      {data.walk.history.some((d) => d.state !== 'not_applicable') && (
        <div className="cn-muted cn-care-week">
          Last week: {data.walk.history.map((d) => `${d.day.slice(5)} ${WALK_WORDS[d.state] || d.state}`).join(' · ')}
        </div>
      )}

      <div className="cn-care-row">
        <span className="cn-now-k">Next</span>
        {data.next
          ? <span>{data.next.title} — {data.next.dueDate}{data.next.dueTime ? ` ${data.next.dueTime}` : ''}{data.next.recurrenceWords ? ` (${data.next.recurrenceWords})` : ''}</span>
          : <span className="cn-muted">Nothing dated.</span>}
      </div>

      {data.open.length > 0 && (
        <ul className="cn-list">
          {data.open.map((i) => (
            <li key={i.id} className="cn-row">
              <span className="cn-rowtitle">{i.title}</span>
              <span className="cn-muted">{i.kindLabel} · {i.dueDate || 'no date'}{i.recurrenceWords ? ` · ${i.recurrenceWords}` : ''}</span>
              {ACTION_WORDS[i.actionState] && <span className={`cn-chip ${i.actionState === 'needs_you' ? 'cn-chip--firm' : 'cn-chip--soft'}`} title={i.why}>{ACTION_WORDS[i.actionState]}</span>}
              <button type="button" className="cn-btn" disabled={busy} onClick={() => act(() => postCanonical(`/api/canonical/care/${encodeURIComponent(i.id)}/done`, {}))}>Done</button>
              <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/canonical/care/${encodeURIComponent(i.id)}/cancel`, {}))}>Cancel</button>
            </li>
          ))}
        </ul>
      )}

      <Fold title="Add care" meta="vet, vaccination, flea, worming…">
      <form className="cn-goalform" onSubmit={add}>
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Kind of care">
          {KINDS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}
        </select>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={`e.g. ${name}'s booster`} maxLength={200} aria-label="What" />
        <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} aria-label="Date (optional)" />
        <span className="cn-muted">repeat every</span>
        <input className="cn-input--tiny" type="number" min="1" max="365" value={form.every} onChange={(e) => setForm({ ...form, every: e.target.value })} aria-label="Repeat every (leave empty for no repeat)" placeholder="—" />
        <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} aria-label="Repeat unit" disabled={!form.every}>
          {['day', 'week', 'month', 'year'].map((u) => <option key={u} value={u}>{u}s</option>)}
        </select>
        <button type="submit" className="cn-btn" disabled={busy || !form.title.trim() || (!!form.every && !form.dueDate)}>Add</button>
      </form>
      </Fold>

      <Fold title={`Linked to ${name}`} meta={data.linked.length ? `${data.linked.length}` : 'nothing linked'}>
      {data.linked.length > 0 && (
        <ul className="cn-list">
          {data.linked.map((l) => (
            <li key={l.entityId} className="cn-row">
              <span className="cn-rowtitle">{l.found ? l.title : 'no longer held by NEURO'}</span>
              <span className="cn-muted">{l.careKind}{l.kindOf ? ` · ${l.kindOf === 'meeting' ? 'calendar' : l.kindOf}` : ''}{l.day ? ` · ${l.day}` : l.dueDate ? ` · due ${l.dueDate}` : ''}{l.status ? ` · ${l.status}` : ''}</span>
              {l.hidden && <span className="cn-muted">{l.why}</span>}
              <button type="button" className="cn-btn cn-btn--tiny" disabled={busy}
                onClick={() => act(() => postCanonical(`${path.replace('/care', '/links/remove')}`, { entityId: l.entityId, label: l.title }))}>Unlink</button>
            </li>
          ))}
        </ul>
      )}
      <div className="cn-hike-form">
        <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} aria-label={`Link something to ${name}'s care`} disabled={busy}>
          <option value="">link a task, reminder or calendar entry…</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select value={linkKind} onChange={(e) => setLinkKind(e.target.value)} aria-label="As which kind of care" disabled={busy}>
          {KINDS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}
        </select>
        <button type="button" className="cn-btn" disabled={busy || !linkTo}
          onClick={() => act(async () => { await postCanonical(path.replace('/care', '/links'), { entityId: linkTo, careKind: linkKind, label: (candidates.find((c) => c.id === linkTo) || {}).label }); setLinkTo(''); })}>Link</button>
      </div>
      {data.mentions.length > 0 && (
        <div className="cn-small cn-muted">Mentioned (not linked): {data.mentions.map((m) => m.title).join('; ')}</div>
      )}
      </Fold>

      {data.recent.length > 0 && (
        <details className="cn-details">
          <summary>Recently done ({data.recent.length})</summary>
          <ul className="cn-act-lines">{data.recent.map((r, i) => <li key={`${r.careId}-${i}`}>{r.doneOn} — {r.title}{r.nextDue ? ` (next ${r.nextDue})` : ''}</li>)}</ul>
        </details>
      )}
      <HowItWorks>{data.walk.rule} NEURO schedules nothing for {name} by itself; a task or calendar entry counts as her care only when you link it.</HowItWorks>
    </div>
  );
}
