import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './GmailCleanup.css';

/**
 * Gmail clean-up (12 Oct 2026). One row per sender over the last 30 days,
 * busiest first, with how many were opened. Archive is a RULE (that sender
 * skips the inbox from now on, existing mail too — nothing deleted);
 * Unsubscribe uses the sender's own unsubscribe and archives too; Keep takes
 * the sender off the list. Every word about what a button does comes from the
 * server's `note`, not from here.
 */

async function call(path, method = 'GET', body) {
  const r = await fetch(apiUrl(path), { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  try { return await r.json(); } catch { return { ok: false, error: `HTTP ${r.status}` }; }
}

const WORDS = { archive: 'Archived', keep: 'Kept', unsubscribed: 'Unsubscribed' };
const UNSUB_WORDS = { 'one-click': 'Unsubscribe', web: 'Unsubscribe (opens page)', mailto: 'Unsubscribe (opens email)' };

export function CleanupView({ data, onDecide, onRescan, busy, outcome, selected = null, onToggle = null, onSelectAll = null, onBulk = null }) {
  const [showDecided, setShowDecided] = useState(false);
  const sel = selected || new Set();
  if (!data) return <div className="gc-empty">Loading…</div>;
  const senders = data.senders || [];
  const decided = data.decided || [];
  return (
    <div className="gc" data-testid="gmail-cleanup">
      <div className="gc-head">
        <div>
          <strong>Clean up Gmail</strong>
          <div className="gc-sub">{data.total != null ? `${data.total} emails in the last ${data.days} days from ${senders.length + decided.length} senders` : 'Not scanned yet'}{data.scannedAt ? ` · read ${new Date(data.scannedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
        </div>
        <button type="button" className="pi-btn" disabled={busy} onClick={onRescan}>{busy ? 'Working…' : 'Rescan'}</button>
      </div>
      {data.scanError && <div className="pi-warn">Could not read Gmail: {data.scanError}</div>}
      {data.note && <p className="pi-note">{data.note}</p>}
      {outcome && <div className={`pi-outcome pi-outcome-${outcome.tone}`}>{outcome.text}{outcome.link && <> <a href={outcome.link} target="_blank" rel="noopener noreferrer" data-testid="gc-unsub-link">Open the unsubscribe page</a></>}{(outcome.links || []).length > 0 && <ul className="gc-links">{outcome.links.map((l) => <li key={l.sender}><a href={l.link} target="_blank" rel="noopener noreferrer">{l.sender}</a> — finish unsubscribing</li>)}</ul>}</div>}
      {onBulk && senders.length > 0 && (
        <div className="pi-bulk gc-bulk" data-testid="gc-bulk">
          <label className="pi-check"><input type="checkbox" checked={sel.size > 0 && sel.size === senders.length} ref={(el) => { if (el) el.indeterminate = sel.size > 0 && sel.size < senders.length; }} onChange={() => onSelectAll(sel.size === senders.length ? [] : senders.map((s) => s.sender))} /> {sel.size ? `${sel.size} selected` : 'Select all'}</label>
          {sel.size > 0 && <>
            <button type="button" className="pi-btn" disabled={busy || !senders.some((s) => sel.has(s.sender) && s.unsubscribe && s.unsubscribe.kind)} onClick={() => onBulk('unsubscribe')}>Unsubscribe</button>
            <button type="button" className="pi-btn" disabled={busy} onClick={() => onBulk('archive')}>Archive</button>
            <button type="button" className="pi-btn" disabled={busy} onClick={() => onBulk('keep')}>Keep</button>
            <button type="button" className="pi-btn" disabled={busy} onClick={() => onSelectAll([])}>Clear</button>
          </>}
        </div>
      )}
      {senders.length === 0
        ? <div className="gc-empty">{data.scannedAt ? 'Every sender has a decision.' : 'Nothing read yet.'}</div>
        : (
          <ul className="gc-list">
            {senders.map((s) => (
              <li key={s.sender} className={`gc-row${onToggle ? ' gc-pickable' : ''}${sel.has(s.sender) ? ' gc-selected' : ''}`}>
                {onToggle && <input type="checkbox" className="pi-pick gc-pick" aria-label={`Select ${s.name || s.sender}`} checked={sel.has(s.sender)} onChange={() => onToggle(s.sender)} />}
                <div className="gc-who">
                  <span className="gc-name">{s.name || s.sender}</span>
                  <span className="gc-addr">{s.sender}</span>
                  <span className="gc-last">{s.lastSubject}</span>
                </div>
                <div className="gc-num"><strong>{s.count}</strong> · opened {s.opened}</div>
                <div className="gc-acts">
                  {s.unsubscribe && s.unsubscribe.kind && <button type="button" className="pi-btn" disabled={busy} onClick={() => onDecide(s.sender, 'unsubscribe')}>{UNSUB_WORDS[s.unsubscribe.kind] || 'Unsubscribe'}</button>}
                  <button type="button" className="pi-btn" disabled={busy} onClick={() => onDecide(s.sender, 'archive')}>Archive</button>
                  <button type="button" className="pi-btn" disabled={busy} onClick={() => onDecide(s.sender, 'keep')}>Keep</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      {decided.length > 0 && (
        <div className="gc-decided">
          <button type="button" className="pi-btn pi-btn-small" onClick={() => setShowDecided((v) => !v)}>{showDecided ? 'Hide' : 'Show'} decided ({decided.length})</button>
          {showDecided && (
            <ul className="gc-list">
              {decided.map((d) => (
                <li key={d.sender} className="gc-row">
                  <div className="gc-who"><span className="gc-name">{d.name || d.sender}</span><span className="gc-addr">{d.sender}</span></div>
                  <div className="gc-num">{WORDS[d.action] || d.action}{d.unsubscribe && d.unsubscribe.status ? ` (${d.unsubscribe.status})` : ''}</div>
                  <div className="gc-acts"><button type="button" className="pi-btn pi-btn-small" disabled={busy} onClick={() => onDecide(d.sender, 'clear')}>Undo</button></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function GmailCleanup({ onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const load = useCallback(async () => { const d = await call('/api/personal-inbox/gmail/cleanup'); setData(d && d.ok ? d : { scanError: (d && d.error) || 'could not load', senders: [], decided: [] }); }, []);
  useEffect(() => { load(); }, [load]);
  const decide = async (sender, action) => {
    setBusy(true); setOutcome(null);
    try {
      const r = await call('/api/personal-inbox/gmail/cleanup', 'POST', { sender, action });
      if (!r.ok) { setOutcome({ tone: 'warn', text: r.error || 'That did not work.' }); return; }
      const moved = typeof r.archived === 'number' && r.archived > 0 ? ` ${r.archived} moved out of the inbox.` : '';
      const text = action === 'unsubscribe'
        ? `${sender}: ${r.method === 'one-click' && r.status === 'sent' ? 'unsubscribed' : 'unsubscribe link opened'}.${moved}${r.note ? ` ${r.note}` : ''}`
        : action === 'archive' ? `${sender} now skips your inbox.${moved}` : action === 'keep' ? `${sender} kept.` : `${sender}: decision undone (nothing moved back).`;
      setOutcome({ tone: 'ok', text, link: r.link || null });
      await load();
      if (onChanged) onChanged();
    } finally { setBusy(false); }
  };
  const toggle = (s) => setSelected((cur) => { const n = new Set(cur); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const bulk = async (action) => {
    setBusy(true); setOutcome(null);
    try {
      const senders = [...selected];
      const r = await call('/api/personal-inbox/gmail/cleanup/bulk', 'POST', { senders, action });
      if (r && r.error) { setOutcome({ tone: 'warn', text: r.error }); return; }
      const failed = (r && r.failed) || [];
      const word = { unsubscribe: 'Unsubscribed', archive: 'Archived', keep: 'Kept' }[action] || 'Done';
      const moved = r && r.archived ? ` ${r.archived} moved out of the inbox.` : '';
      const skipped = failed.length ? ` ${failed.length} not done: ${failed.map((f) => `${f.sender} (${f.reason})`).join('; ')}.` : '';
      setOutcome({ tone: failed.length ? 'warn' : 'ok', text: `${word}: ${(r && r.done ? r.done.length : 0)} sender${r && r.done && r.done.length === 1 ? '' : 's'}.${moved}${skipped}${r && r.links && r.links.length ? ' These need you to finish on their own page:' : ''}`, links: (r && r.links) || [] });
      setSelected(new Set(failed.map((f) => f.sender)));
      await load();
      if (onChanged) onChanged();
    } finally { setBusy(false); }
  };
  const rescan = async () => { setBusy(true); setOutcome(null); try { const d = await call('/api/personal-inbox/gmail/cleanup/scan', 'POST', {}); if (d && d.ok) setData(d); else setOutcome({ tone: 'warn', text: (d && d.error) || 'Could not read Gmail.' }); } finally { setBusy(false); } };
  return <CleanupView data={data} onDecide={decide} onRescan={rescan} busy={busy} outcome={outcome} selected={selected} onToggle={toggle} onSelectAll={(list) => setSelected(new Set(list))} onBulk={bulk} />;
}
