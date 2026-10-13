import React, { useState } from 'react';
import { apiUrl } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './InboxPanel.css';

/**
 * The ONE email card (13 Oct 2026). The work Inbox and Life → Personal inbox
 * both render this component, so the two cannot drift in how an email looks
 * or what can be done with it. What differs is passed in:
 *   endpoint(id)  the card's API base: GET detail, POST /summary, /draft, /reply
 *                 (defaults to the work Inbox's /api/email/triage/<id>)
 *   sourceChip    a chip after the sender (which personal mailbox)
 *   extraActions  buttons after the shared ones (Delete, Gmail rules)
 *   selected / onSelect   a checkbox for multi-select
 *   readWhere     where "Read & dismiss" marks it read ("Outlook", "the mailbox")
 * Separate stores, one face.
 */

export const workEndpoint = (id) => `/api/email/triage/${encodeURIComponent(id)}`;

export function timeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - Number(timestamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// When the email landed. The window is 14 days now, so "how long has this been
// sitting" is most of what the date is for — a relative age is what scans, with
// the exact moment on hover for the rare case the wording matters.
//
// NOTE this DOES parse into a Date, deliberately, and is not the calendar's
// slice-the-string rule: `receivedDateTime` is a real UTC instant, and both an
// elapsed duration and a local rendering of an instant are correct to compute.
// The calendar rule exists because Graph is asked there for Europe/London
// wall-clock, which re-parsing would shift by an offset a second time.
export const OLD_MAIL_DAYS = 7;

export function receivedAge(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  // Unreadable is nothing, never a guess — a card with no date says less than
  // a card with the wrong one.
  if (!Number.isFinite(t)) return null;
  const mins = Math.floor((now - t) / 60000);
  if (mins < 0) return { label: 'just now', days: 0 };
  if (mins < 60) return { label: `${Math.max(mins, 1)}m`, days: 0 };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { label: `${hrs}h`, days: 0 };
  const days = Math.floor(hrs / 24);
  return { label: `${days}d`, days };
}

export function receivedExact(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function EmailCard({ email, borderClass, onDismiss, dismissing, onReplied, onPromote, endpoint = workEndpoint, sourceChip = null, extraActions = null, selected, onSelect = null, readWhere = 'Outlook' }) {
  // mode: null | 'summary' | 'full' | 'reply'
  const [mode, setMode] = useState(null);
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [replyText, setReplyText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [to, setTo] = useState([]);
  const [cc, setCc] = useState([]);
  const [replyAllCc, setReplyAllCc] = useState([]);
  // false = the thread could not be read, which is NOT the same as a one-to-one
  const [threadKnown, setThreadKnown] = useState(true);
  const [newTo, setNewTo] = useState('');
  const [newCc, setNewCc] = useState('');

  const base = endpoint(email.id);

  const toggle = (next) => {
    setError('');
    setMode(m => (m === next ? null : next));
  };

  // Both Full email and Reply need the Graph detail — fetch once, share it.
  const loadDetail = () => {
    if (detail) return Promise.resolve(detail);
    setLoading(true);
    return fetch(apiUrl(base))
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setError(d.error || 'Could not load email'); return null; }
        setDetail(d.email);
        return d.email;
      })
      .catch(() => { setError('Could not load email'); return null; })
      .finally(() => setLoading(false));
  };

  const openReply = () => {
    toggle('reply');
    if (mode === 'reply') return;
    loadDetail().then(d => {
      if (!d?.replyDefaults) return;
      // Only prefill once — don't stamp on edits made before the fetch landed.
      setTo(prev => (prev.length ? prev : d.replyDefaults.to || []));
      setReplyAllCc(d.replyDefaults.replyAllCc || []);
      setThreadKnown(d.replyDefaults.threadKnown !== false);
    });
  };

  const addRecipient = (value, list, setList, clear) => {
    const email = value.trim().replace(/^.*<|>$/g, '').trim();
    if (!email || !email.includes('@')) { setError('That does not look like an email address'); return; }
    if (list.some(r => r.email.toLowerCase() === email.toLowerCase())) { clear(''); return; }
    setError('');
    setList([...list, { name: email, email }]);
    clear('');
  };

  const addAllCc = () => {
    const merged = [...cc];
    replyAllCc.forEach(r => {
      if (!merged.some(x => x.email.toLowerCase() === r.email.toLowerCase())) merged.push(r);
    });
    setCc(merged);
  };

  const showSummary = () => {
    toggle('summary');
    if (summary || mode === 'summary') return;
    setLoading(true);
    fetch(apiUrl(`${base}/summary`), { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        if (d.ok) setSummary(d.summary);
        else setError(d.error || 'Could not summarise');
      })
      .catch(() => setError('Could not summarise'))
      .finally(() => setLoading(false));
  };

  const showFull = () => {
    toggle('full');
    if (mode === 'full') return;
    loadDetail();
  };

  const draftWithAI = () => {
    setDrafting(true);
    setError('');
    fetch(apiUrl(`${base}/draft`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: replyText.trim() || undefined }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) setReplyText(d.draft);
        else setError(d.error || 'Could not draft a reply');
      })
      .catch(() => setError('Could not draft a reply'))
      .finally(() => setDrafting(false));
  };

  // 9 Oct 2026: Send is the decision. The reply is PREPARED as a governed
  // action (exact words, recipients, thread) and the same click confirms THAT
  // action with a one-use intent grant — sent at once, then checked in Sent
  // Items. No code, no trusted browser, no Actions card. A grant that expired
  // or no longer matches leaves the prepared reply here with "Confirm again".
  const [prepared, setPrepared] = useState(null);
  const [acting, setActing] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const refreshPrepared = (id) => fetch(apiUrl(`/api/prepared-actions/${id}`)).then(r => r.json()).then(d => d.ok && setPrepared(d.action)).catch(() => {});

  const sendPrepared = async (action) => {
    setActing(true);
    setError('');
    try {
      const x = await executeDirect(action);
      const o = directOutcome(x);
      if (x.ok && ['executed', 'verified'].includes(x.status)) { onReplied(email.id); return true; }
      setOutcome(o);
      refreshPrepared(action.actionId);
      return false;
    } catch (e) { setError(e.message); return false; } finally { setActing(false); }
  };

  const sendReply = () => {
    if (!replyText.trim()) return;
    setSending(true);
    setError('');
    setOutcome(null);
    fetch(apiUrl(`${base}/reply`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: replyText, to, cc }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.action) { setPrepared(d.action); return sendPrepared(d.action); }
        setError(d.error || 'Could not prepare the reply — nothing was sent');
        return null;
      })
      .catch(() => setError('Could not prepare the reply — nothing was sent'))
      .finally(() => setSending(false));
  };

  const verbPrepared = async (verb, body) => {
    setActing(true);
    try {
      const res = await fetch(apiUrl(`/api/prepared-actions/${prepared.actionId}/${verb}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      const d = await res.json();
      if (!d.ok) { setError(d.error); return false; }
      if (verb === 'reject') setPrepared(null); else setPrepared(d.action);
      return true;
    } finally { setActing(false); }
  };

  const busy = dismissing === email.id;
  const age = receivedAge(email.received);

  return (
    <div className={`inbox-item ${borderClass}${selected ? ' inbox-item-selected' : ''}`} data-testid="email-card">
      <div className="inbox-item-header">
        {onSelect && (
          <input
            type="checkbox"
            className="inbox-item-pick"
            aria-label={`Select ${email.subject || 'this email'}`}
            checked={!!selected}
            onChange={() => onSelect(email.id)}
          />
        )}
        <span className="inbox-item-from">{email.from}</span>
        {sourceChip}
        {age && (
          <span
            className={`inbox-item-age${age.days >= OLD_MAIL_DAYS ? ' inbox-item-age-old' : ''}`}
            title={receivedExact(email.received)}
          >
            {age.label}
          </span>
        )}
        {email.reason && <span className="inbox-item-cat">{email.reason}</span>}
      </div>
      <div className="inbox-item-subject">{email.subject}</div>
      {email.preview && mode !== 'full' && (
        <div className="inbox-item-summary">{email.preview.substring(0, 150)}</div>
      )}

      {mode === 'summary' && (
        <div className="inbox-detail">
          {loading ? <div className="inbox-detail-loading">Summarising...</div>
            : <div className="inbox-detail-body">{summary}</div>}
        </div>
      )}

      {mode === 'full' && (
        <div className="inbox-detail">
          {loading ? <div className="inbox-detail-loading">Loading email...</div> : detail && (
            <>
              <div className="inbox-detail-meta">
                {detail.fromEmail && <span>{detail.fromEmail}</span>}
                {detail.received && <span>{new Date(detail.received).toLocaleString('en-GB')}</span>}
              </div>
              {/* Who it went to (5 Oct 2026) — a forward to the whole team and
                  one sent to Nick alone ask different things of him. */}
              {(detail.to || []).length > 0 && (
                <div className="inbox-detail-recips"><span className="inbox-detail-recips-k">To</span> {detail.to.join(', ')}</div>
              )}
              {(detail.cc || []).length > 0 && (
                <div className="inbox-detail-recips"><span className="inbox-detail-recips-k">Cc</span> {detail.cc.join(', ')}</div>
              )}
              <div className="inbox-detail-body inbox-detail-full">{detail.body}</div>
              {detail.webLink && (
                <a className="inbox-detail-link" href={detail.webLink} target="_blank" rel="noreferrer">
                  Open in Outlook
                </a>
              )}
            </>
          )}
        </div>
      )}

      {mode === 'reply' && (
        <div className="inbox-detail">
          {loading && <div className="inbox-detail-loading">Loading recipients...</div>}

          {/* Nick (12 Oct 2026): every email screen says which address it sends from — the server's answer. */}
          {detail?.sendsFrom && (
            <div className="inbox-recip-row" data-testid="inbox-sends-from">
              <span className="inbox-recip-label">From</span>
              <div className="inbox-recip-chips"><span className="inbox-chip">{detail.sendsFrom.address}</span></div>
            </div>
          )}

          <div className="inbox-recip-row">
            <span className="inbox-recip-label">To</span>
            <div className="inbox-recip-chips">
              {to.map(r => (
                <span className="inbox-chip" key={r.email} title={r.email}>
                  {r.name || r.email}
                  <button
                    className="inbox-chip-x"
                    onClick={() => setTo(to.filter(x => x.email !== r.email))}
                    aria-label={`Remove ${r.email}`}
                  >×</button>
                </span>
              ))}
              <input
                className="inbox-recip-input"
                value={newTo}
                onChange={e => setNewTo(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addRecipient(newTo, to, setTo, setNewTo);
                  }
                }}
                onBlur={() => newTo.trim() && addRecipient(newTo, to, setTo, setNewTo)}
                placeholder={to.length ? 'Add...' : 'name@company.com'}
              />
            </div>
          </div>

          <div className="inbox-recip-row">
            <span className="inbox-recip-label">Cc</span>
            <div className="inbox-recip-chips">
              {cc.map(r => (
                <span className="inbox-chip" key={r.email} title={r.email}>
                  {r.name || r.email}
                  <button
                    className="inbox-chip-x"
                    onClick={() => setCc(cc.filter(x => x.email !== r.email))}
                    aria-label={`Remove ${r.email}`}
                  >×</button>
                </span>
              ))}
              <input
                className="inbox-recip-input"
                value={newCc}
                onChange={e => setNewCc(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addRecipient(newCc, cc, setCc, setNewCc);
                  }
                }}
                onBlur={() => newCc.trim() && addRecipient(newCc, cc, setCc, setNewCc)}
                placeholder={cc.length ? 'Add...' : 'none'}
              />
              {replyAllCc.length > 0 && replyAllCc.some(r => !cc.some(c => c.email === r.email)) && (
                <button className="inbox-recip-all" onClick={addAllCc}>
                  + everyone on thread ({replyAllCc.length})
                </button>
              )}
              {/* An unreachable thread used to render as nothing at all, which
                  reads exactly like a one-to-one email — and the difference is
                  who gets left off the reply. */}
              {!threadKnown && (
                <span className="inbox-recip-unknown" title="Only the cached copy of this email was available, and it does not record the other participants.">
                  thread unavailable — add anyone else by hand
                </span>
              )}
            </div>
          </div>

          <div className="inbox-reply-modes">
            <button className="inbox-action-btn" onClick={draftWithAI} disabled={drafting || sending}>
              {drafting ? 'Drafting...' : 'Draft with AI'}
            </button>
            <span className="inbox-reply-hint">
              or just type below — anything you write is used as a steer if you then draft with AI
            </span>
          </div>
          <textarea
            className="inbox-reply-text"
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            placeholder="Write your reply..."
            rows={8}
            // Locked once prepared: the grant binds THESE words. Discard to edit.
            disabled={!!prepared && prepared.status === 'prepared'}
          />
          {!prepared && (
            <div className="inbox-item-actions">
              <button
                className="inbox-action-btn inbox-action-done"
                onClick={sendReply}
                disabled={sending || acting || drafting || !replyText.trim() || to.length === 0}
                title="Sends exactly this reply now, as you, then checks it in Sent Items"
              >
                {sending || acting ? 'Sending...' : `Send to ${to.length + cc.length || 'nobody'}`}
              </button>
              <button className="inbox-action-btn inbox-action-ignore" onClick={() => setMode(null)} disabled={sending}>
                Cancel
              </button>
            </div>
          )}
          {prepared && outcome && <div className={`inbox-reply-hint inbox-outcome-${outcome.tone}`}>{outcome.text}</div>}
          {prepared && prepared.status === 'prepared' && (
            <div className="inbox-item-actions">
              <button className="inbox-action-btn inbox-action-done" disabled={acting} onClick={() => sendPrepared(prepared)}>
                {acting ? 'Sending...' : 'Confirm again & send'}
              </button>
              <button className="inbox-action-btn inbox-action-ignore" disabled={acting} onClick={() => verbPrepared('reject', {})}>
                Discard
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="inbox-detail-error">{error}</div>}

      <div className="inbox-item-actions">
        <button
          className="inbox-action-btn inbox-action-done"
          onClick={() => onDismiss(email.id, { reason: 'done' })}
          disabled={busy}
          title="Handled — triage was right to surface it"
        >
          {busy ? '...' : 'Done'}
        </button>
        <button
          className="inbox-action-btn inbox-action-done"
          onClick={() => onDismiss(email.id, { markRead: true, reason: 'done' })}
          disabled={busy}
          title={`Marks it read in ${readWhere} as well as clearing it from triage`}
        >
          {busy ? '...' : 'Read & dismiss'}
        </button>
        <button
          className="inbox-action-btn inbox-action-ignore"
          onClick={() => onDismiss(email.id, { reason: 'not-relevant', mute: 'subject' })}
          disabled={busy}
          title="Files this and mutes this subject from this sender — their other mail still comes through"
        >
          {busy ? '...' : 'Subject not relevant'}
        </button>
        <button
          className="inbox-action-btn inbox-action-ignore"
          onClick={() => {
            if (window.confirm(`Mute ${email.from || email.fromEmail}? Nothing from ${email.fromEmail || 'this address'} will reach the panel until you un-mute them.`)) {
              onDismiss(email.id, { reason: 'not-relevant', mute: 'sender' });
            }
          }}
          disabled={busy}
          title="Files this and mutes the whole sender — for newsletters and marketing"
        >
          {busy ? '...' : 'Mute sender'}
        </button>
        {/* The other direction. Only offered where there is somewhere to go:
            on an ACTION card it would be a no-op button. */}
        {email.category !== 'ACTION' && onPromote && (
          <button
            className="inbox-action-btn inbox-action-promote"
            onClick={() => onPromote(email.id)}
            disabled={busy}
            title="Triage under-ranked this — move it to Action and record the miss"
          >
            {busy ? '...' : 'Needs action'}
          </button>
        )}
        <button
          className={`inbox-action-btn inbox-action-view${mode === 'summary' ? ' is-open' : ''}`}
          onClick={showSummary}
        >
          Summary
        </button>
        <button
          className={`inbox-action-btn inbox-action-view${mode === 'full' ? ' is-open' : ''}`}
          onClick={showFull}
        >
          Full email
        </button>
        <button
          className={`inbox-action-btn inbox-action-view${mode === 'reply' ? ' is-open' : ''}`}
          onClick={openReply}
        >
          Reply
        </button>
        {extraActions}
      </div>
    </div>
  );
}

export default EmailCard;
