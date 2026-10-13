import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import GmailCleanup from './GmailCleanup';
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

export function MessageList({ items, onOpen, openId, now, selected = null, onToggle = null }) {
  if (!items.length) return <div className="pi-empty">Nothing in this mailbox.</div>;
  return (
    <ul className="pi-list">
      {items.map((m) => (
        <li key={m.id} className={`pi-row${m.seen ? '' : ' pi-unread'}${openId === m.id ? ' pi-open' : ''}${selected && selected.has(m.id) ? ' pi-selected' : ''}`}>
          {onToggle && <input type="checkbox" className="pi-pick" aria-label={`Select ${m.subject}`} checked={!!(selected && selected.has(m.id))} onChange={() => onToggle(m.id)} />}
          <button type="button" className="pi-row-btn" onClick={() => onOpen(m.id)}>
            <span className="pi-from">{m.from}</span>
            {m.kind && <span className={`pi-kind pi-kind-${m.kind}`}>{KIND_WORDS[m.kind] || m.kind}</span>}
            {m.hikeTripId && <span className="pi-kind pi-kind-bounce">hike alert</span>}
            {m.why && <span className="pi-why" title="Why this is here">{m.why}</span>}
            <span className="pi-age">{ago(m.received, now)}</span>
            <span className="pi-subject">{m.subject}</span>
            {m.preview && <span className="pi-preview">{m.preview.slice(0, 140)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

const splitAddrs = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/**
 * Compose a new email (12 Oct 2026). The From dropdown lists the addresses the
 * server says can send; NEURO suggests one from who it is going to, and SAYS
 * when the choice and the recipients disagree — it never picks silently.
 */
export function ComposeForm({ options, suggestion, onRecipients, onSend, onCancel, busy, outcome, initialFrom = null }) {
  const ready = (options || []).filter((o) => o.ready);
  const [from, setFrom] = useState(initialFrom || (ready[0] && ready[0].key) || 'work');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [touchedFrom, setTouchedFrom] = useState(false);
  useEffect(() => {
    if (!touchedFrom && suggestion && suggestion.mailbox && ready.some((o) => o.key === suggestion.mailbox)) setFrom(suggestion.mailbox);
  }, [suggestion, touchedFrom]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = (options || []).find((o) => o.key === from);
  const mismatch = suggestion && !suggestion.ask && suggestion.mailbox && suggestion.mailbox !== from
    && !(suggestion.mailbox === 'nick' && from !== 'work');
  return (
    <div className="pi-compose" data-testid="pi-compose">
      <div className="pi-compose-row">
        <label htmlFor="pi-from">From</label>
        <select id="pi-from" value={from} onChange={(e) => { setFrom(e.target.value); setTouchedFrom(true); }}>
          {(options || []).map((o) => <option key={o.key} value={o.key} disabled={!o.ready}>{o.address}{o.ready ? '' : ' (no password saved)'}</option>)}
        </select>
      </div>
      {suggestion && suggestion.ask && <div className="pi-warn" data-testid="pi-compose-ask">{suggestion.why} Check the From.</div>}
      {mismatch && <div className="pi-warn" data-testid="pi-compose-mismatch">NEURO would send this from {(options.find((o) => o.key === suggestion.mailbox) || {}).address} — {suggestion.why}</div>}
      <div className="pi-compose-row"><label htmlFor="pi-to">To</label><input id="pi-to" value={to} onChange={(e) => setTo(e.target.value)} onBlur={() => onRecipients(splitAddrs(`${to},${cc}`))} placeholder="name@example.com, …" /></div>
      <div className="pi-compose-row"><label htmlFor="pi-cc">Cc</label><input id="pi-cc" value={cc} onChange={(e) => setCc(e.target.value)} onBlur={() => onRecipients(splitAddrs(`${to},${cc}`))} placeholder="optional" /></div>
      <div className="pi-compose-row"><label htmlFor="pi-subject">Subject</label><input id="pi-subject" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="Your email…" />
      <div className="pi-from-line" data-testid="pi-compose-from">Sends from <strong>{chosen ? chosen.address : from}</strong>{chosen ? ` (${chosen.via})` : ''}</div>
      <div className="pi-actions">
        <button type="button" className="pi-btn pi-btn-primary" disabled={busy || !splitAddrs(to).length || !subject.trim() || !body.trim()}
          onClick={async () => { if (await onSend({ from, to: splitAddrs(to), cc: splitAddrs(cc), subject, body })) { setTo(''); setCc(''); setSubject(''); setBody(''); } }}>{busy ? 'Sending…' : 'Send'}</button>
        <button type="button" className="pi-btn" disabled={busy} onClick={onCancel}>Close</button>
      </div>
      {outcome && <div className={`pi-outcome pi-outcome-${outcome.tone}`}>{outcome.text}</div>}
    </div>
  );
}

/**
 * Multi-select actions (12 Oct 2026, Nick). Delete asks once, names the count
 * and where the mail goes. "Stop showing" is Gmail-only and acts on SENDERS.
 */
export function BulkBar({ count, total, onAll, onNone, onRead, onDelete, onHideSenders, busy }) {
  const [confirm, setConfirm] = useState(false);
  if (!total) return null;
  return (
    <div className="pi-bulk" data-testid="pi-bulk">
      <label className="pi-check"><input type="checkbox" checked={count > 0 && count === total} ref={(el) => { if (el) el.indeterminate = count > 0 && count < total; }} onChange={() => (count === total ? onNone() : onAll())} /> {count ? `${count} selected` : 'Select all'}</label>
      {count > 0 && (confirm
        ? <>
            <span className="pi-confirm">Move {count} to the mailbox’s Bin? (recoverable there)</span>
            <button type="button" className="pi-btn pi-btn-danger" disabled={busy} onClick={() => { setConfirm(false); onDelete(); }}>Delete {count}</button>
            <button type="button" className="pi-btn" disabled={busy} onClick={() => setConfirm(false)}>Keep</button>
          </>
        : <>
            <button type="button" className="pi-btn" disabled={busy} onClick={onRead}>Mark read</button>
            <button type="button" className="pi-btn" disabled={busy} onClick={() => setConfirm(true)}>Delete</button>
            {onHideSenders && <button type="button" className="pi-btn" disabled={busy} onClick={onHideSenders} title="Hide these senders here; Gmail is not changed">Stop showing these senders</button>}
            <button type="button" className="pi-btn" disabled={busy} onClick={onNone}>Clear</button>
          </>)}
    </div>
  );
}

/**
 * The Gmail tab's rule (12 Oct 2026): what lets a message in, and Nick's two
 * sender lists, each entry removable. Nothing here changes Gmail.
 */
export function GmailRules({ rules, onSet, busy }) {
  if (!rules) return null;
  const keep = rules.keep || [];
  const hide = rules.hide || [];
  return (
    <details className="pi-rules" data-testid="pi-gmail-rules">
      <summary>Why mail is here — {keep.length} always shown, {hide.length} hidden</summary>
      <p className="pi-note">NEURO shows a Gmail message when it is: {Object.values(rules.reasons || {}).join(' · ')}. Mailing lists and anything else stay in Gmail, untouched. Hidden senders beat every reason.{rules.correspondents ? ` People you write to: ${rules.correspondents.count} addresses from your Gmail Sent (last 12 months).` : ''}</p>
      {keep.length > 0 && <div className="pi-rule-list"><strong>Always shown</strong>{keep.map((s) => <span key={s} className="pi-rule">{s} <button type="button" className="pi-btn pi-btn-small" disabled={busy} onClick={() => onSet(s, null)}>Remove</button></span>)}</div>}
      {hide.length > 0 && <div className="pi-rule-list"><strong>Hidden</strong>{hide.map((s) => <span key={s} className="pi-rule">{s} <button type="button" className="pi-btn pi-btn-small" disabled={busy} onClick={() => onSet(s, null)}>Show again</button></span>)}</div>}
    </details>
  );
}

export function MessageView({ data, onRead, onReply, onDelete, busy, outcome, canReply, onSender = null }) {
  const [text, setText] = useState('');
  const [replyAll, setReplyAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
        {onDelete && (confirmDelete
          ? <>
              <span className="pi-confirm">Move to the mailbox’s Bin? (recoverable there)</span>
              <button type="button" className="pi-btn pi-btn-danger" disabled={busy} onClick={() => { setConfirmDelete(false); onDelete(); }}>Delete</button>
              <button type="button" className="pi-btn" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</button>
            </>
          : <button type="button" className="pi-btn" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</button>)}
        {onSender && m.from && <>
          <button type="button" className="pi-btn" disabled={busy} onClick={() => onSender(m.from, 'keep')} data-testid="pi-keep">Always show {m.from}</button>
          <button type="button" className="pi-btn" disabled={busy} onClick={() => onSender(m.from, 'hide')} data-testid="pi-hide">Stop showing {m.from}</button>
        </>}
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
  const [composing, setComposing] = useState(false);
  const [options, setOptions] = useState([]);
  const [suggestion, setSuggestion] = useState(null);
  const [rules, setRules] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [cleanup, setCleanup] = useState(false);

  const startCompose = async () => {
    setComposing(true); setOutcome(null); setSuggestion(null);
    const d = await call('/api/personal-inbox/compose/options');
    if (d && d.ok) setOptions(d.options);
  };
  const recipients = async (list) => {
    if (!list.length) { setSuggestion(null); return; }
    const d = await call(`/api/personal-inbox/compose/options?to=${encodeURIComponent(list.join(','))}`);
    if (d && d.ok) { setOptions(d.options); setSuggestion(d.suggestion); }
  };
  const sendNew = async (fields) => {
    setBusy(true); setOutcome(null); setError(null);
    try {
      const p = await call('/api/personal-inbox/compose', 'POST', fields);
      if (!p.ok) { setError(p.error || 'Could not prepare the email.'); return false; }
      const x = await executeDirect(p.action);
      setOutcome(directOutcome(x));
      return x.ok;
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(null);
    try {
      const d = await call(`/api/personal-inbox/message/${encodeURIComponent(openId)}/delete`, 'POST', {});
      if (!d.ok) { setError(`Could not delete it (${d.reason || 'error'}).`); return; }
      setOpenId(null); setView(null);
      await load();
    } finally { setBusy(false); }
  };

  const load = useCallback(async () => {
    const [o, l] = await Promise.all([call('/api/personal-inbox'), call(`/api/personal-inbox/mail/${tab}`)]);
    if (o && o.ok) setOverview(o); else setError((o && o.error) || 'Could not read the personal inbox.');
    if (l && l.ok) setItems(l.items); else setItems([]);
    if (tab === 'gmail') { const r = await call('/api/personal-inbox/gmail/rules'); setRules(r && r.ok ? r : null); }
  }, [tab]);
  const setSender = async (sender, list) => {
    setBusy(true); setError(null);
    try {
      const d = await call('/api/personal-inbox/gmail/rules', 'POST', { sender, list });
      if (!d.ok) { setError(d.error || 'Could not change that.'); return; }
      if (list === 'hide') { setOpenId(null); setView(null); }
      setOutcome(list === 'keep' ? { tone: 'ok', text: `Mail from ${d.sender} will always show${typeof d.pulled === 'number' ? ` — ${d.pulled} from the last 30 days brought in` : d.why ? ` (could not pull older mail: ${d.why})` : ''}.` }
        : list === 'hide' ? { tone: 'ok', text: `Mail from ${d.sender} is hidden here (still in Gmail). Undo under “Why mail is here”.` } : null);
      await load();
    } finally { setBusy(false); }
  };
  useEffect(() => { setOpenId(null); setView(null); setOutcome(null); setSelected(new Set()); load(); }, [load]);
  // A selection only ever names messages still in the list.
  useEffect(() => { setSelected((s) => { const keep = new Set([...s].filter((id) => items.some((m) => m.id === id))); return keep.size === s.size ? s : keep; }); }, [items]);
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const runBulk = async (action) => {
    setBusy(true); setError(null); setOutcome(null);
    try {
      const ids = [...selected];
      const d = await call('/api/personal-inbox/bulk', 'POST', { action, ids });
      if (d && d.error) { setError(d.error); return; }
      const failed = (d && d.failed) || [];
      setOutcome({ tone: failed.length ? 'warn' : 'ok', text: `${action === 'read' ? 'Marked read' : 'Moved to the Bin'}: ${d.done || 0}${failed.length ? ` — ${failed.length} could not be (${[...new Set(failed.map((f) => f.reason))].join(', ')})` : ''}.` });
      if (action === 'delete' && openId && ids.includes(openId)) { setOpenId(null); setView(null); }
      setSelected(new Set(failed.map((f) => f.id)));
      await load();
    } finally { setBusy(false); }
  };
  const hideSenders = async () => {
    const senders = [...new Set(items.filter((m) => selected.has(m.id)).map((m) => m.fromEmail).filter(Boolean))];
    if (!senders.length) return;
    setBusy(true); setError(null);
    try {
      const bad = [];
      for (const s of senders) { const d = await call('/api/personal-inbox/gmail/rules', 'POST', { sender: s, list: 'hide' }); if (!d || !d.ok) bad.push(s); }
      setOutcome({ tone: bad.length ? 'warn' : 'ok', text: `Hidden here: ${senders.length - bad.length} sender${senders.length - bad.length === 1 ? '' : 's'} (still in Gmail).${bad.length ? ` Could not hide ${bad.join(', ')}.` : ''} Undo under “Why mail is here”.` });
      setSelected(new Set());
      await load();
    } finally { setBusy(false); }
  };

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
        <div className="pi-actions">
          <button type="button" className="pi-btn pi-btn-primary" disabled={busy} onClick={startCompose}>Compose</button>
          <button type="button" className="pi-btn" disabled={busy} onClick={refresh}>{busy ? 'Checking…' : 'Check now'}</button>
        </div>
      </div>
      <p className="pi-lede">{overview ? overview.rule : 'Loading…'}</p>
      <div className="pi-tabs" role="tablist">
        {boxes.map((b) => (
          <button key={b.key} type="button" role="tab" aria-selected={tab === b.key} className={`pi-tab${tab === b.key ? ' pi-tab-on' : ''}`} onClick={() => setTab(b.key)}>
            {b.address || b.key}{b.watchedOnly ? ' (bounces)' : ''}{b.unread ? <span className="pi-badge">{b.unread}</span> : null}
          </button>
        ))}
      </div>
      {current && !current.configured && <div className="pi-warn">No password saved for {current.address} — add it in Settings → Personal email.</div>}
      {current && current.last && current.last.ok === false && <div className="pi-warn">Last check could not read {current.address}: {current.last.why}</div>}
      {current && current.watchedOnly && <div className="pi-note">SAiM sends from here with replies going to nick@, so what lands here is mostly machinery. A bounced hike alert is flagged and pushed to you.</div>}
      {current && current.key === 'gmail' && <GmailRules rules={rules} onSet={setSender} busy={busy} />}
      {current && current.key === 'gmail' && current.configured && <div className="pi-actions"><button type="button" className="pi-btn" onClick={() => setCleanup((v) => !v)}>{cleanup ? 'Close clean-up' : 'Clean up senders'}</button></div>}
      {current && current.key === 'gmail' && cleanup && <GmailCleanup onChanged={load} />}
      {error && <div className="pi-warn">{error}</div>}
      {composing && <ComposeForm options={options} suggestion={suggestion} onRecipients={recipients} onSend={sendNew} onCancel={() => setComposing(false)} busy={busy} outcome={outcome} initialFrom={current && !current.watchedOnly && current.configured ? current.key : null} />}
      {/* Nothing open: the list takes the whole width rather than leaving half the page empty. */}
      <div className={`pi-split${view ? '' : ' pi-split--solo'}`}>
        <div className="pi-listcol">
          <BulkBar count={selected.size} total={items.length} onAll={() => setSelected(new Set(items.map((m) => m.id)))} onNone={() => setSelected(new Set())} onRead={() => runBulk('read')} onDelete={() => runBulk('delete')} onHideSenders={tab === 'gmail' ? hideSenders : null} busy={busy} />
          <MessageList items={items} onOpen={open} openId={openId} selected={selected} onToggle={current && current.watchedOnly ? null : toggle} />
        </div>
        <MessageView data={view} onRead={markRead} onReply={reply} onDelete={remove} busy={busy} outcome={composing ? null : outcome} canReply={!!(current && !current.watchedOnly)} onSender={tab === 'gmail' ? setSender : null} />
      </div>
    </div>
  );
}
