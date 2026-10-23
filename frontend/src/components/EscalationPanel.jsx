import { useState, useEffect, useRef } from 'react';
import { apiUrl } from '../api';
import './EscalationPanel.css';

/**
 * Escalations — ONE list of the Jira tickets Nick is on top of (23 Oct 2026).
 *
 * It used to be three tools on one page: the escalated queue, the watched
 * tickets, and a form to escalate. Nick: "three separate bits of functionality
 * smooshed together". Now a ticket appears ONCE, whatever it is — escalated,
 * watched, or both — with everything that applies to it on its own card:
 * its escalation route, its customer's latest reply, the update he promised,
 * and the actions (Watch, Escalate, Add commitment). One key box opens any
 * ticket, in the list or not.
 *
 * Escalating still has its lookup + confirm steps: escalating the wrong ticket
 * is a real risk when someone reads a number out over Teams, nothing is written
 * until the confirm, and the confirm names exactly what will change.
 */

const PRIORITY_TARGET = 'Critical';

// ── Small formatters ─────────────────────────────────────────────────────────

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

function dayMonth(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function clockLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `${hm} today` : `${hm} ${dayMonth(iso)}`;
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

// ── One list (PURE) ──────────────────────────────────────────────────────────

/** How a ticket came to be escalated — the old three groups, now a label on the ticket. */
function escalationRoute(e) {
  if (!e) return null;
  if (e.viaUrgency) return { label: 'escalated · urgency', title: ['Escalated with this tool — priority raised and an internal comment posted.', e.urgencyReason, e.escalatedBy && `by ${e.escalatedBy}`].filter(Boolean).join(' ') };
  if (e.viaRequestType) return { label: 'escalated · customer', title: 'Raised as an escalation through the portal — the customer asked for this one.' };
  return { label: 'escalated · tier', title: 'Moved into the Escalations tier by the team.' };
}

/**
 * Escalated and watched tickets as ONE list, a ticket once. PURE. Each item
 * says why it needs Nick (if it does), and the list is ordered by that: things
 * that need him first, then promised updates by time, then escalations, then
 * watched, then resolved tickets still being listened to.
 */
export function mergeTickets(escalations = [], watched = null) {
  const byKey = new Map();
  for (const e of escalations || []) byKey.set(e.key, { key: e.key, esc: e, watch: null });
  for (const w of [...(watched?.active || []), ...(watched?.listening || [])]) {
    const item = byKey.get(w.key) || { key: w.key, esc: null, watch: null };
    item.watch = w;
    byKey.set(w.key, item);
  }
  const items = [...byKey.values()].map((it) => {
    const { esc, watch } = it;
    const commitments = watch?.commitments || [];
    const open = commitments.filter((c) => c.state === 'open');
    const reasons = [];
    if (open.some((c) => c.missed)) reasons.push('promised update overdue');
    else if (open.some((c) => c.dueSoon)) reasons.push('update due soon');
    if (watch?.unread > 0) reasons.push(`${watch.unread} new ${watch.unread === 1 ? 'reply' : 'replies'}`);
    if (esc?.replyState === 'awaiting-you') reasons.push('no reply from you');
    if (commitments.some((c) => c.state === 'proposed')) reasons.push('confirm a commitment');
    const nextDue = open.length ? Math.min(...open.map((c) => Date.parse(c.dueAt))) : Infinity;
    const rank = reasons.length ? 0 : open.length ? 1 : esc ? 2 : watch?.phase === 'background' ? 4 : 3;
    return {
      ...it,
      summary: esc?.summary || watch?.summary || '',
      url: esc?.url || watch?.url || null,
      status: esc?.status || watch?.status || null,
      needs: reasons,
      hasOpenCommitment: open.length > 0,
      listening: watch?.phase === 'background',
      _rank: rank,
      _due: nextDue,
      _created: Date.parse(esc?.created || watch?.watchedAt || '') || 0,
    };
  });
  items.sort((a, b) => a._rank - b._rank || a._due - b._due || a._created - b._created);
  return items;
}

export const FILTERS = [
  ['all', 'All', () => true],
  ['needs', 'Needs you', (t) => t.needs.length > 0],
  ['escalated', 'Escalated', (t) => !!t.esc],
  ['watching', 'Watching', (t) => !!t.watch],
  ['due', 'Update due', (t) => t.hasOpenCommitment],
];

// ── Update commitments on a ticket ───────────────────────────────────────────

/**
 * Updates Nick promised the customer. A spotted one is only a proposal until he
 * confirms it — no reminder or Now card before then. An open one counts down
 * and is closed by his next public reply on the ticket.
 */
function Commitments({ t, busy, onCommit }) {
  const [adding, setAdding] = useState(false);
  const [when, setWhen] = useState(defaultWhen);
  const list = t.commitments || [];
  const save = async (e) => {
    e.preventDefault();
    if (await onCommit(t.key, '', { due: when })) setAdding(false);
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
            <span className="esc-commitment-kept-text">
              Update kept {c.closedAt ? clockLabel(c.closedAt) : ''}{c.keptLate ? ` — after the ${clockLabel(c.dueAt)} you promised` : ''}
              {c.closedBy === 'nick' ? ' (marked by you)' : ''}
            </span>
          )}
        </div>
      ))}
      {adding && (
        <form className="esc-commitment-add" onSubmit={save}>
          <label>Update the customer by
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <button type="submit" className="esc-mini esc-mini-primary" disabled={busy || !when}>Add</button>
          <button type="button" className="esc-mini" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      )}
      {!adding && (
        <button type="button" className="esc-link-btn" onClick={() => { setWhen(defaultWhen()); setAdding(true); }}>+ Add update commitment</button>
      )}
    </div>
  );
}

// ── Escalate, inside the ticket's card ───────────────────────────────────────

function TicketDetail({ ticket }) {
  return (
    <>
      <dl className="esc-meta">
        <div><dt>Status</dt><dd>{ticket.status || '—'}</dd></div>
        <div><dt>Priority</dt><dd>{ticket.priority || 'Unset'}</dd></div>
        <div><dt>Tier</dt><dd>{ticket.tier || '—'}</dd></div>
        <div><dt>Assignee</dt><dd>{ticket.assignee || 'Unassigned'}</dd></div>
        <div><dt>Due</dt><dd>{ticket.duedate || '—'}</dd></div>
        <div><dt>Updated</dt><dd>{ticket.updated ? new Date(ticket.updated).toLocaleDateString('en-GB') : '—'}</dd></div>
      </dl>
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
    </>
  );
}

/** Fetches the ticket, shows enough to know it is the right one, then reason → confirm → result. */
function EscalatePanel({ ticketKey, reasons, onEscalated, onClose, showDetail = true }) {
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState(null);
  const [reasonCode, setReasonCode] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    fetch(apiUrl(`/api/escalation/ticket/${encodeURIComponent(ticketKey)}`))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Lookup failed');
        if (live) setTicket(data.ticket);
      })
      .catch((err) => { if (live) setError(err.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ticketKey]);

  const submit = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(apiUrl('/api/escalation'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket_key: ticket.key, reason_code: reasonCode, needed_by: neededBy || undefined, notes: notes || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Escalation failed');
      setResult(data.result);
      setConfirming(false);
      onEscalated?.();
    } catch (err) {
      setError(err.message);
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  };

  // What the confirm step promises. Mirrors NOVA's rules so the promise is honest:
  // priority only rises, the due date only tightens.
  const willRaisePriority = ticket && !['Blocker', PRIORITY_TARGET].includes(ticket.priority);
  const willTightenDue = ticket && neededBy && (!ticket.duedate || neededBy < ticket.duedate);

  if (result) {
    return (
      <div className="esc-result">
        <p className="esc-result-title">Escalated {result.ticket_key} — {result.reason_label}</p>
        <ul>
          <li>Priority: {result.priority.changed ? `${result.priority.from || 'unset'} → ${result.priority.to}` : `unchanged (${result.priority.from || 'unset'})`}</li>
          <li>Due date: {result.duedate.changed ? result.duedate.to : `unchanged (${result.duedate.from || 'none'})`}</li>
          <li>Internal comment: {result.comment_posted ? 'posted' : 'FAILED'}</li>
        </ul>
        {result.warnings?.length > 0 && <div className="esc-warn">{result.warnings.join(' ')}</div>}
        <button type="button" className="esc-mini" onClick={onClose}>Close</button>
      </div>
    );
  }

  return (
    <div className="esc-escalate">
      <div className="esc-escalate-head">
        <span className="esc-escalate-title">Escalate {ticketKey}</span>
        <span className="esc-escalate-sub">Raises priority, tightens the due date and leaves an internal note, through NOVA. Nothing changes until you confirm.</span>
      </div>
      {error && <div className="esc-error">{error}</div>}
      {loading && !ticket && <p className="esc-empty">Looking up {ticketKey}…</p>}
      {ticket && (
        <>
          {showDetail && <TicketDetail ticket={ticket} />}
          {ticket.statusCategory === 'done' && (
            <div className="esc-warn">This ticket is already closed — escalating it is probably not what you want.</div>
          )}
          <div className="esc-form">
            <label>
              <span>Why does it need to jump the queue?</span>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                <option value="">Choose a reason…</option>
                {reasons.map((r) => <option key={r.reason_code} value={r.reason_code}>{r.label}</option>)}
              </select>
            </label>
            <label>
              <span>Needed by <em>(optional — only ever brings a date forward)</em></span>
              <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
            </label>
            <label>
              <span>Context <em>(the assignee reads this)</em></span>
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Who asked, and why it matters." />
            </label>
            {!confirming ? (
              <div className="esc-confirm-actions">
                <button type="button" className="esc-btn esc-btn-primary" disabled={!reasonCode} onClick={() => setConfirming(true)}>Escalate {ticket.key}</button>
                <button type="button" className="esc-btn esc-btn-ghost" onClick={onClose}>Cancel</button>
              </div>
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
                  <button type="button" className="esc-btn esc-btn-primary" onClick={submit} disabled={loading}>{loading ? 'Escalating…' : 'Yes, escalate'}</button>
                  <button type="button" className="esc-btn esc-btn-ghost" onClick={() => setConfirming(false)}>Back</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── One ticket ───────────────────────────────────────────────────────────────

/**
 * Everything about one ticket on one card. A ticket that is escalated says how
 * (urgency / customer / tier); a watched one carries the customer's latest
 * reply and any update Nick promised. A reply NEURO judged a thank-you is
 * shown muted, so "it went quiet" and "it was filtered" stay different.
 */
export function TicketCard({ item, busy, highlighted, escalating, reasons, onWatch, onRead, onUnwatch, onCommit, onEscalate, onCloseEscalate, onEscalated }) {
  const { esc, watch } = item;
  const route = escalationRoute(esc);
  const latest = watch?.replies?.[0];
  const raised = ageDays(esc?.created);
  // "touched", not "replied": Jira bumps `updated` for NOVA triage, a
  // round-robin assignment or the CSAT bot as readily as for a human.
  const touched = ageDays(esc?.updated);
  const cls = ['esc-ticket-card'];
  if (item.needs.length) cls.push('esc-ticket-card-needs');
  if (highlighted) cls.push('esc-ticket-card-highlight');
  if (item.listening) cls.push('esc-ticket-card-quiet');
  return (
    <article className={cls.join(' ')} id={`esc-ticket-${item.key}`}>
      <div className="esc-ticket-main">
      <div className="esc-watch-head">
        <a href={item.url || '#'} target="_blank" rel="noreferrer" className="esc-watch-key"
          onClick={() => { if (watch?.unread) onRead(item.key); }}>{item.key}</a>
        <span className="esc-watch-summary">{item.summary || '—'}</span>
        <span className="esc-watch-badges">
          {item.needs.map((n) => <span key={n} className="esc-pill esc-pill-alert">{n}</span>)}
          {route && <span className="esc-pill esc-pill-esc" title={route.title}>{route.label}</span>}
          {watch && !item.listening && <span className="esc-pill esc-pill-watch" title="You get a push when the customer replies">watching</span>}
          {item.listening && (
            <span className="esc-pill" title="Resolved. Only a real follow-up from the customer — not a thank-you — will flag it.">
              resolved · listening until {dayMonth(watch.listeningUntil)}
            </span>
          )}
          {item.status && <span className="esc-pill">{item.status}</span>}
        </span>
      </div>

      {esc && (
        <div className="esc-watch-notes">
          <span>{esc.priority || 'No priority'}</span>
          <span>{esc.assignee || 'Unassigned'}</span>
          {raised != null && <span title="When this escalation was raised">raised {agoLabel(raised)}</span>}
          {touched != null && (
            <span className={touched >= 7 ? 'esc-row-touched esc-row-touched-cold' : 'esc-row-touched'}
              title="Last change of any kind on the ticket — includes NOVA automation, not just a human reply">touched {agoLabel(touched)}</span>
          )}
        </div>
      )}
      {watch && (!watch.baselineTaken || watch.lastError) && (
        <div className="esc-watch-notes">
          {!watch.baselineTaken && <span title="NEURO could not read the comments yet; it will on the next check">waiting for first read</span>}
          {watch.lastError && <span className="esc-row-touched-cold" title={watch.lastError}>couldn’t check</span>}
        </div>
      )}

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

      </div>

      <div className="esc-ticket-side">
        {watch && onCommit && <Commitments t={watch} busy={busy} onCommit={onCommit} />}
        {!escalating && (
          <div className="esc-ticket-actions">
            {!watch && <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={() => onWatch(item.key)}>Watch</button>}
            {watch?.unread > 0 && <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={() => onRead(item.key)}>Mark read</button>}
            <button type="button" className="esc-mini" onClick={() => onEscalate(item.key)}>{esc ? 'Escalate again' : 'Escalate'}</button>
            {watch && <button type="button" className="esc-mini" disabled={busy} onClick={() => onUnwatch(item.key)}>Unwatch</button>}
          </div>
        )}
      </div>

      {escalating && (
        <div className="esc-ticket-full">
          <EscalatePanel ticketKey={item.key} reasons={reasons || []} onClose={onCloseEscalate} onEscalated={onEscalated} />
        </div>
      )}
    </article>
  );
}

/**
 * A ticket opened from the key box that is not in the list yet: enough to know
 * it is the right one, then Watch or Escalate.
 */
function OpenedTicket({ ticketKey, busy, reasons, onWatch, onClose, onEscalated }) {
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState(null);
  const [escalating, setEscalating] = useState(false);
  useEffect(() => {
    let live = true;
    setTicket(null); setError(null); setEscalating(false);
    fetch(apiUrl(`/api/escalation/ticket/${encodeURIComponent(ticketKey)}`))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Lookup failed');
        if (live) setTicket(data.ticket);
      })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [ticketKey]);
  return (
    <article className="esc-ticket-card esc-ticket-card-highlight">
      <div className="esc-watch-head">
        <span className="esc-watch-key">{ticketKey}</span>
        <span className="esc-watch-summary">{ticket?.summary || (error ? '' : 'Looking up…')}</span>
        <span className="esc-watch-badges">
          <span className="esc-pill">not in your list</span>
          {ticket?.status && <span className="esc-pill">{ticket.status}</span>}
        </span>
      </div>
      {error && <div className="esc-error">{error}</div>}
      {ticket && !escalating && <TicketDetail ticket={ticket} />}
      {ticket && (escalating
        ? <EscalatePanel ticketKey={ticketKey} reasons={reasons} showDetail={false} onClose={() => setEscalating(false)} onEscalated={onEscalated} />
        : (
          <div className="esc-ticket-actions">
            <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={() => onWatch(ticketKey)}>Watch</button>
            <button type="button" className="esc-mini" onClick={() => setEscalating(true)}>Escalate</button>
            <button type="button" className="esc-mini" onClick={onClose}>Close</button>
          </div>
        ))}
      {error && <div className="esc-ticket-actions"><button type="button" className="esc-mini" onClick={onClose}>Close</button></div>}
    </article>
  );
}

// ── The page (pure view + the container below) ───────────────────────────────

/**
 * Everything on screen, from props. `escalations` null = could not be read
 * (never "nothing escalated"); same for `watched`.
 */
export function TicketsView({
  escalations, escalationsLoading, escalationsError, escalationsWarning,
  watched, watchedError, note, busy, reasons = [],
  opened, onOpen, onCloseOpened,
  highlightKey, escalatingKey, onEscalate, onCloseEscalate, onEscalated,
  onWatch, onRead, onUnwatch, onCommit, onRefresh,
  initialFilter = 'all',
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [key, setKey] = useState('');
  const items = mergeTickets(escalations || [], watched);
  const counts = Object.fromEntries(FILTERS.map(([id, , test]) => [id, items.filter(test).length]));
  const shown = items.filter(FILTERS.find(([id]) => id === filter)[2]);
  const loading = escalationsLoading && !escalations;
  const open = (e) => {
    e.preventDefault();
    const k = key.trim().toUpperCase();
    if (!k) return;
    setFilter('all');
    onOpen(k, items.some((t) => t.key === k));
    setKey('');
  };

  return (
    <div className="escalation-panel">
      <header className="esc-page-head">
        <div>
          <h2>Escalations</h2>
          <p className="esc-sub">Escalated tickets and the ones you’re watching, in one list. A watched ticket pushes you when the customer replies.</p>
        </div>
        <div className="esc-toolbar">
          <form className="esc-lookup esc-lookup-compact" onSubmit={open}>
            <input className="esc-key-input" value={key} onChange={(e) => setKey(e.target.value)}
              placeholder="NT-28061" aria-label="Open a ticket" spellCheck={false} autoCapitalize="characters" />
            <button type="submit" className="esc-btn" disabled={!key.trim()}>Open</button>
          </form>
          <button type="button" className="esc-btn esc-btn-ghost" onClick={onRefresh} disabled={busy || escalationsLoading}>
            {busy || escalationsLoading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </header>

      <nav className="esc-filters" aria-label="Filter tickets">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className={filter === id ? 'esc-filter esc-filter-on' : 'esc-filter'}
            onClick={() => setFilter(id)}>
            {label}<span className={id === 'needs' && counts.needs ? 'esc-filter-count esc-filter-count-alert' : 'esc-filter-count'}>{counts[id]}</span>
          </button>
        ))}
      </nav>

      {escalationsError && <div className="esc-error">Couldn’t read the escalated queue: {escalationsError}. Watched tickets below are still current.</div>}
      {watchedError && <div className="esc-error">{watchedError}</div>}
      {escalationsWarning && <div className="esc-warn">{escalationsWarning}</div>}
      {watched?.lastRun && watched.lastRun.ok === false && (
        <div className="esc-warn">The last check didn’t complete{watched.lastRun.why ? ` — ${watched.lastRun.why}` : ''}. Replies may be late.</div>
      )}
      {note && <div className="esc-warn">{note}</div>}

      <div className="esc-ticket-list">
        {opened && (
          <OpenedTicket ticketKey={opened} busy={busy} reasons={reasons} onWatch={onWatch} onClose={onCloseOpened} onEscalated={onEscalated} />
        )}

        {loading && <p className="esc-empty">Loading…</p>}
        {!loading && shown.length === 0 && (
          <p className="esc-empty">
            {filter === 'all' && (escalationsError
              ? 'Nothing watched, and the escalated queue couldn’t be read — this is not an empty queue.'
              : 'Nothing escalated and nothing watched. That is the good outcome, not a broken query.')}
            {filter === 'needs' && 'Nothing needs you right now.'}
            {filter === 'escalated' && (escalationsError ? 'The escalated queue couldn’t be read.' : 'Nothing is escalated. That is the good outcome, not a broken query.')}
            {filter === 'watching' && 'You’re not watching any tickets. Open one above, or press Watch on an escalation.'}
            {filter === 'due' && 'No updates promised.'}
          </p>
        )}

        {shown.map((item) => (
          <TicketCard
            key={item.key}
            item={item}
            busy={busy}
            reasons={reasons}
            highlighted={item.key === highlightKey}
            escalating={item.key === escalatingKey}
            onWatch={onWatch}
            onRead={onRead}
            onUnwatch={onUnwatch}
            onCommit={onCommit}
            onEscalate={onEscalate}
            onCloseEscalate={onCloseEscalate}
            onEscalated={onEscalated}
          />
        ))}
      </div>
    </div>
  );
}

export default function EscalationPanel() {
  const [reasons, setReasons] = useState([]);
  const [escalations, setEscalations] = useState(null);
  const [escalationsLoading, setEscalationsLoading] = useState(true);
  const [escalationsError, setEscalationsError] = useState(null);
  const [escalationsWarning, setEscalationsWarning] = useState(null);
  const [watched, setWatched] = useState(null);
  const [watchedError, setWatchedError] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(null);
  const [highlightKey, setHighlightKey] = useState(null);
  const [escalatingKey, setEscalatingKey] = useState(null);
  const highlightTimer = useRef(null);

  useEffect(() => {
    fetch(apiUrl('/api/escalation/reasons'))
      .then((r) => r.json())
      .then((d) => setReasons(d.reasons || []))
      .catch(() => setReasons([]));
  }, []);

  const loadEscalations = async () => {
    setEscalationsLoading(true);
    try {
      const res = await fetch(apiUrl('/api/escalation/active'));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load escalations');
      setEscalations(data.escalations || []);
      setEscalationsWarning(data.warning || null);
      setEscalationsError(null);
    } catch (err) {
      setEscalationsError(err.message);
    } finally {
      setEscalationsLoading(false);
    }
  };

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

  useEffect(() => { loadEscalations(); loadWatched(); }, []);

  const watchAction = async (path, body) => {
    setBusy(true); setNote(null);
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
      setBusy(false);
    }
  };

  const highlight = (k) => {
    setHighlightKey(k);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightKey(null), 4000);
    setTimeout(() => document.getElementById(`esc-ticket-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };

  const watchKey = async (k) => {
    const r = await watchAction('', { key: k });
    if (!r) return false;
    if (opened === k) setOpened(null);
    if (r.already) setNote(`${r.ticket.key} is already being watched.`);
    else if (r.proposed) setNote(`Spotted a promise in your latest reply on ${r.ticket.key}: an update by ${clockLabel(r.proposed.dueAt)}. Confirm it on the ticket to get reminders.`);
    else if (r.ticket?.phase === 'background') setNote(`${r.ticket.key} is already resolved — NEURO will listen for a follow-up until ${dayMonth(r.ticket.listeningUntil)}.`);
    highlight(k);
    return true;
  };

  return (
    <TicketsView
      escalations={escalations}
      escalationsLoading={escalationsLoading}
      escalationsError={escalationsError}
      escalationsWarning={escalationsWarning}
      watched={watched}
      watchedError={watchedError}
      note={note}
      busy={busy}
      reasons={reasons}
      opened={opened}
      onOpen={(k, inList) => { if (inList) { setOpened(null); highlight(k); } else setOpened(k); }}
      onCloseOpened={() => setOpened(null)}
      highlightKey={highlightKey}
      escalatingKey={escalatingKey}
      onEscalate={(k) => setEscalatingKey(k)}
      onCloseEscalate={() => setEscalatingKey(null)}
      // Priority and due date have just moved on that ticket — the list is now wrong.
      onEscalated={() => loadEscalations()}
      onWatch={watchKey}
      onRead={(k) => watchAction(`/${encodeURIComponent(k)}/read`)}
      onUnwatch={(k) => watchAction(`/${encodeURIComponent(k)}/unwatch`)}
      onCommit={async (k, path, body) => !!(await watchAction(`/${encodeURIComponent(k)}/commitments${path}`, body))}
      onRefresh={async () => { await Promise.all([loadEscalations(), watchAction('/check')]); }}
    />
  );
}
