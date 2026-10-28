import { useState, useEffect, useRef } from 'react';
import { apiUrl } from '../api';
import { executeDirect, directOutcome } from '../directAction';
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

/**
 * Pending-rejection tickets (Tier 2 rejected, awaiting approval) as row items.
 * PURE. Not merged into the main list — they are their own section. Unopened
 * ones carry "new", which is what the sidebar badge counts.
 */
export function rejectionItems(rejections = []) {
  return (rejections || []).map((r) => ({
    key: r.key, esc: null, watch: null, rej: r,
    summary: r.summary || '', url: r.url || null, status: r.status || null,
    needs: r.seen ? [] : ['new'], hasOpenCommitment: false, listening: false,
  }));
}

/**
 * Tickets NOVA scores Angry right now, as row items. PURE. Their own section,
 * angriest first; an unopened one carries "new", which the sidebar badge counts.
 */
export function sentimentItems(sentiment = []) {
  return (sentiment || []).map((s) => ({
    key: s.key, esc: null, watch: null, sent: s,
    summary: s.summary || '', url: s.url || null, status: s.status || null,
    needs: s.seen ? [] : ['new'], hasOpenCommitment: false, listening: false,
  }));
}

/**
 * What has already been done to each ticket, so a row says so (28 Oct 2026):
 * emails sent with "Escalate by email…" (newest first) and, for rows from the
 * sentiment/rejection sections, whether it is also raised in Jira. PURE.
 */
export function withHistory(list, emailed = null, raisedKeys = new Set()) {
  return (list || []).map((it) => ({
    ...it,
    mail: (emailed && emailed[it.key]) || null,
    raisedInJira: !it.esc && raisedKeys.has(it.key),
  }));
}

/** "Chris · 28 Oct 12:41" for the newest email on a ticket. PURE. */
export function mailLabel(m) {
  if (!m) return '';
  const who = (m.to || []).join(', ') || 'someone';
  return `${who} · ${dayMonth(m.at)} ${clockLabel(m.at).replace(/ today$/, '')}`;
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
              {typeof c.closedBy === 'string' && c.closedBy.startsWith('reply:') ? ` (reply by ${c.closedBy.slice(6)})` : ''}
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
        <span className="esc-escalate-title">Raise {ticketKey} in Jira</span>
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

// ── Reply on the ticket ──────────────────────────────────────────────────────

async function postJson(path, body) {
  const res = await fetch(apiUrl(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/**
 * Draft → edit → preview → post. Internal note by default; the preview says in
 * words who will see it. Posting is Nick's click on that preview. A public
 * reply that promises an update sets it as an open commitment and starts
 * watching the ticket. A gap the draft left ("[time of next update]") must be
 * filled before it can be posted.
 */
export function ReplyComposer({ ticketKey, onClose, onPosted }) {
  const [visibility, setVisibility] = useState('internal');
  const [guidance, setGuidance] = useState('');
  const [text, setText] = useState('');
  const [step, setStep] = useState('edit');
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ledgerKey, setLedgerKey] = useState(null);
  const [result, setResult] = useState(null);

  const runDraft = async () => {
    setBusy(true); setError(null);
    const { ok, data } = await postJson('/api/escalation/reply/draft', { key: ticketKey, visibility, guidance: guidance || undefined });
    setBusy(false);
    if (!ok) { setError(data.error || 'Could not draft it.'); return; }
    setText(data.text || '');
  };
  const runPreview = async () => {
    setBusy(true); setError(null);
    const { data } = await postJson('/api/escalation/reply/preview', { key: ticketKey, text, visibility });
    setBusy(false);
    setPv(data); setStep('preview');
  };
  const runPost = async () => {
    setBusy(true); setError(null); setLedgerKey(null);
    const { ok, data } = await postJson('/api/escalation/reply/post', { key: ticketKey, text, visibility });
    setBusy(false);
    if (!ok) { setError(data.error || 'Not posted.'); setLedgerKey(data.ledgerKey || null); return; }
    setResult(data); setStep('done');
    onPosted?.();
  };
  const resolve = async (applied) => {
    setBusy(true);
    const { ok, data } = await postJson('/api/escalation/ledger/resolve', { key: ledgerKey, applied });
    setBusy(false);
    if (!ok) { setError(data.why || data.error || 'Could not record that.'); return; }
    setLedgerKey(null);
    setError(applied ? 'Recorded as posted — it will not be posted again.' : 'Recorded as not posted — you can post it now.');
    if (applied) onPosted?.();
  };

  if (step === 'done' && result) {
    return (
      <div className="esc-reply">
        <p className={result.warning ? 'esc-warn' : 'esc-reply-done'}>
          {result.warning || `Posted on ${ticketKey} as ${result.visibility === 'public' ? 'a reply to the customer' : 'an internal note'} — read back from Jira.`}
        </p>
        {result.commitment && <p className="esc-reply-note">Commitment set: update by {clockLabel(result.commitment.dueAt)}.</p>}
        {result.watchedNow && <p className="esc-reply-note">Now watching {ticketKey} — you’ll get a push when the customer replies.</p>}
        <div className="esc-ticket-actions"><button type="button" className="esc-mini" onClick={onClose}>Close</button></div>
      </div>
    );
  }

  const isPublic = visibility === 'public';
  return (
    <div className={isPublic ? 'esc-reply esc-reply-public' : 'esc-reply'}>
      <div className="esc-reply-head">
        <span className="esc-escalate-title">{step === 'preview' ? 'Check before posting' : `Reply on ${ticketKey}`}</span>
        <span className="esc-seg" role="radiogroup" aria-label="Who sees it">
          <button type="button" role="radio" aria-checked={!isPublic} className={!isPublic ? 'esc-seg-on' : ''}
            disabled={step === 'preview'} onClick={() => setVisibility('internal')}>Internal note</button>
          <button type="button" role="radio" aria-checked={isPublic} className={isPublic ? 'esc-seg-on esc-seg-public' : ''}
            disabled={step === 'preview'} onClick={() => setVisibility('public')}>Reply to customer</button>
        </span>
      </div>

      {error && <div className={ledgerKey ? 'esc-error' : 'esc-warn'}>{error}</div>}
      {ledgerKey && (
        <div className="esc-ticket-actions esc-ticket-actions-left">
          <span className="esc-reply-note">Look at {ticketKey} in Jira. Is it there?</span>
          <button type="button" className="esc-mini" disabled={busy} onClick={() => resolve(true)}>It’s there</button>
          <button type="button" className="esc-mini" disabled={busy} onClick={() => resolve(false)}>It isn’t there</button>
        </div>
      )}

      {step === 'edit' && (
        <>
          <div className="esc-reply-draft">
            <input value={guidance} onChange={(e) => setGuidance(e.target.value)} maxLength={2000}
              placeholder="What should it say? e.g. fix is in testing, next update 5pm" aria-label="What should the reply say" />
            <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={runDraft}>
              {busy ? 'Drafting…' : text ? 'Redraft' : 'Draft it'}
            </button>
          </div>
          <textarea className="esc-reply-text" rows={9} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={isPublic ? 'Write to the customer, or press Draft it.' : 'Write the note for your team, or press Draft it.'} />
          <p className="esc-reply-note">Golden rules: who owns it, what’s happening, and when the next update comes. Anything in [square brackets] is a gap to fill.</p>
          <div className="esc-ticket-actions esc-ticket-actions-left">
            <button type="button" className="esc-mini esc-mini-primary" disabled={busy || !text.trim()} onClick={runPreview}>Preview</button>
            <button type="button" className="esc-mini" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}

      {step === 'preview' && pv && (
        <>
          <p className={isPublic ? 'esc-reply-audience esc-reply-audience-public' : 'esc-reply-audience'}>{pv.audience}</p>
          <pre className="esc-reply-preview">{text}</pre>
          {pv.problem && <div className="esc-error">{pv.problem}</div>}
          {pv.promise && <p className="esc-reply-note">Posting sets a commitment: update by {clockLabel(pv.promise.dueAt)}.</p>}
          {pv.willWatch && <p className="esc-reply-note">Posting starts watching {ticketKey}.</p>}
          <div className="esc-ticket-actions esc-ticket-actions-left">
            <button type="button" className={isPublic ? 'esc-btn esc-btn-primary esc-btn-public' : 'esc-btn esc-btn-primary'}
              disabled={busy || !!pv.problem} onClick={runPost}>
              {busy ? 'Posting…' : isPublic ? 'Post reply to customer' : 'Post internal note'}
            </button>
            <button type="button" className="esc-btn esc-btn-ghost" disabled={busy} onClick={() => setStep('edit')}>Back to edit</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Escalate to… by email ───────────────────────────────────────────────────

const RECENT_TO_KEY = 'neuro_escalate_to_recent';
function recentTo() {
  try { return JSON.parse(localStorage.getItem(RECENT_TO_KEY) || '[]').filter((s) => typeof s === 'string'); } catch { return []; }
}
function rememberTo(addresses) {
  try { localStorage.setItem(RECENT_TO_KEY, JSON.stringify([...new Set([...addresses, ...recentTo()])].slice(0, 8))); } catch { /* per-device convenience only */ }
}

/** Linked development items still open, as "TPJ-1" / "TPJ-1 and TPJ-2". PURE. null when there are none. */
export function devAsk(devItems) {
  const keys = (devItems || []).filter((d) => d && d.key && !d.done).map((d) => d.key);
  if (!keys.length) return null;
  return keys.length === 1 ? keys[0] : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
}

/**
 * The email NEURO starts from — Nick's own wording (28 Oct 2026), every line a
 * fact off the ticket card, editable before sending. With an open linked dev
 * item it asks for that by name; otherwise a [gap] Send will not pass.
 */
export function escalationEmailDraft(item, devItems = null) {
  const esc = item.esc || item.rej || item.sent || {};
  const raised = item.esc ? ageDays(esc.created) : null;
  const lines = [
    'Hi,',
    '',
    `Another one I need to escalate, please: ${item.key}.`,
    '',
    `Ticket: ${item.key}${item.summary ? ` — ${item.summary}` : ''}`,
    !!item.url && `Link: ${item.url}`,
    !!item.status && `Status: ${item.status}`,
    !!esc.priority && `Priority: ${esc.priority}`,
    `Assignee: ${esc.assignee || 'Unassigned'}`,
    raised != null && `Escalated: ${agoLabel(raised)}`,
    !!esc.urgencyReason && `Reason: ${esc.urgencyReason}`,
    !!item.sent && `Customer sentiment: Angry (NOVA score ${item.sent.score})${item.sent.why ? ` — ${item.sent.why}` : ''}`,
    !!item.rej && 'Rejected by Tier 2 — the rejection is awaiting approval',
    '',
    devAsk(devItems) ? `Can we get ${devAsk(devItems)} prioritised please` : '[What you need from them, and by when]',
  ];
  return {
    subject: `Escalation: ${item.key}${item.summary ? ` — ${item.summary}` : ''}`.slice(0, 240),
    body: lines.filter((l) => typeof l === 'string').join('\n'),
  };
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * One recipient from what Nick typed or picked. PURE. "Name <email>" (a picked
 * person), a bare address (named if a People note has it), or a People note's
 * exact name. Anything else is null — never guessed into an address.
 */
export function parseRecipient(text, people = []) {
  const t = String(text || '').trim();
  if (!t) return null;
  const angle = t.match(/^(.*)<([^>]+)>$/);
  if (angle) {
    const email = angle[2].trim().toLowerCase();
    return EMAIL_RE.test(email) ? { name: angle[1].trim() || null, email } : null;
  }
  if (EMAIL_RE.test(t)) {
    const email = t.toLowerCase();
    const known = people.find((p) => p.email === email);
    return { name: known ? known.name : null, email };
  }
  const byName = people.filter((p) => p.name.toLowerCase() === t.toLowerCase());
  return byName.length === 1 ? { name: byName[0].name, email: byName[0].email } : null;
}

function EmailEscalation({ item, onClose, onSent }) {
  const draft = escalationEmailDraft(item);
  const recents = recentTo();
  const [people, setPeople] = useState([]);
  const [peopleError, setPeopleError] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [typed, setTyped] = useState('');
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [dev, setDev] = useState(null); // null = still reading; {items} or {error}
  const autoBody = useRef(draft.body);

  // The ticket's linked development items, read from Jira — the ask names them.
  // Only an untouched draft is rewritten; anything Nick has typed stays.
  useEffect(() => {
    let live = true;
    fetch(apiUrl(`/api/escalation/ticket/${encodeURIComponent(item.key)}`)).then((r) => r.json()).then((d) => {
      if (!live) return;
      if (!d.ticket) { setDev({ error: d.error || 'unreadable' }); return; }
      const items = d.ticket.devItems || [];
      setDev({ items });
      const next = escalationEmailDraft(item, items).body;
      setBody((cur) => (cur === autoBody.current ? next : cur));
      autoBody.current = next;
    }).catch((e) => { if (live) setDev({ error: e.message }); });
    return () => { live = false; };
  }, [item.key]);

  useEffect(() => {
    let live = true;
    fetch(apiUrl('/api/escalation/people')).then((r) => r.json()).then((d) => {
      if (!live) return;
      if (d.ok) setPeople(d.people || []);
      else setPeopleError(d.error || 'unreadable');
    }).catch((e) => { if (live) setPeopleError(e.message); });
    return () => { live = false; };
  }, []);

  const add = (text) => {
    if (!String(text || '').trim()) return true;
    const r = parseRecipient(text, people);
    if (!r) { setError(`“${String(text).trim()}” isn’t an email address or a person with one in their People note.`); return false; }
    setError(null);
    setRecipients((prev) => (prev.some((x) => x.email === r.email) ? prev : [...prev, r]));
    setTyped('');
    return true;
  };
  const remove = (email) => setRecipients((prev) => prev.filter((x) => x.email !== email));

  const options = [
    ...people.map((p) => `${p.name} <${p.email}>`),
    ...recents.filter((e) => !people.some((p) => p.email === e)),
  ];
  const onType = (v) => {
    // Picking from the list fills the whole option in one go — add it straight away.
    if (options.includes(v)) { add(v); return; }
    if (/[,;]$/.test(v)) { add(v.slice(0, -1)); return; }
    setTyped(v);
  };

  const gap = /\[[^\]]+\]/.test(body);
  const pending = typed.trim() ? parseRecipient(typed, people) : null;
  const all = pending && !recipients.some((x) => x.email === pending.email) ? [...recipients, pending] : recipients;

  const send = async () => {
    if (typed.trim() && !pending) { add(typed); return; }
    setBusy(true); setError(null);
    const { ok, data } = await postJson('/api/escalation/email', { key: item.key, to: all, subject, body });
    if (!ok) { setBusy(false); setError(data.error || 'Not prepared — nothing was sent.'); return; }
    const r = await executeDirect(data.action);
    setBusy(false);
    if (r.ok) { rememberTo(all.map((x) => x.email)); setRecipients(all); setTyped(''); onSent?.(); }
    setOutcome(directOutcome(r));
  };

  const label = (r) => r.name || r.email;
  if (outcome && outcome.tone !== 'bad') {
    return (
      <div className="esc-reply">
        <p className={outcome.tone === 'ok' ? 'esc-reply-done' : 'esc-warn'}>Emailed {all.map(label).join(', ')} about {item.key}. {outcome.text}</p>
        <div className="esc-ticket-actions"><button type="button" className="esc-mini" onClick={onClose}>Close</button></div>
      </div>
    );
  }

  return (
    <div className="esc-reply">
      <div className="esc-reply-head"><span className="esc-escalate-title">Escalate {item.key} to…</span></div>
      {(error || outcome) && <div className="esc-error">{error || outcome.text}</div>}
      <div className="esc-email-to esc-email-chips">
        {recipients.map((r) => (
          <span key={r.email} className="esc-chip" title={r.email}>
            {label(r)}
            <button type="button" aria-label={`Remove ${label(r)}`} onClick={() => remove(r.email)}>×</button>
          </span>
        ))}
        <input value={typed} list={`esc-to-${item.key}`} autoFocus
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(typed); }
            else if (e.key === 'Backspace' && !typed && recipients.length) remove(recipients[recipients.length - 1].email);
          }}
          onBlur={() => { if (typed.trim()) add(typed); }}
          placeholder={recipients.length ? 'Add another…' : 'Pick a person, or type any email address'}
          aria-label="Escalate to — a person or an email address" />
        <datalist id={`esc-to-${item.key}`}>{options.map((o) => <option key={o} value={o} />)}</datalist>
      </div>
      {peopleError && <p className="esc-reply-note">Couldn’t read your People notes ({peopleError}) — type the address instead.</p>}
      {dev === null && <p className="esc-reply-note">Looking for a linked development item…</p>}
      {dev?.error && <p className="esc-reply-note">Couldn’t read the ticket’s links ({dev.error}) — add the dev item yourself.</p>}
      {dev?.items && (dev.items.length
        ? <p className="esc-reply-note">Linked in Jira: {dev.items.map((d) => `${d.key}${d.status ? ` (${d.status})` : ''}`).join(', ')}{devAsk(dev.items) ? '' : ' — all done, so the ask is left for you to write'}</p>
        : <p className="esc-reply-note">No linked development item in Jira — say what you need in the [gap].</p>)}
      <input className="esc-email-to" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" maxLength={240} />
      <textarea className="esc-reply-text" rows={12} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Email" />
      <p className="esc-reply-note">
        Sent from your work address when you press Send{gap ? ' — fill in the [square brackets] first' : ''}.
      </p>
      <div className="esc-ticket-actions esc-ticket-actions-left">
        <button type="button" className="esc-btn esc-btn-primary" disabled={busy || !all.length || !subject.trim() || !body.trim() || gap} onClick={send}>
          {busy ? 'Sending…' : `Send to ${all.length > 1 ? `${all.length} people` : all[0] ? label(all[0]) : '…'}`}
        </button>
        <button type="button" className="esc-btn esc-btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ── One ticket: a compact row that expands ──────────────────────────────────

/** The one thing at the end of a row: a promised update first, else how fresh the ticket is. */
function rowTail(item) {
  const open = (item.watch?.commitments || []).filter((c) => c.state === 'open')
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
  if (open) {
    return { cls: open.missed ? 'esc-tail esc-tail-alert' : 'esc-tail esc-tail-warn', text: `update ${clockLabel(open.dueAt).replace(' today', '')} · ${untilLabel(open.dueAt).replace('overdue by', 'overdue')}` };
  }
  if ((item.watch?.commitments || []).some((c) => c.state === 'proposed')) return { cls: 'esc-tail esc-tail-ask', text: 'confirm a commitment' };
  const touched = ageDays((item.esc || item.rej || item.sent)?.updated);
  if (touched != null) return { cls: touched >= 7 ? 'esc-tail esc-tail-cold' : 'esc-tail', text: `touched ${agoLabel(touched)}` };
  if (item.listening) return { cls: 'esc-tail', text: `listening until ${dayMonth(item.watch.listeningUntil)}` };
  return null;
}

/**
 * One ticket, one line: key, summary, status, how it got here, and whatever is
 * due. Click the line to see the rest — the customer's latest reply, the
 * updates promised, and the actions. A reply NEURO judged a thank-you is shown
 * muted, so "it went quiet" and "it was filtered" stay different.
 */
export function TicketCard({ item, busy, expanded, onToggle, highlighted, escalating, reasons, onWatch, onRead, onUnwatch, onCommit, onEscalate, onCloseEscalate, onEscalated, onPosted, onEmailed }) {
  const { esc, watch } = item;
  const [replying, setReplying] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const route = escalationRoute(esc);
  const latest = watch?.replies?.[0];
  const raised = ageDays(esc?.created);
  // "touched", not "replied": Jira bumps `updated` for NOVA triage, a
  // round-robin assignment or the CSAT bot as readily as for a human.
  const info = esc || item.rej || item.sent || null;
  const touched = ageDays(info?.updated);
  const tail = rowTail(item);
  const open = expanded || escalating || replying || emailing;
  const cls = ['esc-trow'];
  if (item.needs.length) cls.push('esc-trow-needs');
  if (highlighted) cls.push('esc-trow-highlight');
  if (item.listening) cls.push('esc-trow-quiet');
  if (open) cls.push('esc-trow-open');
  return (
    <article className={cls.join(' ')} id={`esc-ticket-${item.key}`}>
      <div className="esc-trow-line" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => onToggle?.(item.key)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.(item.key); } }}>
        <span className="esc-trow-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <a href={item.url || '#'} target="_blank" rel="noreferrer" className="esc-trow-key"
          onClick={(e) => { e.stopPropagation(); if (watch?.unread) onRead(item.key); }}>{item.key}</a>
        <span className="esc-trow-summary" title={item.summary}>{item.summary || '—'}</span>
        <span className="esc-trow-pills">
          {item.needs.filter((n) => !/^update due|^promised update|^confirm/.test(n)).map((n) => <span key={n} className="esc-pill esc-pill-alert">{n}</span>)}
          {route && <span className="esc-pill esc-pill-esc" title={route.title}>{route.label.replace('escalated · ', '')}</span>}
          {item.sent && <span className="esc-pill esc-pill-alert" title="NOVA's current sentiment score for the customer, -1 to +1">angry {item.sent.score}</span>}
          {watch && !item.listening && <span className="esc-pill esc-pill-watch" title="You get a push when the customer replies">watching</span>}
          {item.raisedInJira && <span className="esc-pill esc-pill-esc" title="Also raised in Jira (it is in the escalated list)">raised in Jira</span>}
          {item.mail?.length > 0 && (
            <span className="esc-pill esc-pill-mail" title={item.mail.map((m) => `Emailed ${mailLabel(m)}${m.status === 'verified' ? '' : ` (${m.status})`}`).join('
')}>
              emailed{item.mail.length > 1 ? ` ×${item.mail.length}` : ''}
            </span>
          )}
        </span>
        <span className="esc-trow-status">{item.status || ''}</span>
        <span className="esc-trow-tail">{tail && <span className={tail.cls}>{tail.text}</span>}</span>
      </div>

      {open && (
        <div className="esc-trow-body">
          <div className="esc-watch-notes">
            {info && <span>{info.priority || 'No priority'}</span>}
            {info && <span>{info.assignee || 'Unassigned'}</span>}
            {item.rej && <span title="Tier 2 rejected this ticket; the rejection is waiting to be approved">rejected by Tier 2 · awaiting approval</span>}
            {item.sent?.organisation && <span>{item.sent.organisation}</span>}
            {item.sent?.angryAt && <span title="When the customer's latest angry message was written">angry since {clockLabel(item.sent.angryAt)}</span>}
            {raised != null && <span title="When this escalation was raised">escalated {agoLabel(raised)}</span>}
            {touched != null && (
              <span className={touched >= 7 ? 'esc-row-touched esc-row-touched-cold' : 'esc-row-touched'}
                title="Last change of any kind on the ticket — includes NOVA automation, not just a human reply">touched {agoLabel(touched)}</span>
            )}
            {route && <span title={route.title}>{route.label}</span>}
            {item.listening && <span>resolved · listening until {dayMonth(watch.listeningUntil)}</span>}
            {(item.mail || []).map((m, i) => (
              <span key={`m${i}`} className="esc-row-mailed" title={m.status === 'verified' ? 'Confirmed in Sent Items' : `Status: ${m.status}`}>
                escalated by email to {mailLabel(m)}{m.status === 'verified' ? '' : ` (${m.status})`}
              </span>
            ))}
            {watch && !watch.baselineTaken && <span title="NEURO could not read the comments yet; it will on the next check">waiting for first read</span>}
            {watch?.lastError && <span className="esc-row-touched-cold" title={watch.lastError}>couldn’t check</span>}
          </div>

          {item.sent?.why && (
            <blockquote className="esc-watch-reply">
              <span className="esc-comment-author">Why NOVA scored it Angry</span>
              <span className="esc-watch-reply-text">{item.sent.why}</span>
            </blockquote>
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
          {watch && !latest && <p className="esc-trow-quietnote">No customer reply since you started watching.</p>}

          {watch && onCommit && <Commitments t={watch} busy={busy} onCommit={onCommit} />}

          {escalating && <EscalatePanel ticketKey={item.key} reasons={reasons || []} onClose={onCloseEscalate} onEscalated={onEscalated} />}
          {replying && !escalating && <ReplyComposer ticketKey={item.key} onClose={() => setReplying(false)} onPosted={onPosted} />}
          {emailing && !escalating && !replying && <EmailEscalation item={item} onClose={() => setEmailing(false)} onSent={onEmailed} />}
          {!escalating && !replying && !emailing && (
              <div className="esc-ticket-actions">
                <button type="button" className="esc-mini esc-mini-primary" onClick={() => setReplying(true)}>Reply</button>
                {!watch && <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={() => onWatch(item.key)}>Watch</button>}
                {watch?.unread > 0 && <button type="button" className="esc-mini esc-mini-primary" disabled={busy} onClick={() => onRead(item.key)}>Mark read</button>}
                <button type="button" className="esc-mini" onClick={() => setEmailing(true)}
                  title="Email this ticket to someone, from your work address">Escalate by email…</button>
                <button type="button" className="esc-mini" onClick={() => onEscalate(item.key)}
                  title="Raise the priority in Jira through NOVA and track it here">{esc ? 'Raise in Jira again' : 'Raise priority in Jira'}</button>
                {watch && <button type="button" className="esc-mini" disabled={busy} onClick={() => onUnwatch(item.key)}>Unwatch</button>}
              </div>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * A ticket opened from the key box that is not in the list yet: enough to know
 * it is the right one, then Watch or Escalate.
 */
function OpenedTicket({ ticketKey, busy, reasons, onWatch, onClose, onEscalated, onPosted }) {
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState(null);
  const [escalating, setEscalating] = useState(false);
  const [replying, setReplying] = useState(false);
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
      {ticket && !escalating && !replying && <TicketDetail ticket={ticket} />}
      {ticket && replying && <ReplyComposer ticketKey={ticketKey} onClose={() => setReplying(false)} onPosted={onPosted} />}
      {ticket && !replying && (escalating
        ? <EscalatePanel ticketKey={ticketKey} reasons={reasons} showDetail={false} onClose={() => setEscalating(false)} onEscalated={onEscalated} />
        : (
          <div className="esc-ticket-actions">
            <button type="button" className="esc-mini esc-mini-primary" onClick={() => setReplying(true)}>Reply</button>
            <button type="button" className="esc-mini" disabled={busy} onClick={() => onWatch(ticketKey)}>Watch</button>
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
  rejections = [], rejectionsError = null, onSeenRejection,
  sentiment = [], sentimentError = null, onSeenSentiment,
  emailed = null, onEmailed,
  opened, onOpen, onCloseOpened,
  highlightKey, escalatingKey, onEscalate, onCloseEscalate, onEscalated,
  onWatch, onRead, onUnwatch, onCommit, onRefresh, onPosted,
  initialFilter = 'all',
  initialExpanded = [],
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [expanded, setExpanded] = useState(() => new Set(initialExpanded));
  const toggle = (k) => setExpanded((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // A ticket opened from the key box opens up when it is found in the list.
  useEffect(() => { if (highlightKey) setExpanded((prev) => new Set(prev).add(highlightKey)); }, [highlightKey]);
  const [key, setKey] = useState('');
  const raisedKeys = new Set((escalations || []).map((e) => e.key));
  const items = withHistory(mergeTickets(escalations || [], watched), emailed, raisedKeys);
  const counts = Object.fromEntries(FILTERS.map(([id, , test]) => [id, items.filter(test).length]));
  const rejItems = withHistory(rejectionItems(rejections || []), emailed, raisedKeys);
  const rejUnseen = rejItems.filter((r) => r.needs.length).length;
  const sentItems = withHistory(sentimentItems(sentiment || []), emailed, raisedKeys);
  const sentUnseen = sentItems.filter((s) => s.needs.length).length;
  const ownSection = filter === 'rejected' || filter === 'sentiment';
  const shown = ownSection ? [] : items.filter(FILTERS.find(([id]) => id === filter)[2]);
  const showRejections = filter === 'all' || filter === 'rejected';
  const showSentiment = filter === 'all' || filter === 'sentiment';
  const sentSection = showSentiment && (sentItems.length > 0 || !!sentimentError || filter === 'sentiment');
  const rejSection = showRejections && (rejItems.length > 0 || !!rejectionsError || filter === 'rejected');
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
        <button type="button" className={filter === 'rejected' ? 'esc-filter esc-filter-on' : 'esc-filter'}
          onClick={() => setFilter('rejected')} title="Pending Rejection Approval (to CC)">
          Rejected by Tier 2<span className={rejUnseen ? 'esc-filter-count esc-filter-count-alert' : 'esc-filter-count'}>{rejectionsError ? '?' : rejItems.length}</span>
        </button>
        <button type="button" className={filter === 'sentiment' ? 'esc-filter esc-filter-on' : 'esc-filter'}
          onClick={() => setFilter('sentiment')} title="Open tickets NOVA scores Angry right now">
          Sentiment escalations<span className={sentUnseen ? 'esc-filter-count esc-filter-count-alert' : 'esc-filter-count'}>{sentimentError ? '?' : sentItems.length}</span>
        </button>
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
          <OpenedTicket ticketKey={opened} busy={busy} reasons={reasons} onWatch={onWatch} onClose={onCloseOpened} onEscalated={onEscalated} onPosted={onPosted} />
        )}

        {sentSection && (
          <section className="esc-section">
            <h3 className="esc-section-title">
              Sentiment escalations — customer is angry
              <span className="esc-section-sub"> · open tickets NOVA scores Angry now{sentUnseen ? ` · ${sentUnseen} not opened` : ''}</span>
            </h3>
            {sentimentError && <div className="esc-error">{sentimentError}. This is not an empty list.</div>}
            {!sentimentError && sentItems.length === 0 && !loading && <p className="esc-empty">No open ticket has an angry customer right now.</p>}
            {sentItems.map((item) => (
              <TicketCard
                key={`sent-${item.key}`}
                item={item}
                busy={busy}
                reasons={reasons}
                expanded={expanded.has(`sent-${item.key}`)}
                onToggle={() => { toggle(`sent-${item.key}`); if (item.needs.length) onSeenSentiment?.(item.key); }}
                escalating={item.key === escalatingKey}
                onWatch={onWatch}
                onRead={onRead}
                onUnwatch={onUnwatch}
                onEscalate={onEscalate}
                onCloseEscalate={onCloseEscalate}
                onEscalated={onEscalated}
                onPosted={onPosted}
                onEmailed={onEmailed}
              />
            ))}
          </section>
        )}

        {rejSection && (
          <section className="esc-section">
            <h3 className="esc-section-title">
              Rejected by Tier 2 — awaiting approval
              <span className="esc-section-sub"> · status “Pending Rejection Approval (to CC)”{rejUnseen ? ` · ${rejUnseen} not opened` : ''}</span>
            </h3>
            {rejectionsError && <div className="esc-error">{rejectionsError}. This is not an empty list.</div>}
            {!rejectionsError && rejItems.length === 0 && !loading && <p className="esc-empty">No tickets are waiting on a rejection approval.</p>}
            {rejItems.map((item) => (
              <TicketCard
                key={`rej-${item.key}`}
                item={item}
                busy={busy}
                reasons={reasons}
                expanded={expanded.has(`rej-${item.key}`)}
                onToggle={() => { toggle(`rej-${item.key}`); if (item.needs.length) onSeenRejection?.(item.key); }}
                escalating={item.key === escalatingKey}
                onWatch={onWatch}
                onRead={onRead}
                onUnwatch={onUnwatch}
                onEscalate={onEscalate}
                onCloseEscalate={onCloseEscalate}
                onEscalated={onEscalated}
                onPosted={onPosted}
                onEmailed={onEmailed}
              />
            ))}
          </section>
        )}

        {filter === 'all' && shown.length > 0 && (sentSection || rejSection) && (
          <h3 className="esc-section-title">Escalated and watched</h3>
        )}

        {loading && <p className="esc-empty">Loading…</p>}
        {!loading && !ownSection && shown.length === 0 && (
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
            expanded={expanded.has(item.key)}
            onToggle={toggle}
            highlighted={item.key === highlightKey}
            escalating={item.key === escalatingKey}
            onWatch={onWatch}
            onRead={onRead}
            onUnwatch={onUnwatch}
            onCommit={onCommit}
            onEscalate={onEscalate}
            onCloseEscalate={onCloseEscalate}
            onEscalated={onEscalated}
            onPosted={onPosted}
            onEmailed={onEmailed}
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
  const [rejections, setRejections] = useState(null);
  const [rejectionsError, setRejectionsError] = useState(null);
  const [sentiment, setSentiment] = useState(null);
  const [emailed, setEmailed] = useState(null);
  const [sentimentError, setSentimentError] = useState(null);
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
      setRejections(data.rejections || null);
      setRejectionsError(data.rejectionsError || null);
      setSentiment(data.sentiment || null);
      setSentimentError(data.sentimentError || null);
      setEmailed(data.emailed || null);
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
      rejections={rejections}
      rejectionsError={rejectionsError}
      onSeenRejection={(k) => {
        // Optimistic: the row stops saying "new" at once; the sidebar follows on its next poll.
        setRejections((prev) => (prev || []).map((r) => (r.key === k ? { ...r, seen: true } : r)));
        fetch(apiUrl('/api/escalation/rejections/seen'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [k] }),
        }).catch(() => {});
      }}
      sentiment={sentiment}
      sentimentError={sentimentError}
      emailed={emailed}
      onEmailed={() => loadEscalations()}
      onSeenSentiment={(k) => {
        setSentiment((prev) => (prev || []).map((s) => (s.key === k ? { ...s, seen: true } : s)));
        fetch(apiUrl('/api/escalation/sentiment/seen'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [k] }),
        }).catch(() => {});
      }}
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
      // A posted reply may have kept a promise, set a new one or started a watch.
      onPosted={() => { loadWatched(); loadEscalations(); }}
    />
  );
}
