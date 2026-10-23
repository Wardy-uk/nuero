import { useState, useEffect, useRef } from 'react';
import { apiUrl } from '../api';
import './EscalationPanel.css';

/**
 * Escalations — what is escalated right now, and the form to escalate something.
 *
 * The list comes first because that is the question this screen is usually
 * opened with. The form's lookup step exists because escalating the wrong
 * ticket is a real risk when someone reads a number to you over Teams. Nothing
 * is written until the confirm step, and the confirm names exactly what will
 * change on the ticket.
 */

const PRIORITY_TARGET = 'Critical';

function ageDays(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso)) / 86400000);
}

function agoLabel(days) {
  if (days == null) return null;
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function EscalationRow({ t, onPick, watched, onWatch }) {
  const age = ageDays(t.created);
  // Two dates, because one of them was being read as the other. The badge used
  // to say "9d old" from `created` alone, which is the age of the ESCALATION
  // and says nothing about whether anything has happened on it — so a ticket
  // replied to this morning still read as nine days of silence. `updated` was
  // already fetched and mapped and simply never rendered.
  //
  // It is labelled "touched", not "replied", on purpose: Jira bumps `updated`
  // for a NOVA triage comment, a round-robin assignment or the CSAT bot as
  // readily as for a human, so calling it a reply would be a claim the field
  // cannot support. The honest version of that answer needs the comments, and
  // /active deliberately does not pay for them.
  const touched = ageDays(t.updated);
  return (
    <div className="esc-row">
      <div className="esc-row-main">
        <a href={t.url || '#'} target="_blank" rel="noreferrer" className="esc-row-key">{t.key}</a>
        <span className="esc-row-summary">{t.summary}</span>
      </div>
      <div className="esc-row-meta">
        {/* #105 — the one badge that turns this list into a work queue. Only
            rendered when it says something: "replied" is the quiet case and
            "unknown" means the sync has never looked at this ticket's comments,
            which must not read as "needs you". */}
        {t.replyState === 'awaiting-you' && (
          <span className="esc-tag esc-tag-awaiting" title="No reply from you on this ticket yet">
            needs you
          </span>
        )}
        {/* Kept even though the groups now say most of this: a ticket can be
            more than one at once, and only the badges show the overlap. */}
        {t.viaRequestType && <span className="esc-tag esc-tag-req">customer-raised</span>}
        {t.viaTier && <span className="esc-tag esc-tag-tier">tier</span>}
        {t.viaUrgency && (
          <span className="esc-tag esc-tag-urgency" title={
            [t.urgencyReason, t.escalatedBy && `by ${t.escalatedBy}`].filter(Boolean).join(' — ')
          }>urgency</span>
        )}
        <span>{t.status || '—'}</span>
        <span>{t.priority || 'No priority'}</span>
        <span>{t.assignee || 'Unassigned'}</span>
        {age != null && (
          <span title="When this escalation was raised">raised {agoLabel(age)}</span>
        )}
        {touched != null && (
          <span
            className={touched >= 7 ? 'esc-row-touched esc-row-touched-cold' : 'esc-row-touched'}
            title="Last change of any kind on the ticket — includes NOVA automation, not just a human reply"
          >
            touched {agoLabel(touched)}
          </span>
        )}
        {onWatch && (
          watched
            ? <span className="esc-tag esc-tag-watching" title="In your watched tickets">watching</span>
            : <button type="button" className="esc-row-action esc-row-action-watch" onClick={() => onWatch(t.key)}>Watch</button>
        )}
        <button type="button" className="esc-row-action esc-row-action-tight" onClick={() => onPick(t.key)}>
          Escalate again
        </button>
      </div>
    </div>
  );
}

/**
 * One collapsible group, closed by default. Safe to close because the count
 * lives in the summary — the shut state still answers "is there anything
 * here", which is the question that must never need a click.
 */
function EscalationGroup({ title, blurb, items, onPick, watchedKeys, onWatch }) {
  return (
    <details className="esc-group">
      <summary>
        <span className="esc-group-title">{title}</span>
        <span className="esc-count">{items.length}</span>
      </summary>
      <p className="esc-group-blurb">{blurb}</p>
      {items.length === 0
        ? <p className="esc-empty">None.</p>
        : items.map(t => <EscalationRow key={t.key} t={t} onPick={onPick} watched={watchedKeys?.has(t.key)} onWatch={onWatch} />)}
    </details>
  );
}

/**
 * The escalated queue, split by how a ticket got here.
 *
 * Three groups rather than two, because the two named ones do not cover the
 * queue: most escalated tickets were moved into the Escalations tier by the
 * team without a portal escalation or a pass through this tool. Folding those
 * into either named group would be a lie, and dropping them would put the tab
 * back to under-reporting, which is what it was built to stop.
 *
 * Membership is exclusive and most-specific-first, so the counts sum to the
 * total and nothing appears twice. The per-row badges still show overlap.
 */
function ActiveEscalations({ items, loading, error, warning, awaitingReply, onPick, onRefresh, watchedKeys, onWatch }) {
  const functional = items.filter(t => t.viaUrgency);
  const customer = items.filter(t => !t.viaUrgency && t.viaRequestType);
  const tier = items.filter(t => !t.viaUrgency && !t.viaRequestType);

  return (
    <section className="esc-active">
      <div className="esc-active-head">
        <h3>
          Currently escalated
          {!loading && !error && <span className="esc-count">{items.length}</span>}
        </h3>
        <button type="button" className="esc-btn esc-btn-ghost esc-btn-sm" onClick={onRefresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="esc-error">{error}</div>}

      {/* #105 — the whole point of the tab in one line, above the groups, which
          are collapsed by default. "17 escalated" is a status; "5 of them are
          waiting on you" is a to-do. Silent when nothing is waiting, because a
          zero here is a good day rather than a thing to render. */}
      {!loading && !error && awaitingReply > 0 && (
        <div className="esc-awaiting-summary">
          <strong>{awaitingReply}</strong> {awaitingReply === 1 ? 'is' : 'are'} waiting on a reply from you.
        </div>
      )}

      {/* A short list is indistinguishable from a quiet day, so say so. */}
      {warning && <div className="esc-warn">{warning}</div>}

      {!error && !loading && items.length === 0 && (
        <p className="esc-empty">Nothing is escalated. That is the good outcome, not a broken query.</p>
      )}

      {items.length > 0 && (
        <>
          <EscalationGroup
            title="Functional escalations"
            blurb="Escalated with this tool — priority raised and an internal comment posted. Recorded in NOVA's escalation log, not on the ticket."
            items={functional}
            onPick={onPick}
            watchedKeys={watchedKeys}
            onWatch={onWatch}
          />
          <EscalationGroup
            title="Customer escalations"
            blurb="Raised as an escalation through the portal — the customer asked for this one."
            items={customer}
            onPick={onPick}
            watchedKeys={watchedKeys}
            onWatch={onWatch}
          />
          <EscalationGroup
            title="In the escalations tier"
            blurb="Moved into the Escalations tier by the team. Neither raised as an escalation by the customer nor put through this tool."
            items={tier}
            onPick={onPick}
            watchedKeys={watchedKeys}
            onWatch={onWatch}
          />
        </>
      )}
    </section>
  );
}

function dayMonth(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * One watched ticket. The unread replies are the point, so they lead; a reply
 * NEURO judged a thank-you (in the post-resolve listen) is shown muted, so
 * "it went quiet" and "it was filtered" stay visibly different.
 */
function clockLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  return d.toDateString() === today.toDateString() ? `${hm} today` : `${hm} ${dayMonth(iso)}`;
}

function untilLabel(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round(Math.abs(ms) / 60000);
  const span = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return ms >= 0 ? `in ${span}` : `overdue by ${span}`;
}

/** 'YYYY-MM-DDTHH:MM' for a datetime-local input, an hour from now on the quarter. */
function defaultWhen() {
  const d = new Date(Date.now() + 60 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Updates Nick promised the customer. A spotted one is only a proposal until he
 * confirms it — no reminder or Now card before then. An open one counts down
 * and is closed by his next public reply on the ticket.
 */
function Commitments({ t, busy, onCommit, children }) {
  const [adding, setAdding] = useState(false);
  const [when, setWhen] = useState(defaultWhen);
  const list = t.commitments || [];
  const save = async (e) => {
    e.preventDefault();
    const ok = await onCommit(t.key, '', { due: when });
    if (ok) setAdding(false);
  };
  return (
    <div className="esc-commitments">
      {list.map((c) => (
        <div key={c.id} className={`esc-commitment esc-commitment-${c.missed ? 'missed' : c.state}`}>
          {c.state === 'proposed' && (
            <>
              <span className="esc-commitment-text"><strong>Spotted in your reply:</strong> update by {clockLabel(c.dueAt)}</span>
              <span className="esc-commitment-actions">
                <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={() => onCommit(t.key, `/${c.id}/confirm`)}>Confirm</button>
                <button type="button" className="esc-mini" disabled={busy} onClick={() => onCommit(t.key, `/${c.id}/dismiss`)}>Not a commitment</button>
              </span>
              {c.phrase && <span className="esc-commitment-phrase">“{c.phrase}”</span>}
            </>
          )}
          {c.state === 'open' && (
            <>
              <span className="esc-commitment-text">
                <strong>Update promised by {clockLabel(c.dueAt)}</strong>
                <span className={c.missed ? 'esc-pill esc-pill-alert' : 'esc-pill esc-pill-warn'}>{untilLabel(c.dueAt)}</span>
              </span>
              <span className="esc-commitment-actions">
                <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={() => onCommit(t.key, `/${c.id}/done`)}>Done</button>
                <button type="button" className="esc-mini" disabled={busy} onClick={() => onCommit(t.key, `/${c.id}/dismiss`)}>Remove</button>
              </span>
            </>
          )}
          {c.state === 'kept' && (
            <span className="esc-watch-reply-muted">
              Update kept {c.closedAt ? clockLabel(c.closedAt) : ''}{c.keptLate ? ` — after the ${clockLabel(c.dueAt)} you promised` : ''}
              {c.closedBy === 'nick' ? ' (marked by you)' : ''}
            </span>
          )}
        </div>
      ))}
      {adding ? (
        <form className="esc-commitment-add" onSubmit={save}>
          <label>Update the customer by
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <button type="submit" className="esc-mini esc-mini-primary" disabled={busy || !when}>Add</button>
          <button type="button" className="esc-mini" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : (
        <div className="esc-watch-foot">
          <button type="button" className="esc-link-btn" onClick={() => { setWhen(defaultWhen()); setAdding(true); }}>+ Add update commitment</button>
          <span className="esc-watch-actions">{children}</span>
        </div>
      )}
    </div>
  );
}

function WatchedRow({ t, onRead, onUnwatch, onCommit, busy }) {
  const latest = t.replies[0];
  const actions = (
    <>
      {t.unread > 0 && (
        <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={() => onRead(t.key)}>Mark read</button>
      )}
      <button type="button" className="esc-mini" disabled={busy} onClick={() => onUnwatch(t.key)}>Unwatch</button>
    </>
  );
  const notes = [
    t.phase === 'background' && t.listeningUntil && (
      <span key="l" title="Resolved. Only a real follow-up from the customer — not a thank-you — will flag it.">
        Resolved · listening until {dayMonth(t.listeningUntil)}
      </span>
    ),
    !t.baselineTaken && <span key="b" title="NEURO could not read the comments yet; it will on the next check">waiting for first read</span>,
    t.lastError && <span key="e" className="esc-row-touched-cold" title={t.lastError}>couldn’t check</span>,
  ].filter(Boolean);
  return (
    <article className={t.unread > 0 ? 'esc-watch esc-watch-unread' : 'esc-watch'}>
      <div className="esc-watch-head">
        <a href={t.url || '#'} target="_blank" rel="noreferrer" className="esc-watch-key"
          onClick={() => { if (t.unread) onRead(t.key); }}>{t.key}</a>
        <span className="esc-watch-summary">{t.summary || '—'}</span>
        <span className="esc-watch-badges">
          {t.unread > 0 && (
            <span className="esc-pill esc-pill-alert">{t.unread} new {t.unread === 1 ? 'reply' : 'replies'}</span>
          )}
          {t.status && <span className="esc-pill">{t.status}</span>}
        </span>
      </div>
      {notes.length > 0 && <div className="esc-watch-notes">{notes}</div>}
      {latest && (
        <blockquote className={latest.flagged ? 'esc-watch-reply' : 'esc-watch-reply esc-watch-reply-muted'}>
          <span className="esc-comment-author">
            {latest.author} · {dayMonth(latest.created)}
            {!latest.flagged && <span className="esc-tag">judged a thank-you</span>}
            {latest.judgedBy === 'model-unavailable' && <span className="esc-tag" title="The model could not judge it, so it was flagged rather than dropped">not judged</span>}
          </span>
          <span className="esc-watch-reply-text">{latest.excerpt}</span>
        </blockquote>
      )}
      {onCommit
        ? <Commitments t={t} busy={busy} onCommit={onCommit}>{actions}</Commitments>
        : <div className="esc-watch-foot"><span /><span className="esc-watch-actions">{actions}</span></div>}
    </article>
  );
}

/**
 * Tickets Nick follows. Only a public comment from the CUSTOMER notifies;
 * agents' replies and internal notes never do. Resolved tickets drop to a
 * folded "listening" group for 10 working days, then end.
 */
export function WatchedTickets({ data, error, busy, note, onWatch, onRead, onUnwatch, onCheck, onCommit }) {
  const [key, setKey] = useState('');
  const add = (e) => {
    e.preventDefault();
    if (!key.trim()) return;
    onWatch(key.trim().toUpperCase()).then((ok) => { if (ok) setKey(''); });
  };
  const active = data?.active || [];
  const listening = data?.listening || [];
  return (
    <section className="esc-watched">
      <div className="esc-active-head">
        <h3>
          Watched tickets
          {data && <span className="esc-count">{active.length}</span>}
        </h3>
        <button type="button" className="esc-btn esc-btn-ghost esc-btn-sm" onClick={onCheck} disabled={busy}>
          {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <p className="esc-card-blurb">
        A push when the customer replies (not your team, not internal notes). After a ticket is resolved, NEURO listens for 10 working days and flags only a real follow-up, not a thank-you.
      </p>

      <form className="esc-lookup esc-lookup-compact" onSubmit={add}>
        <input className="esc-key-input" value={key} onChange={e => setKey(e.target.value)}
          placeholder="NT-28061" aria-label="Ticket to watch" />
        <button type="submit" className="esc-btn" disabled={busy || !key.trim()}>Watch</button>
      </form>

      {error && <div className="esc-error">{error}</div>}
      {note && <div className="esc-warn">{note}</div>}
      {data?.lastRun && data.lastRun.ok === false && (
        <div className="esc-warn">The last check didn’t complete{data.lastRun.why ? ` — ${data.lastRun.why}` : ''}. Replies may be late.</div>
      )}

      {data && active.length === 0 && listening.length === 0 && (
        <p className="esc-empty">You’re not watching any tickets. Add one above, or press Watch on an escalation.</p>
      )}
      {active.map(t => <WatchedRow key={t.key} t={t} busy={busy} onRead={onRead} onUnwatch={onUnwatch} onCommit={onCommit} />)}

      {listening.length > 0 && (
        <details className="esc-group">
          <summary>
            <span className="esc-group-title">Resolved — still listening</span>
            <span className="esc-count">{listening.length}</span>
          </summary>
          {listening.map(t => <WatchedRow key={t.key} t={t} busy={busy} onRead={onRead} onUnwatch={onUnwatch} onCommit={onCommit} />)}
        </details>
      )}
    </section>
  );
}

export default function EscalationPanel() {
  const [key, setKey] = useState('');
  const [ticket, setTicket] = useState(null);
  const [reasons, setReasons] = useState([]);
  const [reasonCode, setReasonCode] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const [active, setActive] = useState([]);
  const [activeLoading, setActiveLoading] = useState(true);
  const [activeError, setActiveError] = useState(null);
  const [activeWarning, setActiveWarning] = useState(null);
  const [awaitingReply, setAwaitingReply] = useState(null);
  const keyInput = useRef(null);

  useEffect(() => { keyInput.current?.focus(); }, []);

  useEffect(() => {
    fetch(apiUrl('/api/escalation/reasons'))
      .then(r => r.json())
      .then(d => setReasons(d.reasons || []))
      .catch(() => setReasons([]));
  }, []);

  const loadActive = async () => {
    setActiveLoading(true); setActiveError(null);
    try {
      const res = await fetch(apiUrl('/api/escalation/active'));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load escalations');
      setActive(data.escalations || []);
      setAwaitingReply(data.awaitingReply ?? null);
      setActiveWarning(data.warning || null);
    } catch (err) {
      setActiveError(err.message);
    } finally {
      setActiveLoading(false);
    }
  };

  useEffect(() => { loadActive(); }, []);

  // ── Watched tickets ──
  const [watched, setWatched] = useState(null);
  const [watchedError, setWatchedError] = useState(null);
  const [watchedNote, setWatchedNote] = useState(null);
  const [watchBusy, setWatchBusy] = useState(false);

  const loadWatched = async () => {
    try {
      const res = await fetch(apiUrl('/api/escalation/watched'));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load watched tickets');
      setWatched(data); setWatchedError(null);
    } catch (err) {
      setWatchedError(err.message);
    }
  };
  useEffect(() => { loadWatched(); }, []);

  const watchAction = async (path, body) => {
    setWatchBusy(true); setWatchedNote(null);
    try {
      const res = await fetch(apiUrl(`/api/escalation/watched${path}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'That did not work');
      await loadWatched();
      return data;
    } catch (err) {
      setWatchedError(err.message);
      return null;
    } finally {
      setWatchBusy(false);
    }
  };
  const watchKey = async (k) => {
    const r = await watchAction('', { key: k });
    if (r?.already) setWatchedNote(`${r.ticket.key} is already being watched.`);
    else if (r?.proposed) setWatchedNote(`Spotted a promise in your latest reply on ${r.ticket.key}: an update by ${clockLabel(r.proposed.dueAt)}. Confirm it below to get reminders.`);
    else if (r?.ticket?.phase === 'background') setWatchedNote(`${r.ticket.key} is already resolved — NEURO will listen for a follow-up until ${dayMonth(r.ticket.listeningUntil)}.`);
    return !!r;
  };
  const watchedKeys = new Set([...(watched?.active || []), ...(watched?.listening || [])].map(t => t.key));

  const lookup = async (e, presetKey) => {
    e?.preventDefault();
    const k = String(presetKey ?? key).trim().toUpperCase();
    if (!k) return;
    if (presetKey) setKey(k);
    setLoading(true); setError(null); setTicket(null); setResult(null); setConfirming(false);
    try {
      const res = await fetch(apiUrl(`/api/escalation/ticket/${encodeURIComponent(k)}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lookup failed');
      setTicket(data.ticket);
      setKey(data.ticket.key);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(apiUrl('/api/escalation'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket_key: ticket.key,
          reason_code: reasonCode,
          needed_by: neededBy || undefined,
          notes: notes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Escalation failed');
      setResult(data.result);
      setConfirming(false);
      // Priority and due date have just moved on that ticket — if it's in the
      // list, the list is now wrong.
      loadActive();
    } catch (err) {
      setError(err.message);
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setKey(''); setTicket(null); setReasonCode(''); setNeededBy('');
    setNotes(''); setResult(null); setError(null); setConfirming(false);
    keyInput.current?.focus();
  };

  // What the confirm step promises. Mirrors NOVA's rules so the promise is honest:
  // priority only rises, the due date only tightens.
  const willRaisePriority = ticket && !['Blocker', PRIORITY_TARGET].includes(ticket.priority);
  const willTightenDue = ticket && neededBy && (!ticket.duedate || neededBy < ticket.duedate);

  return (
    <div className="escalation-panel">
      <header className="esc-header">
        <h2>Escalations</h2>
        <p className="esc-sub">Make a ticket jump the queue, and record why.</p>
      </header>

      <div className="esc-grid">
      <div className="esc-card esc-area-active">
      <ActiveEscalations
        items={active}
        loading={activeLoading}
        error={activeError}
        warning={activeWarning}
        awaitingReply={awaitingReply}
        onRefresh={loadActive}
        onPick={(k) => lookup(null, k)}
        watchedKeys={watchedKeys}
        onWatch={watchKey}
      />
      </div>

      <div className="esc-card esc-area-watched">
      <WatchedTickets
        data={watched}
        error={watchedError}
        note={watchedNote}
        busy={watchBusy}
        onWatch={watchKey}
        onRead={(k) => watchAction(`/${encodeURIComponent(k)}/read`)}
        onUnwatch={(k) => watchAction(`/${encodeURIComponent(k)}/unwatch`)}
        onCheck={() => watchAction('/check')}
        onCommit={async (k, path, body) => !!(await watchAction(`/${encodeURIComponent(k)}/commitments${path}`, body))}
      />
      </div>

      <section className="esc-card esc-area-escalate">
      <div className="esc-active-head"><h3>Escalate a ticket</h3></div>
      <p className="esc-card-blurb">Raise its priority, tighten the due date and leave an internal note, through NOVA. Nothing changes until you confirm.</p>
      <form className="esc-lookup" onSubmit={lookup}>
        <input
          ref={keyInput}
          className="esc-key-input"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="NT-28061"
          spellCheck={false}
          autoCapitalize="characters"
        />
        <button type="submit" className="esc-btn" disabled={loading || !key.trim()}>
          {loading && !ticket ? 'Looking…' : 'Find ticket'}
        </button>
        {(ticket || result) && (
          <button type="button" className="esc-btn esc-btn-ghost" onClick={reset}>Clear</button>
        )}
      </form>

      {error && <div className="esc-error">{error}</div>}

      {ticket && !result && (
        <div className="esc-ticket">
          <div className="esc-ticket-head">
            <span className="esc-ticket-key">{ticket.key}</span>
            <span className="esc-ticket-summary">{ticket.summary}</span>
            {watchedKeys.has(ticket.key)
              ? <span className="esc-tag esc-tag-watching">watching</span>
              : <button type="button" className="esc-row-action" disabled={watchBusy} onClick={() => watchKey(ticket.key)}>Watch</button>}
          </div>
          <dl className="esc-meta">
            <div><dt>Status</dt><dd>{ticket.status || '—'}</dd></div>
            <div><dt>Priority</dt><dd>{ticket.priority || 'Unset'}</dd></div>
            <div><dt>Tier</dt><dd>{ticket.tier || '—'}</dd></div>
            <div><dt>Assignee</dt><dd>{ticket.assignee || 'Unassigned'}</dd></div>
            <div><dt>Due</dt><dd>{ticket.duedate || '—'}</dd></div>
            <div><dt>Updated</dt><dd>{ticket.updated ? new Date(ticket.updated).toLocaleDateString('en-GB') : '—'}</dd></div>
          </dl>

          {ticket.statusCategory === 'done' && (
            <div className="esc-warn">This ticket is already closed — escalating it is probably not what you want.</div>
          )}

          {ticket.description && <p className="esc-desc">{ticket.description.slice(0, 400)}</p>}

          {ticket.comments?.length > 0 && (
            <details className="esc-comments">
              <summary>Last {ticket.comments.length} comment{ticket.comments.length === 1 ? '' : 's'}</summary>
              {ticket.comments.map((c, i) => (
                <div key={i} className={`esc-comment ${c.internal ? 'is-internal' : ''}`}>
                  <span className="esc-comment-author">
                    {c.author}
                    {c.internal && <span className="esc-tag">internal</span>}
                  </span>
                  <span className="esc-comment-text">{c.text}</span>
                </div>
              ))}
            </details>
          )}

          <div className="esc-form">
            <label>
              <span>Why does it need to jump the queue?</span>
              <select value={reasonCode} onChange={e => setReasonCode(e.target.value)}>
                <option value="">Choose a reason…</option>
                {reasons.map(r => (
                  <option key={r.reason_code} value={r.reason_code}>{r.label}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Needed by <em>(optional — only ever brings a date forward)</em></span>
              <input type="date" value={neededBy} onChange={e => setNeededBy(e.target.value)} />
            </label>

            <label>
              <span>Context <em>(the assignee reads this)</em></span>
              <textarea
                rows={3}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Who asked, and why it matters."
              />
            </label>

            {!confirming ? (
              <button
                className="esc-btn esc-btn-primary"
                disabled={!reasonCode}
                onClick={() => setConfirming(true)}
              >
                Escalate {ticket.key}
              </button>
            ) : (
              <div className="esc-confirm">
                <p className="esc-confirm-title">This will change {ticket.key}:</p>
                <ul>
                  <li>
                    {willRaisePriority
                      ? <>Priority <strong>{ticket.priority || 'Unset'} → {PRIORITY_TARGET}</strong></>
                      : <>Priority stays <strong>{ticket.priority}</strong> — already at or above {PRIORITY_TARGET}</>}
                  </li>
                  {neededBy && (
                    <li>
                      {willTightenDue
                        ? <>Due date <strong>{ticket.duedate || 'none'} → {neededBy}</strong></>
                        : <>Due date stays <strong>{ticket.duedate}</strong> — already tighter than {neededBy}</>}
                    </li>
                  )}
                  <li>An <strong>internal</strong> comment, visible to the team but never to the customer</li>
                </ul>
                <div className="esc-confirm-actions">
                  <button className="esc-btn esc-btn-primary" onClick={submit} disabled={loading}>
                    {loading ? 'Escalating…' : 'Yes, escalate'}
                  </button>
                  <button className="esc-btn esc-btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="esc-result">
          <p className="esc-result-title">Escalated {result.ticket_key} — {result.reason_label}</p>
          <ul>
            <li>Priority: {result.priority.changed
              ? `${result.priority.from || 'unset'} → ${result.priority.to}`
              : `unchanged (${result.priority.from || 'unset'})`}</li>
            <li>Due date: {result.duedate.changed
              ? result.duedate.to
              : `unchanged (${result.duedate.from || 'none'})`}</li>
            <li>Internal comment: {result.comment_posted ? 'posted' : 'FAILED'}</li>
          </ul>
          {result.warnings?.length > 0 && (
            <div className="esc-warn">{result.warnings.join(' ')}</div>
          )}
          <button className="esc-btn" onClick={reset}>Escalate another</button>
        </div>
      )}
      </section>
      </div>
    </div>
  );
}
