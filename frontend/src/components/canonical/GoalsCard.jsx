import React, { useState } from 'react';
import { useCanonical, postCanonical, DOMAIN_IDS, DOMAIN_LABELS, IMPORTANCE_IDS, IMPORTANCE_LABELS, ImportanceChip, when } from './canonicalUi';
import './GoalsCard.css';

/**
 * Goals and intentions (13 Oct 2026).
 *
 * A goal has a TYPE — its part of life (Fitness, Health, Leisure, Projects…) —
 * and, if Nick chooses one, a MEASURE: the one thing NEURO counts it by (hikes a
 * month, a blood-pressure average, weight, a project finished). With a measure
 * NEURO says how it is moving and lists LEVERS: other things it can see that
 * bear on the goal, each with an action. Every word of that comes from
 * /api/canonical/goals/progress; this card only renders it.
 *
 * Only what Nick stores is shown. NEURO never makes a goal up, never picks a
 * measure for one, and a goal never becomes a reminder by itself.
 */

const STATUS_WORDS = { active: 'Active', paused: 'Paused', achieved: 'Achieved', dropped: 'Dropped' };
const STATE_WORDS = {
  met: 'At target', 'on-track': 'On track', behind: 'Behind', 'not-moving': 'Not moving',
  'moving-away': 'Going the wrong way', unknown: 'Can’t tell yet',
};
const NEEDS_HELP = new Set(['behind', 'not-moving', 'moving-away']);

export default function GoalsCard({ data, busy, act }) {
  const progress = useCanonical('/api/canonical/goals/progress');
  const catalogue = useCanonical('/api/canonical/goals/measures');
  const measures = (catalogue.data && catalogue.data.measures) || [];
  const goals = data ? data.goals || [] : [];
  const live = goals.filter((g) => g.status === 'active' || g.status === 'paused');
  const done = goals.filter((g) => g.status === 'achieved' || g.status === 'dropped');
  const byGoal = new Map(((progress.data && progress.data.goals) || []).map((p) => [p.goalId, p]));

  // Every write reloads both the goal list and its progress.
  const run = (fn) => act(async () => { await fn(); await progress.reload(); });
  const update = (g, body) => run(() => postCanonical(`/api/canonical/goals/${encodeURIComponent(g.id)}`, body));

  return (
    <section className="cn-section">
      <h3 className="cn-h3">Goals and intentions</h3>
      {data && !goals.length && <div className="cn-empty">None stored. NEURO only shows goals you write down here — it never makes them up, and a goal never becomes a reminder by itself.</div>}
      {progress.error && <div className="cn-error">Couldn’t read how goals are moving — {progress.error}. This is not “no progress”.</div>}
      {progress.data && progress.data.gaps && progress.data.gaps.length > 0 && (
        <div className="cn-muted">Couldn’t read: {progress.data.gaps.map((g) => g.input).join(', ')} — goals that rely on them say “can’t tell”.</div>
      )}
      <ul className="cn-list">
        {live.map((g) => (
          <GoalRow key={g.id} g={g} p={byGoal.get(g.id)} measures={measures} busy={busy} update={update} />
        ))}
      </ul>
      <AddGoal measures={measures} busy={busy} run={run} />
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

function GoalRow({ g, p, measures, busy, update }) {
  const [editing, setEditing] = useState(false);
  const prog = p && p.progress;
  const levers = (p && p.levers) || [];
  const label = g.measure ? (measures.find((m) => m.kind === g.measure.kind) || {}).label || g.measure.kind : null;
  return (
    <li className={`cn-row cn-goal${g.status === 'paused' ? ' cn-goal--paused' : ''}`}>
      <span className="cn-rowtitle">{g.title}</span>
      {g.domains.length
        ? g.domains.map((d) => <span key={d.domain} className="cn-chip cn-chip--firm">{DOMAIN_LABELS[d.domain] || d.domain}</span>)
        : <span className="cn-chip cn-chip--unknown">no type</span>}
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
        <button type="button" className="cn-btn" disabled={busy} onClick={() => setEditing((v) => !v)}>{g.measure ? 'Change measure' : 'Measure it'}</button>
        <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { reviewed: true })}>Reviewed</button>
        {g.status === 'active'
          ? <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'paused' })}>Pause</button>
          : <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'active' })}>Resume</button>}
        <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'achieved' })}>Achieved</button>
        <button type="button" className="cn-btn" disabled={busy} onClick={() => update(g, { status: 'dropped' })}>Drop</button>
      </span>
      {g.description && <div className="cn-muted cn-goal-desc">{g.description}</div>}

      {g.status === 'active' && (
        <div className="cn-goal-progress">
          {!g.measure && <div className="cn-muted">Not measured — NEURO only knows about items you link to it. “Measure it” lets it track a number.</div>}
          {g.measure && !prog && <div className="cn-muted">Measured by {label}. Reading…</div>}
          {g.measure && prog && <GoalProgress prog={prog} label={label} />}
          {levers.length > 0 && <Levers levers={levers} open={!!prog && NEEDS_HELP.has(prog.state)} />}
        </div>
      )}
      {editing && (
        <MeasureEditor initial={g.measure} domain={g.domains[0] && g.domains[0].domain} measures={measures} busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (measure) => { await update(g, { measure }); setEditing(false); }} />
      )}
    </li>
  );
}

export function GoalProgress({ prog, label }) {
  return (
    <div className="cn-goal-measure">
      <span className={`cn-goal-state cn-goal-state--${prog.state}`}>{STATE_WORDS[prog.state] || prog.state}</span>
      <span>{prog.line}</span>
      <div className="cn-muted cn-goal-src">
        Measured by {label || prog.label}{prog.targetText ? ` · target ${prog.targetText}` : ''}{prog.by ? ` by ${prog.by}` : ''}{prog.source ? ` · ${prog.source}` : ''}
      </div>
    </div>
  );
}

export function Levers({ levers, open }) {
  return (
    <details className="cn-goal-levers" open={open}>
      <summary>What would help ({levers.length})</summary>
      <ul>
        {levers.map((l) => (
          <li key={l.id} className={`cn-lever cn-lever--${l.level}`}>
            <div className="cn-lever-title">{l.title}</div>
            {l.finding && <div className="cn-muted">{l.finding}</div>}
            <div className="cn-lever-action">{l.action}</div>
            <div className="cn-muted cn-goal-src">from {l.source}{l.basis ? ` · ${l.basis}` : ''}</div>
          </li>
        ))}
      </ul>
      <div className="cn-muted cn-goal-src">These are things NEURO can see that bear on the goal — not a diagnosis, and not a claim about what caused anything.</div>
    </details>
  );
}

/** Fields for one measure. Empty kind = not measured. */
export function MeasureEditor({ initial = null, domain = null, measures, busy, onSave, onCancel }) {
  const [kind, setKind] = useState(initial ? initial.kind : '');
  const [target, setTarget] = useState(initial && typeof initial.target === 'number' ? String(initial.target) : '');
  const [sys, setSys] = useState(initial && initial.target && initial.target.sys ? String(initial.target.sys) : '');
  const [dia, setDia] = useState(initial && initial.target && initial.target.dia ? String(initial.target.dia) : '');
  const [period, setPeriod] = useState((initial && initial.period) || 'month');
  const [projectId, setProjectId] = useState((initial && initial.projectId) || '');
  const [by, setBy] = useState((initial && initial.by) || '');
  const [err, setErr] = useState(null);
  const def = measures.find((m) => m.kind === kind) || null;
  const projects = useCanonical(kind === 'project' ? '/api/projects/personal' : '/api/canonical/goals/measures');
  const projectList = kind === 'project' && projects.data ? projects.data.projects || [] : [];
  // Measures that fit the goal's type are offered first.
  const ordered = [...measures].sort((a, b) => (a.domain === domain ? 0 : 1) - (b.domain === domain ? 0 : 1));

  const build = () => {
    if (!kind) return null;
    const m = { kind };
    if (def && def.target === 'count') { m.target = Number(target); m.period = period; }
    else if (def && def.target === 'pair') m.target = { sys: Number(sys), dia: Number(dia) };
    else if (def && def.target === 'number') m.target = Number(target);
    else if (def && def.target === 'project') m.projectId = projectId;
    if (by) m.by = by;
    return m;
  };
  const save = async (e) => {
    e.preventDefault(); setErr(null);
    try { await onSave(build()); } catch (x) { setErr(x.message); }
  };

  return (
    <form className="cn-goalform cn-measureform" onSubmit={save}>
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Measure">
        <option value="">not measured</option>
        {ordered.map((m) => <option key={m.kind} value={m.kind}>{m.label}{m.unit ? ` (${m.unit})` : ''}</option>)}
      </select>
      {def && def.target === 'count' && (<>
        <input className="cn-input--tiny" type="number" min="1" max="31" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="How many" placeholder="4" />
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Per">
          {(def.periods || []).map((p) => <option key={p} value={p}>a {p}</option>)}
        </select>
      </>)}
      {def && def.target === 'pair' && (<>
        <input className="cn-input--tiny" type="number" value={sys} onChange={(e) => setSys(e.target.value)} aria-label="Systolic target" placeholder="130" />
        <span>/</span>
        <input className="cn-input--tiny" type="number" value={dia} onChange={(e) => setDia(e.target.value)} aria-label="Diastolic target" placeholder="80" />
        <span className="cn-muted">mmHg or lower</span>
      </>)}
      {def && def.target === 'number' && (<>
        <input className="cn-input--short" type="number" step="any" min={def.min ?? undefined} max={def.max ?? undefined} value={target}
          onChange={(e) => setTarget(e.target.value)} aria-label={`${def.label} target`} placeholder={`target ${def.unit || ''}`} />
        <span className="cn-muted">{def.unit}</span>
      </>)}
      {def && def.target === 'project' && (
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">choose a personal project…</option>
          {projectList.map((p) => <option key={p.projectId} value={p.projectId}>{p.displayTitle || p.name}</option>)}
        </select>
      )}
      {kind && <input type="date" value={by} onChange={(e) => setBy(e.target.value)} aria-label="By (optional)" title="By when (optional) — without one NEURO only says which way it is moving" />}
      <button type="submit" className="cn-btn" disabled={busy}>Save measure</button>
      {onCancel && <button type="button" className="cn-btn" onClick={onCancel}>Cancel</button>}
      {def && <div className="cn-muted cn-goal-src">Read from {def.source}.</div>}
      {err && <div className="cn-error">Not saved — {err}</div>}
    </form>
  );
}

function AddGoal({ measures, busy, run }) {
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [importance, setImportance] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [measuring, setMeasuring] = useState(false);
  const [measure, setMeasure] = useState(null);

  const add = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    run(async () => {
      await postCanonical('/api/canonical/goals', {
        title, domains: domain ? [domain] : null, importance: importance || null, reviewDate: reviewDate || null,
        ...(measure ? { measure } : {}),
      });
      setTitle(''); setDomain(''); setImportance(''); setReviewDate(''); setMeasure(null); setMeasuring(false);
    });
  };

  return (
    <div className="cn-goal-add">
      <form className="cn-goalform" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. hike four times a month" maxLength={300} aria-label="Goal" />
        <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Type of goal">
          <option value="">type…</option>
          {DOMAIN_IDS.filter((d) => d !== 'work').map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
        </select>
        <select value={importance} onChange={(e) => setImportance(e.target.value)} aria-label="Importance">
          <option value="">importance not said</option>
          {IMPORTANCE_IDS.filter((i) => i !== 'work-critical').map((i) => <option key={i} value={i}>{IMPORTANCE_LABELS[i]}</option>)}
        </select>
        <input type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} aria-label="Review date" title="Review date (optional)" />
        {!measuring && <button type="button" className="cn-btn" onClick={() => setMeasuring(true)}>+ measure</button>}
        {measure && <span className="cn-chip cn-chip--firm">measured by {(measures.find((m) => m.kind === measure.kind) || {}).label || measure.kind}</span>}
        <button type="submit" className="cn-btn" disabled={busy || !title.trim()}>Add</button>
      </form>
      {measuring && (
        <MeasureEditor initial={measure} domain={domain || null} measures={measures} busy={busy}
          onCancel={() => { setMeasuring(false); setMeasure(null); }}
          onSave={async (m) => { setMeasure(m); setMeasuring(false); }} />
      )}
    </div>
  );
}
