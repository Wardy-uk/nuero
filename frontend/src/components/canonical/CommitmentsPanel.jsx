import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../api';
import { useCanonical, postCanonical, DomainChips, ProvenanceBadge, Freshness, when, DOMAIN_IDS, DOMAIN_LABELS } from './canonicalUi';
import './Canonical.css';

/**
 * Commitments — the first NEURO screen that reads the WORLD MODEL (Build 10B).
 *
 * Reads /api/canonical/commitments (the wm_commitments projection, resolved
 * people, meeting links, progress evidence). It deliberately does NOT read
 * /api/waiting-on: that table is a SOURCE the projection folds, and a screen
 * reading the source beside the belief is how one fact gets two answers.
 * Chasing and snoozing still happen in People (the chase is a governed draft);
 * this screen says what NEURO believes and why.
 *
 * Honesty rules on screen:
 *  • An unresolved person keeps their raw name AND the reason — never hidden,
 *    never guessed onto the nearest colleague.
 *  • A due date says what KIND of date it is: a stated deadline, a planned
 *    date, or NEURO's own placeholder. Only a stated deadline is "overdue".
 *  • Domain unknown is shown as unknown.
 */

const PAGE = 60;

function Counterpart({ c }) {
  const cp = c.counterpart;
  if (cp.status === 'resolved') return <span className="cn-who">{cp.name}</span>;
  if (cp.status === 'unresolved') {
    return <span className="cn-who cn-who--unresolved" title={cp.why}>{cp.name || '?'} · unresolved</span>;
  }
  return <span className="cn-who cn-who--none" title={cp.why}>no-one named</span>;
}

function Due({ due }) {
  if (due.kind === 'none') return <span className="cn-due cn-due--none">no date</span>;
  const urgent = due.kind === 'stated' && (due.relative === 'overdue' || due.relative === 'today');
  return <span className={`cn-due cn-due--${due.kind}${urgent ? ' cn-due--urgent' : ''}`}>{due.label}</span>;
}

const PROGRESS_WORDS = {
  fulfilled: 'done (fact)', closed: 'closed', contradicted: 'still open (said so)', likely_fulfilled: 'probably done (inferred)',
  progress_observed: 'moving', no_evidence: 'no sign of movement', unknown: 'could not check',
};

function Detail({ id, onClose, onChanged }) {
  const { data, error, loading, reload } = useCanonical(`/api/canonical/commitments/${encodeURIComponent(id)}`);
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [people, setPeople] = useState(null);
  const [closed, setClosed] = useState(null);
  const resolveAs = async (outcome) => {
    setSaving(outcome); setSaveError(null);
    try {
      await postCanonical(`/api/canonical/commitments/${encodeURIComponent(id)}/resolve`, { outcome });
      setClosed(outcome === 'done' ? 'Marked done.' : 'Marked not owed.');
      // The world model follows the owner a moment later.
      setTimeout(() => onChanged && onChanged(), 1500);
    } catch (e) { setSaveError(e.message); }
    setSaving(null);
  };
  const setWho = async (name) => {
    if (!name) return;
    setSaving('who'); setSaveError(null);
    try { await postCanonical(`/api/canonical/commitments/${encodeURIComponent(id)}/who`, { name }); setTimeout(() => { reload(); onChanged && onChanged(); }, 1500); }
    catch (e) { setSaveError(e.message); }
    setSaving(null);
  };
  if (loading && !data) return <div className="cn-detail">Loading evidence…</div>;
  if (error && !data) return <div className="cn-detail cn-error">Couldn’t read the evidence — {error}</div>;
  const { item, evidence } = data;
  const declared = (item.domains.domains || []).filter((d) => d.basis === 'declared').map((d) => d.domain);
  const toggle = async (d) => {
    setSaving(d); setSaveError(null);
    const next = declared.includes(d) ? declared.filter((x) => x !== d) : [...declared, d];
    try { await postCanonical('/api/canonical/annotations', { entityId: item.id, domains: next.length ? next : null }); await reload(); }
    catch (e) { setSaveError(e.message); }
    setSaving(null);
  };
  const setImportance = async (v) => {
    setSaving('importance'); setSaveError(null);
    try { await postCanonical('/api/canonical/annotations', { entityId: item.id, importance: v || null }); await reload(); }
    catch (e) { setSaveError(e.message); }
    setSaving(null);
  };
  return (
    <div className="cn-detail">
      <div className="cn-detail-head">
        <strong>Evidence</strong>
        <span className="cn-detail-acts">
          {closed ? <span className="cn-muted">{closed}</span> : <>
            <button type="button" className="cn-btn" disabled={!!saving} onClick={() => resolveAs('done')}>Done</button>
            <button type="button" className="cn-btn" disabled={!!saving} title="It was never owed, or it was a misread of the meeting"
              onClick={() => resolveAs('not-owed')}>Not owed</button>
          </>}
          <button type="button" className="cn-btn" onClick={onClose}>Close</button>
        </span>
      </div>
      <dl className="cn-dl">
        <dt>Belief</dt><dd><ProvenanceBadge kind={evidence.provenance.kind} confidence={evidence.provenance.confidence} /> from {evidence.source.kind}{evidence.source.date ? ` on ${evidence.source.date}` : ''}{evidence.source.path ? <span className="cn-path"> · {evidence.source.path}</span> : null}</dd>
        <dt>Who</dt><dd>{item.counterpart.status === 'resolved' ? `${item.counterpart.name} (${item.counterpart.method || 'matched'})` : item.counterpart.why}
          {item.counterpart.status !== 'resolved' && evidence.source && evidence.source.kind === 'meeting-waiting-on' && (
            <WhoPicker raw={item.counterpart.name} people={people} setPeople={setPeople} disabled={!!saving} onPick={setWho} />
          )}
        </dd>
        {item.meeting && <><dt>Meeting</dt><dd>{item.meeting.title}{item.meeting.start ? ` · ${when(item.meeting.start)}` : ''}{item.meeting.linked ? '' : <span className="cn-muted"> — not tied to a calendar occurrence: {item.meeting.why}</span>}</dd></>}
        {evidence.task && <><dt>Task</dt><dd>{evidence.task.title} · {evidence.task.state}{evidence.task.possibleCompletion ? <span className="cn-muted"> · possibly done elsewhere (inference): {evidence.task.possibleCompletion.note || 'same wording completed'}</span> : null}</dd></>}
        <dt>Still open because</dt>
        <dd>
          {evidence.progress
            ? <>{PROGRESS_WORDS[evidence.progress.state] || evidence.progress.state} ({evidence.progress.basis}){(evidence.progress.reasons || []).length ? ` — ${evidence.progress.reasons.join('; ')}` : ''}</>
            : 'no progress evidence has been read for this one'}
          {evidence.progress && evidence.progress.coverage && (evidence.progress.coverage.sentMail === 'unavailable' || evidence.progress.coverage.laterNotes === 'unavailable')
            && <div className="cn-muted">Some evidence could not be read (sent mail: {evidence.progress.coverage.sentMail}, later notes: {evidence.progress.coverage.laterNotes}) — this is not proof nothing happened.</div>}
          {(evidence.progress && evidence.progress.evidence || []).slice(0, 5).map((e, i) => (
            <div key={i} className="cn-ev">{e.at ? when(e.at) : ''} · {e.kind} · {e.polarity} ({e.provenance}) — {e.reason}</div>
          ))}
        </dd>
        <dt>Life domain</dt>
        <dd>
          <DomainChips domains={item.domains} />
          <div className="cn-tagrow">
            {DOMAIN_IDS.map((d) => (
              <label key={d} className="cn-tag">
                <input type="checkbox" checked={declared.includes(d)} disabled={!!saving} onChange={() => toggle(d)} /> {DOMAIN_LABELS[d]}
              </label>
            ))}
          </div>
          <div className="cn-muted">Ticking sets it as yours; it replaces any inference.</div>
        </dd>
        <dt>Matters to you</dt>
        <dd>
          <select value={item.importance || ''} disabled={!!saving} onChange={(e) => setImportance(e.target.value)}>
            <option value="">not said</option>
            <option value="work-critical">work-critical</option>
            <option value="personally-important">personally important</option>
            <option value="restorative">restorative</option>
            <option value="optional">optional</option>
          </select>
        </dd>
      </dl>
      {saveError && <div className="cn-error">Not saved — {saveError}</div>}
    </div>
  );
}

// Only People notes are offered: a typed name with no note would stay
// unresolved and look as though it worked. Same first name first.
function WhoPicker({ raw, people, setPeople, disabled, onPick }) {
  useEffect(() => {
    if (people) return;
    apiFetch('/api/events/world/people').then((r) => r.json())
      .then((j) => setPeople((j.people || []).map((p) => p.displayName).filter(Boolean)))
      .catch(() => setPeople([]));
  }, [people, setPeople]);
  const first = String(raw || '').trim().split(/\s+/)[0].toLowerCase();
  const names = (people || []).slice().sort((a, b) => {
    const am = a.toLowerCase().startsWith(first) ? 0 : 1; const bm = b.toLowerCase().startsWith(first) ? 0 : 1;
    return am - bm || a.localeCompare(b);
  });
  return (
    <div className="cn-tagpick" style={{ padding: '6px 0 0' }}>
      <select className="cn-select" value="" disabled={disabled || !people} onChange={(e) => onPick(e.target.value)} aria-label="Who owes this">
        <option value="">{people ? 'Who is it?' : 'Reading people…'}</option>
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
}

export default function CommitmentsPanel({ focusContext = null } = {}) {
  const [direction, setDirection] = useState((focusContext && focusContext.direction) || 'i-owe');
  const [domain, setDomain] = useState((focusContext && focusContext.domain) || '');
  const [tagging, setTagging] = useState(null);
  const [tagError, setTagError] = useState(null);
  // One step per item while reviewing unknowns: pick a domain on the row, it is
  // saved as Nick's declaration and the row leaves the "unknown" list.
  const [tagProgress, setTagProgress] = useState('');
  const tagAll = async (list, d) => {
    if (!window.confirm(`Mark all ${list.length} as ${DOMAIN_LABELS[d] || d}?`)) return;
    setTagging('all'); setTagError(null);
    let n = 0; let failed = 0;
    for (const c of list) {
      try { await postCanonical('/api/canonical/annotations', { entityId: c.id, domains: [d] }); } catch { failed += 1; }
      n += 1; setTagProgress(`${n}/${list.length}`);
    }
    if (failed) setTagError(`${failed} of ${list.length} were not saved`);
    setTagging(null); setTagProgress('');
    await reload();
  };
  const tag = async (c, d) => {
    if (!d) return;
    setTagging(c.id); setTagError(null);
    try { await postCanonical('/api/canonical/annotations', { entityId: c.id, domains: [d] }); await reload(); }
    catch (e) { setTagError(e.message); }
    setTagging(null);
  };
  const [dueFilter, setDueFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const [limit, setLimit] = useState(PAGE);
  const path = `/api/canonical/commitments?direction=${direction}${domain ? `&domain=${domain}` : ''}`;
  const { data, error, loading, reload } = useCanonical(path);

  const items = useMemo(() => {
    const all = data ? data.items : [];
    if (dueFilter === 'overdue') return all.filter((i) => i.due.kind === 'stated' && i.due.relative === 'overdue');
    if (dueFilter === 'soon') return all.filter((i) => ['today', 'soon'].includes(i.due.relative) && ['stated', 'set'].includes(i.due.kind));
    if (dueFilter === 'meeting') return all.filter((i) => i.meeting);
    if (dueFilter === 'unresolved') return all.filter((i) => i.counterpart.status === 'unresolved');
    return all;
  }, [data, dueFilter]);
  const counts = data ? data.counts : null;

  return (
    <div className="cn-panel">
      <div className="cn-head">
        <h2 className="cn-title">Commitments</h2>
        <button type="button" className="cn-btn" onClick={reload}>Refresh</button>
      </div>
      <p className="cn-sub">
        What NEURO believes is owed, in both directions, from the world model. Chase or snooze a colleague’s item in People.
        {data && <> · <Freshness projection={data.freshness} /></>}
      </p>

      <div className="cn-tabs" role="tablist">
        {[['i-owe', 'I owe'], ['owed-to-me', 'Owed to me']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={direction === id}
            className={`cn-tab${direction === id ? ' cn-tab--on' : ''}`} onClick={() => { setDirection(id); setOpen(null); setLimit(PAGE); }}>
            {label}
          </button>
        ))}
        <select className="cn-select" value={dueFilter} onChange={(e) => setDueFilter(e.target.value)} aria-label="Filter">
          <option value="all">all open</option>
          <option value="overdue">overdue (stated deadline)</option>
          <option value="soon">due soon</option>
          <option value="meeting">from a meeting</option>
          <option value="unresolved">who is unresolved</option>
        </select>
        <select className="cn-select" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Life domain">
          <option value="">every domain</option>
          <option value="unknown">domain unknown</option>
          {DOMAIN_IDS.map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
        </select>
      </div>

      {counts && (
        <div className="cn-stats">
          <span>{counts.total} open</span>
          {counts.overdue > 0 && <span className="cn-stat--warn">{counts.overdue} past a stated deadline</span>}
          {counts.soon > 0 && <span>{counts.soon} due soon</span>}
          <span>{counts.meetingLinked} tied to a meeting</span>
          {counts.unresolved > 0 && <span className="cn-stat--warn">{counts.unresolved} with an unresolved person</span>}
          {counts.domainUnknown > 0 && <span className="cn-muted">{counts.domainUnknown} domain unknown</span>}
        </div>
      )}

      {domain === 'unknown' && items.length > 0 && (
        <div className="cn-tagpick" style={{ padding: '0 0 8px' }}>
          <button type="button" className="cn-btn" disabled={!!tagging} onClick={() => tagAll(items, 'work')}>
            {tagging === 'all' ? `Tagging… ${tagProgress}` : `Mark all ${items.length} as Work`}
          </button>
          <span className="cn-muted">Every one shown here, on this tab.</span>
        </div>
      )}
      {tagError && <div className="cn-error">Not saved — {tagError}</div>}
      {loading && !data && <div className="cn-muted">Reading the world model…</div>}
      {error && <div className="cn-error">Couldn’t read commitments — {error}. This is not the same as having none.</div>}
      {data && !items.length && !error && <div className="cn-empty">Nothing here — the world model holds no open commitments matching this.</div>}

      <ul className="cn-list">
        {items.slice(0, limit).map((c) => (
          <li key={c.id} className="cn-row">
            <button type="button" className="cn-rowbtn" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
              <div className="cn-rowtitle">{c.description}</div>
              <div className="cn-meta">
                <Counterpart c={c} />
                <Due due={c.due} />
                {c.meeting && <span className="cn-meeting" title={c.meeting.linked ? 'tied to a calendar occurrence' : c.meeting.why}>{c.meeting.linked ? '📅' : '📝'} {c.meeting.title}</span>}
                {c.progress && <span className="cn-progress">{PROGRESS_WORDS[c.progress.state] || c.progress.state}</span>}
                {c.importance && <span className="cn-chip cn-chip--firm">{c.importance}</span>}
                <DomainChips domains={c.domains} />
                <ProvenanceBadge kind={c.provenance.kind} confidence={c.provenance.confidence} />
              </div>
            </button>
            {domain === 'unknown' && (
              <div className="cn-tagpick">
                <select className="cn-select" value="" disabled={tagging === c.id} aria-label={`Which part of life: ${c.description}`}
                  onChange={(e) => tag(c, e.target.value)}>
                  <option value="">{tagging === c.id ? 'Saving…' : 'Which part of life?'}</option>
                  {DOMAIN_IDS.map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
                </select>
              </div>
            )}
            {open === c.id && <Detail id={c.id} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />}
          </li>
        ))}
      </ul>
      {items.length > limit && (
        <button type="button" className="cn-btn" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, items.length - limit)} more of {items.length - limit}</button>
      )}
    </div>
  );
}
