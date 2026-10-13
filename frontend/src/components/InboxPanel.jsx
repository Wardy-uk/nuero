import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import EmailCard, { timeAgo } from './EmailCard';
import './InboxPanel.css';

export default function InboxPanel({ focusContext }) {
  const fromFocus = focusContext?.fromFocus;
  const [showAllAction, setShowAllAction] = useState(!fromFocus);
  const [showDelegate, setShowDelegate] = useState(!fromFocus);
  const [triage, setTriage] = useState(null);
  const [running, setRunning] = useState(false);
  const [dismissing, setDismissing] = useState(null);
  const [dismissNote, setDismissNote] = useState('');
  const [fyiOpen, setFyiOpen] = useState(false);
  // #69 — a sent reply dismisses the email, so it leaves this list entirely and
  // the only record used to be Outlook's Sent Items. There is no "dismissed"
  // view to hang a "Replied" badge on, so replies get their own section.
  const [replies, setReplies] = useState(null);
  const [repliesOpen, setRepliesOpen] = useState(false);
  // 4 Sep 2026 - "Not relevant" now mutes the SENDER on the first press, and a
  // rule the panel cannot show is a rule Nick cannot revoke. A one-click mute
  // with no way back is the only genuinely dangerous shape this could take.
  const [muted, setMuted] = useState(null);
  const [mutedOpen, setMutedOpen] = useState(false);
  // 7 Sep 2026 — "Clear all" on the FYI section. Two-step: the confirm quotes
  // the count the SERVER just measured, not the one this component happens to
  // be rendering, so what Nick agrees to is what goes.
  const [clearingFyi, setClearingFyi] = useState(false);
  const [confirmClearFyi, setConfirmClearFyi] = useState(null);

  const fetchTriage = () => {
    fetch(apiUrl('/api/email/triage'))
      .then(r => r.json())
      .then(data => setTriage(data))
      .catch(() => {});
  };

  const fetchReplies = () => {
    fetch(apiUrl('/api/email/replies?limit=20'))
      .then(r => r.json())
      .then(data => setReplies(data))
      .catch(() => {});
  };

  const fetchMuted = () => {
    fetch(apiUrl('/api/email/triage/muted'))
      .then(r => r.json())
      // null stays null on a failure: "I could not read the rules" and "there
      // are none" are different facts and only one of them is reassuring.
      .then(data => setMuted(data?.ok ? { senders: data.senders || [], subjects: data.subjects || [] } : null))
      .catch(() => setMuted(null));
  };

  const unmute = (address) => {
    fetch(apiUrl(`/api/email/triage/muted/${encodeURIComponent(address)}`), { method: 'DELETE' })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) setDismissNote(d?.error ? `Could not un-mute: ${d.error}` : 'Could not un-mute.');
        else setDismissNote(`${address} will show up again from now on. Mail already filed stays filed.`);
        fetchMuted();
      })
      .catch(() => setDismissNote('Could not un-mute.'));
  };

  const unmuteSubject = (m) => {
    fetch(apiUrl('/api/email/triage/muted-subjects/unmute'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: m.key }),
    })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) setDismissNote(d?.error ? `Could not un-mute: ${d.error}` : 'Could not un-mute.');
        else setDismissNote(`"${m.subject}" from ${m.address} will show up again from now on. Mail already filed stays filed.`);
        fetchMuted();
      })
      .catch(() => setDismissNote('Could not un-mute.'));
  };

  const askClearFyi = () => {
    setDismissNote('');
    setClearingFyi(true);
    fetch(apiUrl('/api/email/triage/clear-fyi'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    })
      .then(r => r.json())
      .then(d => {
        setClearingFyi(false);
        // Nothing to clear is a real answer, not a confirmation with a zero in
        // it — asking "clear 0 emails?" reads as the button being broken.
        if (!d?.ok) setDismissNote('Could not work out what would be cleared.');
        else if (!d.cleared) setDismissNote('Nothing in the FYI section to clear.');
        else setConfirmClearFyi(d.cleared);
      })
      .catch(() => { setClearingFyi(false); setDismissNote('Could not work out what would be cleared.'); });
  };

  const clearFyi = () => {
    setClearingFyi(true);
    fetch(apiUrl('/api/email/triage/clear-fyi'), { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        setConfirmClearFyi(null);
        setClearingFyi(false);
        setDismissNote(d?.ok
          ? `Cleared ${d.cleared} from the FYI section. Nothing owed was touched.`
          : 'Could not clear the section.');
        fetchTriage();
      })
      .catch(() => {
        setConfirmClearFyi(null);
        setClearingFyi(false);
        setDismissNote('Could not clear the section.');
      });
  };

  useEffect(() => { fetchTriage(); fetchReplies(); fetchMuted(); }, []);

  const runTriage = () => {
    setRunning(true);
    fetch(apiUrl('/api/email/triage/run'), { method: 'POST' })
      .then(r => r.json())
      .then(() => { fetchTriage(); setRunning(false); })
      .catch(() => setRunning(false));
  };

  // #70 — `reason` is what makes Done and Not relevant different buttons rather
  // than two labels on the same one. "Not relevant" is a misclassification
  // report and it is the only free feedback this classifier will ever get.
  const dismiss = (emailId, { markRead = false, reason = 'done', mute = null } = {}) => {
    setDismissing(emailId);
    setDismissNote('');
    fetch(apiUrl(`/api/email/triage/dismiss/${encodeURIComponent(emailId)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markRead, reason, mute }),
    })
      .then(r => r.json())
      .then(d => {
        // The dismiss still happened — this only reports the Outlook half failing.
        if (d?.readError) setDismissNote(d.readError);
        // A mute is a bigger statement than a dismissal, so it is said out loud
        // — and a REFUSED one especially, since a silent refusal is
        // indistinguishable from a mute that worked until the next edition
        // turns up, which is the bug this whole change exists to fix.
        else if (d?.muted && d.muted.ok && d.muted.kind === 'subject') {
          setDismissNote(`Muted "${d.muted.subject}" from ${d.muted.address}. Their other mail still comes through.`);
        } else if (d?.muted && d.muted.ok) {
          setDismissNote(d.muted.alreadyMuted
            ? `${d.muted.muted} was already muted — nothing from them will reach the panel.`
            : `Muted ${d.muted.muted}. Future mail from this sender is filed automatically.`);
        } else if (d?.muted && !d.muted.ok) {
          setDismissNote(`Dismissed, but nothing was muted — ${d.muted.reason}.`);
        }
        fetchTriage();
        fetchMuted();
        setDismissing(null);
      })
      .catch(() => setDismissing(null));
  };

  // The mirror of "Not relevant". Deliberately NOT a dismissal — the email
  // moves up into ACTION and stays on screen, because the complaint being
  // answered is "this should be in front of me", not "take it away".
  const promote = (emailId) => {
    setDismissing(emailId);
    setDismissNote('');
    fetch(apiUrl(`/api/email/triage/promote/${encodeURIComponent(emailId)}`), { method: 'POST' })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        // A promotion that moved nothing must say so rather than leaving the
        // card sitting where it was with no explanation.
        if (!ok) setDismissNote(d?.error ? `Could not move it: ${d.error}` : 'Could not move it.');
        fetchTriage();
        setDismissing(null);
      })
      .catch(() => { setDismissNote('Could not move it.'); setDismissing(null); });
  };

  // The backend dismisses on send, so a reply just needs a refresh — and the
  // reply now leaves a record, so refresh that too or the section it just
  // joined would stay a send behind.
  const handleReplied = () => { fetchTriage(); fetchReplies(); };

  const action = triage?.action || [];
  const delegate = triage?.delegate || [];
  const fyi = triage?.fyi || [];
  const ignore = triage?.ignore || [];
  const fyiTotal = fyi.length + ignore.length;

  return (
    <div className="inbox-container">
      {fromFocus && action.length > 0 && (
        <div className="todo-focus-summary" style={{ marginBottom: 16 }}>
          <span className="todo-focus-summary-text">
            {action.length} email{action.length !== 1 ? 's' : ''} need action — start here
          </span>
          {(delegate.length + fyiTotal) > 0 && (
            <span className="todo-focus-summary-stale">
              {delegate.length + fyiTotal} lower-priority below
            </span>
          )}
        </div>
      )}
      <div className="inbox-header">
        <h2 className="inbox-title">{fromFocus ? 'Urgent Emails — Start Here' : 'Inbox Triage'}</h2>
        <div className="inbox-actions">
          {triage?.lastRun && (
            <span className="inbox-last-scan">
              Last triage: {timeAgo(triage.lastRun)}
            </span>
          )}
          <button
            className="inbox-scan-btn"
            onClick={runTriage}
            disabled={running}
          >
            {running ? 'Running...' : 'Run Triage'}
          </button>
        </div>
      </div>

      {/* Only rendered when there is something to say. An always-on panel of
          rules is one nobody reads by week two; a hidden one is a rule Nick
          cannot take back. null means the read FAILED, which is said plainly
          rather than rendered as "no rules". */}
      {muted === null && (
        <div className="inbox-dismiss-note">
          <span>Couldn't read your muted senders and subjects — this isn't confirmation there are none.</span>
        </div>
      )}
      {muted && (muted.senders.length + muted.subjects.length) > 0 && (
        <div className="inbox-muted">
          <button className="inbox-muted-toggle" onClick={() => setMutedOpen(o => !o)}>
            {mutedOpen ? '▾' : '▸'} {muted.subjects.length} muted subject{muted.subjects.length === 1 ? '' : 's'} · {muted.senders.length} muted sender{muted.senders.length === 1 ? '' : 's'}
          </button>
          {mutedOpen && (
            <ul className="inbox-muted-list">
              {muted.subjects.map(m => (
                <li key={m.key}>
                  <span className="inbox-muted-addr">"{m.subject}"</span>
                  <span className="inbox-muted-sample">from {m.name ? `${m.name} <${m.address}>` : m.address}</span>
                  <button className="inbox-muted-undo" onClick={() => unmuteSubject(m)}>Un-mute</button>
                </li>
              ))}
              {muted.senders.map(m => (
                <li key={m.address}>
                  <span className="inbox-muted-addr">Everything from {m.name ? `${m.name} <${m.address}>` : m.address}</span>
                  {m.sampleSubject && (
                    <span className="inbox-muted-sample">muted on "{m.sampleSubject}"</span>
                  )}
                  <button className="inbox-muted-undo" onClick={() => unmute(m.address)}>Un-mute</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dismissNote && (
        <div className="inbox-dismiss-note">
          <span>{dismissNote}</span>
          <button className="inbox-dismiss-note-x" onClick={() => setDismissNote('')}>×</button>
        </div>
      )}

      {!triage && <div className="inbox-empty">Loading...</div>}

      {triage && action.length === 0 && delegate.length === 0 && fyiTotal === 0 && (
        <div className="inbox-empty">
          {triage.lastRun
            ? 'Inbox clear — nothing needs your attention.'
            : 'No triage yet. Click Run Triage to classify your inbox.'}
        </div>
      )}

      {action.length > 0 && (
        <div className="inbox-section">
          <div className="inbox-section-label inbox-section-action">ACTION ({action.length})</div>
          {(showAllAction ? action : action.slice(0, 5)).map(e => (
            <EmailCard key={e.id} email={e} borderClass="urgency-high" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} onPromote={promote} />
          ))}
          {!showAllAction && action.length > 5 && (
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setShowAllAction(true)}>
              +{action.length - 5} more action emails
            </button>
          )}
        </div>
      )}

      {delegate.length > 0 && (
        <div className="inbox-section">
          {fromFocus && !showDelegate ? (
            <button className="inbox-section-toggle" onClick={() => setShowDelegate(true)}>
              ▸ DELEGATE ({delegate.length})
            </button>
          ) : (
            <>
              <div className="inbox-section-label inbox-section-delegate">DELEGATE ({delegate.length})</div>
              {delegate.map(e => (
                <EmailCard key={e.id} email={e} borderClass="urgency-medium" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} onPromote={promote} />
              ))}
            </>
          )}
        </div>
      )}

      {fyiTotal > 0 && (
        <div className="inbox-section">
          <button
            className="inbox-section-toggle"
            onClick={() => setFyiOpen(o => !o)}
          >
            {fyiOpen ? '▾' : '▸'} FYI ({fyiTotal})
          </button>
          {confirmClearFyi == null ? (
            <button
              className="inbox-section-clear"
              onClick={askClearFyi}
              disabled={clearingFyi}
            >
              {clearingFyi ? 'Checking…' : 'Clear all'}
            </button>
          ) : (
            <span className="inbox-section-confirm">
              Clear {confirmClearFyi}? Nothing in Action, Delegate or promoted is touched.
              <button className="inbox-section-clear danger" onClick={clearFyi} disabled={clearingFyi}>
                {clearingFyi ? 'Clearing…' : 'Yes, clear'}
              </button>
              <button className="inbox-section-clear" onClick={() => setConfirmClearFyi(null)}>
                Cancel
              </button>
            </span>
          )}
          {/* Mail that vanishes with no stated cause reads as a bug. Say the
              rule, and take the number from the server so the two cannot
              disagree. */}
          {fyiOpen && triage?.fyiAgeOutDays > 0 && (
            <p className="inbox-section-note">
              Cleared automatically after {triage.fyiAgeOutDays} days — nothing here is waiting on you.
            </p>
          )}
          {fyiOpen && [...fyi, ...ignore].map(e => (
            <EmailCard key={e.id} email={e} borderClass="urgency-low" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} onPromote={promote} />
          ))}
        </div>
      )}

      {replies?.total > 0 && (
        <div className="inbox-section">
          <button className="inbox-section-toggle" onClick={() => setRepliesOpen(o => !o)}>
            {repliesOpen ? '▾' : '▸'} REPLIED ({replies.total})
          </button>
          {repliesOpen && replies.replies.map(r => (
            <div className="inbox-reply" key={r.id}>
              <div className="inbox-reply-head">
                <span className="inbox-reply-subject">{r.subject || '(no subject)'}</span>
                <span className="inbox-reply-when">{timeAgo(r.sentAt)}</span>
              </div>
              <div className="inbox-reply-to">
                {r.recipients.length
                  ? `To ${r.recipients.map(p => p.name || p.email).join(', ')}`
                  : 'Recipients not recorded'}
                {/* NEURO only knows the addressees for certain when the composer
                    passed them; on a plain reply Graph chooses. Saying which is
                    the difference between a record and a guess (#65). */}
                {r.recipientsSource === 'inferred' && (
                  <span className="inbox-reply-hint"> · from the thread, not confirmed</span>
                )}
              </div>
              <div className="inbox-reply-body">{r.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
