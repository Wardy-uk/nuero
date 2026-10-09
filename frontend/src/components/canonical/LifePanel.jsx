import React, { useState, useEffect } from 'react';
import { apiFetch } from '../../api';
import { useCanonical, postCanonical, DOMAIN_IDS, DOMAIN_LABELS, IMPORTANCE_IDS, IMPORTANCE_LABELS, ImportanceChip, when, Fold } from './canonicalUi';
import OutdoorCard from './OutdoorCard';
import LeisureCard from './LeisureCard';
import PeopleCard from './PeopleCard';
import PersonalDatesCard from './PersonalDatesCard';
import CompanionCareCard from './CompanionCareCard';
import TransportCard from './TransportCard';
import FinanceCard from './FinanceCard';
import ProjectsCard from './ProjectsCard';
import HomeCard from './HomeCard';
import { FutureRadarCard, PersonalAdminCard, ReminderListsCard } from './FutureRadar';
import HouseholdCard from '../../../../saim/shared-ui/HouseholdCard';
import './Canonical.css';

/**
 * Life — the whole of Nick's life as the world model can currently see it
 * (Build 10C/10G, made real in Build 11). Four things, all honest about how
 * thin they are:
 *
 *  • Goals and intentions — ONLY what Nick has stored. NEURO never proposes
 *    one, never turns one into a task, never nags about one. Importance and
 *    dates are his too; a paused goal lends nothing to anything.
 *  • What each calendar and list is for — the ONLY way a phone calendar or a
 *    reminder list says anything about which part of life an item belongs to.
 *    Unclassified is unknown, never "personal because it came from the phone".
 *    This lives here, in NEURO, and never in SAiM.
 *  • Companions — Ember, from a vault note marked `type: pet`. What mentions
 *    her by name is shown as exactly that (a mention, not a fact).
 *  • Coverage by life domain — counts of evidence. A row of zeros is kept.
 */
// Who's in the house — the shared card (7 Oct 2026). Module scope: stable transports.
const fetchHousehold = async () => { const r = await apiFetch('/api/household'); return r.ok ? r.json() : null; };
const fetchHouseholdPhoto = async (id, version) => {
  const r = await apiFetch(`/api/household/photo/${encodeURIComponent(id)}?v=${version}`);
  return r.ok ? URL.createObjectURL(await r.blob()) : null;
};

export default function LifePanel({ onNavigate = null } = {}) {
  const { data, error, loading, reload } = useCanonical('/api/canonical/life');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const act = async (fn) => {
    setBusy(true); setSaveError(null);
    try { await fn(); await reload(); } catch (err) { setSaveError(err.message); }
    setBusy(false);
  };

  return (
    <div className="cn-panel">
      <div className="cn-head">
        <h2 className="cn-title">Life</h2>
        <button type="button" className="cn-btn" onClick={reload}>Refresh</button>
      </div>
      <p className="cn-sub">Work is one part of this. What NEURO can see across the rest, and what you have said you want.</p>
      {loading && !data && <div className="cn-muted">Reading…</div>}
      {error && <div className="cn-error">Couldn’t read this — {error}</div>}
      {saveError && <div className="cn-error">Not saved — {saveError}</div>}

      <div className="cn-section"><HouseholdCard fetchJson={fetchHousehold} fetchPhoto={fetchHouseholdPhoto} /></div>
      <HomeCard />
      {/* Build 31: who people are to Nick — only as he has said. */}
      <PeopleCard />
      <FutureRadarCard />
      <Goals data={data} busy={busy} act={act} />
      {/* Build 29: Outdoor carries the Hike weekly loop (its confirm / not-a-hike controls). */}
      <OutdoorCard />
      {/* Build 30: Leisure — what Nick is into; no feed, no history wall. */}
      <LeisureCard />
      <PersonalAdminCard />
      <TransportCard />
      <FinanceCard />
      <ProjectsCard />
      <ReminderListsCard />
      <Classifications data={data} busy={busy} act={act} />
      <Companions data={data} busy={busy} act={act} />
      <Coverage data={data} onNavigate={onNavigate} />
    </div>
  );
}

const STATUS_WORDS = { active: 'Active', paused: 'Paused', achieved: 'Achieved', dropped: 'Dropped' };

function Goals({ data, busy, act }) {
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [importance, setImportance] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const goals = data ? data.goals || [] : [];
  const live = goals.filter((g) => g.status === 'active' || g.status === 'paused');
  const done = goals.filter((g) => g.status === 'achieved' || g.status === 'dropped');

  const add = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    act(async () => {
      await postCanonical('/api/canonical/goals', {
        title, domains: domain ? [domain] : null, importance: importance || null, reviewDate: reviewDate || null,
      });
      setTitle(''); setDomain(''); setImportance(''); setReviewDate('');
    });
  };
  const update = (g, body) => act(() => postCanonical(`/api/canonical/goals/${encodeURIComponent(g.id)}`, body));

  return (
    <section className="cn-section">
      <h3 className="cn-h3">Goals and intentions</h3>
      {data && !goals.length && <div className="cn-empty">None stored. NEURO only shows goals you write down here — it never makes them up, and a goal never becomes a reminder by itself.</div>}
      <ul className="cn-list">
        {live.map((g) => (
          <li key={g.id} className={`cn-row cn-goal${g.status === 'paused' ? ' cn-goal--paused' : ''}`}>
            <span className="cn-rowtitle">{g.title}</span>
            {g.domains.map((d) => <span key={d.domain} className="cn-chip cn-chip--firm">{DOMAIN_LABELS[d.domain] || d.domain}</span>)}
            <ImportanceChip value={g.importance} basis="declared" />
            {g.status === 'paused' && <span className="cn-chip cn-chip--soft">paused — lends nothing to anything</span>}
            {g.reviewDate && <span className="cn-muted">review {g.reviewDate}</span>}
            {g.lastReviewedAt && <span className="cn-muted">reviewed {when(g.lastReviewedAt)}</span>}
            {g.links && g.links.length > 0 && <span className="cn-muted">{g.links.length} linked</span>}
            <span className="cn-goal-actions">
              <select value={g.importance || ''} disabled={busy} aria-label="How much it matters to you"
                onChange={(e) => update(g, { importance: e.target.value || null })}>
                <option value="">importance not said</option>
                {IMPORTANCE_IDS.filter((i) => i !== 'work-critical').map((i) => <option key={i} value={i}>{IMPORTANCE_LABELS[i]}</option>)}
              </select>
              <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { reviewed: true })}>Reviewed</button>
              {g.status === 'active'
                ? <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'paused' })}>Pause</button>
                : <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'active' })}>Resume</button>}
              <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'achieved' })}>Achieved</button>
              <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'dropped' })}>Drop</button>
            </span>
            {g.description && <div className="cn-muted cn-goal-desc">{g.description}</div>}
          </li>
        ))}
      </ul>
      <PersonalDatesCard />
      <form className="cn-goalform" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. hike once a fortnight" maxLength={300} aria-label="Goal" />
        <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Life domain">
          <option value="">no domain</option>
          {DOMAIN_IDS.map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
        </select>
        <select value={importance} onChange={(e) => setImportance(e.target.value)} aria-label="Importance">
          <option value="">importance not said</option>
          {IMPORTANCE_IDS.filter((i) => i !== 'work-critical').map((i) => <option key={i} value={i}>{IMPORTANCE_LABELS[i]}</option>)}
        </select>
        <input type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} aria-label="Review date" title="Review date (optional)" />
        <button type="submit" className="cn-btn" disabled={busy || !title.trim()}>Add</button>
      </form>
      {done.length > 0 && (
        <details className="cn-details">
          <summary>{done.length} achieved or dropped</summary>
          <ul className="cn-list">
            {done.map((g) => (
              <li key={g.id} className="cn-row"><span className="cn-rowtitle">{g.title}</span> <span className="cn-muted">{STATUS_WORDS[g.status]}</span>
                <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'active' })}>Make active again</button></li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Classifications({ data, busy, act }) {
  const containers = data ? data.containers || [] : [];
  const calendars = containers.filter((c) => c.kind === 'calendar');
  const lists = containers.filter((c) => c.kind === 'reminder-list');
  const save = (c, body) => act(() => postCanonical('/api/canonical/classifications', { kind: c.kind, sourceKey: c.sourceKey, label: c.label, ...body }));

  const [viewing, setViewing] = useState(null);
  const ignoredCal = (c) => c.kind === 'calendar' && !!c.classification && c.classification.tracked === false;
  const Row = ({ c }) => {
    const doms = (c.classification && c.classification.domains) || [];
    return (
      <li className="cn-row cn-class">
        <div className="cn-class-name">
          <span className="cn-rowtitle">{c.label}</span>
          {c.twinIndex && <span className="cn-muted"> · {c.twinIndex}</span>}
          {c.ambiguous && <div className="cn-muted cn-class-note">Two calendars share this name, so a choice here cannot tell them apart.</div>}
          {c.notSeen && <div className="cn-muted cn-class-note">not seen recently</div>}
          <div className="cn-muted cn-class-note">{entryLine(c)}</div>
        </div>
        <div className="cn-class-controls">
          {c.entries && c.entries.total > 0 && (
            <button type="button" className="cn-btn" onClick={() => setViewing(c)}>View</button>
          )}
          {c.kind === 'calendar' && c.keyedBy !== 'account' && (
            ignoredCal(c)
              ? <button type="button" className="cn-btn" disabled={busy} onClick={() => save(c, { tracked: null })}>Restore</button>
              : <button type="button" className="cn-btn" disabled={busy} title="Stop reading this calendar — its events no longer reach NEURO"
                  onClick={() => save(c, { tracked: false })}>Ignore</button>
          )}
          {!ignoredCal(c) && <select className="cn-select" value={doms[0] || ''} disabled={busy} aria-label={`What ${c.label} is for`}
            onChange={(e) => save(c, { domains: e.target.value ? [e.target.value] : null })}>
            <option value="">Not classified</option>
            {DOMAIN_IDS.map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
          </select>}
        </div>
      </li>
    );
  };

  // A by-name container from an app build before ids is SUPERSEDED by the
  // id-keyed one with the same name — the same calendar seen the old way. The
  // backend marks it; it is not listed, and its items use the id one's choice.
  const split = (rows) => {
    const main = rows.filter((c) => !c.superseded);
    const counts = {};
    main.forEach((c) => { counts[c.label] = (counts[c.label] || 0) + 1; });
    const seen = {};
    return main.map((c) => {
      if (counts[c.label] < 2) return c;
      seen[c.label] = (seen[c.label] || 0) + 1;
      return { ...c, twinIndex: `${seen[c.label]} of ${counts[c.label]}` };
    });
  };
  const ignoredCals = calendars.filter(ignoredCal);
  const cal = { main: split(calendars.filter((c) => !ignoredCal(c))) };
  const superseded = containers.filter((c) => c.superseded).length;

  return (
    <section className="cn-section">
      <h3 className="cn-h3">What each calendar and list is for</h3>
      <p className="cn-muted">A calendar or a reminder list says nothing about your life until you say so here — the phone is not "personal" and Outlook is not "work" by themselves. Unclassified stays unknown.</p>
      {data && !containers.length && <div className="cn-empty">No calendars or lists seen yet — they appear after the phone next pushes.</div>}
      {cal.main.length > 0 && <><div className="cn-now-k cn-class-k">Calendars</div><ul className="cn-list cn-class-list">{cal.main.map((c) => <Row key={c.sourceKey} c={c} />)}</ul></>}
      {lists.length > 0 && <p className="cn-muted cn-class-k">Reminder lists — what each is for and whether NEURO reads it — are set in “Reminder lists” above.</p>}
      {ignoredCals.length > 0 && (
        <details className="cn-details">
          <summary>{ignoredCals.length} ignored calendar{ignoredCals.length === 1 ? '' : 's'} — their events no longer reach NEURO</summary>
          <ul className="cn-list cn-class-list">{ignoredCals.map((c) => <Row key={c.sourceKey} c={c} />)}</ul>
        </details>
      )}
      {superseded > 0 && <p className="cn-muted cn-class-k">{superseded} name-only entr{superseded === 1 ? 'y' : 'ies'} from older app builds are the same calendars and lists as above, and use their choices.</p>}
      {viewing && <EntriesModal c={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

// "12 upcoming · 40 in total" — from the world model. null is "not counted",
// never 0: an unreadable count must not read as an empty calendar.
// The phone sends its diary from yesterday to two weeks ahead, so a phone
// calendar's count is the next fortnight — never its whole history. An
// untracked reminder list is never read, so 0 there means "not read".
function entryLine(c) {
  const e = c.entries;
  if (c.kind === 'reminder-list') {
    if (c.tracking !== 'tracked') return c.tracking === 'ignored' ? 'ignored — NEURO does not read this list' : 'not decided — NEURO does not read this list';
  }
  if (c.kind === 'calendar' && c.classification && c.classification.tracked === false) return 'ignored';
  if (e == null) return 'entries not counted';
  if (c.kind === 'calendar') {
    const span = c.keyedBy === 'account' ? 'coming up' : 'in the next two weeks';
    return e.current ? `${e.current} ${span}` : `nothing ${span}`;
  }
  return e.total ? `${e.current} open · ${e.total - e.current} done` : 'empty';
}

// Event times are SLICED out of the wall-clock string, never parsed (BST rule).
const dayTime = (s, allDay) => {
  if (!s) return '';
  const d = String(s).slice(0, 10);
  const t = String(s).slice(11, 16);
  return allDay || !t ? d : `${d} ${t}`;
};

function EntriesModal({ c, onClose }) {
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    apiFetch(`/api/canonical/classifications/entries?kind=${encodeURIComponent(c.kind)}&sourceKey=${encodeURIComponent(c.sourceKey)}`)
      .then((r) => r.json())
      .then((j) => { if (!live) return; if (j && j.ok) setRes(j); else setError((j && j.error) || 'no answer'); })
      .catch((e) => live && setError(e.message));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { live = false; window.removeEventListener('keydown', onKey); };
  }, [c.kind, c.sourceKey, onClose]);
  const cal = c.kind === 'calendar';
  const line = (x, i) => (
    <li key={i} className="cn-entry">
      <span className="cn-entry-when">{cal ? dayTime(x.start, x.allDay) : (x.due ? String(x.due).slice(0, 10) : x.completedAt ? `done ${String(x.completedAt).slice(0, 10)}` : 'no date')}</span>
      <span className="cn-entry-title">{x.title}</span>
    </li>
  );
  return (
    <div className="cn-modal-back" onClick={onClose}>
      <div className="cn-modal" role="dialog" aria-label={`${c.label} entries`} onClick={(e) => e.stopPropagation()}>
        <div className="cn-head">
          <h3 className="cn-h3">{c.label}</h3>
          <button type="button" className="cn-btn" onClick={onClose}>Close</button>
        </div>
        {!res && !error && <div className="cn-muted">Reading…</div>}
        {error && <div className="cn-error">Couldn’t read this — {error}</div>}
        {res && (
          <>
            <div className="cn-now-k">{cal ? 'Upcoming' : 'Open'} ({res.current.length})</div>
            {res.current.length ? <ul className="cn-entries">{res.current.map(line)}</ul> : <div className="cn-muted">None.</div>}
            {res.past.length > 0 && (
              <details className="cn-details">
                <summary>{cal ? 'Earlier' : 'Completed'} ({res.past.length})</summary>
                <ul className="cn-entries">{res.past.map(line)}</ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Companions({ data, busy, act }) {
  const companions = data ? data.companions || [] : [];
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('');
  const [breed, setBreed] = useState('');
  const [household, setHousehold] = useState(true);
  const [made, setMade] = useState(null);
  const create = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    act(async () => {
      const r = await postCanonical('/api/canonical/companions', { name, species, breed, household });
      setMade(r && r.notePath); setName(''); setSpecies(''); setBreed('');
      // The note is published at once; the world model folds it in a moment later.
      await new Promise((ok) => setTimeout(ok, 1500));
    });
  };
  return (
    <section className="cn-section">
      <h3 className="cn-h3">Companions</h3>
      {data && !companions.length && <div className="cn-empty">None yet. Add one below — NEURO writes a note in Companions/ marked <code>type: pet</code>, and never guesses one for you.</div>}
      <ul className="cn-list">
        {companions.map((c) => (
          <li key={c.id} className="cn-row">
            <div className="cn-comp-head">
              <span className="cn-rowtitle">{c.name}</span>
              {c.species && <span className="cn-muted">{c.species}{c.breed ? ` · ${c.breed}` : ''}</span>}
              {c.household === true && <span className="cn-chip cn-chip--soft">lives with you</span>}
              {c.goals && c.goals.length > 0 && <span className="cn-muted">goals: {c.goals.map((g) => g.title).join(', ')}</span>}
            </div>
            {c.upcoming && c.upcoming.length > 0 && <div className="cn-muted">Coming up (mentions {c.name}): {c.upcoming.map((e) => `${when(e.start)} ${e.title}`).join('; ')}</div>}
            <CompanionCareCard companion={c} />
          </li>
        ))}
      </ul>
      <Fold title="Add a companion" meta="NEURO writes a note in Companions/">
      <form className="cn-goalform" onSubmit={create}>
        <input className="cn-input--short" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={60} aria-label="Companion name" />
        <input className="cn-input--short" value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="Species (dog)" maxLength={60} aria-label="Species" />
        <input className="cn-input--short" value={breed} onChange={(e) => setBreed(e.target.value)} placeholder="Breed (optional)" maxLength={60} aria-label="Breed" />
        <label className="cn-check"><input type="checkbox" checked={household} onChange={(e) => setHousehold(e.target.checked)} /> lives with you</label>
        <button type="submit" className="cn-btn" disabled={busy || !name.trim()}>Create</button>
      </form>
      </Fold>
      {made && <div className="cn-muted">Written to {made}.</div>}
    </section>
  );
}

function Coverage({ data, onNavigate }) {
  if (!data) return null;
  return (
    <section className="cn-section">
      <h3 className="cn-h3">What NEURO can see, by part of your life</h3>
      <table className="cn-table">
        <thead><tr><th>Domain</th><th>Commitments</th><th>Tasks</th><th>Upcoming events</th><th>Sources</th><th>Calendars &amp; lists</th><th>Goals</th><th>Set by you</th></tr></thead>
        <tbody>
          {data.coverage.domains.map((r) => {
            const empty = !r.commitments && !r.tasks && !r.upcoming && !r.sources && !r.containers && !r.goals;
            return (
              <tr key={r.domain} className={empty ? 'cn-tr--empty' : undefined}>
                <td>{r.label}</td><td>{r.commitments}</td><td>{r.tasks}</td><td>{r.upcoming}</td><td>{r.sources}</td><td>{r.containers}</td><td>{r.goals}</td><td>{r.declared}</td>
              </tr>
            );
          })}
          <tr className="cn-tr--unknown"><td>domain unknown</td><td>{data.coverage.unknown.commitments > 0 && onNavigate
                ? <button type="button" className="cn-linkbtn" title="Review them in Commitments" onClick={() => onNavigate('commitments', { domain: 'unknown' })}>{data.coverage.unknown.commitments}</button>
                : data.coverage.unknown.commitments}</td><td>{data.coverage.unknown.tasks}</td><td>{data.coverage.unknown.upcoming}</td><td>—</td><td>{data.coverage.unknown.containers}</td><td>—</td><td>—</td></tr>
        </tbody>
      </table>
      {data.coverage.unknown.commitments > 0 && onNavigate && (
        <p className="cn-muted">Click the unknown commitments figure to tag them in Commitments, one pick per row (it opens on "I owe"; "Owed to me" has its own).</p>
      )}
      <p className="cn-muted">These are counts of evidence, not judgements. Work leans on a colleague’s People note or a task’s default; nothing is guessed for health, family or money.</p>
      {data.gaps && data.gaps.length > 0 && <div className="cn-error">Couldn’t read: {data.gaps.map((g) => g.input).join(', ')}</div>}
    </section>
  );
}
