import React, { useState, useEffect } from 'react';
import { apiFetch } from '../../api';
import { useCanonical, postCanonical, DOMAIN_IDS, DOMAIN_LABELS, when, Fold } from './canonicalUi';
import GoalsCard from './GoalsCard';
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

// One page shell for every Life page. `withLife` reads /api/canonical/life —
// only the pages that render Goals, Companions or the setup cards need it, so
// the area pages fire no request beyond their own cards'.
function useLifeData() {
  const { data, error, loading, reload } = useCanonical('/api/canonical/life');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const act = async (fn) => {
    setBusy(true); setSaveError(null);
    try { await fn(); await reload(); } catch (err) { setSaveError(err.message); }
    setBusy(false);
  };
  return { data, error, loading, reload, busy, saveError, act };
}

function LifePage({ title, sub, life, children }) {
  return (
    <div className="cn-panel">
      {/* A tabbed page (Home, Outdoor) has no heading of its own: the tab names
          it and the card under it is titled, so a third "Home" is noise. */}
      {title && (
        <div className="cn-head">
          <h2 className="cn-title">{title}</h2>
          {life && <button type="button" className="cn-btn" onClick={life.reload}>Refresh</button>}
        </div>
      )}
      {sub && <p className="cn-sub">{sub}</p>}
      {life && life.loading && !life.data && <div className="cn-muted">Reading…</div>}
      {life && life.error && <div className="cn-error">Couldn’t read this — {life.error}</div>}
      {life && life.saveError && <div className="cn-error">Not saved — {life.saveError}</div>}
      {children}
    </div>
  );
}

/**
 * The Life overhaul (13 Oct 2026). Life was seventeen cards in one scroll —
 * four kinds of thing at once. It is now an OVERVIEW (who is in, what is
 * coming, what you intend) and each area of life has its own page. The
 * plumbing (reminder lists, calendar classifications, coverage) lives in
 * SYSTEM → Life sources. Every card is unchanged; only where it mounts moved.
 */
export default function LifePanel() {
  const life = useLifeData();
  return (
    <LifePage title="Life" life={life} sub="Who’s in, what’s coming, and what you’ve said you want. Each part of life has its own page in the menu.">
      <div className="cn-section"><HouseholdCard fetchJson={fetchHousehold} fetchPhoto={fetchHouseholdPhoto} /></div>
      <FutureRadarCard />
      <GoalsCard data={life.data} busy={life.busy} act={life.act} />
    </LifePage>
  );
}

export function LifeHomePage() {
  return (
    <LifePage>
      <HomeCard />
    </LifePage>
  );
}

export function LifeFamilyPage() {
  const life = useLifeData();
  return (
    <LifePage title="Family & friends" life={life} sub="Who people are to you — only as you have said — their dates, and Ember.">
      {/* Build 31: who people are to Nick — only as he has said. */}
      <PeopleCard />
      <section className="cn-section"><PersonalDatesCard /></section>
      <Companions data={life.data} busy={life.busy} act={life.act} />
    </LifePage>
  );
}

export function LifeOutdoorPage() {
  return (
    <LifePage>
      {/* Build 29: Outdoor carries the Hike weekly loop (its confirm / not-a-hike controls). */}
      <OutdoorCard />
    </LifePage>
  );
}

export function LifeMoneyPage() {
  return (
    <LifePage title="Money & car" sub="Personal admin, money (Tally works it out), and the car.">
      <PersonalAdminCard />
      <FinanceCard />
      <TransportCard />
    </LifePage>
  );
}

export function LifeLeisurePage() {
  return (
    <LifePage title="Leisure & projects" sub="What you’re into, and the things you’re building.">
      {/* Build 30: Leisure — what Nick is into; no feed, no history wall. */}
      <LeisureCard />
      <ProjectsCard />
    </LifePage>
  );
}

export function LifeSourcesPage({ onNavigate = null } = {}) {
  const life = useLifeData();
  return (
    <LifePage title="Life sources" life={life} sub="Which reminder lists NEURO reads, what each calendar is for, and what it can see by part of life. Set once; rarely visited.">
      <ReminderListsCard />
      <Classifications data={life.data} busy={life.busy} act={life.act} />
      <Coverage data={life.data} onNavigate={onNavigate} />
    </LifePage>
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
