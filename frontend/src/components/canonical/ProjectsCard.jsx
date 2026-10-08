import React, { useState } from 'react';
import { useCanonical, postCanonical, HowItWorks, Fold, when } from './canonicalUi';

/**
 * Build 24 — Life → Personal projects. Personal projects only: NOVA and every
 * work project are absent by construction (the server never sends them here).
 * Each card says what the project is, its state, when it last really moved
 * (not just when something was touched), what blocks it and the next action —
 * and why it is shown. Projects NEURO cannot place are listed for Nick to say
 * whose they are; nothing is filed as personal for him. No GitHub controls.
 */

const STATUS_WORDS = { active: 'Active', paused: 'Paused', parked: 'Parked', blocked: 'Blocked', completed: 'Completed', abandoned: 'Abandoned', unknown: 'Status unknown' };
const FOCUS_WORDS = { ready: 'Ready to continue', blocked: 'Blocked — needs you', waiting: 'Waiting on someone', 'no-next-action': 'No next action', parked: 'Parked', closed: 'Closed' };
const STATUSES = ['active', 'paused', 'parked', 'blocked', 'completed', 'abandoned'];
const enc = encodeURIComponent;

export default function ProjectsCard() {
  const { data, error, reload } = useCanonical('/api/projects/personal');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const act = async (path, body) => {
    setBusy(true); setNote(null);
    try { await postCanonical(path, body); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  if (error && !data) return <section className="cn-section"><h3>Personal projects</h3><div className="cn-error">Couldn’t read projects — {error}</div></section>;
  if (!data) return <section className="cn-section"><h3>Personal projects</h3><div className="cn-muted">Reading…</div></section>;
  return <ProjectsView data={data} busy={busy} act={act} note={note} />;
}

/** The whole card for one payload. Exported so a test can render it for real. */
export function ProjectsView({ data, busy, act, note = null }) {
  const projects = data.projects || [];
  const gh = (data.sources && data.sources.github) || {};
  const ghLine = gh.state === 'never' ? 'GitHub: no snapshot yet — repo activity is unknown, not absent.'
    : `GitHub: ${gh.inScope} repo${gh.inScope === 1 ? '' : 's'} read ${gh.fetchedAt ? when(gh.fetchedAt) : ''}${gh.state === 'stale' ? ` — stale (${Math.round(gh.ageHours)}h old)` : ''}.`;
  const ready = projects.filter((p) => p.focus.focus === 'ready');
  const rest = projects.filter((p) => p.focus.focus !== 'ready' && p.focus.focus !== 'closed');
  const closed = projects.filter((p) => p.focus.focus === 'closed');
  return (
    <section className="cn-section cn-projects">
      <h3>Personal projects</h3>
      {note && <div className="cn-error">{note}</div>}
      <div className="cn-muted cn-small">{ghLine}</div>
      {!projects.length && <div className="cn-muted">No project is classified as personal yet. Say whose each project is below — NEURO never decides that for you.</div>}
      {ready.length > 0 && <div className="cn-small cn-muted">Ready to pick up: {ready.map((p) => p.name).join(', ')}</div>}
      {[...ready, ...rest].map((p) => <Project key={p.projectId} p={p} busy={busy} act={act} />)}
      {closed.length > 0 && (
        <Fold title="Closed" meta={`${closed.length}`}>
          <ul className="cn-list cn-small">{closed.map((p) => <li key={p.projectId}>{p.name} — {STATUS_WORDS[p.status.status]}</li>)}</ul>
        </Fold>
      )}
      <NeedsClassifying items={data.needsClassifying || []} busy={busy} act={act} />
      <LikelyLinks items={data.likelyLinks || []} busy={busy} act={act} />
      <HowItWorks>{data.rule}</HowItWorks>
    </section>
  );
}

function Project({ p, busy, act }) {
  const base = `/api/projects/${enc(p.projectId)}`;
  const [blocker, setBlocker] = useState('');
  return (
    <div className="cn-row cn-project">
      <div className="cn-rowtitle">{p.name}{p.displayTitle && p.displayTitle !== p.name ? ` — ${p.displayTitle}` : ''}</div>
      <div className="cn-small"><strong>{FOCUS_WORDS[p.focus.focus]}</strong> · {STATUS_WORDS[p.status.status]}{p.rawStatus && p.status.status === 'unknown' ? ` (note says "${p.rawStatus}")` : ''}</div>
      {p.description && <div className="cn-small cn-muted">{p.description}</div>}
      <div className="cn-act-lines cn-small">
        <div>Last real progress: {p.lastProgress ? `${when(p.lastProgress.at)} — ${p.lastProgress.what}` : 'none NEURO can see'}</div>
        <div className="cn-muted">Last activity: {p.lastActivity ? `${when(p.lastActivity.at)} — ${p.lastActivity.what}` : 'none seen'}</div>
        <div>Next: {p.nextAction ? `${p.nextAction.text}${p.nextAction.due ? ` (due ${p.nextAction.due})` : ''}` : (p.focus.focus === 'parked' ? 'nothing — it is parked' : 'nothing stated')}</div>
        {p.blockers.map((b) => (
          <div key={b.id} className="cn-error">Blocked: {b.what}{b.unblock ? ` — unblocks when ${b.unblock}` : ''}
            {b.source === 'you' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`${base}/blockers/${enc(b.id)}/resolve`, {})}>Unblocked</button>}
          </div>
        ))}
        {p.parkedComponents.length > 0 && <div className="cn-muted">Parked parts: {p.parkedComponents.join(', ')}</div>}
      </div>
      <Fold title="Details" meta={`${p.repos.filter((r) => r.state === 'confirmed').length} repo · ${p.tasks.open.length} open task`}>
        <div className="cn-small cn-muted">Why shown: {p.whyShown.join('; ')}</div>
        {p.repos.length > 0 && (
          <ul className="cn-list cn-small">
            {p.repos.map((r) => (
              <li key={r.repoId}><a href={r.htmlUrl} target="_blank" rel="noreferrer">{r.fullName}</a> — {r.state} ({r.why})
                {r.state === 'likely' && <>
                  {' '}<button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`${base}/repos`, { repoId: r.repoId, state: 'confirmed' })}>Confirm</button>
                  <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`${base}/repos`, { repoId: r.repoId, state: 'rejected' })}>Not this</button>
                </>}
              </li>
            ))}
          </ul>
        )}
        {p.tasks.open.length > 0 && (
          <ul className="cn-list cn-small">
            {p.tasks.open.map((t) => (
              <li key={t.id}>#{t.id} {t.text}{t.due ? ` — due ${t.due}` : ''} <span className="cn-muted">({t.basis})</span>
                {(!p.nextAction || p.nextAction.taskId !== t.id) && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`${base}/next`, { taskId: t.id })}>Make next</button>}
              </li>
            ))}
          </ul>
        )}
        {p.recentProgress.length > 0 && (
          <ul className="cn-list cn-small">{p.recentProgress.map((x, i) => <li key={i}>{when(x.at)} — {x.what} <span className="cn-muted">({x.why || x.kind})</span></li>)}</ul>
        )}
        <div className="cn-small">Status:{' '}
          {STATUSES.map((s) => <button key={s} type="button" className="cn-btn cn-btn--tiny" disabled={busy || (p.status.basis === 'you' && p.status.status === s)} onClick={() => act(`${base}/status`, { status: s })}>{STATUS_WORDS[s]}</button>)}
          {p.status.basis === 'you' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`${base}/status`, { status: null })}>Clear mine</button>}
        </div>
        <div className="cn-small">Not personal?{' '}
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`${base}/classify`, { sphere: 'work' })}>Work</button>
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`${base}/classify`, { sphere: 'other' })}>Other</button>
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`${base}/classify`, { sphere: 'unknown' })}>Unknown</button>
        </div>
        <form className="cn-small" onSubmit={(e) => { e.preventDefault(); if (blocker.trim()) { act(`${base}/blockers`, { what: blocker.trim() }); setBlocker(''); } }}>
          <input className="cn-input--tiny" value={blocker} placeholder="What blocks it?" onChange={(e) => setBlocker(e.target.value)} />
          <button type="submit" className="cn-btn cn-btn--tiny" disabled={busy || !blocker.trim()}>Add blocker</button>
        </form>
      </Fold>
    </div>
  );
}

function NeedsClassifying({ items, busy, act }) {
  if (!items.length) return null;
  return (
    <Fold title="Whose are these?" meta={`${items.length} not yet classified`}>
      <div className="cn-small cn-muted">NEURO does not decide whether a project is personal or work. Until you say, it stays out of this list.</div>
      <ul className="cn-list cn-small">
        {items.map((it) => (
          <li key={it.projectId}>{it.name}{it.suggestion ? <span className="cn-muted"> — maybe {it.suggestion.sphere} ({it.suggestion.why})</span> : null}
            {(it.conflicts || []).length > 0 && <span className="cn-error"> — the evidence disagrees</span>}{' '}
            {['personal', 'work', 'other'].map((s) => <button key={s} type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/projects/${enc(it.projectId)}/classify`, { sphere: s })}>{s[0].toUpperCase() + s.slice(1)}</button>)}
          </li>
        ))}
      </ul>
    </Fold>
  );
}

function LikelyLinks({ items, busy, act }) {
  if (!items.length) return null;
  return (
    <Fold title="Repo links to confirm" meta={`${items.length}`}>
      <ul className="cn-list cn-small">
        {items.map((l) => (
          <li key={`${l.projectId}|${l.repoId}`}>{l.project} ↔ {l.fullName} <span className="cn-muted">({l.why})</span>{' '}
            <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/projects/${enc(l.projectId)}/repos`, { repoId: l.repoId, state: 'confirmed' })}>Confirm</button>
            <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/projects/${enc(l.projectId)}/repos`, { repoId: l.repoId, state: 'rejected' })}>Not this</button>
          </li>
        ))}
      </ul>
    </Fold>
  );
}
