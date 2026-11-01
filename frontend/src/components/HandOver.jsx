import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './HandOver.css';

/**
 * Delegation prompts (1 Nov 2026) — backend/services/delegation.js.
 *
 * "Could go to Naomi — she runs Tier 2 billing", with Hand over / Not this one.
 * Hand over opens the drafted email; any [gap] left in it blocks Send (the
 * server refuses too). Send prepares a governed email and spends ONE intent
 * grant — the press is the decision. The task or email leaves Nick's list only
 * once the send is read back in Sent Items.
 *
 * One read of GET /api/delegation is shared by every card on the screen
 * (cached a minute), so a task list of 150 rows asks once, not 150 times.
 */

const GAP_RE = /\[[^\]\n]{1,60}\]/g;
let cache = { at: 0, promise: null };
const listeners = new Set();

function load(force = false) {
  if (!force && cache.promise && Date.now() - cache.at < 60000) return cache.promise;
  cache = {
    at: Date.now(),
    promise: apiFetch('/api/delegation').then((r) => r.json()).catch(() => ({ ok: false, suggestions: [] })),
  };
  return cache.promise;
}
function refresh() { load(true).then((d) => listeners.forEach((fn) => fn(d))); }

function useSuggestions() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    const fn = (d) => { if (live) setData(d); };
    listeners.add(fn);
    load().then(fn);
    return () => { live = false; listeners.delete(fn); };
  }, []);
  return data;
}

async function post(path, body) {
  const r = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return j || { ok: false, error: `HTTP ${r.status}` };
}

export function Suggestion({ s, showTitle = false }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(s.draft ? s.draft.subject : '');
  const [body, setBody] = useState(s.draft ? s.draft.body : '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const gaps = [...new Set(`${subject}\n${body}`.match(GAP_RE) || [])];

  const dismiss = async () => {
    setBusy(true);
    const r = await post(`/api/delegation/${s.id}/dismiss`);
    setBusy(false);
    if (!r.ok) setNote({ tone: 'bad', text: r.error || 'Could not save that.' }); else refresh();
  };
  const send = async () => {
    if (gaps.length) { setNote({ tone: 'warn', text: `Fill in ${gaps.join(', ')} first.` }); return; }
    setBusy(true); setNote({ tone: 'info', text: 'Sending…' });
    const p = await post(`/api/delegation/${s.id}/hand-over`, { subject, body });
    if (!p.ok) { setBusy(false); setNote({ tone: 'bad', text: p.error || 'Could not prepare the email.' }); return; }
    const r = await executeDirect(p.action);
    setBusy(false);
    const o = directOutcome(r);
    setNote({ tone: o.tone, text: `${o.text} Once it is in Sent Items, ${s.first} has it in Waiting on.` });
    setTimeout(refresh, 4000);
  };

  return (
    <div className="ho">
      <div className="ho__line">
        {showTitle && s.title && <span className="ho__title">{s.title}</span>}
        <span className="ho__why">{s.line}</span>
      </div>
      {s.status === 'prepared' ? (
        <div className="ho__note">Hand-over email prepared — waiting for Sent Items.</div>
      ) : (
        <div className="ho__acts">
          <button type="button" className="ho__btn ho__btn--go" disabled={busy || !!s.blocker} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Hand over'}</button>
          <button type="button" className="ho__btn" disabled={busy} onClick={dismiss}>Not this one</button>
        </div>
      )}
      {s.blocker && <div className="ho__note ho__note--warn">{s.blocker}</div>}
      {open && (
        <div className="ho__editor">
          <div className="ho__to">To {s.person} &lt;{s.email}&gt; · from your work address</div>
          <input className="ho__subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
          <textarea className="ho__body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Hand-over email" />
          {gaps.length > 0 && <div className="ho__note ho__note--warn">Still to fill in: {gaps.join(', ')} — NEURO won’t guess these for you.</div>}
          <button type="button" className="ho__btn ho__btn--go" disabled={busy || gaps.length > 0} onClick={send}>Send to {s.first}</button>
        </div>
      )}
      {note && <div className={`ho__note ho__note--${note.tone}`}>{note.text}</div>}
    </div>
  );
}

/** Now: "Could hand over" (≤3). Renders nothing when there is nothing to suggest. */
export function HandOverSection() {
  const data = useSuggestions();
  const list = (data && data.suggestions) || [];
  if (!list.length) return null;
  return (
    <section className="ho-section">
      <h3 className="ho-section__h">Could hand over</h3>
      {list.map((s) => <Suggestion key={s.id} s={s} showTitle />)}
    </section>
  );
}

/** A task or email card: the suggestion for THIS item, if there is one. */
export function HandOverHint({ kind, itemId }) {
  const data = useSuggestions();
  const s = ((data && data.suggestions) || []).find((x) => x.kind === kind && String(x.itemId) === String(itemId));
  if (!s) return null;
  return <div onClick={(e) => e.stopPropagation()}><Suggestion s={s} /></div>;
}

export default HandOverSection;
