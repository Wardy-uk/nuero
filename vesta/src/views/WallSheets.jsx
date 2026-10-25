import { Component, useEffect, useRef, useState } from 'react';
import { Face, dayOfKey, DAYS, DAYS_LONG, MONTHS, MONTHS_LONG, dueLabel, gbp, addDays } from './Wall';

/**
 * Interactive sheets for the cinema wall (18 Oct 2026): household jobs you can
 * complete, reopen, reschedule, reassign and add; read-only views of a person,
 * the weather and energy.
 *
 * ⚠ NOTHING HERE CHANGES LOCAL STATE AS IF IT WERE SAVED. Every change goes
 * through `act` (the wall shell), which calls NEURO's /api/v and re-reads the
 * wall afterwards; a sheet shows "Saving…" until NEURO answers and says so if
 * it refused. A job only leaves the list when the re-read no longer has it.
 * ⚠ Only what /api/v supports is offered: due date, who it is for, done/open,
 * and new jobs. A job's own wording, notes and priority are not editable here.
 */

/**
 * Catches a fault inside a sheet so it closes the sheet and leaves the wall
 * running. An always-on screen must never go blank because one view failed.
 */
export class SheetBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) {
    try { console.warn('[wall sheet] a sheet failed and was closed', err && err.message); } catch { /* no console */ }
    if (this.props.onFail) this.props.onFail();
  }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Today, tomorrow, the coming Saturday, a week on. PURE. */
export function dueChoices(todayKey) {
  const { dow } = dayOfKey(todayKey);
  const toSat = (6 - dow + 7) % 7 || 7;
  return [
    { label: 'Today', date: todayKey },
    { label: 'Tomorrow', date: addDays(todayKey, 1) },
    { label: 'Saturday', date: addDays(todayKey, toSat) },
    { label: 'Next week', date: addDays(todayKey, 7) },
  ];
}

const dateWords = (key) => {
  if (!key) return 'No date';
  const { dow, day, month } = dayOfKey(key);
  return `${DAYS_LONG[dow]} ${day} ${MONTHS_LONG[month]}`;
};

/** One save at a time: busy, the last error, and a guard against double taps. */
function useSaver() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);
  const run = async (fn) => {
    if (inFlight.current) return null;      // a second tap while saving does nothing
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const res = await fn();
      if (!res || res.ok === false) { setError((res && res.error) || 'That did not save.'); return null; }
      return res;
    } catch (e) {
      setError((e && e.message) || 'That did not save.');
      return null;
    } finally { inFlight.current = false; setBusy(false); }
  };
  return { busy, error, run, setError };
}

function SaveState({ busy, error, ok }) {
  if (busy) return <p className="cine__savestate" role="status">Saving…</p>;
  if (error) return <p className="cine__savestate cine__savestate--err" role="alert">{`Not saved — ${error}`}</p>;
  if (ok) return <p className="cine__savestate cine__savestate--ok" role="status">{ok}</p>;
  return null;
}

function DueChips({ todayKey, value, onPick, disabled }) {
  return (
    <div className="cine__chips" role="group" aria-label="Due date">
      {dueChoices(todayKey).map((c) => (
        <button key={c.label} className={`cine__chip2${value === c.date ? ' cine__chip2--on' : ''}`} disabled={disabled} onClick={() => onPick(c.date)}>{c.label}</button>
      ))}
      <label className="cine__chip2 cine__chip2--date">
        Pick a day
        <input type="date" value={value || ''} disabled={disabled} onChange={(e) => onPick(e.target.value || null)} />
      </label>
      <button className={`cine__chip2${!value ? ' cine__chip2--on' : ''}`} disabled={disabled} onClick={() => onPick(null)}>No date</button>
    </div>
  );
}

function PeopleChips({ people, value, onToggle, disabled }) {
  if (!people || !people.length) return null;
  return (
    <div className="cine__chips" role="group" aria-label="Who it is for">
      {people.map((p) => {
        const on = (value || []).includes(p.id);
        return <button key={p.id} className={`cine__chip2${on ? ' cine__chip2--on' : ''}`} aria-pressed={on} disabled={disabled} onClick={() => onToggle(p.id)}>{p.label}</button>;
      })}
    </div>
  );
}

const PRIORITIES = [{ id: 'high', label: 'High' }, { id: 'normal', label: 'Normal' }, { id: 'low', label: 'Low' }, { id: null, label: 'None' }];
function PriorityChips({ value, onPick, disabled }) {
  return (
    <div className="cine__chips" role="group" aria-label="Priority">
      {PRIORITIES.map((p) => (
        <button key={p.label} className={`cine__chip2${(value || null) === p.id ? ' cine__chip2--on' : ''}`} aria-pressed={(value || null) === p.id}
                disabled={disabled} onClick={() => onPick(p.id)}>{p.label}</button>
      ))}
    </div>
  );
}
const priorityWords = (p) => (p === 'high' ? 'High priority' : p === 'low' ? 'Low priority' : p === 'normal' ? 'Normal priority' : null);

/** What is wrong with a job's name/description, or null. PURE. A tap on Save says it — never a silently dead button. */
export function jobProblem({ text = '', notes = '' } = {}, { changed = true } = {}) {
  if (!String(text).trim()) return { field: 'text', message: 'Give the job a name.' };
  if (String(text).trim().length > 500) return { field: 'text', message: 'That name is too long.' };
  if (String(notes || '').trim().length > 2000) return { field: 'notes', message: 'That description is too long.' };
  if (!changed) return { field: null, message: 'Nothing has changed yet.' };
  return null;
}

/** Name and description of a job, edited together; saved only on Save. */
function JobTextEditor({ task, act, onClose, setDirty }) {
  const s = useSaver();
  const [text, setText] = useState(task.text || '');
  const [notes, setNotes] = useState(task.notes || '');
  const [problem, setProblem] = useState(null);
  const changed = text.trim() !== (task.text || '') || notes.trim() !== (task.notes || '');
  useEffect(() => { if (setDirty) setDirty(changed); }, [changed]);
  useEffect(() => () => { if (setDirty) setDirty(false); }, []);
  useEffect(() => { setProblem(null); s.setError(null); }, [text, notes]);
  const save = () => {
    if (s.busy) return;
    const p = jobProblem({ text, notes }, { changed });
    if (p) { setProblem(p); return; }
    const patch = {};
    if (text.trim() !== (task.text || '')) patch.text = text.trim();
    if (notes.trim() !== (task.notes || '')) patch.notes = notes.trim();
    s.run(() => act.task(task.id, patch)).then((res) => { if (res) { if (setDirty) setDirty(false); onClose('Saved.'); } });
  };
  return (
    <div className="cine__form">
      <input className={`cine__textin${problem && problem.field === 'text' ? ' cine__invalid' : ''}`} value={text} maxLength={500} placeholder="What needs doing?"
             disabled={s.busy} autoFocus onChange={(e) => setText(e.target.value)} />
      <textarea className={`cine__textin cine__textarea${problem && problem.field === 'notes' ? ' cine__invalid' : ''}`} value={notes} maxLength={2000}
                placeholder="Description (optional)" disabled={s.busy} onChange={(e) => setNotes(e.target.value)} />
      <div className="cine__formfoot">
        <button className="cine__sheetbtn" disabled={s.busy} onClick={() => { if (setDirty) setDirty(false); onClose(null); }}>Cancel</button>
        <button className="cine__sheetbtn cine__sheetbtn--primary" disabled={s.busy} onClick={save}>{s.busy ? 'Saving…' : 'Save'}</button>
      </div>
      {problem && <p className="cine__savestate cine__savestate--err" role="alert">{problem.message}</p>}
      <SaveState busy={s.busy} error={s.error} />
    </div>
  );
}

/** One job: its full wording, done/undo, reschedule, reassign. */
export function JobSheet({ task, people, today, act, onDone, setDirty }) {
  const s = useSaver();
  const [ok, setOk] = useState(null);
  const [completed, setCompleted] = useState(false);
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <JobTextEditor task={task} act={act} setDirty={setDirty} onClose={(msg) => { setEditing(false); if (msg) setOk(msg); }} />;
  }
  const due = dueLabel(task, today);
  const patch = (fields, msg) => s.run(() => act.task(task.id, fields)).then((r) => { if (r) setOk(msg); return r; });
  const toggle = (id) => {
    const cur = task.assignees || [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    patch({ assignees: next }, 'Saved.');
  };
  return (
    <div className="cine__form">
      <div className="cine__jobfull">
        <button className={`cine__bigcheck${completed ? ' cine__bigcheck--on' : ''}`} disabled={s.busy} aria-pressed={completed}
                onClick={() => (completed
                  ? patch({ done: false }, 'Reopened.').then((r) => { if (r) setCompleted(false); })
                  : patch({ done: true }, 'Done.').then((r) => { if (r) setCompleted(true); }))}
                aria-label={completed ? 'Reopen this job' : 'Mark this job done'}>
          <span aria-hidden="true">✓</span>
        </button>
        <div>
          <p className="cine__jobtext">{task.text}</p>
          {task.notes && <p className="cine__jobnotes">{task.notes}</p>}
          <p className="cine__jobmeta">
            {task.overdue ? <span className="cine__late">Overdue</span> : task.dueToday ? <span className="cine__soon">Due today</span> : due ? <span>{`Due ${due}`}</span> : <span>No date</span>}
            {task.who && task.who.length > 0 && <span>{` · ${task.who.join(' & ')}`}</span>}
            {priorityWords(task.priority) && <span>{` · ${priorityWords(task.priority)}`}</span>}
          </p>
        </div>
      </div>
      {completed ? (
        <div className="cine__formfoot">
          <button className="cine__sheetbtn" disabled={s.busy} onClick={() => patch({ done: false }, 'Reopened.').then((r) => { if (r) setCompleted(false); })}>Undo — not done yet</button>
          <button className="cine__sheetbtn cine__sheetbtn--primary" onClick={onDone}>Close</button>
        </div>
      ) : (
        <>
          <p className="cine__formlabel">When</p>
          <DueChips todayKey={today} value={task.dueDate} disabled={s.busy} onPick={(d) => patch({ dueDate: d }, d ? `Moved to ${dateWords(d)}.` : 'Date cleared.')} />
          {people && people.length > 0 && <p className="cine__formlabel">Who it’s for</p>}
          <PeopleChips people={people} value={task.assignees} disabled={s.busy} onToggle={toggle} />
          <p className="cine__formlabel">Priority</p>
          <PriorityChips value={task.priority} disabled={s.busy} onPick={(pr) => patch({ priority: pr }, pr ? `${priorityWords(pr)}.` : 'Priority cleared.')} />
          <div className="cine__formfoot">
            <button className="cine__sheetbtn" disabled={s.busy} onClick={() => { setOk(null); setEditing(true); }}>Edit name &amp; description</button>
          </div>
        </>
      )}
      <SaveState busy={s.busy} error={s.error} ok={ok} />
    </div>
  );
}

/** A new household job. Saved only on Save; never auto-closed while it holds text. */
export function AddJobSheet({ people, today, act, onSaved, onCancel, setDirty, prefill = '' }) {
  const s = useSaver();
  const [text, setText] = useState(prefill);
  const [dueDate, setDue] = useState(null);
  const [who, setWho] = useState([]);
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState(null);
  const [problem, setProblem] = useState(null);
  const [saved, setSaved] = useState(null);
  const box = useRef(null);
  useEffect(() => { setDirty(Boolean(text.trim() && text.trim() !== prefill.trim()) || Boolean(dueDate) || who.length > 0 || Boolean(notes.trim()) || Boolean(priority)); }, [text, dueDate, who, notes, priority]);
  useEffect(() => () => setDirty(false), []);
  useEffect(() => { if (box.current) box.current.focus(); }, []);
  useEffect(() => { setProblem(null); s.setError(null); }, [text, notes]);
  const save = () => {
    if (s.busy || saved) return;
    const p = jobProblem({ text, notes });
    if (p) { setProblem(p); return; }
    s.run(() => act.addTask({ text: text.trim(), dueDate, assignees: who, notes: notes.trim() || undefined, priority: priority || undefined }))
      .then((res) => {
        if (!res) return;
        setDirty(false);
        setSaved(res.created === false ? 'That job was already on the list — nothing duplicated.' : 'Saved — in NEURO.');
        setTimeout(onSaved, 1100);
      });
  };
  return (
    <div className="cine__form">
      <input ref={box} className={`cine__textin${problem && problem.field === 'text' ? ' cine__invalid' : ''}`} value={text} maxLength={500} placeholder="What needs doing?" disabled={s.busy}
             onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
      <textarea className={`cine__textin cine__textarea${problem && problem.field === 'notes' ? ' cine__invalid' : ''}`} value={notes} maxLength={2000}
                placeholder="Description (optional)" disabled={s.busy} onChange={(e) => setNotes(e.target.value)} />
      <p className="cine__formlabel">When</p>
      <DueChips todayKey={today} value={dueDate} disabled={s.busy} onPick={setDue} />
      {people && people.length > 0 && <p className="cine__formlabel">Who it’s for</p>}
      <PeopleChips people={people} value={who} disabled={s.busy} onToggle={(id) => setWho((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]))} />
      <p className="cine__formlabel">Priority</p>
      <PriorityChips value={priority} disabled={s.busy} onPick={setPriority} />
      <div className="cine__formfoot">
        <button className="cine__sheetbtn" disabled={s.busy} onClick={onCancel}>Cancel</button>
        <button className="cine__sheetbtn cine__sheetbtn--primary" disabled={s.busy || !!saved} onClick={save}>{s.busy ? 'Saving…' : saved ? 'Saved' : 'Save'}</button>
      </div>
      {problem && <p className="cine__savestate cine__savestate--err" role="alert">{problem.message}</p>}
      <SaveState busy={s.busy} error={s.error} ok={saved} />
    </div>
  );
}

/** Every outstanding job, each with its own tick, and Add. */
export function AllJobsSheet({ tasks, done = [], today, act, onOpenJob, onAdd, care = undefined }) {
  const s = useSaver();
  const [ok, setOk] = useState(null);
  const list = (tasks && tasks.tasks) || [];
  return (
    <div className="cine__form">
      {care !== undefined && <CareRows care={care} />}
      {list.length === 0 && <p className="cine__sub">Nothing to do.</p>}
      <ul className="cine__alljobs">
        {list.map((t) => (
          <li key={t.id} className={`cine__alljob${t.overdue ? ' cine__alljob--late' : ''}`}>
            <button className="cine__tick" disabled={s.busy} aria-label={`Mark “${t.text}” done`}
                    onClick={() => s.run(() => act.task(t.id, { done: true })).then((r) => { if (r) setOk(`Done: ${t.short || t.text}`); })}>
              <span aria-hidden="true">✓</span>
            </button>
            <button className="cine__alljobbody" onClick={() => onOpenJob(t)}>
              <span className="cine__jtext cine__jtext--full">{t.text}</span>
              <span className="cine__jmeta">{t.overdue ? <span className="cine__late">Overdue</span> : t.dueToday ? <span className="cine__soon">Due today</span> : dueLabel(t, today) ? `Due ${dueLabel(t, today)}` : ''}{t.who && t.who.length ? ` · ${t.who.join(' & ')}` : ''}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="cine__formfoot">
        <button className="cine__sheetbtn cine__sheetbtn--primary" onClick={onAdd}>+ Add a job</button>
      </div>
      <SaveState busy={s.busy} error={s.error} ok={ok} />
      {done && done.length > 0 && (
        <>
          <p className="cine__formlabel">Done in the last two weeks</p>
          <ul className="cine__alljobs">
            {done.map((t) => (
              <li key={t.id} className="cine__alljob cine__alljob--done">
                <span className="cine__tick cine__tick--done" aria-hidden="true">✓</span>
                <span className="cine__alljobbody cine__alljobbody--static">
                  <span className="cine__jtext cine__jtext--full">{t.text}</span>
                  <span className="cine__jmeta">{`Done ${dateWords(String(t.doneAt).slice(0, 10))}`}{t.who && t.who.length ? ` · ${t.who.join(' & ')}` : ''}</span>
                </span>
                <button className="cine__sheetbtn" disabled={s.busy} onClick={() => s.run(() => act.task(t.id, { done: false })).then((res) => { if (res) setOk(`Reopened: ${t.text}`); })}>Reopen</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** A household member: presence, and the jobs explicitly assigned to them. */
export function MemberSheet({ person, tasks, today, onOpenJob, onAddFor }) {
  const theirs = ((tasks && tasks.tasks) || []).filter((t) => (t.who || []).some((w) => String(w).toLowerCase() === String(person.name).toLowerCase()));
  const state = person.state === 'home' ? 'Home' : person.state === 'out' ? 'Out' : 'Not sure where';
  const companion = person.role === 'companion';
  return (
    <div className="cine__form">
      <div className="cine__member">
        <span className={`cine__avatar cine__avatar--big cine__person--${person.state}`}><Face person={person} /><span className="cine__dot" /></span>
        <div><p className="cine__jobtext">{person.name}</p><p className="cine__jobmeta">{state}</p></div>
      </div>
      {!companion && (
        <>
          <p className="cine__formlabel">{`Jobs for ${person.name}`}</p>
          {theirs.length === 0 ? <p className="cine__sub">None assigned.</p> : (
            <ul className="cine__alljobs">
              {theirs.map((t) => (
                <li key={t.id} className="cine__alljob"><button className="cine__alljobbody" onClick={() => onOpenJob(t)}>
                  <span className="cine__jtext cine__jtext--full">{t.text}</span>
                  <span className="cine__jmeta">{t.overdue ? <span className="cine__late">Overdue</span> : dueLabel(t, today) ? `Due ${dueLabel(t, today)}` : ''}</span>
                </button></li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="cine__note">The diary doesn’t record who an event is for, so events aren’t listed per person.</p>
      <div className="cine__formfoot">
        <button className="cine__sheetbtn cine__sheetbtn--primary" onClick={() => onAddFor(person)}>{companion ? `+ Add a job for ${person.name}` : `+ Add a job`}</button>
      </div>
    </div>
  );
}

/** Read-only weather detail from the station and Home Assistant. */
export function WeatherSheet({ station, dew }) {
  if (!station || !station.known) return <p className="cine__sub">{(station && station.why) || 'The weather station can’t be read just now.'}</p>;
  const rows = [
    station.conditionLabel && ['Conditions', station.conditionLabel],
    station.tempC != null && ['Temperature', `${station.tempC.toFixed(1)}°`],
    station.humidityPct != null && ['Humidity', `${station.humidityPct}%`],
    dew != null && ['Dew point', `${dew.toFixed(1)}°`],
    station.pressureHpa != null && ['Pressure', `${station.pressureHpa} hPa${station.tendency ? ` · ${station.tendency}` : ''}`],
  ].filter(Boolean);
  return (
    <div className="cine__form">
      <dl className="cine__dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {station.verdict && <p className="cine__sub">{station.verdict}</p>}
      {station.indoorLikely && <p className="cine__note">The sensor reads like it’s indoors.</p>}
      <p className="cine__note">Readings from the garden weather station; conditions from Home Assistant. No forecast is held for the wall.</p>
    </div>
  );
}

/** Read-only energy detail: the last 14 days per fuel, yesterday and the month. */
export function EnergySheet({ energy }) {
  const fuels = energy ? Object.entries(energy.fuels || {}) : [];
  const hasData = fuels.some(([, f]) => (f.days || []).some((d) => d.kwh != null));
  if (!energy || !fuels.length || !hasData) {
    return <p className="cine__sub">{energy && !energy.connected ? 'The meters aren’t connected yet, so there is no usage to show.' : 'No meter readings have arrived yet. Usage will appear here once the smart meters report.'}</p>;
  }
  const NAME = { electricity: 'Electricity', gas: 'Gas' };
  return (
    <div className="cine__form">
      {fuels.map(([fuel, f]) => {
        const days = (f.days || []).slice(-14);
        const max = Math.max(0, ...days.map((d) => d.kwh || 0));
        return (
          <section key={fuel} className="cine__efull">
            <p className="cine__formlabel">{NAME[fuel] || fuel}</p>
            <div className="cine__ebars2" role="img" aria-label={`${NAME[fuel] || fuel}, last ${days.length} days`}>
              {days.map((d, i) => {
                // A day key that is not YYYY-MM-DD gets no label rather than crashing the sheet.
                const ok = /^\d{4}-\d{2}-\d{2}$/.test(String(d.day || ''));
                const { dow, day, month } = ok ? dayOfKey(d.day) : {};
                const label = ok ? `${DAYS[dow]} ${day} ${MONTHS[month]}` : '';
                return (
                  <span key={d.day || i} className="cine__ebar2" title={`${label}${label ? ': ' : ''}${d.kwh == null ? 'no reading' : `${d.kwh.toFixed(1)} kWh${d.complete ? '' : ' so far'}`}`}>
                    <span className={`cine__ebar2fill${d.kwh == null ? ' cine__ebar2fill--none' : d.complete ? '' : ' cine__ebar2fill--part'}`}
                          style={{ height: d.kwh == null || !max ? '0' : `${Math.max(4, (d.kwh / max) * 100)}%` }} />
                    <span className="cine__ebar2day">{ok ? DAYS[dow].slice(0, 1) : ''}</span>
                  </span>
                );
              })}
            </div>
            <p className="cine__sub">
              {`Yesterday ${f.yesterday && f.yesterday.kwh != null ? `${f.yesterday.kwh.toFixed(1)} kWh` : '—'}${f.yesterday && f.yesterday.costP != null ? ` (~${gbp(f.yesterday.costP)})` : ''}`}
              {` · This month ${f.month && f.month.kwh != null ? `${Math.round(f.month.kwh)} kWh` : '—'}${f.month && f.month.costP != null ? ` (~${gbp(f.month.costP)})` : ''}`}
            </p>
            {f.freshness && f.freshness.state !== 'usual' && f.freshness.state !== 'none' && <p className="cine__note">Meter data is running late.</p>}
          </section>
        );
      })}
      {energy.monthCostP != null && <p className="cine__sub">{`Both this month ~${gbp(energy.monthCostP)} (estimated)`}</p>}
    </div>
  );
}

// ── Family calendar events (18 Oct 2026) ─────────────────────────────────────
//
// Only events in the shared family Google calendar (`event.editable`) can be
// changed; anything else shows its details and says where it lives. Every
// change goes through `act.event`, which NEURO reads back from Google before it
// answers ok.

/** A Google event id the wall chooses up front (base32hex: 0–9, a–v). */
export function newWallEventId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  const bytes = new Uint8Array(26);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `neu${Array.from(bytes, (b) => alphabet[b % 32]).join('')}`;
}

const hm = (iso) => String(iso || '').slice(11, 16);
const dateOf = (iso) => String(iso || '').slice(0, 10);

/** The form's starting values from an event (or a blank for a day). PURE. */
export function eventForm(event, date) {
  if (!event) return { title: '', date, allDay: false, start: '', end: '', endDate: date, location: '' };
  const allDay = !!event.allDay;
  const first = dateOf(event.start);
  let endDate = allDay && event.end ? addDays(dateOf(event.end), -1) : first;
  if (!endDate || endDate < first) endDate = first;
  return {
    title: event.title || '', date: first, allDay,
    start: allDay ? '' : hm(event.start), end: allDay ? '' : hm(event.end),
    endDate, location: event.location || '',
  };
}

/** What changed, as the server's draft. PURE. */
export function eventPatch(before, after) {
  const out = {};
  if (after.title.trim() !== before.title) out.title = after.title.trim();
  const timing = ['date', 'allDay', 'start', 'end', 'endDate'].some((k) => after[k] !== before[k]);
  if (timing) Object.assign(out, { date: after.date, allDay: after.allDay, ...(after.allDay ? { endDate: after.endDate } : { start: after.start, end: after.end || null }) });
  if (after.location.trim() !== before.location) out.location = after.location.trim();
  return out;
}

const whenWords = (e) => {
  const { dow, day, month } = dayOfKey(dateOf(e.start));
  const d = `${DAYS_LONG[dow]} ${day} ${MONTHS_LONG[month]}`;
  return e.allDay ? `${d} · all day` : `${d} · ${hm(e.start)}${e.end ? `–${hm(e.end)}` : ''}`;
};

/**
 * What is wrong with the form, in words, or null. PURE. Save is never silently
 * disabled for this — a tap says what is missing (18 Oct 2026: on the iPad a
 * name with no start time left Save faded but tappable-looking, and the tap did
 * nothing at all).
 */
export function eventProblem(f, { isNew = true, changed = true } = {}) {
  if (!String(f.title || '').trim()) return { field: 'title', message: 'Give the event a name.' };
  if (!f.date) return { field: 'date', message: 'Pick a day.' };
  if (f.allDay) {
    if (f.endDate && f.endDate < f.date) return { field: 'endDate', message: 'The last day can’t be before the first.' };
  } else {
    if (!f.start) return { field: 'start', message: 'Pick a start time, or choose All day.' };
    if (f.end && f.end <= f.start) return { field: 'end', message: 'It has to end after it starts.' };
  }
  if (!isNew && !changed) return { field: null, message: 'Nothing has changed yet.' };
  return null;
}

export function EventSheet({ event = null, date, today, act, canEdit = false, why = null, onDone, setDirty, live = null }) {
  const s = useSaver();
  const idRef = useRef(null);
  const [start] = useState(() => eventForm(event, date || today));
  const [f, setF] = useState(start);
  const [askDelete, setAskDelete] = useState(false);
  const [problem, setProblem] = useState(null);
  const [saved, setSaved] = useState(null);
  const editable = !event || !!event.editable;
  const isNew = !event;
  const patch = isNew ? null : eventPatch(start, f);
  const changed = isNew ? Boolean(f.title.trim()) : Object.keys(patch).length > 0;
  useEffect(() => { if (setDirty) setDirty(changed); }, [changed]);
  useEffect(() => () => { if (setDirty) setDirty(false); }, []);
  // Any edit clears the last validation message and the last save error.
  useEffect(() => { setProblem(null); s.setError(null); }, [f]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const setDay = (d) => setF((x) => ({ ...x, date: d, endDate: x.endDate < d ? d : x.endDate }));
  // Moving the start keeps the length, so the end never lands before it.
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  const moveStart = (t) => setF((x) => {
    if (!t || !x.start || !x.end || !/^\d\d:\d\d$/.test(t)) return { ...x, start: t };
    const len = toMin(x.end) - toMin(x.start);
    if (len <= 0) return { ...x, start: t };
    return { ...x, start: t, end: fromMin(Math.min(toMin(t) + len, 23 * 60 + 59)) };
  });

  if (event && (!editable || !canEdit)) {
    return (
      <div className="cine__form">
        <p className="cine__big">{event.title}</p>
        <p className="cine__sub">{whenWords(event)}</p>
        {event.location && <p className="cine__sub">{event.location}</p>}
        <CountdownToggle event={event} live={live} act={act} />
        <p className="cine__note">{!editable
          ? 'This is in a phone calendar, not the shared family one. Change it on that phone.'
          : (why || 'This wall can’t change the family calendar.')}</p>
      </div>
    );
  }

  const bad = (field) => (problem && problem.field === field ? ' cine__invalid' : '');
  // Shown for a moment so a save is SEEN to have worked, then the sheet closes.
  const finish = (words) => { if (setDirty) setDirty(false); setSaved(words); setTimeout(onDone, 1200); };
  const save = () => {
    if (s.busy || saved) return;
    const p = eventProblem(f, { isNew, changed });
    if (p) { setProblem(p); return; }
    return s.run(() => {
    if (isNew) {
      if (!idRef.current) idRef.current = newWallEventId();   // the same id on every retry
      const body = { id: idRef.current, title: f.title.trim(), date: f.date, allDay: f.allDay, location: f.location.trim() };
      if (f.allDay) body.endDate = f.endDate; else { body.start = f.start; body.end = f.end || null; }
      return act.event.add(body);
    }
    return act.event.update(event.calendarId, patch);
    }).then((r) => { if (r) finish('Saved — checked with Google.'); });
  };
  const remove = () => s.run(() => act.event.remove(event.calendarId)).then((r) => { if (r) finish('Deleted — checked with Google.'); });

  return (
    <div className="cine__form">
      <input className={`cine__textin${bad('title')}`} value={f.title} maxLength={200} placeholder="What’s happening?" disabled={s.busy} autoFocus={isNew}
             onChange={(e) => set('title')(e.target.value)} />
      <p className="cine__formlabel">Day</p>
      <div className="cine__chips" role="group" aria-label="Day">
        {dueChoices(today).map((c) => (
          <button key={c.label} className={`cine__chip2${f.date === c.date ? ' cine__chip2--on' : ''}`} disabled={s.busy} onClick={() => setDay(c.date)}>{c.label}</button>
        ))}
        <input type="date" className="cine__datein" value={f.date} disabled={s.busy} aria-label="Pick a day"
               onChange={(e) => { if (e.target.value) setDay(e.target.value); }} />
      </div>
      <p className="cine__formlabel">Time</p>
      <div className="cine__chips" role="group" aria-label="Time">
        <button className={`cine__chip2${f.allDay ? ' cine__chip2--on' : ''}`} disabled={s.busy} aria-pressed={f.allDay} onClick={() => set('allDay')(!f.allDay)}>All day</button>
        {f.allDay ? (
          <label className="cine__timelabel">until <input type="date" className={`cine__datein${bad('endDate')}`} value={f.endDate} min={f.date} disabled={s.busy} onChange={(e) => { if (e.target.value) set('endDate')(e.target.value); }} /></label>
        ) : (
          <>
            <label className="cine__timelabel">from <input type="time" className={`cine__timein${bad('start')}`} value={f.start} disabled={s.busy} onChange={(e) => moveStart(e.target.value)} /></label>
            <label className="cine__timelabel">to <input type="time" className={`cine__timein${bad('end')}`} value={f.end} disabled={s.busy} onChange={(e) => set('end')(e.target.value)} /></label>
          </>
        )}
      </div>
      <input className="cine__textin cine__textin--small" value={f.location} maxLength={200} placeholder="Where (optional)" disabled={s.busy}
             onChange={(e) => set('location')(e.target.value)} />
      {event && <CountdownToggle event={event} live={live} act={act} disabled={s.busy} />}
      {event && event.recurring && <p className="cine__note">This repeats. Changes apply to this one only.</p>}
      {askDelete ? (
        <div className="cine__confirm" role="alertdialog" aria-label="Delete this event?">
          <span>{event && event.recurring ? 'Delete this one only?' : 'Delete this event?'}</span>
          <button className="cine__sheetbtn" disabled={s.busy} onClick={() => setAskDelete(false)}>Keep it</button>
          <button className="cine__sheetbtn cine__sheetbtn--danger" disabled={s.busy} onClick={remove}>{s.busy ? 'Deleting…' : 'Delete'}</button>
        </div>
      ) : (
        <div className="cine__formfoot">
          {!isNew && <button className="cine__sheetbtn cine__sheetbtn--danger" disabled={s.busy} onClick={() => setAskDelete(true)}>Delete</button>}
          <button className="cine__sheetbtn cine__sheetbtn--primary" disabled={s.busy || !!saved} onClick={save}>{s.busy ? 'Saving…' : saved ? 'Saved' : 'Save'}</button>
        </div>
      )}
      {problem && <p className="cine__savestate cine__savestate--err" role="alert">{problem.message}</p>}
      <SaveState busy={s.busy} error={s.error} ok={saved} />
      {isNew && <p className="cine__note">Goes into the shared family calendar.</p>}
    </div>
  );
}

// ── Family wall additions (25 Oct 2026) ──────────────────────────────────────
//
// Countdowns, Ember's care, the house controls, the shopping list, notes, tea
// and Nick's walk. The same rules as above: every write goes through `act`,
// shows "Saving…" until NEURO answers, and "Not saved — <why>" if it refused.
// Nothing changes on screen until NEURO's answer (or the re-read) says so.

/**
 * "Count down to this" on an event. Its state is the event's own `countdown`
 * flag — the LIVE copy from the latest wall read when there is one — and,
 * between a press and the re-read, what NEURO just answered.
 */
export function CountdownToggle({ event, live = null, act, disabled = false }) {
  const s = useSaver();
  const [answered, setAnswered] = useState(null);
  if (!event || !event.countdownKey || !act || !act.countdown) return null;
  const fromLive = live && typeof live.countdown === 'boolean' ? live.countdown : null;
  const on = answered != null ? answered : fromLive != null ? fromLive : !!event.countdown;
  const press = () => {
    const want = !on;
    s.run(() => act.countdown({ key: event.countdownKey, title: event.title, date: String(event.start || '').slice(0, 10), on: want }))
      .then((r) => { if (r) setAnswered(want); });
  };
  return (
    <div className="cine__countdown">
      <button className={`cine__chip2${on ? ' cine__chip2--on' : ''}`} aria-pressed={on} disabled={disabled || s.busy} onClick={press}>
        {on ? '✓ Counting down to this' : 'Count down to this'}
      </button>
      <SaveState busy={s.busy} error={s.error} />
    </div>
  );
}

/** Ember's care (read-only): due within a week, or overdue. `care` null = could not read. */
export function CareRows({ care, compact = false }) {
  if (care === undefined) return null;
  if (care === null) return <p className="cine__gap">I couldn’t read Ember’s care list.</p>;
  if (!care.length) return compact ? null : <p className="cine__sub">No care due this week.</p>;
  return (
    <ul className={`cine__care${compact ? ' cine__care--compact' : ''}`} aria-label="Care due">
      {care.map((c) => (
        <li key={c.id || c.title} className={`cine__careitem${c.overdue ? ' cine__careitem--late' : ''}`}>
          <span className="cine__paw" aria-hidden="true">🐾</span>
          <span className="cine__caretext">{c.say || c.title}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── Home: lights, radiators, sockets ───────────────────────────────────── */

const HOME_POLL_MS = 10 * 1000;
const degrees = (c) => (typeof c === 'number' ? `${Math.round(c * 10) / 10}°` : '—');

/**
 * What to say after a house press, from NEURO's answer. PURE.
 * ok:false (a 200 refusal) or a thrown error is "Not saved — <why>"; a write
 * NEURO could not read back (verified:false) is said as such, never as done.
 */
export function homeAnswer(r, err = null) {
  if (err) return { ok: false, text: `Not saved — ${(err && err.message) || 'the house didn’t take it.'}` };
  if (!r || r.ok === false) return { ok: false, text: `Not saved — ${(r && (r.say || r.error)) || 'the house didn’t take it.'}` };
  if (r.verified === false) return { ok: false, text: r.say || 'Sent — the house hasn’t confirmed it yet.' };
  return { ok: true, text: r.say || 'Done.' };
}

/**
 * The house controls. Read on open and every 10 s while open. A press shows
 * "Saving…" then the server's own `say`; the switch on screen only changes when
 * a re-read says it did. One press at a time.
 */
export function HomeSheet({ act }) {
  const [home, setHome] = useState(undefined);  // undefined = first read pending
  const [readErr, setReadErr] = useState(null);
  const [busy, setBusy] = useState(null);       // the key being pressed
  const [msg, setMsg] = useState(null);         // { ok, text }
  const inFlight = useRef(false);
  const reading = useRef(false);
  const read = async () => {
    if (reading.current || !act || !act.home) return;
    reading.current = true;
    try { const r = await act.home.get(); setHome(r); setReadErr(null); } catch (e) { setReadErr((e && e.message) || 'I couldn’t read the house.'); } finally { reading.current = false; }
  };
  useEffect(() => {
    read();
    const t = setInterval(read, HOME_POLL_MS);
    return () => clearInterval(t);
  }, []);
  const press = async (key, entity, action) => {
    if (inFlight.current) return;            // a second tap while saving does nothing
    inFlight.current = true; setBusy(key); setMsg(null);
    try {
      setMsg(homeAnswer(await act.home.control(entity, action)));
    } catch (e) {
      setMsg(homeAnswer(null, e));
    } finally {
      inFlight.current = false; setBusy(null);
      read();
    }
  };
  return <HomeView home={home} readErr={readErr} busy={busy} msg={msg} onPress={press} />;
}

function HomeDevice({ d, busy, onPress }) {
  if (!d || d.state === 'unavailable') {
    return (
      <div className="cine__hdev cine__hdev--dead" aria-label={`${d && d.name}: off at the wall`}>
        <span className="cine__hname">{d && d.name}</span>
        <span className="cine__hstate">off at the wall</span>
      </div>
    );
  }
  const on = d.state === 'on';
  return (
    <button className={`cine__hdev${on ? ' cine__hdev--on' : ''}`} aria-pressed={on} disabled={busy != null}
            aria-label={`${d.name} is ${on ? 'on' : 'off'} — turn it ${on ? 'off' : 'on'}`}
            onClick={() => onPress(d.entity, d.entity, on ? 'off' : 'on')}>
      <span className="cine__hname">{d.name}</span>
      <span className="cine__hstate">{busy === d.entity ? 'Saving…' : on ? 'On' : 'Off'}</span>
    </button>
  );
}

/** PURE view of the house controls. Exported for the render test. */
export function HomeView({ home, readErr = null, busy = null, msg = null, onPress = () => {} }) {
  if (home === undefined && !readErr) return <p className="cine__sub" role="status">Reading the house…</p>;
  if (!home) return <p className="cine__gap">{`I couldn’t read the house — ${readErr || 'no answer'}. Nothing has been changed.`}</p>;
  if (home.known === false) return <p className="cine__gap">{home.why || 'I can’t see the house controls just now.'}</p>;
  const usable = (d) => d && d.state !== 'unavailable';
  const rooms = (home.rooms || []).filter((r) => r.climate || (r.lights || []).some(usable) || (r.sockets || []).some(usable));
  const anyBusy = busy != null;
  return (
    <div className="cine__form cine__home">
      {msg && <p className={`cine__savestate${msg.ok ? ' cine__savestate--ok' : ' cine__savestate--err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      {home.lightsOn > 0 && (
        <button className="cine__sheetbtn cine__sheetbtn--primary cine__alloff" disabled={anyBusy} onClick={() => onPress('all-lights-off', null, 'all-lights-off')}>
          {busy === 'all-lights-off' ? 'Saving…' : `Turn all lights off (${home.lightsOn} on)`}
        </button>
      )}
      {rooms.length === 0 && <p className="cine__sub">Nothing in the house can be controlled from here just now.</p>}
      <div className="cine__hrooms">
        {rooms.map((r) => (
          <section key={r.id || r.name} className="cine__hroom" aria-label={r.name}>
            <p className="cine__formlabel">{r.name}</p>
            {r.climate && (
              <div className="cine__hrad">
                <span className="cine__htemp">{degrees(r.tempC)}</span>
                <span className="cine__hset">{r.targetC != null ? `set to ${degrees(r.targetC)}` : ''}{r.boost && r.boost.on ? ' · boosting' : ''}</span>
                {r.boost && r.boost.on ? (
                  <button className="cine__sheetbtn" disabled={anyBusy} onClick={() => onPress(r.climate, r.climate, 'boost-off')}>
                    {busy === r.climate ? 'Saving…' : `Cancel boost${r.boost.untilHHMM ? ` (until ${r.boost.untilHHMM})` : ''}`}
                  </button>
                ) : (
                  <button className="cine__sheetbtn cine__sheetbtn--warm" disabled={anyBusy} onClick={() => onPress(r.climate, r.climate, 'boost')}>
                    {busy === r.climate ? 'Saving…' : 'Boost 1 hr'}
                  </button>
                )}
              </div>
            )}
            <div className="cine__hdevs">
              {(r.lights || []).map((d) => <HomeDevice key={d.entity} d={d} busy={busy} onPress={onPress} />)}
              {(r.sockets || []).map((d) => <HomeDevice key={d.entity} d={d} busy={busy} onPress={onPress} />)}
            </div>
          </section>
        ))}
      </div>
      <p className="cine__note">Boost warms that room to 21° for an hour; the heating goes back to its own schedule after.</p>
    </div>
  );
}

/* ── Shopping ───────────────────────────────────────────────────────────── */

export function ShoppingSheet({ shopping, act, setDirty }) {
  const s = useSaver();
  const [text, setText] = useState('');
  const [ok, setOk] = useState(null);
  const box = useRef(null);
  useEffect(() => { if (setDirty) setDirty(Boolean(text.trim())); }, [text]);
  useEffect(() => () => { if (setDirty) setDirty(false); }, []);
  if (shopping === null) return <p className="cine__gap">I couldn’t read the shopping list. That isn’t the same as it being empty.</p>;
  const sh = shopping || { exists: false, toBuy: [], bought: [] };
  const add = () => {
    const name = text.trim();
    if (s.busy) return;
    if (!name) { s.setError('type what to add first.'); return; }
    setOk(null);
    s.run(() => act.shopping.add(name)).then((r) => {
      if (!r) return;
      setText(''); if (setDirty) setDirty(false);
      setOk(r.already ? `${name} was already on the list.` : `Added ${name}.`);
      if (box.current) box.current.focus();
    });
  };
  const tick = (name, undo) => { setOk(null); s.run(() => act.shopping.bought(name, undo)).then((r) => { if (r) setOk(undo ? `${name} is back on the list.` : `Got ${name}.`); }); };
  return (
    <div className="cine__form">
      <div className="cine__addrow">
        <input ref={box} className="cine__textin" value={text} maxLength={80} placeholder="Add to the list…" disabled={s.busy}
               onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} aria-label="Add to the shopping list" />
        <button className="cine__sheetbtn cine__sheetbtn--primary" disabled={s.busy} onClick={add}>{s.busy ? 'Saving…' : 'Add'}</button>
      </div>
      <SaveState busy={s.busy} error={s.error} ok={ok} />
      {!sh.exists && <p className="cine__sub">No shopping list yet — add the first thing and it starts.</p>}
      {sh.exists && (sh.toBuy || []).length === 0 && <p className="cine__sub">Nothing to buy.</p>}
      <ul className="cine__alljobs">
        {(sh.toBuy || []).map((i) => (
          <li key={i.name} className="cine__alljob">
            <button className="cine__tick" disabled={s.busy} aria-label={`Got ${i.name}`} onClick={() => tick(i.name, false)}><span aria-hidden="true">✓</span></button>
            <span className="cine__alljobbody cine__alljobbody--static"><span className="cine__jtext cine__jtext--full">{i.name}</span></span>
          </li>
        ))}
      </ul>
      {(sh.bought || []).length > 0 && (
        <>
          <p className="cine__formlabel">Bought today</p>
          <ul className="cine__alljobs">
            {sh.bought.map((i) => (
              <li key={i.name} className="cine__alljob cine__alljob--done">
                <span className="cine__tick cine__tick--done" aria-hidden="true">✓</span>
                <span className="cine__alljobbody cine__alljobbody--static"><span className="cine__jtext cine__jtext--full cine__bought">{i.name}</span></span>
                <button className="cine__sheetbtn" disabled={s.busy} onClick={() => tick(i.name, true)} aria-label={`Undo — ${i.name} not bought`}>Undo</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ── Notes ──────────────────────────────────────────────────────────────── */

/** "14:05", "yesterday 18:20" or "Thu 18:20" for when a note was left. PURE. */
export function noteWhen(at, now = new Date()) {
  const d = new Date(at);
  if (!at || Number.isNaN(d.getTime())) return '';
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return hhmm;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (day(d) === day(y)) return `yesterday ${hhmm}`;
  return `${DAYS[d.getDay()]} ${hhmm}`;
}

export function NotesSheet({ notes, act, setDirty, now = new Date() }) {
  const s = useSaver();
  const [text, setText] = useState('');
  const [ok, setOk] = useState(null);
  useEffect(() => { if (setDirty) setDirty(Boolean(text.trim())); }, [text]);
  useEffect(() => () => { if (setDirty) setDirty(false); }, []);
  if (notes === null) return <p className="cine__gap">I couldn’t read the notes. That isn’t the same as there being none.</p>;
  const list = notes || [];
  const add = () => {
    if (s.busy) return;
    const t = text.trim();
    if (!t) { s.setError('write the note first.'); return; }
    setOk(null);
    s.run(() => act.note.add(t)).then((r) => { if (r) { setText(''); if (setDirty) setDirty(false); setOk('Left on the wall.'); } });
  };
  return (
    <div className="cine__form">
      <div className="cine__addrow">
        <input className="cine__textin" value={text} maxLength={140} placeholder="Leave a note…" disabled={s.busy} aria-label="Leave a note"
               onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="cine__sheetbtn cine__sheetbtn--primary" disabled={s.busy} onClick={add}>{s.busy ? 'Saving…' : 'Leave it'}</button>
      </div>
      <SaveState busy={s.busy} error={s.error} ok={ok} />
      {list.length === 0 && <p className="cine__sub">No notes.</p>}
      <ul className="cine__notes">
        {list.map((n) => (
          <li key={n.id} className="cine__noteitem">
            <div className="cine__notebody">
              <p className="cine__notetext">{n.text}</p>
              <p className="cine__notemeta">{[n.by, noteWhen(n.at, now)].filter(Boolean).join(' · ')}</p>
            </div>
            <button className="cine__sheetbtn" disabled={s.busy} aria-label={`Clear the note “${n.text}”`}
                    onClick={() => { setOk(null); s.run(() => act.note.clear(n.id)).then((r) => { if (r) setOk('Cleared.'); }); }}>Clear</button>
          </li>
        ))}
      </ul>
      <p className="cine__note">Notes clear themselves after two days.</p>
    </div>
  );
}

/* ── Tea ────────────────────────────────────────────────────────────────── */

/** Today and the next six days, with what is set for each. PURE. */
export function teaDays(tea, todayKey) {
  const byDate = new Map(((tea && tea.days) || []).map((d) => [d.date, d.text]));
  if (tea && tea.today && !byDate.has(todayKey)) byDate.set(todayKey, tea.today);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(todayKey, i);
    const { dow, day } = dayOfKey(date);
    return { date, label: i === 0 ? 'Tonight' : i === 1 ? 'Tomorrow' : `${DAYS[dow]} ${day}`, text: byDate.get(date) || '' };
  });
}

export function TeaSheet({ tea, today, act, setDirty }) {
  const s = useSaver();
  const days = teaDays(tea, today);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(days.map((d) => [d.date, d.text])));
  const [saving, setSaving] = useState(null);
  const [ok, setOk] = useState(null);
  const changed = days.filter((d) => (drafts[d.date] || '').trim() !== d.text).length;
  useEffect(() => { if (setDirty) setDirty(changed > 0); }, [changed]);
  useEffect(() => () => { if (setDirty) setDirty(false); }, []);
  if (tea === null) return <p className="cine__gap">I couldn’t read the tea plan.</p>;
  const save = (d) => {
    if (s.busy) return;
    const text = (drafts[d.date] || '').trim();
    setSaving(d.date); setOk(null);
    s.run(() => act.tea(d.date, text || null)).then((r) => {
      setSaving(null);
      if (r) setOk(text ? `${d.label}: ${text}.` : `${d.label} cleared.`);
    });
  };
  const recent = ((tea && tea.recent) || []).slice(0, 6);
  return (
    <div className="cine__form">
      {recent.length > 0 && (
        <>
          <p className="cine__formlabel">Recent — tap to use for tonight</p>
          <div className="cine__chips">
            {recent.map((r) => <button key={r} className="cine__chip2" disabled={s.busy} onClick={() => setDrafts((x) => ({ ...x, [today]: r }))}>{r}</button>)}
          </div>
        </>
      )}
      <ul className="cine__teadays">
        {days.map((d) => {
          const draft = drafts[d.date] || '';
          const dirty = draft.trim() !== d.text;
          return (
            <li key={d.date} className="cine__teaday">
              <span className="cine__tealabel">{d.label}</span>
              <input className="cine__textin cine__textin--small" value={draft} maxLength={80} placeholder="—" disabled={s.busy} aria-label={`Tea ${d.label}`}
                     onChange={(e) => setDrafts((x) => ({ ...x, [d.date]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter' && dirty) save(d); }} />
              <button className={`cine__sheetbtn${dirty ? ' cine__sheetbtn--primary' : ''}`} disabled={s.busy || !dirty} onClick={() => save(d)}>
                {saving === d.date ? 'Saving…' : dirty && !draft.trim() ? 'Clear' : 'Save'}
              </button>
            </li>
          );
        })}
      </ul>
      <SaveState busy={s.busy} error={s.error} ok={ok} />
    </div>
  );
}

/* ── Nick's walk ────────────────────────────────────────────────────────── */

const localHM = (local) => (local ? String(local).slice(11, 16) : '?');

/** The walk sheet. `MapView` is the shared WalkMap (passed in so tests need no Leaflet). */
export function WalkSheet({ walk, MapView = null }) {
  if (walk === null) return <p className="cine__gap">I couldn’t see Nick’s walk just now. That isn’t the same as something being wrong.</p>;
  if (!walk || !walk.active) {
    return <p className="cine__sub">{walk && walk.back ? `Nick’s back from ${walk.back.name} — checked in at ${localHM(walk.back.checkedInAt)}.` : 'Nick isn’t out on a walk.'}</p>;
  }
  const overdue = walk.state === 'overdue';
  const positions = walk.positions || [];
  return (
    <div className="cine__form cine__walk">
      <p className={`cine__walkhead${overdue ? ' cine__walkhead--late' : ''}`}>
        <strong>{walk.name}</strong>{walk.ember ? ` with ${walk.companion || 'Ember'}` : ''}
        {' · '}{overdue ? 'overdue' : walk.state === 'out' ? 'out walking' : 'not started yet'}
      </p>
      {overdue ? (
        <p className="cine__walkalert" role="alert">
          {`Nick planned to be back by ${localHM(walk.due)} and hasn’t checked in${walk.minutesLate != null ? ` — ${walk.minutesLate} min late` : ''}.`}
          {walk.alerted && walk.alerted.sent ? ' NEURO has emailed the route card.' : ''}
          {' Try calling Nick. If you can’t reach Nick and you’re worried, call 999 and ask for the Police.'}
        </p>
      ) : (
        <p className="cine__sub">{`Started ${localHM(walk.start)} · back by ~${localHM(walk.due)}${walk.extended ? ' (extended)' : ''} · an alert goes out at ${localHM(walk.alertAt)} if Nick hasn’t checked in.`}</p>
      )}
      {MapView && <div className="cine__walkmap"><MapView route={walk.route || []} trail={walk.trail || []} emberTrail={walk.emberTrail || []} positions={positions} height="100%" /></div>}
      {positions.length ? (
        <ul className="cine__walkpos">
          {positions.map((p, i) => (
            <li key={i}><strong>{p.label}</strong>{` — last seen ${localHM(p.at)} `}<span className={p.minutesAgo > 30 ? 'cine__late' : ''}>{`(${p.ago})`}</span></li>
          ))}
        </ul>
      ) : <p className="cine__note">No position has reached NEURO yet — out of signal the trackers just stop. That isn’t the same as something being wrong.</p>}
    </div>
  );
}
