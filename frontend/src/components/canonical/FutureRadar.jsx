import React, { useState } from 'react';
import { useCanonical, postCanonical, DOMAIN_LABELS, DOMAIN_IDS, DoneTick, HowItWorks } from './canonicalUi';

/**
 * Build 19 — personal operations on the Life page.
 *
 *  • FutureRadarCard: what is coming up over 7 / 14 / 30 days, needs-you
 *    first, each item with "why is this here?". Goals are linked here
 *    EXPLICITLY (a link gives context, never urgency), and a task can be marked
 *    as PREPARATION for a date or calendar entry. Nothing is created or sent.
 *  • PersonalAdminCard: obligations whose explicit domain is admin, finance or
 *    transport, plus which sources hold any at all.
 *  • ReminderListsCard: every Apple Reminders list by stable id — name, app,
 *    what it is for, whether it is read and why, counts from the last push.
 *
 * Every word is the server's; this renders and never ranks.
 */

const ACTION_WORDS = {
  needs_you: 'Needs you', preparation_open: 'Preparation open', planned: 'Planned', none: 'Nothing needed', unknown: 'Can’t tell',
};
const KIND_WORDS = {
  birthday: 'Birthday', anniversary: 'Anniversary', 'personal-date': 'Date', event: 'Calendar', hike: 'Hike',
  obligation: 'To do', admin: 'Admin', 'goal-review': 'Goal review', care: 'Care',
};

export function FutureRadarCard() {
  const [days, setDays] = useState(14);
  const { data, error, loading, reload } = useCanonical(`/api/canonical/radar?days=${days}`);
  const goals = useCanonical('/api/canonical/goals');
  const tasks = useCanonical('/api/canonical/tasks?status=open');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const act = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  const active = goals.data ? (goals.data.goals || []).filter((g) => g.status === 'active') : [];
  const openTasks = tasks.data ? tasks.data.items || [] : [];

  return (
    <section className="cn-section">
      <div className="cn-head">
        <h3 className="cn-h3">{data ? data.heading : 'Future Radar'}</h3>
        <span className="cn-tabs" role="tablist" aria-label="How far ahead">
          {[7, 14, 30].map((d) => (
            <button key={d} type="button" role="tab" aria-selected={days === d} className={`cn-tab${days === d ? ' cn-tab--on' : ''}`} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </span>
      </div>
      {loading && !data && <div className="cn-muted">Reading…</div>}
      {error && <div className="cn-error">Couldn’t read the Radar — {error}</div>}
      {note && <div className="cn-error">{note}</div>}
      {data && (
        <>
          <div className="cn-radar-summary">
            <strong>{data.summary.title}:</strong>
            <span className="cn-radar-inline">{data.summary.lines.join(' · ')}</span>
            {data.coverage && !data.coverage.complete && (
              <div className="cn-muted cn-small" title={data.coverage.reasons.join('; ')}>Not the whole picture — {data.coverage.reasons.length} gap{data.coverage.reasons.length === 1 ? '' : 's'} (hover for why).</div>
            )}
          </div>
          {!data.items.length && <div className="cn-empty">Nothing known coming up in the next {days} days. That is what NEURO has been told — not a promise that nothing is happening.</div>}
          <ul className="cn-list">
            {data.items.map((i) => <RadarItem key={i.id} item={i} goals={active} tasks={openTasks} busy={busy} act={act}
              onDone={(n) => act(async () => { await postCanonical(`/api/tasks/${n}/complete`, {}); await tasks.reload(); })} />)}
          </ul>
          {data.goals && data.goals.length > 0 && (
            <div className="cn-radar-goals">
              {data.goals.map((g) => (
                <div key={g.goalId} className="cn-muted"><strong>{g.title}</strong> — {g.progress.why}{g.progress.period ? ` (${g.progress.period})` : ''}</div>
              ))}
            </div>
          )}
          <HowItWorks>{data.rule}</HowItWorks>
        </>
      )}
    </section>
  );
}

function RadarItem({ item, goals, tasks, busy, act, onDone }) {
  const [open, setOpen] = useState(false);
  const [goalId, setGoalId] = useState('');
  const [prepId, setPrepId] = useState('');
  const linkable = /^(task:|commitment:|pd:|radar:event:|radar:hike:)/.test(item.id);
  const entityId = item.id.startsWith('radar:event:') ? `meeting:${item.id.slice('radar:event:'.length)}`
    : item.id.startsWith('radar:hike:') ? `meeting:${item.sourceRefs[0]}` : item.id;
  const prepSubject = item.id.startsWith('pd:') ? item.id : item.id.startsWith('radar:event:') ? entityId : null;
  const explicitGoals = (item.linkedGoals || []).filter((g) => g.basis === 'explicit');

  return (
    <li className={`cn-row cn-radar cn-radar--${item.actionState}`}>
      <div className="cn-radar-line">
      <DoneTick id={item.id} busy={busy} onDone={onDone} />
      <button type="button" className="cn-rowbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cn-radar-when">{item.when}{item.time ? ` · ${item.time}` : ''}</span>
        <span className="cn-rowtitle">{item.title}</span>
        <span className="cn-chip cn-chip--soft">{KIND_WORDS[item.kind] || item.kind}</span>
        {item.actionState !== 'none' && <span className={`cn-chip ${item.actionState === 'needs_you' ? 'cn-chip--firm' : 'cn-chip--soft'}`}>{ACTION_WORDS[item.actionState]}</span>}
        {item.domains.length === 0 && item.kind === 'event' && <span className="cn-chip cn-chip--unknown">domain unknown</span>}
        {item.domains.filter((d) => !(d === 'admin' && item.kind === 'admin') && (DOMAIN_LABELS[d] || d) !== KIND_WORDS[item.kind]).map((d) => <span key={d} className="cn-chip">{DOMAIN_LABELS[d] || d}</span>)}
        {item.companion && item.kind !== 'care' && <span className="cn-chip cn-chip--soft" title="You linked this to her care">↳ {item.companion.name}</span>}
        {item.linkedGoals.map((g) => <span key={g.goalId} className="cn-chip cn-chip--soft" title={g.basis === 'explicit' ? 'You linked this' : 'The hiking loop counts it (its rule)'}>↳ {g.title}</span>)}
      </button>
      </div>
      {open && (
        <div className="cn-detail">
          <div className="cn-k">Why is this here?</div>
          <ul className="cn-act-lines">{item.whyVisible.map((w) => <li key={w}>{w}</li>)}</ul>
          <div className="cn-muted">Confidence: {item.confidence}. {item.attention.eligible ? 'May be raised by the attention policy.' : 'Shown here only — it will not interrupt.'}</div>
          {linkable && goals.length > 0 && (
            <div className="cn-hike-form">
              <select value={goalId} onChange={(e) => setGoalId(e.target.value)} aria-label="Link to a goal" disabled={busy}>
                <option value="">link to a goal…</option>
                {goals.filter((g) => !explicitGoals.some((x) => x.goalId === g.id)).map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
              <button type="button" className="cn-btn" disabled={busy || !goalId}
                onClick={() => act(async () => { await postCanonical(`/api/canonical/goals/${encodeURIComponent(goalId)}/links`, { entityId, label: item.title }); setGoalId(''); })}>Link</button>
              {explicitGoals.map((g) => (
                <button key={g.goalId} type="button" className="cn-btn cn-btn--tiny" disabled={busy}
                  onClick={() => act(() => postCanonical(`/api/canonical/goals/${encodeURIComponent(g.goalId)}/links/remove`, { entityId, label: item.title }))}>Unlink {g.title}</button>
              ))}
            </div>
          )}
          {prepSubject && (
            <div className="cn-hike-form">
              <select value={prepId} onChange={(e) => setPrepId(e.target.value)} aria-label="Mark a task as preparation" disabled={busy}>
                <option value="">mark a task as preparation…</option>
                {tasks.filter((t) => !item.linkedTaskRefs.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
              </select>
              <button type="button" className="cn-btn" disabled={busy || !prepId}
                onClick={() => act(async () => { await postCanonical('/api/canonical/prep-links', { subjectId: prepSubject, entityId: prepId, label: (tasks.find((t) => t.id === prepId) || {}).description }); setPrepId(''); })}>Mark</button>
              {item.linkedTaskRefs.map((id) => (
                <button key={id} type="button" className="cn-btn cn-btn--tiny" disabled={busy}
                  onClick={() => act(() => postCanonical('/api/canonical/prep-links/remove', { subjectId: prepSubject, entityId: id }))}>Remove prep link</button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function PersonalAdminCard() {
  const { data, error, reload } = useCanonical('/api/canonical/personal-admin');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  if (error && !data) return <section className="cn-section"><h3 className="cn-h3">Personal admin</h3><div className="cn-error">Couldn’t read it — {error}</div></section>;
  if (!data) return null;
  const act = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  const done = (n) => act(() => postCanonical(`/api/tasks/${n}/complete`, {}));
  const activation = data.audit && data.audit.activation;
  const candidates = (activation && activation.candidates) || [];
  // One press answers the question the setup steps were asking: this list IS
  // admin, and NEURO should read it. Both are Nick's — the button says so.
  const useList = (c) => act(() => postCanonical('/api/canonical/classifications', { kind: 'reminder-list', sourceKey: c.sourceKey, label: c.name, tracked: true, ...(activation.state === 'classified-not-tracked' ? {} : { domains: ['admin'] }) }));
  return (
    <section className="cn-section">
      <h3 className="cn-h3">Personal admin</h3>
      {note && <div className="cn-error">{note}</div>}
      {activation && activation.state !== 'active' && (
        candidates.length > 0 ? (
          <div className="cn-callout">
            <div>{activation.state === 'classified-not-tracked' ? 'Set as admin, but NEURO isn’t reading it yet:' : 'Arrived from the phone — is this your admin list?'}</div>
            <div className="cn-hike-form">
              {candidates.map((c) => (
                <button key={c.sourceKey} type="button" className="cn-btn" disabled={busy} onClick={() => useList(c)}>
                  Read “{c.name}”{c.disambiguator ? ` (${c.disambiguator})` : ''} as admin
                </button>
              ))}
            </div>
          </div>
        ) : (
          <details className="cn-details cn-callout" open>
            <summary><strong>Not set up yet</strong> — {activation.why}</summary>
            {activation.steps.length > 0 && <ol className="cn-act-lines">{activation.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
          </details>
        )
      )}
      {activation && activation.state === 'active' && <p className="cn-muted cn-small">Reading {activation.lists.map((l) => `“${l}”`).join(', ')}.</p>}
      {!data.items.length && <div className="cn-empty">Nothing here yet.</div>}
      <ul className="cn-list">
        {data.items.map((o) => (
          <li key={o.id} className="cn-row cn-arow" style={{ padding: '10px 12px' }}>
            <DoneTick id={o.id} busy={busy} onDone={done} />
            <div className="cn-arow-body">
              <div className="cn-arow-top">
                <span className="cn-rowtitle">{o.what}</span>
                {o.needsNow && <span className="cn-chip cn-chip--firm">Needs you</span>}
              </div>
              <div className="cn-muted cn-small">
                {o.due ? o.due.label.split(' · ')[0] : 'no date'}
                {o.source && o.source !== 'NEURO' ? ` · ${o.source}` : ''}
                {(o.vehicles || []).map((v) => (
                  <span key={v.id}> · ↳ {v.name}
                    <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} aria-label={`Unlink from ${v.name}`}
                      onClick={() => act(() => postCanonical('/api/canonical/vehicle-links/remove', { vehicle: v.id, entityId: o.id, label: o.what }))}>×</button>
                  </span>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <HowItWorks>
        Admin appears here only from a reminder list or task you have classified as personal admin, finance or transport, or linked to a vehicle (on the Vehicle card) — nothing is guessed from wording, and no renewal date is made up. A NEURO task is ticked here; a reminder is ticked in Apple Reminders.
        <ul className="cn-act-lines">
          {data.audit.sources.map((s) => (
            <li key={s.source}>{s.source}: {s.items === null ? s.why : `${s.items ?? s.upcomingEvents ?? 0}${s.containers && s.containers.length ? ` (${s.containers.join(', ')})` : ''}`}</li>
          ))}
        </ul>
      </HowItWorks>
    </section>
  );
}


/**
 * Build 20C — one row per Apple Reminders list, keyed by its STABLE id. Two
 * separate choices per list, both Nick's: what it is FOR (classification) and
 * whether NEURO READS it (tracked / ignored / not decided). A list is read only
 * once he says Track; its name never decides. Two lists that share a name get
 * a stable "List 1 of 2" so a choice on one cannot land on the other.
 */
export function ReminderListsCard() {
  const { data, error, reload } = useCanonical('/api/canonical/reminder-lists');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  if (error && !data) return <section className="cn-section"><h3 className="cn-h3">Reminder lists</h3><div className="cn-error">Couldn’t read them — {error}</div></section>;
  if (!data) return null;
  const s = data.summary;
  const save = async (l, body) => {
    setBusy(true); setNote(null);
    try { await postCanonical('/api/canonical/classifications', { kind: 'reminder-list', sourceKey: l.sourceKey, label: l.name, ...body }); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  return (
    <section className="cn-section">
      <h3 className="cn-h3">Reminder lists</h3>
      <p className="cn-muted">{s.lists} lists · {s.tracked} tracked · {s.ignored} ignored · {s.trackingUndecided} not decided · {s.open === null ? 'counts not measured yet' : `${s.open} open, ${s.completed30d} done in 30 days`}</p>
      {note && <div className="cn-error">{note}</div>}
      <ul className="cn-list cn-class-list">
        {data.lists.map((l) => (
          <li key={l.sourceKey} className={`cn-row cn-class${l.trackingState === 'unknown' ? ' cn-class--undecided' : ''}`}>
            <div className="cn-class-name">
              <span className="cn-rowtitle">{l.name}</span>
              {l.disambiguator && <span className="cn-muted" title={`Apple list id …${String(l.listId).slice(-4)}`}> · {l.disambiguator}</span>}
              <div className="cn-muted cn-class-note">
                {l.openCount === null ? 'counts not measured yet' : `${l.openCount} open · ${l.completedCount30d} done in 30 days`}
                {l.lastSeenAt ? ` · last seen ${String(l.lastSeenAt).slice(0, 10)}` : ''}
                {l.sourceApps.length ? ` · from ${l.sourceApps.join(', ')}` : ''}
              </div>
              <div className="cn-muted cn-class-note">{l.trackedWhy}</div>
            </div>
            <div className="cn-class-controls">
              <span className="cn-tabs" role="radiogroup" aria-label={`Does NEURO read ${l.name}${l.disambiguator ? ` (${l.disambiguator})` : ''}?`}>
                {[['tracked', true, 'Track'], ['ignored', false, 'Ignore'], ['unknown', null, 'Undecided']].map(([state, value, word]) => (
                  <button key={state} type="button" role="radio" aria-checked={l.trackingState === state} disabled={busy || l.keyedBy !== 'id'}
                    className={`cn-tab${l.trackingState === state ? ' cn-tab--on' : ''}`} onClick={() => save(l, { tracked: value })}>{word}</button>
                ))}
              </span>
              <select className="cn-select" value={(l.classification.domains[0] || {}).domain || ''} disabled={busy} aria-label={`What ${l.name} is for`}
                onChange={(e) => save(l, { domains: e.target.value ? [e.target.value] : null })}>
                <option value="">Not classified</option>
                {DOMAIN_IDS.map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
              </select>
            </div>
          </li>
        ))}
      </ul>
      {data.legacy.length > 0 && <div className="cn-small cn-muted">{data.legacy.length} older by-name record{data.legacy.length === 1 ? '' : 's'} from app builds before list ids — superseded, not separate lists.</div>}
      <div className="cn-small cn-muted">{data.rule}</div>
    </section>
  );
}

