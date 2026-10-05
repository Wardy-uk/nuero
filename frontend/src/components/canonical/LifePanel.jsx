import React, { useState } from 'react';
import { useCanonical, postCanonical, DOMAIN_IDS, DOMAIN_LABELS, IMPORTANCE_IDS, IMPORTANCE_LABELS, ImportanceChip, when } from './canonicalUi';
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
export default function LifePanel() {
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

      <Goals data={data} busy={busy} act={act} />
      <Classifications data={data} busy={busy} act={act} />
      <Companions data={data} busy={busy} act={act} />
      <Coverage data={data} />
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

  const ignoredCal = (c) => c.kind === 'calendar' && !!c.classification && c.classification.tracked === false;
  const Row = ({ c }) => {
    const doms = (c.classification && c.classification.domains) || [];
    const tracked = c.kind === 'reminder-list'
      ? (c.classification && typeof c.classification.tracked === 'boolean' ? c.classification.tracked : c.defaultTracked)
      : null;
    return (
      <li className="cn-row cn-class">
        <div className="cn-class-name">
          <span className="cn-rowtitle">{c.label}</span>
          {c.twinIndex && <span className="cn-muted"> · {c.twinIndex}</span>}
          {c.ambiguous && <div className="cn-muted cn-class-note">Two calendars share this name, so a choice here cannot tell them apart.</div>}
          {c.notSeen && <div className="cn-muted cn-class-note">not seen recently</div>}
        </div>
        <div className="cn-class-controls">
          {c.kind === 'reminder-list' && (
            <label className="cn-check">
              <input type="checkbox" checked={!!tracked} disabled={busy} onChange={(e) => save(c, { tracked: e.target.checked })} />
              tracked{c.classification && typeof c.classification.tracked === 'boolean' ? '' : ' (default)'}
            </label>
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

  // A calendar seen by id AND by name is one calendar: the by-name entry only
  // exists for pushes from app builds before ids were sent. Show the id rows;
  // fold the name-only twins away (still classifiable) so each appears once.
  const split = (rows) => {
    const idLabels = new Set(rows.filter((c) => c.keyedBy === 'id').map((c) => c.label));
    const main = rows.filter((c) => c.keyedBy !== 'title' || !idLabels.has(c.label));
    const older = rows.filter((c) => !main.includes(c));
    const counts = {};
    main.forEach((c) => { counts[c.label] = (counts[c.label] || 0) + 1; });
    const seen = {};
    const labelled = main.map((c) => {
      if (counts[c.label] < 2) return c;
      seen[c.label] = (seen[c.label] || 0) + 1;
      return { ...c, twinIndex: `${seen[c.label]} of ${counts[c.label]}` };
    });
    return { main: labelled, older };
  };
  const ignoredCals = calendars.filter(ignoredCal);
  const cal = split(calendars.filter((c) => !ignoredCal(c)));
  const lst = split(lists);
  const older = [...cal.older, ...lst.older];

  return (
    <section className="cn-section">
      <h3 className="cn-h3">What each calendar and list is for</h3>
      <p className="cn-muted">A calendar or a reminder list says nothing about your life until you say so here — the phone is not "personal" and Outlook is not "work" by themselves. Unclassified stays unknown.</p>
      {data && !containers.length && <div className="cn-empty">No calendars or lists seen yet — they appear after the phone next pushes.</div>}
      {cal.main.length > 0 && <><div className="cn-now-k cn-class-k">Calendars</div><ul className="cn-list cn-class-list">{cal.main.map((c) => <Row key={c.sourceKey} c={c} />)}</ul></>}
      {lst.main.length > 0 && <><div className="cn-now-k cn-class-k">Reminder lists</div><ul className="cn-list cn-class-list">{lst.main.map((c) => <Row key={c.sourceKey} c={c} />)}</ul></>}
      {data && lists.length === 0 && <div className="cn-muted">No reminder lists seen yet. The app builds before Build 11 only send the “Reminders” list, without ids.</div>}
      {ignoredCals.length > 0 && (
        <details className="cn-details">
          <summary>{ignoredCals.length} ignored calendar{ignoredCals.length === 1 ? '' : 's'} — their events no longer reach NEURO</summary>
          <ul className="cn-list cn-class-list">{ignoredCals.map((c) => <Row key={c.sourceKey} c={c} />)}</ul>
        </details>
      )}
      {older.length > 0 && (
        <details className="cn-details">
          <summary>{older.length} older name-only entr{older.length === 1 ? 'y' : 'ies'} (from app builds before ids)</summary>
          <ul className="cn-list cn-class-list">{older.map((c) => <Row key={c.sourceKey} c={c} />)}</ul>
        </details>
      )}
    </section>
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
            <span className="cn-rowtitle">{c.name}</span>
            {c.species && <span className="cn-muted">{c.species}{c.breed ? ` · ${c.breed}` : ''}</span>}
            {c.household === true && <span className="cn-chip cn-chip--firm">household</span>}
            {c.goals && c.goals.length > 0 && <span className="cn-muted">goals: {c.goals.map((g) => g.title).join(', ')}</span>}
            {c.upcoming && c.upcoming.length > 0 && <div className="cn-muted">Coming up (mentions {c.name}): {c.upcoming.map((e) => `${when(e.start)} ${e.title}`).join('; ')}</div>}
            {c.mentionedBy && c.mentionedBy.length > 0 && <div className="cn-muted">Mentioned by {c.mentionedBy.length} open item{c.mentionedBy.length === 1 ? '' : 's'} — a mention, not a link you made</div>}
          </li>
        ))}
      </ul>
      <form className="cn-goalform" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Ember" maxLength={60} aria-label="Companion name" />
        <input className="cn-input--short" value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="Species (dog)" maxLength={60} aria-label="Species" />
        <input className="cn-input--short" value={breed} onChange={(e) => setBreed(e.target.value)} placeholder="Breed (optional)" maxLength={60} aria-label="Breed" />
        <label className="cn-check"><input type="checkbox" checked={household} onChange={(e) => setHousehold(e.target.checked)} /> lives with you</label>
        <button type="submit" className="cn-btn" disabled={busy || !name.trim()}>Create</button>
      </form>
      {made && <div className="cn-muted">Written to {made}.</div>}
    </section>
  );
}

function Coverage({ data }) {
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
          <tr className="cn-tr--unknown"><td>domain unknown</td><td>{data.coverage.unknown.commitments}</td><td>{data.coverage.unknown.tasks}</td><td>{data.coverage.unknown.upcoming}</td><td>—</td><td>{data.coverage.unknown.containers}</td><td>—</td><td>—</td></tr>
        </tbody>
      </table>
      <p className="cn-muted">These are counts of evidence, not judgements. Work leans on a colleague’s People note or a task’s default; nothing is guessed for health, family or money.</p>
      {data.gaps && data.gaps.length > 0 && <div className="cn-error">Couldn’t read: {data.gaps.map((g) => g.input).join(', ')}</div>}
    </section>
  );
}
