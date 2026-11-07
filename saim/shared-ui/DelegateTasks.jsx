import { useEffect, useMemo, useState } from 'react';
import { sendPrepared, sendOutcome } from './sendPrepared.mjs';
import './DelegateTasks.css';

/**
 * Delegate (6 Nov 2026) — backend/services/task-delegation.js.
 *
 * On a task card: hand THIS task — and, if Nick wants, a couple more — to one
 * of his direct reports as ONE delegation. Either email them the hand-over
 * (governed email, one press; the tasks move once it is read back in Sent
 * Items) or say he has already told them (recorded at once). Delegated work
 * leaves Tasks and lives in Commitments → Delegated.
 *
 * The pool of other tasks to add is whatever the Tasks screen is showing,
 * handed in by TodoPanel each render (setDelegatePool) — one list, not a second
 * fetch of 150 rows per open card.
 *
 * ⚠ SHARED since 7 Nov 2026 (audit F18): it lived only on the desktop Tasks
 * card. It takes the shell's `call` ({status, body}) so the SAiM phone app, the
 * Task workflow screen and NEURO's desktop all mount the SAME panel.
 */

const GAP_RE = /\[[^\]\n]{1,60}\]/g;
let pool = [];
/** TodoPanel calls this each render with its open rows. */
export function setDelegatePool(rows) { pool = Array.isArray(rows) ? rows : []; }

/** The item a row stands for, or null when it cannot be delegated (a daily-note line). */
export function delegateItemOf(t) {
  if (!t || t.done) return null;
  if (t.task_id) return { kind: 'task', id: String(t.task_id), title: t.text, label: `#${t.task_id}` };
  if (t.ms_id) return { kind: 'ms', id: String(t.ms_id), title: t.text, label: t.msPlan || String(t.source || 'Microsoft').replace(/^MS\s+/, '') };
  return null;
}
const keyOf = (i) => `${i.kind}:${i.id}`;

let peopleCache = { at: 0, promise: null };
function loadPeople(call) {
  if (peopleCache.promise && Date.now() - peopleCache.at < 300000) return peopleCache.promise;
  peopleCache = { at: Date.now(), promise: call('/api/delegation/people').then((r) => (r && r.body) || { ok: false }).catch(() => ({ ok: false })) };
  return peopleCache.promise;
}
let pendingCache = { at: 0, promise: null };
function loadPending(call, force = false) {
  if (!force && pendingCache.promise && Date.now() - pendingCache.at < 60000) return pendingCache.promise;
  pendingCache = { at: Date.now(), promise: call('/api/delegation/tasks/pending').then((r) => (r && r.body) || { ok: false, pending: [] }).catch(() => ({ ok: false, pending: [] })) };
  return pendingCache.promise;
}

async function post(call, path, body) {
  try {
    const r = await call(path, { method: 'POST', body: body || {} });
    return (r && r.body) || { ok: false, error: `HTTP ${r && r.status}` };
  } catch (e) { return { ok: false, error: (e && e.message) || 'NEURO didn’t answer' }; }
}

export default function DelegateTasks({ todo, onDone, call = null, readOnly = false, surface = 'neuro-web' }) {
  const self = delegateItemOf(todo);
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState(null);
  const [pending, setPending] = useState(null);
  const [person, setPerson] = useState('');
  const [extra, setExtra] = useState([]);
  const [query, setQuery] = useState('');
  const [via, setVia] = useState('email');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  useEffect(() => {
    let live = true;
    if (!call) return undefined;
    loadPending(call).then((d) => { if (live) setPending((d && d.pending) || []); });
    return () => { live = false; };
  }, [call]);
  useEffect(() => {
    if (!open || people || !call) return undefined;
    let live = true;
    loadPeople(call).then((d) => { if (live) setPeople(d && d.ok ? d.people : []); });
    return () => { live = false; };
  }, [open, people]);
  // A change to who or what makes any draft stale — write it again.
  useEffect(() => { setDraft(null); }, [person, extra, via]);

  const items = useMemo(() => (self ? [self, ...extra] : extra), [self && keyOf(self), extra]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = new Set(items.map(keyOf));
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return pool.map(delegateItemOf).filter((i) => i && !chosen.has(keyOf(i)) && String(i.title || '').toLowerCase().includes(q)).slice(0, 8);
  }, [query, extra]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!self || !call || readOnly) return null;
  const waiting = (pending || []).find((p) => (p.items || []).some((i) => keyOf(i) === keyOf(self)));
  if (waiting) {
    return <div className="ho__note dlg__pending">Hand-over email to {waiting.person} sent — it moves to Commitments → Delegated once NEURO reads it back in Sent Items.</div>;
  }

  const who = (people || []).find((p) => p.name === person) || null;
  const gaps = draft ? [...new Set(`${draft.subject}\n${draft.body}`.match(GAP_RE) || [])] : [];
  const payloadItems = items.map((i) => ({ kind: i.kind, id: i.id }));

  const writeEmail = async () => {
    setBusy(true); setNote(null);
    const r = await post(call, '/api/delegation/tasks/draft', { person, items: payloadItems });
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.error || 'Could not draft the email.' }); return; }
    setDraft({ subject: r.draft.subject, body: r.draft.body });
  };
  const finish = (text) => {
    setNote({ tone: 'ok', text });
    loadPending(call, true).then((d) => setPending((d && d.pending) || []));
    setTimeout(() => onDone && onDone(), 1500);
  };
  const record = async () => {
    setBusy(true); setNote({ tone: 'info', text: 'Recording…' });
    const r = await post(call, '/api/delegation/tasks', { person, items: payloadItems, via: 'told' });
    setBusy(false);
    if (!r.ok) { setNote({ tone: 'bad', text: r.error || 'Not recorded.' }); return; }
    finish(`Delegated to ${who ? who.first : person} — ${items.length > 1 ? `these ${items.length} are` : 'it is'} now in Commitments → Delegated.${(r.notes || []).length ? ` (${r.notes.join('; ')})` : ''}`);
  };
  const send = async () => {
    if (gaps.length) { setNote({ tone: 'warn', text: `Fill in ${gaps.join(', ')} first.` }); return; }
    setBusy(true); setNote({ tone: 'info', text: 'Sending…' });
    const p = await post(call, '/api/delegation/tasks', { person, items: payloadItems, via: 'email', subject: draft.subject, body: draft.body });
    if (!p.ok) { setBusy(false); setNote({ tone: 'bad', text: p.error || 'Could not prepare the email.' }); return; }
    const r = await sendPrepared(call, p.action, { surface });
    setBusy(false);
    const o = sendOutcome(r);
    if (!r.ok) { setNote({ tone: o.tone, text: o.text }); return; }
    finish(`${o.text} Once it is in Sent Items, ${items.length > 1 ? 'these move' : 'it moves'} to Commitments → Delegated.`);
  };

  return (
    <div className="dlg" onClick={(e) => e.stopPropagation()}>
      {!open ? (
        <button type="button" className="ho__btn" onClick={() => setOpen(true)}>Delegate…</button>
      ) : (
        <div className="ho dlg__box">
          <div className="dlg__head">
            <strong>Delegate</strong>
            <button type="button" className="ho__btn" onClick={() => { setOpen(false); setNote(null); }}>Close</button>
          </div>

          <label className="dlg__row">
            <span className="dlg__label">To</span>
            <select className="dlg__select" value={person} disabled={busy || !people} onChange={(e) => setPerson(e.target.value)}>
              <option value="">{people ? 'Choose who…' : 'Reading your team…'}</option>
              {(people || []).map((p) => <option key={p.name} value={p.name}>{p.name}{p.team ? ` — ${p.team}` : ''}</option>)}
            </select>
          </label>
          {people && !people.length && <div className="ho__note ho__note--bad">Couldn’t read your direct reports — nothing to delegate to.</div>}
          {who && who.leave && who.leave.say && <div className="ho__note ho__note--warn">{who.first} is {who.leave.say}.</div>}

          <div className="dlg__row dlg__row--top">
            <span className="dlg__label">Tasks</span>
            <div className="dlg__items">
              {items.map((i) => (
                <span key={keyOf(i)} className="dlg__chip" title={i.title}>
                  <span className="dlg__id">{i.label}</span> {i.title}
                  {keyOf(i) !== keyOf(self) && (
                    <button type="button" className="dlg__x" aria-label={`Remove ${i.title}`} disabled={busy}
                      onClick={() => setExtra(extra.filter((x) => keyOf(x) !== keyOf(i)))}>×</button>
                  )}
                </span>
              ))}
              <input className="dlg__search" value={query} disabled={busy} placeholder="Add another task to this delegation…"
                onChange={(e) => setQuery(e.target.value)} aria-label="Find another task to add" />
              {matches.length > 0 && (
                <div className="dlg__matches">
                  {matches.map((m) => (
                    <button key={keyOf(m)} type="button" className="dlg__match" onClick={() => { setExtra([...extra, m]); setQuery(''); }}>
                      <span className="dlg__id">{m.label}</span> {m.title}
                    </button>
                  ))}
                </div>
              )}
              {query.trim() && !matches.length && <div className="ho__note">No other open task matches — only tasks NEURO or Microsoft hold can be delegated.</div>}
            </div>
          </div>

          <div className="dlg__row">
            <span className="dlg__label">How</span>
            <label className="dlg__radio"><input type="radio" checked={via === 'email'} onChange={() => setVia('email')} /> Email them the hand-over</label>
            <label className="dlg__radio"><input type="radio" checked={via === 'told'} onChange={() => setVia('told')} /> I’ve told them already</label>
          </div>

          {via === 'told' ? (
            <button type="button" className="ho__btn ho__btn--go" disabled={busy || !person} onClick={record}>
              Delegate {items.length > 1 ? `${items.length} tasks` : 'it'}{who ? ` to ${who.first}` : ''}
            </button>
          ) : !draft ? (
            <>
              {who && !who.email && <div className="ho__note ho__note--warn">{who.name} has no email address in their People note — choose “I’ve told them already”, or add one.</div>}
              <button type="button" className="ho__btn ho__btn--go" disabled={busy || !person || (who && !who.email)} onClick={writeEmail}>Write the email</button>
            </>
          ) : (
            <div className="ho__editor">
              <div className="ho__to">To {who ? `${who.name} <${who.email}>` : person} · from your work address</div>
              <input className="ho__subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} aria-label="Subject" />
              <textarea className="ho__body" rows={12} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label="Hand-over email" />
              {gaps.length > 0 && <div className="ho__note ho__note--warn">Still to fill in: {gaps.join(', ')} — NEURO won’t guess these for you.</div>}
              <button type="button" className="ho__btn ho__btn--go" disabled={busy || gaps.length > 0} onClick={send}>Send to {who ? who.first : person}</button>
            </div>
          )}
          {note && <div className={`ho__note ho__note--${note.tone}`}>{note.text}</div>}
        </div>
      )}
    </div>
  );
}
