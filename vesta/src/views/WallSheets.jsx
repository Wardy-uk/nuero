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

/** One job: its full wording, done/undo, reschedule, reassign. */
export function JobSheet({ task, people, today, act, onDone }) {
  const s = useSaver();
  const [ok, setOk] = useState(null);
  const [completed, setCompleted] = useState(false);
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
          <p className="cine__jobmeta">
            {task.overdue ? <span className="cine__late">Overdue</span> : task.dueToday ? <span className="cine__soon">Due today</span> : due ? <span>{`Due ${due}`}</span> : <span>No date</span>}
            {task.who && task.who.length > 0 && <span>{` · ${task.who.join(' & ')}`}</span>}
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
  const box = useRef(null);
  useEffect(() => { setDirty(Boolean(text.trim() && text.trim() !== prefill.trim()) || Boolean(dueDate) || who.length > 0); }, [text, dueDate, who]);
  useEffect(() => () => setDirty(false), []);
  useEffect(() => { if (box.current) box.current.focus(); }, []);
  const save = () => s.run(() => act.addTask({ text: text.trim(), dueDate, assignees: who })).then((r) => { if (r) { setDirty(false); onSaved(); } });
  return (
    <div className="cine__form">
      <input ref={box} className="cine__textin" value={text} maxLength={200} placeholder="What needs doing?" disabled={s.busy}
             onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) save(); }} />
      <p className="cine__formlabel">When</p>
      <DueChips todayKey={today} value={dueDate} disabled={s.busy} onPick={setDue} />
      {people && people.length > 0 && <p className="cine__formlabel">Who it’s for</p>}
      <PeopleChips people={people} value={who} disabled={s.busy} onToggle={(id) => setWho((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]))} />
      <div className="cine__formfoot">
        <button className="cine__sheetbtn" disabled={s.busy} onClick={onCancel}>Cancel</button>
        <button className="cine__sheetbtn cine__sheetbtn--primary" disabled={s.busy || !text.trim()} onClick={save}>{s.busy ? 'Saving…' : 'Save'}</button>
      </div>
      <SaveState busy={false} error={s.error} />
    </div>
  );
}

/** Every outstanding job, each with its own tick, and Add. */
export function AllJobsSheet({ tasks, today, act, onOpenJob, onAdd }) {
  const s = useSaver();
  const [ok, setOk] = useState(null);
  const list = (tasks && tasks.tasks) || [];
  return (
    <div className="cine__form">
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
