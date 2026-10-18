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

export function EventSheet({ event = null, date, today, act, canEdit = false, why = null, onDone, setDirty }) {
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
