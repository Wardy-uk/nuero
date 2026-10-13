import React, { useState } from 'react';
import { useCanonical, postCanonical, DOMAIN_LABELS, DOMAIN_IDS, DoneTick, HowItWorks, Headline, StatTiles, Stat, Group, PrimaryAction, dayLabel, TileGrid, Tile } from './canonicalUi';

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
  const onDone = (n) => act(async () => { await postCanonical(`/api/tasks/${n}/complete`, {}); await tasks.reload(); });

  // The server orders the items (needs-you first); the card only SPLITS that
  // order into two groups — it never re-ranks.
  const items = data ? data.items : [];
  const needs = items.filter((i) => i.actionState === 'needs_you');
  const rest = items.filter((i) => i.actionState !== 'needs_you');
  const sm = data ? data.summary : null;
  const gaps = data && data.coverage && !data.coverage.complete ? data.coverage.reasons : [];
  const gapLine = gaps.length > 0
    ? <span title={gaps.join('; ')}>Not the whole picture — {gaps.length} gap{gaps.length === 1 ? '' : 's'} (hover for why).</span>
    : null;
  const head = !data
    ? { tone: error ? 'warn' : 'neutral', pill: error ? 'Can’t read' : 'Reading', text: error ? 'Couldn’t read the Radar.' : 'Reading what is coming up…' }
    : sm.needsYou > 0
      ? { tone: 'warn', pill: 'Needs you', text: `${sm.needsYou} thing${sm.needsYou === 1 ? ' needs' : 's need'} you in the next ${days} days.` }
      : items.length
        ? { tone: 'plan', pill: 'Coming up', text: `${items.length} known item${items.length === 1 ? '' : 's'} in the next ${days} days — nothing needs you.` }
        : { tone: 'neutral', pill: 'All quiet', text: `Nothing known coming up in the next ${days} days.` };
  const detail = data && !items.length
    ? <>That is what NEURO has been told — not a promise that nothing is happening.{gapLine ? <> {gapLine}</> : null}</>
    : gapLine;
  const extra = sm ? [['care', 'companion care'], ['vehicle', 'vehicle'], ['finance', 'finance'], ['projects', 'projects']].filter(([k]) => sm[k]) : [];
  const row = (i) => <RadarItem key={i.id} item={i} goals={active} tasks={openTasks} busy={busy} act={act} onDone={onDone} />;

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
      <Headline tone={head.tone} pill={head.pill} detail={detail}>{head.text}</Headline>
      {error && <div className="cn-error">Couldn’t read the Radar — {error}</div>}
      {note && <div className="cn-error">{note}</div>}
      {data && (
        <>
          <StatTiles>
            <Stat v={sm.needsYou} l="need you" tone={sm.needsYou ? 'warn' : undefined} />
            <Stat v={sm.personalDates} l="personal dates" />
            <Stat v={sm.obligations} l="to do" />
            <Stat v={sm.plannedHikes} l="planned hikes" />
            <Stat v={sm.events} l="calendar" title={sm.lines.find((x) => /calendar entr/.test(x))} />
            {extra.map(([k, l]) => <Stat key={k} v={sm[k]} l={l} />)}
          </StatTiles>
          {needs.length > 0 && (
            <Group label="Needs you">
              <ul className="cn-list">{needs.map(row)}</ul>
            </Group>
          )}
          {rest.length > 0 && (
            <Group label={needs.length ? 'Also coming up' : 'Coming up'} why="Open an item for why it is here, to link it to a goal, or to mark a task as its preparation.">
              <ul className="cn-list">{rest.map(row)}</ul>
            </Group>
          )}
          {data.goals && data.goals.length > 0 && (
            <Group label="Goals">
              <TileGrid>
                {data.goals.map((g) => <Tile key={g.goalId} title={g.title} sub={g.progress.why} foot={g.progress.period || null} />)}
              </TileGrid>
            </Group>
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
  const domains = item.domains.filter((d) => !(d === 'admin' && item.kind === 'admin') && (DOMAIN_LABELS[d] || d) !== KIND_WORDS[item.kind]);

  // The row is one fact — when, what, its state (or kind) and what it is
  // linked to. Why it is here and which part of life it belongs to are on
  // hover and under the opened item, said once.
  return (
    <li className={`cn-row cn-radar cn-radar--${item.actionState}`}>
      <div className="cn-radar-line">
      <DoneTick id={item.id} busy={busy} onDone={onDone} />
      <button type="button" className="cn-rowbtn" onClick={() => setOpen(!open)} aria-expanded={open} title={item.whyVisible.join(' ')}>
        <span className="cn-radar-when">{item.when}{item.time ? ` · ${item.time}` : ''}</span>
        <span className="cn-rowtitle">{item.title}</span>
        {item.actionState !== 'none'
          ? <span className={`cn-chip ${item.actionState === 'needs_you' ? 'cn-chip--firm' : 'cn-chip--soft'}`}>{ACTION_WORDS[item.actionState]}</span>
          : <span className="cn-chip cn-chip--soft">{KIND_WORDS[item.kind] || item.kind}</span>}
        {item.domains.length === 0 && item.kind === 'event' && <span className="cn-chip cn-chip--unknown">domain unknown</span>}
        {item.companion && item.kind !== 'care' && <span className="cn-chip cn-chip--soft" title="You linked this to her care">↳ {item.companion.name}</span>}
        {item.linkedGoals.map((g) => <span key={g.goalId} className="cn-chip cn-chip--soft" title={g.basis === 'explicit' ? 'You linked this' : 'The hiking loop counts it (its rule)'}>↳ {g.title}</span>)}
      </button>
      </div>
      {open && (
        <div className="cn-detail">
          {(item.actionState !== 'none' || domains.length > 0) && (
            <div className="cn-tile-foot">
              {item.actionState !== 'none' && <span className="cn-chip cn-chip--soft">{KIND_WORDS[item.kind] || item.kind}</span>}
              {domains.map((d) => <span key={d} className="cn-chip">{DOMAIN_LABELS[d] || d}</span>)}
            </div>
          )}
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

/**
 * Build 25 — Personal admin as a working view. The server decides every
 * state and every word (personal-admin.js); this groups by its `state` and
 * renders. Sections: Needs you · Coming up · Open, no date · Waiting & blocked
 * · Routine · Recently done. Nick's own word (waiting / blocked / routine /
 * lead time / kind) is the only thing written from here.
 */
const ADMIN_SECTIONS = [
  { key: 'needs', title: 'Needs you', states: ['needs_you'] },
  { key: 'coming', title: 'Coming up', states: ['upcoming'] },
  { key: 'open', title: 'Open, no rush', states: ['open', 'unknown'] },
  { key: 'waiting', title: 'Waiting or blocked', states: ['waiting', 'blocked'] },
  { key: 'routine', title: 'Routine', states: ['routine'], fold: true },
  { key: 'done', title: 'Recently done', states: ['done'], fold: true },
];
const ADMIN_KIND_WORDS = {
  vehicle: 'Vehicle', insurance: 'Insurance', tax: 'Tax', subscription: 'Subscription', account: 'Account', booking: 'Booking',
  appointment: 'Appointment', form: 'Form', renewal: 'Renewal', household: 'Household', pet: 'Pet', finance: 'Finance', project: 'Project', other: 'Other',
};

export function adminSectionsOf(view) {
  const items = (view && view.items) || [];
  return ADMIN_SECTIONS.map((s) => ({ ...s, items: items.filter((i) => s.states.includes(i.state)) }));
}

export function AdminRow({ item, busy, act, onDone }) {
  const [edit, setEdit] = useState(false);
  const [note, setNote] = useState('');
  const [lead, setLead] = useState(item.annotation && item.annotation.leadDays ? String(item.annotation.leadDays) : '');
  const save = (body) => act(() => postCanonical('/api/canonical/personal-admin/annotations', { entityId: item.obligationId, ...body }));
  const ann = item.annotation || {};
  return (
    <li className="cn-row cn-arow" style={{ padding: '10px 12px' }}>
      {item.canTick ? <DoneTick id={item.obligationId} busy={busy} onDone={onDone} /> : item.state !== 'done' && /^task:eventkit-reminders:/.test(item.obligationId) ? <DoneTick id={item.obligationId} /> : null}
      <div className="cn-arow-body">
        <div className="cn-arow-top">
          <span className="cn-rowtitle">{item.title}</span>
          {item.state === 'needs_you' && <span className="cn-chip cn-chip--firm">Needs you</span>}
          {item.state === 'blocked' && <span className="cn-chip cn-chip--firm">Blocked</span>}
          {item.state === 'waiting' && <span className="cn-chip">Waiting</span>}
          <span className="cn-chip" title={`Kind: ${item.kindBasis}`}>{ADMIN_KIND_WORDS[item.kind] || item.kind}</span>
        </div>
        <div className="cn-muted cn-small">
          {item.when}{item.dueMileage != null ? ` · or at ${item.dueMileage} mi` : ''}
          {(item.entityLinks || []).map((l) => <span key={`${l.type}:${l.id}`}> · ↳ {l.name}</span>)}
        </div>
        <details className="cn-details">
          <summary className="cn-small">Why is this here?</summary>
          <ul className="cn-act-lines cn-small">
            <li>From {item.sourceRef}{item.action ? ` · action: “${item.action.title}” (${item.action.state})` : ''}</li>
            {item.whyVisible.map((w) => <li key={w}>{w}</li>)}
            <li>{item.actionRequired ? 'Something is yours to do.' : 'Nothing to do yet.'} Completion: {item.completionAuthority}.</li>
          </ul>
          {item.state !== 'done' && (
            <div className="cn-hike-form">
              {ann.state !== 'waiting' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => save({ state: 'waiting', note: note || null })}>I’m waiting on it</button>}
              {ann.state !== 'routine' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => save({ state: 'routine' })}>Routine</button>}
              {ann.state && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => save({ state: null, note: null })}>Clear “{ann.state}”</button>}
              {!edit && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => setEdit(true)}>More…</button>}
            </div>
          )}
          {edit && item.state !== 'done' && (
            <div className="cn-hike-form">
              <input className="cn-input--short" placeholder="What is it waiting on / blocked by?" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} aria-label="Reason" />
              <button type="button" className="cn-btn cn-btn--tiny" disabled={busy || !note.trim()} onClick={() => save({ state: 'blocked', note })}>Blocked</button>
              {item.dueDate && (
                <>
                  <input className="cn-input--tiny" inputMode="numeric" placeholder="days" value={lead} onChange={(e) => setLead(e.target.value.replace(/[^0-9]/g, ''))} aria-label="Lead time in days" />
                  <button type="button" className="cn-btn cn-btn--tiny" disabled={busy || !lead} onClick={() => save({ leadDays: Number(lead) })}>Set lead time</button>
                  {ann.leadDays && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => save({ leadDays: null })}>No lead time</button>}
                </>
              )}
              <select className="cn-select" value={ann.kind || ''} disabled={busy} aria-label="Kind" onChange={(e) => save({ kind: e.target.value || null })}>
                <option value="">Kind: {ADMIN_KIND_WORDS[item.kind] || item.kind} (from {item.kindBasis})</option>
                {Object.keys(ADMIN_KIND_WORDS).map((k) => <option key={k} value={k}>{ADMIN_KIND_WORDS[k]}</option>)}
              </select>
            </div>
          )}
        </details>
      </div>
    </li>
  );
}

export function AdminView({ view, busy, act, onDone, setup = null }) {
  if (!view) return null;
  const c = view.counts || {};
  const sections = adminSectionsOf(view);
  const core = (view.health && view.health.sources || []).find((s) => s.id === 'reminders-admin');
  // Counts are the server's; a missing count object is unknown ("—"), never 0.
  const known = !!view.counts;
  const n = (...keys) => (known ? keys.reduce((t, k) => t + (c[k] || 0), 0) : null);
  const needs = n('needs_you');
  const coming = n('upcoming');
  const partial = (view.health && !view.health.complete) || (view.gaps || []).length > 0;
  const head = needs ? { tone: 'warn', pill: 'Needs you', text: `${needs} ${needs === 1 ? 'thing needs' : 'things need'} you.` }
    : known && !c.total ? { tone: 'neutral', pill: 'Empty', text: 'No personal admin is recorded anywhere NEURO reads.' }
      : coming ? { tone: 'plan', pill: 'Coming up', text: `${coming} coming up — nothing needs you yet.` }
        : known ? { tone: partial ? 'neutral' : 'good', pill: 'In hand', text: 'Nothing needs you.' }
          : { tone: 'neutral', pill: 'Unknown', text: 'Couldn’t count what is here.' };
  return (
    <>
      <Headline tone={head.tone} pill={head.pill} detail={core ? `Personal Admin list: ${core.why}` : null}>{head.text}</Headline>
      {view.health && !view.health.complete && <div className="cn-callout cn-small">Not a complete picture — {view.health.why}</div>}
      {(view.gaps || []).length > 0 && <div className="cn-callout cn-small">Couldn’t read: {view.gaps.map((g) => g.input).join(', ')} — don’t treat it as nothing.</div>}
      {(!known || c.total > 0) && (
        <StatTiles>
          <Stat v={needs} l="need you" tone={needs ? 'warn' : undefined} />
          <Stat v={coming} l="coming up" />
          <Stat v={n('open', 'unknown')} l="open, no rush" />
          <Stat v={n('waiting', 'blocked')} l="waiting or blocked" />
          <Stat v={n('routine')} l="routine" />
        </StatTiles>
      )}
      {setup}
      {sections.filter((s) => s.items.length).map((s) => (s.fold ? (
        <details key={s.key} className="cn-details">
          <summary><strong>{s.title}</strong> · {s.items.length}</summary>
          <ul className="cn-list">{s.items.map((i) => <AdminRow key={i.obligationId} item={i} busy={busy} act={act} onDone={onDone} />)}</ul>
        </details>
      ) : (
        <Group key={s.key} label={s.title} meta={s.items.length}>
          <ul className="cn-list">{s.items.map((i) => <AdminRow key={i.obligationId} item={i} busy={busy} act={act} onDone={onDone} />)}</ul>
        </Group>
      )))}
    </>
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
  const view = data.view;
  // Setting up the admin list is the one obvious action here when it is not yet read.
  const setup = activation && activation.state !== 'active' ? (
    candidates.length > 0 ? (
      <Group label={activation.state === 'classified-not-tracked' ? 'Set as admin, but NEURO isn’t reading it yet' : 'Arrived from the phone — is this your admin list?'}>
        <div className="cn-actions">
          {candidates.map((c) => {
            const words = <>Read “{c.name}”{c.disambiguator ? ` (${c.disambiguator})` : ''} as admin</>;
            return candidates.length === 1
              ? <PrimaryAction key={c.sourceKey} disabled={busy} onClick={() => useList(c)}>{words}</PrimaryAction>
              : <button key={c.sourceKey} type="button" className="cn-btn" disabled={busy} onClick={() => useList(c)}>{words}</button>;
          })}
        </div>
      </Group>
    ) : (
      <details className="cn-details cn-callout" open>
        <summary><strong>Not set up yet</strong> — {activation.why}</summary>
        {activation.steps.length > 0 && <ol className="cn-act-lines">{activation.steps.map((st) => <li key={st}>{st}</li>)}</ol>}
      </details>
    )
  ) : null;
  return (
    <section className="cn-section">
      <h3 className="cn-h3">{view ? view.heading : 'Personal admin'}</h3>
      {note && <div className="cn-error">{note}</div>}
      {view ? <AdminView view={view} busy={busy} act={act} onDone={done} setup={setup} /> : <><Headline pill="Empty">Nothing here yet.</Headline>{setup}</>}
      <HowItWorks>
        {view ? view.rule : null}
        {view && (
          <ul className="cn-act-lines">
            {view.health.sources.map((s) => <li key={s.id}>{s.label}: {s.state} — {s.why}</li>)}
            {view.workExcluded != null && <li>{view.workExcluded} work or unclassified task{view.workExcluded === 1 ? '' : 's'} left out — admin never comes from wording.</li>}
            {(view.dedupe && view.dedupe.collapsed || []).map((d) => <li key={d.folded}>Shown once: {d.folded} is the {d.rule === 'linked action' ? 'linked action of' : 'task realising'} {d.kept}.</li>)}
          </ul>
        )}
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
      {s.trackingUndecided > 0
        ? <Headline tone="warn" pill="Undecided">{s.trackingUndecided} {s.trackingUndecided === 1 ? 'list is' : 'lists are'} waiting for you to say Track or Ignore.</Headline>
        : <Headline tone={s.lists ? 'good' : 'neutral'} pill={s.lists ? 'Decided' : 'None yet'}>{s.lists ? `NEURO reads ${s.tracked} of ${s.lists} lists.` : 'No reminder list has arrived from the phone yet.'}</Headline>}
      <StatTiles>
        <Stat v={s.lists} l="lists" />
        <Stat v={s.tracked} l="tracked" />
        <Stat v={s.ignored} l="ignored" />
        <Stat v={s.trackingUndecided} l="not decided" tone={s.trackingUndecided ? 'warn' : undefined} />
        <Stat v={s.open} l={s.open === null ? 'open — not measured yet' : 'open'} />
        <Stat v={s.open === null ? null : s.completed30d} l="done in 30 days" />
      </StatTiles>
      {note && <div className="cn-error">{note}</div>}
      <ul className="cn-list cn-class-list">
        {data.lists.map((l) => (
          <li key={l.sourceKey} className={`cn-row cn-class${l.trackingState === 'unknown' ? ' cn-class--undecided' : ''}`}
            title={[l.trackedWhy, l.lastSeenAt ? `last seen ${dayLabel(String(l.lastSeenAt))}` : null, l.sourceApps.length ? `from ${l.sourceApps.join(', ')}` : null].filter(Boolean).join(' · ')}>
            <div className="cn-class-name">
              <span className="cn-rowtitle">{l.name}</span>
              {l.disambiguator && <span className="cn-muted" title={`Apple list id …${String(l.listId).slice(-4)}`}> · {l.disambiguator}</span>}
              <div className="cn-muted cn-class-note">
                {l.openCount === null ? 'counts not measured yet' : `${l.openCount} open · ${l.completedCount30d} done in 30 days`}
              </div>
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
      <HowItWorks>
        {data.rule}
        {data.legacy.length > 0 && <> {data.legacy.length} older by-name record{data.legacy.length === 1 ? '' : 's'} from app builds before list ids — superseded, not separate lists.</>}
        {' '}Hover a list for why it is or isn’t read, when it was last seen and which app sent it.
      </HowItWorks>
    </section>
  );
}

