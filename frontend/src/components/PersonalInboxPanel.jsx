import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import GmailCleanup from './GmailCleanup';
import EmailCard, { timeAgo } from './EmailCard';
import './PersonalInboxPanel.css';

/**
 * Life → Personal inbox. nick@, contact@ and Gmail, sorted and worked exactly
 * like the work Inbox (13 Oct 2026, Nick: "it's not the same as work inbox —
 * both how it looks and functionally"): the SAME card component (EmailCard),
 * the same Action / Delegate / FYI sections, the same buttons — against its own
 * store and its own API (/api/personal-inbox/triage). Work and personal never
 * share a list, a count, a mute rule or a nudge.
 *
 * saim@ is shown only for what lands there: bounces and auto-replies (a bounced
 * hike alert is flagged) — the plain list below is kept for that tab.
 *
 * Opening a message does NOT mark it read — Read & dismiss does. A reply
 * prepares the same governed reply the work Inbox uses and sends on the click,
 * from the SAME mailbox; the "From" line is the server's answer.
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


// ── the sorted view, on the shared card ─────────────────────────────────────

export const personalEndpoint = (id) => `/api/personal-inbox/triage/${encodeURIComponent(id)}`;
const BOX_LABEL = { nick: 'nick@', contact: 'contact@', gmail: 'Gmail' };

/** Which mailbox it came from (on All), and for Gmail why it is here. */
export function SourceChip({ email, showBox }) {
  if (!showBox && !email.why) return null;
  const label = [showBox ? (BOX_LABEL[email.mailbox] || email.mailbox) : null, email.why].filter(Boolean).join(' · ');
  return (
    <span className={`inbox-item-source inbox-item-source-${email.mailbox}`} title={email.why ? `Why it is here: ${email.why}` : `From ${BOX_LABEL[email.mailbox] || email.mailbox}`}>
      {label}
    </span>
  );
}

/** The personal-only buttons that sit after the shared ones: Delete (asks first), and Gmail's sender rules. */
export function CardExtras({ email, onDelete, onSender, busy }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      {confirm
        ? <>
            <span className="pi-confirm">Move to the mailbox’s Bin? (recoverable there)</span>
            <button type="button" className="inbox-action-btn inbox-action-ignore" disabled={busy} onClick={() => { setConfirm(false); onDelete(email.id); }}>Delete</button>
            <button type="button" className="inbox-action-btn" disabled={busy} onClick={() => setConfirm(false)}>Keep</button>
          </>
        : <button type="button" className="inbox-action-btn inbox-action-ignore" disabled={busy} onClick={() => setConfirm(true)} title="Moves it to that mailbox’s Bin — recoverable there">Delete</button>}
      {onSender && email.mailbox === 'gmail' && email.fromEmail && <>
        <button type="button" className="inbox-action-btn" disabled={busy} onClick={() => onSender(email.fromEmail, 'keep')} data-testid="pi-keep" title="Always show this sender here">Always show</button>
        <button type="button" className="inbox-action-btn inbox-action-ignore" disabled={busy} onClick={() => onSender(email.fromEmail, 'hide')} data-testid="pi-hide" title="Hide this sender here; Gmail is not changed">Stop showing</button>
      </>}
    </>
  );
}

/**
 * The sections, in the work Inbox's order: ACTION, NOT SORTED YET, DELEGATE,
 * FYI (collapsed). Every row is the shared EmailCard. `fyiTools` is the
 * section's Clear-all control, rendered by the panel.
 */
export function PersonalLanes({ triage, showBox, selected, onSelect, onDismiss, onPromote, onReplied, dismissing, onDelete, onSender, busy, fyiOpen, onToggleFyi, fyiTools = null }) {
  if (!triage) return <div className="inbox-empty">Loading...</div>;
  const action = triage.action || [];
  const unsorted = triage.unsorted || [];
  const delegate = triage.delegate || [];
  const fyi = [...(triage.fyi || []), ...(triage.ignore || [])];
  const card = (e, borderClass) => (
    <EmailCard
      key={e.id} email={e} borderClass={borderClass} endpoint={personalEndpoint} readWhere="the mailbox"
      onDismiss={onDismiss} onPromote={onPromote} onReplied={onReplied} dismissing={dismissing}
      sourceChip={<SourceChip email={e} showBox={showBox} />}
      selected={selected ? selected.has(e.id) : false} onSelect={onSelect}
      extraActions={<CardExtras email={e} onDelete={onDelete} onSender={onSender} busy={busy || dismissing === e.id} />}
    />
  );
  if (!action.length && !unsorted.length && !delegate.length && !fyi.length) {
    return (
      <div className="inbox-empty">
        {triage.lastRun ? 'Nothing waiting — your personal inbox is clear.' : 'Not sorted yet. Press Check now to read and sort your personal mail.'}
      </div>
    );
  }
  return (
    <>
      {action.length > 0 && (
        <div className="inbox-section">
          <div className="inbox-section-label inbox-section-action">ACTION ({action.length})</div>
          {action.map((e) => card(e, 'urgency-high'))}
        </div>
      )}
      {unsorted.length > 0 && (
        <div className="inbox-section">
          <div className="inbox-section-label inbox-section-unsorted">NOT SORTED YET ({unsorted.length})</div>
          <p className="inbox-section-note">The sorting could not reach these yet — it tries again on the next check. Nothing here has been filed as FYI.</p>
          {unsorted.map((e) => card(e, 'urgency-medium'))}
        </div>
      )}
      {delegate.length > 0 && (
        <div className="inbox-section">
          <div className="inbox-section-label inbox-section-delegate">DELEGATE ({delegate.length})</div>
          {delegate.map((e) => card(e, 'urgency-medium'))}
        </div>
      )}
      {fyi.length > 0 && (
        <div className="inbox-section">
          <button className="inbox-section-toggle" onClick={onToggleFyi}>{fyiOpen ? '▾' : '▸'} FYI ({fyi.length})</button>
          {fyiTools}
          {fyiOpen && triage.fyiAgeOutDays > 0 && (
            <p className="inbox-section-note">Cleared automatically after {triage.fyiAgeOutDays} days — nothing here is waiting on you.</p>
          )}
          {fyiOpen && fyi.map((e) => card(e, 'urgency-low'))}
        </div>
      )}
    </>
  );
}

export default function PersonalInboxPanel() {
  const [overview, setOverview] = useState(null);
  const [tab, setTab] = useState('all');
  const [triage, setTriage] = useState(null);
  const [items, setItems] = useState([]); // saim@ tab only
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
  const [dismissing, setDismissing] = useState(null);
  const [note, setNote] = useState('');
  const [fyiOpen, setFyiOpen] = useState(false);
  const [confirmClearFyi, setConfirmClearFyi] = useState(null);
  const [clearingFyi, setClearingFyi] = useState(false);
  const [muted, setMuted] = useState(undefined);
  const [mutedOpen, setMutedOpen] = useState(false);
  const [replies, setReplies] = useState(null);
  const [repliesOpen, setRepliesOpen] = useState(false);

  const watched = tab === 'saim';

  const load = useCallback(async () => {
    const o = await call('/api/personal-inbox');
    if (o && o.ok) setOverview(o); else setError((o && o.error) || 'Could not read the personal inbox.');
    if (watched) {
      const l = await call('/api/personal-inbox/mail/saim');
      setItems(l && l.ok ? l.items : []);
    } else {
      const t = await call(`/api/personal-inbox/triage?mailbox=${tab}`);
      setTriage(t && t.ok ? t : { action: [], delegate: [], fyi: [], ignore: [], unsorted: [], lastRun: null, failed: true });
      if (!(t && t.ok)) setError((t && t.error) || 'Could not read the sorted inbox.');
    }
    if (tab === 'gmail') { const r = await call('/api/personal-inbox/gmail/rules'); setRules(r && r.ok ? r : null); }
    const m = await call('/api/personal-inbox/triage/muted');
    // null = the read FAILED, which is said plainly rather than shown as "no rules".
    setMuted(m && m.ok ? { senders: m.senders || [], subjects: m.subjects || [] } : null);
    const rp = await call('/api/personal-inbox/replies?limit=20');
    setReplies(rp && rp.ok ? rp : null);
  }, [tab, watched]);

  useEffect(() => { setOpenId(null); setView(null); setOutcome(null); setSelected(new Set()); setTriage(null); setNote(''); setConfirmClearFyi(null); load(); }, [load]);

  const live = triage ? [...(triage.action || []), ...(triage.unsorted || []), ...(triage.delegate || []), ...(fyiOpen ? [...(triage.fyi || []), ...(triage.ignore || [])] : [])] : [];
  // A selection only ever names cards still on the screen.
  useEffect(() => { setSelected((s) => { const ids = new Set(live.map((e) => e.id)); const keep = new Set([...s].filter((id) => ids.has(id))); return keep.size === s.size ? s : keep; }); }, [triage, fyiOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // ── compose ──
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

  // ── the card's verdicts: same words and notes as the work Inbox ──
  const dismiss = async (id, { markRead = false, reason = 'done', mute = null } = {}) => {
    setDismissing(id); setNote('');
    try {
      const d = await call(`/api/personal-inbox/triage/dismiss/${encodeURIComponent(id)}`, 'POST', { markRead, reason, mute });
      if (!d || !d.ok) setNote(`Could not dismiss it${d && d.error ? `: ${d.error}` : ''}.`);
      else if (d.readError) setNote(d.readError);
      else if (d.muted && d.muted.ok && d.muted.kind === 'subject') setNote(`Muted "${d.muted.subject}" from ${d.muted.address}. Their other mail still comes through.`);
      else if (d.muted && d.muted.ok) setNote(d.muted.alreadyMuted ? `${d.muted.muted} was already muted.` : `Muted ${d.muted.muted}. Future personal mail from this sender is filed automatically.`);
      else if (d.muted && !d.muted.ok) setNote(`Dismissed, but nothing was muted — ${d.muted.reason}.`);
      await load();
    } finally { setDismissing(null); }
  };
  const promote = async (id) => {
    setDismissing(id); setNote('');
    try {
      const d = await call(`/api/personal-inbox/triage/promote/${encodeURIComponent(id)}`, 'POST', {});
      if (!d || !d.ok) setNote(`Could not move it${d && d.error ? `: ${d.error}` : ''}.`);
      await load();
    } finally { setDismissing(null); }
  };
  const removeOne = async (id) => {
    setBusy(true); setError(null);
    try {
      const d = await call(`/api/personal-inbox/message/${encodeURIComponent(id)}/delete`, 'POST', {});
      if (!d.ok) { setError(`Could not delete it (${d.reason || 'error'}).`); return; }
      if (openId === id) { setOpenId(null); setView(null); }
      await load();
    } finally { setBusy(false); }
  };
  const unmute = async (body, label) => {
    const d = await call('/api/personal-inbox/triage/muted/unmute', 'POST', body);
    setNote(d && d.ok ? `${label} will show up again from now on. Mail already filed stays filed.` : `Could not un-mute${d && d.error ? `: ${d.error}` : ''}.`);
    await load();
  };
  const askClearFyi = async () => {
    setNote(''); setClearingFyi(true);
    try {
      const d = await call('/api/personal-inbox/triage/clear-fyi', 'POST', { mailbox: tab, dryRun: true });
      if (!d || !d.ok) setNote('Could not work out what would be cleared.');
      else if (!d.cleared) setNote('Nothing in the FYI section to clear.');
      else setConfirmClearFyi(d.cleared);
    } finally { setClearingFyi(false); }
  };
  const clearFyi = async () => {
    setClearingFyi(true);
    try {
      const d = await call('/api/personal-inbox/triage/clear-fyi', 'POST', { mailbox: tab });
      setNote(d && d.ok ? `Cleared ${d.cleared} from the FYI section. Nothing owed was touched.` : 'Could not clear the section.');
      setConfirmClearFyi(null);
      await load();
    } finally { setClearingFyi(false); }
  };

  // ── Gmail rules, bulk, refresh (unchanged behaviour) ──
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
  const runBulk = async (action) => {
    setBusy(true); setError(null); setOutcome(null);
    try {
      const ids = [...selected];
      const d = await call('/api/personal-inbox/bulk', 'POST', { action, ids });
      if (d && d.error) { setError(d.error); return; }
      const failed = (d && d.failed) || [];
      setOutcome({ tone: failed.length ? 'warn' : 'ok', text: `${action === 'read' ? 'Marked read' : 'Moved to the Bin'}: ${d.done || 0}${failed.length ? ` — ${failed.length} could not be (${[...new Set(failed.map((f) => f.reason))].join(', ')})` : ''}.` });
      setSelected(new Set(failed.map((f) => f.id)));
      await load();
    } finally { setBusy(false); }
  };
  const hideSenders = async () => {
    const senders = [...new Set(live.filter((m) => selected.has(m.id) && m.mailbox === 'gmail').map((m) => m.fromEmail).filter(Boolean))];
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
  const refresh = async () => { setBusy(true); setError(null); try { await call('/api/personal-inbox/refresh', 'POST', {}); await load(); } finally { setBusy(false); } };

  // saim@ tab (bounces): the plain list and message view.
  const open = async (id) => {
    setOpenId(id); setView(null); setOutcome(null); setError(null);
    const d = await call(`/api/personal-inbox/message/${encodeURIComponent(id)}`);
    if (d && d.ok) setView(d); else setError((d && d.error) || 'Could not open it.');
  };
  const markRead = async () => {
    setBusy(true);
    try {
      const d = await call(`/api/personal-inbox/message/${encodeURIComponent(openId)}/read`, 'POST', {});
      if (!d.ok) setError(`Could not mark it read (${d.reason || 'error'}).`);
      await load();
    } finally { setBusy(false); }
  };

  const boxes = overview ? overview.mailboxes : [];
  const current = boxes.find((b) => b.key === tab);
  const sortable = boxes.filter((b) => !b.watchedOnly);
  const allUnread = sortable.reduce((n, b) => n + (b.unread || 0), 0);
  const gmailSelected = live.some((m) => selected.has(m.id) && m.mailbox === 'gmail');
  const mutedCount = muted ? muted.senders.length + muted.subjects.length : 0;

  return (
    <div className="pi inbox-container" data-testid="personal-inbox">
      <div className="inbox-header">
        <h2 className="inbox-title">Personal inbox</h2>
        <div className="inbox-actions">
          {triage && triage.lastRun && <span className="inbox-last-scan">Last sorted: {timeAgo(triage.lastRun)}</span>}
          <button type="button" className="inbox-scan-btn" disabled={busy} onClick={startCompose}>Compose</button>
          <button type="button" className="inbox-scan-btn" disabled={busy} onClick={refresh}>{busy ? 'Checking…' : 'Check now'}</button>
        </div>
      </div>
      <p className="pi-lede">{overview ? overview.rule : 'Loading…'}</p>
      <div className="pi-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'all'} className={`pi-tab${tab === 'all' ? ' pi-tab-on' : ''}`} onClick={() => setTab('all')}>
          All personal{allUnread ? <span className="pi-badge">{allUnread}</span> : null}
        </button>
        {boxes.map((b) => (
          <button key={b.key} type="button" role="tab" aria-selected={tab === b.key} className={`pi-tab${tab === b.key ? ' pi-tab-on' : ''}`} onClick={() => setTab(b.key)}>
            {b.address || b.key}{b.watchedOnly ? ' (bounces)' : ''}{b.unread ? <span className="pi-badge">{b.unread}</span> : null}
          </button>
        ))}
      </div>
      {tab === 'all' && sortable.filter((b) => !b.configured).map((b) => <div key={`nc-${b.key}`} className="pi-warn">No password saved for {b.address || b.key} — add it in Settings → Personal email.</div>)}
      {tab === 'all' && sortable.filter((b) => b.last && b.last.ok === false).map((b) => <div key={`lf-${b.key}`} className="pi-warn">Last check could not read {b.address || b.key}: {b.last.why}</div>)}
      {current && !current.configured && <div className="pi-warn">No password saved for {current.address} — add it in Settings → Personal email.</div>}
      {current && current.last && current.last.ok === false && <div className="pi-warn">Last check could not read {current.address}: {current.last.why}</div>}
      {current && current.watchedOnly && <div className="pi-note">SAiM sends from here with replies going to nick@, so what lands here is mostly machinery. A bounced hike alert is flagged and pushed to you.</div>}
      {tab === 'gmail' && <GmailRules rules={rules} onSet={setSender} busy={busy} />}
      {tab === 'gmail' && current && current.configured && <div className="pi-actions"><button type="button" className="pi-btn" onClick={() => setCleanup((v) => !v)}>{cleanup ? 'Close clean-up' : 'Clean up senders'}</button></div>}
      {tab === 'gmail' && cleanup && <GmailCleanup onChanged={load} />}
      {error && <div className="pi-warn">{error}</div>}
      {composing && <ComposeForm options={options} suggestion={suggestion} onRecipients={recipients} onSend={sendNew} onCancel={() => setComposing(false)} busy={busy} outcome={outcome} initialFrom={current && !current.watchedOnly && current.configured ? current.key : null} />}

      {!watched && muted === null && <div className="inbox-dismiss-note"><span>Could not read your personal muted senders and subjects — this is not confirmation there are none.</span></div>}
      {!watched && muted && mutedCount > 0 && (
        <div className="inbox-muted">
          <button className="inbox-muted-toggle" onClick={() => setMutedOpen((o) => !o)}>
            {mutedOpen ? '▾' : '▸'} {muted.subjects.length} muted subject{muted.subjects.length === 1 ? '' : 's'} · {muted.senders.length} muted sender{muted.senders.length === 1 ? '' : 's'} (personal)
          </button>
          {mutedOpen && (
            <ul className="inbox-muted-list">
              {muted.subjects.map((m) => (
                <li key={m.key}>
                  <span className="inbox-muted-addr">"{m.subject}"</span>
                  <span className="inbox-muted-sample">from {m.name ? `${m.name} <${m.address}>` : m.address}</span>
                  <button className="inbox-muted-undo" onClick={() => unmute({ key: m.key }, `"${m.subject}" from ${m.address}`)}>Un-mute</button>
                </li>
              ))}
              {muted.senders.map((m) => (
                <li key={m.address}>
                  <span className="inbox-muted-addr">Everything from {m.name ? `${m.name} <${m.address}>` : m.address}</span>
                  {m.sampleSubject && <span className="inbox-muted-sample">muted on "{m.sampleSubject}"</span>}
                  <button className="inbox-muted-undo" onClick={() => unmute({ address: m.address }, m.address)}>Un-mute</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {note && (
        <div className="inbox-dismiss-note">
          <span>{note}</span>
          <button className="inbox-dismiss-note-x" onClick={() => setNote('')}>×</button>
        </div>
      )}
      {!composing && outcome && <div className={`pi-outcome pi-outcome-${outcome.tone}`}>{outcome.text}</div>}

      {watched ? (
        <div className={`pi-split${view ? '' : ' pi-split--solo'}`}>
          <div className="pi-listcol"><MessageList items={items} onOpen={open} openId={openId} /></div>
          <MessageView data={view} onRead={markRead} onReply={async () => false} busy={busy} outcome={null} canReply={false} />
        </div>
      ) : (
        <div className="pi-lanes">
          <BulkBar count={selected.size} total={live.length} onAll={() => setSelected(new Set(live.map((m) => m.id)))} onNone={() => setSelected(new Set())}
            onRead={() => runBulk('read')} onDelete={() => runBulk('delete')} onHideSenders={gmailSelected ? hideSenders : null} busy={busy} />
          <PersonalLanes
            triage={triage} showBox={tab === 'all'} selected={selected} onSelect={toggle}
            onDismiss={dismiss} onPromote={promote} onReplied={() => load()} dismissing={dismissing}
            onDelete={removeOne} onSender={setSender} busy={busy}
            fyiOpen={fyiOpen} onToggleFyi={() => setFyiOpen((o) => !o)}
            fyiTools={confirmClearFyi == null
              ? <button className="inbox-section-clear" onClick={askClearFyi} disabled={clearingFyi}>{clearingFyi ? 'Checking…' : 'Clear all'}</button>
              : <span className="inbox-section-confirm">
                  Clear {confirmClearFyi}? Nothing in Action, Delegate, not-yet-sorted or promoted is touched.
                  <button className="inbox-section-clear danger" onClick={clearFyi} disabled={clearingFyi}>{clearingFyi ? 'Clearing…' : 'Yes, clear'}</button>
                  <button className="inbox-section-clear" onClick={() => setConfirmClearFyi(null)}>Cancel</button>
                </span>}
          />
          {replies && replies.total > 0 && (
            <div className="inbox-section">
              <button className="inbox-section-toggle" onClick={() => setRepliesOpen((o) => !o)}>{repliesOpen ? '▾' : '▸'} REPLIED ({replies.total})</button>
              {repliesOpen && replies.replies.map((r) => (
                <div className="inbox-reply" key={r.id}>
                  <div className="inbox-reply-head">
                    <span className="inbox-reply-subject">{r.subject || '(no subject)'}</span>
                    <span className="inbox-reply-when">{timeAgo(Date.parse(r.sentAt))}</span>
                  </div>
                  <div className="inbox-reply-to">{r.recipients.length ? `To ${r.recipients.map((p) => p.name || p.email).join(', ')}` : 'Recipients not recorded'}</div>
                  <div className="inbox-reply-body">{r.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
