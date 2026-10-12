import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './PersonalInboxPanel.css';

/**
 * Life → Personal inbox (12 Oct 2026): nick@ and contact@, newest first, no AI
 * sorting (Nick's call), separate from the work Inbox. saim@ is shown only for
 * what lands there: bounces and auto-replies (a bounced hike alert is flagged).
 *
 * Opening a message does NOT mark it read — Mark read does. A reply prepares
 * the same governed reply the work Inbox uses and sends on the click, from the
 * SAME mailbox; the "From" line is the server's answer, never composed here.
 */

async function call(path, method = 'GET', body) {
  const r = await fetch(apiUrl(path), {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch { d = { ok: false, error: `HTTP ${r.status}` }; }
  return d;
}

export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const KIND_WORDS = { bounce: 'Bounced', 'auto-reply': 'Auto-reply', reply: 'Reply to SAiM' };

export function MessageList({ items, onOpen, openId, now }) {
  if (!items.length) return <div className="pi-empty">Nothing in this mailbox.</div>;
  return (
    <ul className="pi-list">
      {items.map((m) => (
        <li key={m.id} className={`pi-row${m.seen ? '' : ' pi-unread'}${openId === m.id ? ' pi-open' : ''}`}>
          <button type="button" className="pi-row-btn" onClick={() => onOpen(m.id)}>
            <span className="pi-from">{m.from}</span>
            {m.kind && <span className={`pi-kind pi-kind-${m.kind}`}>{KIND_WORDS[m.kind] || m.kind}</span>}
            {m.hikeTripId && <span className="pi-kind pi-kind-bounce">hike alert</span>}
            <span className="pi-age">{ago(m.received, now)}</span>
            <span className="pi-subject">{m.subject}</span>
            {m.preview && <span className="pi-preview">{m.preview.slice(0, 140)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MessageView({ data, onRead, onReply, busy, outcome, canReply }) {
  const [text, setText] = useState('');
  const [replyAll, setReplyAll] = useState(false);
  if (!data) return null;
  const m = data.message;
  return (
    <div className="pi-view" data-testid="pi-view">
      <div className="pi-view-subject">{m.subject}</div>
      <div className="pi-view-meta">From <strong>{m.fromName || m.from}</strong> &lt;{m.from}&gt;{m.received ? ` · ${new Date(m.received).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
      {(m.cc || []).length > 0 && <div className="pi-view-meta">Cc {m.cc.map((c) => c.email).join(', ')}</div>}
      <pre className="pi-body">{m.body || '(no text)'}</pre>
      <div className="pi-actions">
        <button type="button" className="pi-btn" disabled={busy} onClick={onRead}>Mark read</button>
      </div>
      {canReply && (
        <div className="pi-reply">
          {data.sendsFrom && <div className="pi-from-line" data-testid="pi-sends-from">From <strong>{data.sendsFrom.address}</strong> → {m.from}{replyAll && (m.cc || []).length ? ' + everyone on it' : ''}</div>}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Your reply…" />
          <div className="pi-actions">
            {(m.cc || []).length > 0 && <label className="pi-check"><input type="checkbox" checked={replyAll} onChange={(e) => setReplyAll(e.target.checked)} /> Reply all</label>}
            <button type="button" className="pi-btn pi-btn-primary" disabled={busy || !text.trim()} onClick={async () => { if (await onReply(text, replyAll)) setText(''); }}>{busy ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      )}
      {outcome && <div className={`pi-outcome pi-outcome-${outcome.tone}`}>{outcome.text}</div>}
    </div>
  );
}

export default function PersonalInboxPanel() {
  const [overview, setOverview] = useState(null);
  const [tab, setTab] = useState('nick');
  const [items, setItems] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);

  const load = useCallback(async () => {
    const [o, l] = await Promise.all([call('/api/personal-inbox'), call(`/api/personal-inbox/mail/${tab}`)]);
    if (o && o.ok) setOverview(o); else setError((o && o.error) || 'Could not read the personal inbox.');
    if (l && l.ok) setItems(l.items); else setItems([]);
  }, [tab]);
  useEffect(() => { setOpenId(null); setView(null); setOutcome(null); load(); }, [load]);

  const open = async (id) => {
    setOpenId(id); setView(null); setOutcome(null); setError(null);
    const d = await call(`/api/personal-inbox/message/${encodeURIComponent(id)}`);
    if (d && d.ok) setView(d); else setError((d && d.error) || 'Could not open it.');
  };
  const refresh = async () => { setBusy(true); setError(null); try { await call('/api/personal-inbox/refresh', 'POST', {}); await load(); } finally { setBusy(false); } };
  const markRead = async () => {
    setBusy(true);
    try {
      const d = await call(`/api/personal-inbox/message/${encodeURIComponent(openId)}/read`, 'POST', {});
      if (!d.ok) setError(`Could not mark it read (${d.reason || 'error'}).`);
      await load();
    } finally { setBusy(false); }
  };
  const reply = async (text, replyAll) => {
    setBusy(true); setOutcome(null); setError(null);
    try {
      const p = await call(`/api/personal-inbox/message/${encodeURIComponent(openId)}/reply`, 'POST', { body: text, replyAll });
      if (!p.ok) { setError(p.error || 'Could not prepare the reply.'); return false; }
      const x = await executeDirect(p.action);
      setOutcome(directOutcome(x));
      return x.ok;
    } finally { setBusy(false); }
  };

  const boxes = overview ? overview.mailboxes : [];
  const current = boxes.find((b) => b.key === tab);
  return (
    <div className="pi" data-testid="personal-inbox">
      <div className="pi-head">
        <h1 className="pi-title">Personal inbox</h1>
        <button type="button" className="pi-btn" disabled={busy} onClick={refresh}>{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      <p className="pi-lede">{overview ? overview.rule : 'Loading…'}</p>
      <div className="pi-tabs" role="tablist">
        {boxes.map((b) => (
          <button key={b.key} type="button" role="tab" aria-selected={tab === b.key} className={`pi-tab${tab === b.key ? ' pi-tab-on' : ''}`} onClick={() => setTab(b.key)}>
            {b.address}{b.watchedOnly ? ' (bounces)' : ''}{b.unread ? <span className="pi-badge">{b.unread}</span> : null}
          </button>
        ))}
      </div>
      {current && !current.configured && <div className="pi-warn">No password saved for {current.address} — add it in Settings → Personal email.</div>}
      {current && current.last && current.last.ok === false && <div className="pi-warn">Last check could not read {current.address}: {current.last.why}</div>}
      {current && current.watchedOnly && <div className="pi-note">SAiM sends from here with replies going to nick@, so what lands here is mostly machinery. A bounced hike alert is flagged and pushed to you.</div>}
      {error && <div className="pi-warn">{error}</div>}
      <div className="pi-split">
        <MessageList items={items} onOpen={open} openId={openId} />
        <MessageView data={view} onRead={markRead} onReply={reply} busy={busy} outcome={outcome} canReply={!!(current && !current.watchedOnly)} />
      </div>
    </div>
  );
}
