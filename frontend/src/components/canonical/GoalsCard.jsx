import React, { useState } from 'react';
import {
  useCanonical, postCanonical, DOMAIN_IDS, DOMAIN_LABELS, IMPORTANCE_IDS, IMPORTANCE_LABELS, ImportanceChip, when,
  Headline, StatTiles, Stat, TileGrid, Tile, Fold, PrimaryAction, Pill, dayLabel, Group,
} from './canonicalUi';
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
// A state's tone is a MEANING (docs/design-rules.md): good = there or getting
// there, warn = worth a look. Never "bad" — a goal moving slowly is not a fault.
const STATE_TONE = { met: 'good', 'on-track': 'good', behind: 'warn', 'not-moving': 'warn', 'moving-away': 'warn', unknown: 'neutral' };
const NEEDS_HELP = new Set(['behind', 'not-moving', 'moving-away']);
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

export default function GoalsCard({ data, busy, act }) {
  const progress = useCanonical('/api/canonical/goals/progress');
  const catalogue = useCanonical('/api/canonical/goals/measures');
  const [adding, setAdding] = useState(false);
  const measures = (catalogue.data && catalogue.data.measures) || [];
  const goals = data ? data.goals || [] : [];
  const live = goals.filter((g) => g.status === 'active' || g.status === 'paused');
  const done = goals.filter((g) => g.status === 'achieved' || g.status === 'dropped');
  const byGoal = new Map(((progress.data && progress.data.goals) || []).map((p) => [p.goalId, p]));

  // Every write reloads both the goal list and its progress.
  const run = (fn) => act(async () => { await fn(); await progress.reload(); });
  const update = (g, body) => run(() => postCanonical(`/api/canonical/goals/${encodeURIComponent(g.id)}`, body));

  // Tallies of the SERVER's states — nothing here judges a goal.
  const active = live.filter((g) => g.status === 'active');
  const paused = live.length - active.length;
  const known = !!progress.data;
  const stateOf = (g) => { const p = byGoal.get(g.id); return p && p.progress ? p.progress.state : null; };
  const onTrack = active.filter((g) => ['met', 'on-track'].includes(stateOf(g))).length;
  const help = active.filter((g) => NEEDS_HELP.has(stateOf(g))).length;
  const cantTell = active.filter((g) => g.measure && stateOf(g) === 'unknown').length;
  const unmeasured = active.filter((g) => !g.measure).length;
  const gaps = progress.data && progress.data.gaps && progress.data.gaps.length > 0
    ? `Couldn’t read: ${progress.data.gaps.map((g) => g.input).join(', ')} — goals that rely on them say “can’t tell”.` : null;

  const head = !data
    ? { tone: 'neutral', pill: 'Reading', text: 'Reading your goals…' }
    : !goals.length
      ? { tone: 'neutral', pill: 'None', text: 'No goals stored.', detail: 'NEURO only shows goals you write down here — it never makes them up, and a goal never becomes a reminder by itself.' }
      : progress.error
        ? { tone: 'warn', pill: 'Can’t tell', text: `Couldn’t read how goals are moving — ${progress.error}. This is not “no progress”.` }
        : help > 0
          ? { tone: 'warn', pill: 'Needs a look', text: `${help} of ${n(active.length, 'active goal', 'active goals')} ${help === 1 ? 'is' : 'are'} not on track.` }
          : known && onTrack > 0 && cantTell === 0
            ? { tone: 'good', pill: 'On track', text: 'Every measured goal is on track or at target.' }
            : { tone: 'plan', pill: 'Active', text: `${n(active.length, 'active goal', 'active goals')}${paused ? `, ${paused} paused` : ''}.` };

  return (
    <section className="cn-section">
      <h3 className="cn-h3">Goals and intentions</h3>
      <Headline tone={head.tone} pill={head.pill} detail={head.detail || gaps}>{head.text}</Headline>
      {goals.length > 0 && (
        <StatTiles>
          <Stat v={active.length} l="active" />
          <Stat v={known ? onTrack : null} l="on track" tone={onTrack ? 'good' : undefined} />
          <Stat v={known ? help : null} l="need a look" tone={help ? 'warn' : undefined} />
          {cantTell > 0 && <Stat v={cantTell} l="can’t tell yet" />}
          <Stat v={unmeasured} l="not measured" title="NEURO only knows about items you link to these. “Measure it” lets it track a number." />
          {paused > 0 && <Stat v={paused} l="paused" title="A paused goal lends nothing to anything." />}
        </StatTiles>
      )}
      <div className="cn-actions">
        <PrimaryAction onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : 'Add a goal'}</PrimaryAction>
      </div>
      {adding && <AddGoal measures={measures} busy={busy} run={run} />}
      {live.length > 0 && (
        <TileGrid wide>
          {live.map((g) => <GoalRow key={g.id} g={g} p={byGoal.get(g.id)} measures={measures} busy={busy} update={update} />)}
        </TileGrid>
      )}
      {done.length > 0 && (
        <Fold title="Achieved or dropped" meta={`${done.length}`}>
          <ul className="cn-list">
            {done.map((g) => (
              <li key={g.id} className="cn-row"><span className="cn-rowtitle">{g.title}</span> <span className="cn-muted">{STATUS_WORDS[g.status]}</span>
                <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => update(g, { status: 'active' })}>Make active again</button></li>
            ))}
          </ul>
        </Fold>
      )}
    </section>
  );
}

function GoalRow({ g, p, measures, busy, update }) {
  const [editing, setEditing] = useState(false);
  const prog = p && p.progress;
  const levers = (p && p.levers) || [];
  const label = g.measure ? (measures.find((m) => m.kind === g.measure.kind) || {}).label || g.measure.kind : null;
  const facts = [
    g.reviewDate ? `review ${dayLabel(g.reviewDate)}` : null,
    g.lastReviewedAt ? `reviewed ${when(g.lastReviewedAt)}` : null,
    g.links && g.links.length > 0 ? `${g.links.length} linked` : null,
  ].filter(Boolean).join(' · ');
  const foot = (
    <>
      {g.domains.length
        ? g.domains.map((d) => <span key={d.domain} className="cn-chip cn-chip--firm">{DOMAIN_LABELS[d.domain] || d.domain}</span>)
        : <span className="cn-chip cn-chip--unknown">no type</span>}
      <ImportanceChip value={g.importance} basis="declared" />
      {g.status === 'paused' && <span className="cn-chip cn-chip--soft" title="A paused goal lends nothing to anything">paused</span>}
      {facts && <span>{facts}</span>}
    </>
  );
  return (
    <Tile title={g.title} why={g.description || undefined} foot={foot}>
      {g.status === 'active' && (
        <div className="cn-goal-progress">
          {!g.measure && <span className="cn-tile-sub" title="NEURO only knows about items you link to it. “Measure it” lets it track a number.">Not measured</span>}
          {g.measure && !prog && <span className="cn-tile-sub">Measured by {label}. Reading…</span>}
          {g.measure && prog && <GoalProgress prog={prog} label={label} />}
          {levers.length > 0 && <Levers levers={levers} open={!!prog && NEEDS_HELP.has(prog.state)} />}
        </div>
      )}
      <Fold title="Change">
        <div className="cn-goal-actions">
          <select value={g.importance || ''} disabled={busy} aria-label="How much it matters to you"
            onChange={(e) => update(g, { importance: e.target.value || null })}>
            <option value="">importance not said</option>
            {IMPORTANCE_IDS.filter((i) => i !== 'work-critical').map((i) => <option key={i} value={i}>{IMPORTANCE_LABELS[i]}</option>)}
          </select>
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => setEditing((v) => !v)}>{g.measure ? 'Change measure' : 'Measure it'}</button>
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => update(g, { reviewed: true })}>Reviewed</button>
          {g.status === 'active'
            ? <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => update(g, { status: 'paused' })}>Pause</button>
            : <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => update(g, { status: 'active' })}>Resume</button>}
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => update(g, { status: 'achieved' })}>Achieved</button>
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => update(g, { status: 'dropped' })}>Drop</button>
        </div>
        {editing && (
          <MeasureEditor initial={g.measure} domain={g.domains[0] && g.domains[0].domain} measures={measures} busy={busy}
            onCancel={() => setEditing(false)}
            onSave={async (measure) => { await update(g, { measure }); setEditing(false); }} />
        )}
      </Fold>
    </Tile>
  );
}

/** The state as a badge and the server's line; where the number came from is on hover. */
export function GoalProgress({ prog, label }) {
  const src = `Measured by ${label || prog.label}${prog.targetText ? ` · target ${prog.targetText}` : ''}${prog.by ? ` by ${prog.by}` : ''}${prog.source ? ` · ${prog.source}` : ''}`;
  return (
    <div className="cn-goal-measure" title={src}>
      <Pill tone={STATE_TONE[prog.state] || 'neutral'}>{STATE_WORDS[prog.state] || prog.state}</Pill>
      <span className="cn-tile-sub">{prog.line}</span>
    </div>
  );
}

export function Levers({ levers, open }) {
  return (
    <details className="cn-goal-levers" open={open}>
      <summary>What would help ({levers.length})</summary>
      <div className="cn-group-why">Things NEURO can see that bear on the goal — not a diagnosis, and not a claim about what caused anything.</div>
      <ul className="cn-act-lines">
        {levers.map((l) => (
          <li key={l.id} className={`cn-lever cn-lever--${l.level}`}
            title={[l.finding, `from ${l.source}`, l.basis].filter(Boolean).join(' · ')}>
            <div className="cn-lever-title">{l.title}</div>
            <div className="cn-lever-action">{l.action}</div>
          </li>
        ))}
      </ul>
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

/**
 * The goals measured by `kinds`, shown on the page whose data they rely on
 * (Outdoor for hikes, Projects for a project). Same payload as the Goals card;
 * `match` narrows it (e.g. one project). Renders nothing when no goal applies —
 * a page does not advertise goals you have not set.
 */
export function GoalNote({ kinds, match = null }) {
  const { data, error } = useCanonical(`/api/canonical/goals/progress?kinds=${encodeURIComponent(kinds)}`);
  if (error) return <div className="cn-muted" data-testid="goal-note-error">Couldn’t read your goal — this is not “no progress”.</div>;
  const rows = ((data && data.goals) || []).filter((r) => !r.paused && (!match || match(r)));
  return <GoalNoteView rows={rows} />;
}

export function GoalNoteView({ rows }) {
  if (!rows || !rows.length) return null;
  return (
    <Group label={rows.length === 1 ? 'Your goal' : 'Your goals'}>
      <TileGrid testid="goal-note">
        {rows.map((r) => {
          const p = r.progress || {};
          const top = (r.levers || [])[0];
          return (
            <Tile key={r.goalId} title={r.title} why={p.source || undefined}
              sub={<><Pill tone={STATE_TONE[p.state] || 'neutral'}>{STATE_WORDS[p.state] || 'Can’t tell yet'}</Pill> {p.line || ''}</>}
              foot={top ? `→ ${top.action}` : null} />
          );
        })}
      </TileGrid>
    </Group>
  );
}
