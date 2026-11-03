import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';
import './LifeLoops.css';

/**
 * Life loops (3 Nov 2026): people rhythm, letters to future me, the decision
 * log with look-back, and the logbook + Choose for me. All over
 * /api/life-loops; each one also reaches Next steps when it is due.
 */

function get(path) {
  return fetch(apiUrl(path)).then((r) => r.json()).catch(() => ({ ok: false, error: 'No answer from NEURO.' }));
}
function post(path, body) {
  return fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({ ok: false, error: 'No answer from NEURO.' }));
}
function useLoad(path) {
  const [data, setData] = useState(null);
  const load = useCallback(() => { get(path).then(setData); }, [path]);
  useEffect(() => { load(); }, [load]);
  return [data, load];
}
function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); }
function plusDays(n) {
  const d = new Date(`${todayStr()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function niceDate(iso) {
  if (!iso) return '';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// ── People rhythm ────────────────────────────────────────────────────────────

export function RhythmCard() {
  const [data, load] = useLoad('/api/life-loops/rhythm');
  const [form, setForm] = useState({ name: '', everyDays: '30', askAbout: '', lastAt: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true); setErr('');
    const r = await post('/api/life-loops/rhythm', { name: form.name, everyDays: Number(form.everyDays), askAbout: form.askAbout || null, lastAt: form.lastAt || null });
    setBusy(false);
    if (r.ok) { setForm({ name: '', everyDays: '30', askAbout: '', lastAt: '' }); load(); } else setErr(r.error);
  };
  const act = async (path, name) => { const r = await post(path, { name }); if (r.ok) load(); else setErr(r.error); };

  const people = (data && data.people) || [];
  return (
    <div className="ll-card">
      <div className="ll-head">
        <h2 className="ll-h2">Keeping in touch</h2>
        <span className="ll-sub">How often you want to see or call each person. When it’s been long enough they show in Next steps.</span>
      </div>
      {data && data.ok === false && <div className="ll-gap">{data.error}</div>}
      {people.length === 0 && data && data.ok !== false && <p className="ll-empty">Nobody yet — add someone below.</p>}
      <div className="ll-list">
        {people.map((p) => (
          <div key={p.name} className={`ll-row${p.due ? ' is-due' : ''}`}>
            <div className="ll-row-text">
              <span className="ll-title">{p.name}</span>
              <span className="ll-why">
                Every {p.everyDays} days · {p.lastAt ? `last ${niceDate(p.lastAt)}` : 'no catch-up recorded'} · {p.due ? (p.daysOverdue ? `${p.daysOverdue} days over` : 'due') : `next ${niceDate(p.dueOn)}`}
                {p.askAbout ? ` · ask about: ${p.askAbout}` : ''}
              </span>
            </div>
            <button className="ll-btn ll-btn-primary" onClick={() => act('/api/life-loops/rhythm/caught-up', p.name)}>Caught up</button>
            <button className="ll-btn ll-btn-quiet" onClick={() => act('/api/life-loops/rhythm/remove', p.name)}>Stop tracking</button>
          </div>
        ))}
      </div>
      <div className="ll-form">
        <label>Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Every <input type="number" min="1" max="730" value={form.everyDays} onChange={(e) => setForm({ ...form, everyDays: e.target.value })} style={{ width: 70 }} /> days</label>
        <label>Last caught up <input type="date" value={form.lastAt} max={todayStr()} onChange={(e) => setForm({ ...form, lastAt: e.target.value })} /></label>
        <label>Ask about <input value={form.askAbout} onChange={(e) => setForm({ ...form, askAbout: e.target.value })} placeholder="optional" /></label>
        <button className="ll-btn ll-btn-primary" disabled={busy || !form.name.trim()} onClick={add}>Add</button>
      </div>
      {err && <div className="ll-err">{err}</div>}
    </div>
  );
}

// ── Future me: letters + decisions ───────────────────────────────────────────

function LetterWriter({ onSealed }) {
  const [body, setBody] = useState('');
  const [openOn, setOpenOn] = useState(plusDays(182));
  const [err, setErr] = useState('');
  const seal = async () => {
    setErr('');
    const r = await post('/api/life-loops/letters', { body, openOn });
    if (r.ok) { setBody(''); onSealed(); } else setErr(r.error);
  };
  return (
    <div className="ll-card">
      <div className="ll-head"><h2 className="ll-h2">Letter to future me</h2><span className="ll-sub">Sealed until the day you pick, then it comes back in Next steps.</span></div>
      <textarea className="ll-textarea" rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Dear me, in six months…" />
      <div className="ll-form">
        <span className="ll-sub">Bring it back in</span>
        {[[30, '1 month'], [182, '6 months'], [365, '1 year']].map(([n, l]) => (
          <button key={n} className={`ll-chip${openOn === plusDays(n) ? ' is-on' : ''}`} onClick={() => setOpenOn(plusDays(n))}>{l}</button>
        ))}
        <input type="date" value={openOn} min={plusDays(1)} onChange={(e) => setOpenOn(e.target.value)} />
        <button className="ll-btn ll-btn-primary" disabled={!body.trim()} onClick={seal}>Seal it</button>
      </div>
      <span className="ll-sub">Will come back on {niceDate(openOn)}.</span>
      {err && <div className="ll-err">{err}</div>}
    </div>
  );
}

function Letters({ focus }) {
  const [data, load] = useLoad('/api/life-loops/letters');
  const [opened, setOpened] = useState({});
  const letters = (data && data.letters) || [];
  const open = async (id) => { const r = await post(`/api/life-loops/letters/${encodeURIComponent(id)}/open`); if (r.ok) { setOpened({ ...opened, [id]: r.letter.body }); load(); } };
  useEffect(() => { if (focus && letters.some((l) => l.id === focus && l.arrived && !opened[focus])) open(focus); }, [focus, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const arrived = letters.filter((l) => l.arrived);
  const sealed = letters.filter((l) => !l.arrived);
  return (
    <>
      <LetterWriter onSealed={load} />
      <div className="ll-card">
        <div className="ll-head"><h2 className="ll-h2">From past you</h2><span className="ll-sub">{arrived.length} arrived · {sealed.length} still sealed</span></div>
        {arrived.length === 0 && <p className="ll-empty">Nothing has arrived yet.</p>}
        {arrived.map((l) => (
          <div key={l.id} className={`ll-letter${focus === l.id ? ' is-focus' : ''}`}>
            <span className="ll-why">Written {niceDate(l.writtenOn)} · arrived {niceDate(l.openOn)}</span>
            {opened[l.id] || l.opened ? <p className="ll-letter-body">{opened[l.id] || l.body}</p>
              : <button className="ll-btn ll-btn-primary" onClick={() => open(l.id)}>Read it</button>}
            {(opened[l.id] || l.opened) && !l.kept && <button className="ll-btn ll-btn-secondary" onClick={async () => { await post(`/api/life-loops/letters/${encodeURIComponent(l.id)}/keep`, { kept: true }); load(); }}>Keep</button>}
            {l.kept && <span className="ll-why">Kept</span>}
          </div>
        ))}
        {sealed.map((l) => (
          <div key={l.id} className="ll-row">
            <div className="ll-row-text"><span className="ll-title">Sealed</span><span className="ll-why">Written {niceDate(l.writtenOn)} · opens {niceDate(l.openOn)}</span></div>
            <button className="ll-btn ll-btn-quiet" onClick={async () => { await post(`/api/life-loops/letters/${encodeURIComponent(l.id)}/remove`); load(); }}>Remove</button>
          </div>
        ))}
      </div>
    </>
  );
}

const OUTCOMES = [['right', 'I was right'], ['mixed', 'Mixed'], ['wrong', 'I was wrong'], ['too-early', 'Too early to say']];

function Decisions({ focus }) {
  const [data, load] = useLoad('/api/life-loops/decisions');
  const [text, setText] = useState('');
  const [lessons, setLessons] = useState({});
  const [err, setErr] = useState('');
  const decisions = (data && data.decisions) || [];
  const today = todayStr();
  const due = decisions.filter((d) => !d.outcome && d.lookBackOn && d.lookBackOn <= today);
  const later = decisions.filter((d) => !d.outcome && !(d.lookBackOn && d.lookBackOn <= today));
  const done = decisions.filter((d) => d.outcome);
  const add = async () => { const r = await post('/api/life-loops/decisions', { text }); if (r.ok) { setText(''); load(); } else setErr(r.error); };
  const review = async (id, outcome) => { const r = await post(`/api/life-loops/decisions/${id}/review`, { outcome, lesson: lessons[id] || null }); if (r.ok) load(); else setErr(r.error); };
  const setDate = async (id, date) => { const r = await post(`/api/life-loops/decisions/${id}/look-back`, { date }); if (r.ok) load(); else setErr(r.error); };

  return (
    <div className="ll-card">
      <div className="ll-head"><h2 className="ll-h2">Decision log</h2><span className="ll-sub">Each decision comes back on its look-back day (30 days unless you change it) so you can see whether you were right.</span></div>
      <div className="ll-form">
        <input className="ll-grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="What did you decide?" />
        <button className="ll-btn ll-btn-primary" disabled={!text.trim()} onClick={add}>Log it</button>
      </div>
      {err && <div className="ll-err">{err}</div>}
      {due.length > 0 && <h3 className="ll-h3">To look back on · {due.length}</h3>}
      {due.map((d) => (
        <div key={d.id} className={`ll-letter${focus === d.id ? ' is-focus' : ''}`}>
          <span className="ll-title">{d.text}</span>
          <span className="ll-why">Decided {niceDate(d.madeOn)} · looking back {niceDate(d.lookBackOn)}</span>
          <input className="ll-grow" value={lessons[d.id] || ''} onChange={(e) => setLessons({ ...lessons, [d.id]: e.target.value })} placeholder="What did you learn? (optional)" />
          <div className="ll-form">{OUTCOMES.map(([o, l]) => <button key={o} className="ll-chip" onClick={() => review(d.id, o)}>{l}</button>)}</div>
        </div>
      ))}
      {later.length > 0 && <h3 className="ll-h3">Coming back later · {later.length}</h3>}
      {later.map((d) => (
        <div key={d.id} className="ll-row">
          <div className="ll-row-text"><span className="ll-title">{d.text}</span><span className="ll-why">Decided {niceDate(d.madeOn)}</span></div>
          <label className="ll-sub">Look back <input type="date" value={d.lookBackOn || ''} min={plusDays(1)} onChange={(e) => setDate(d.id, e.target.value)} /></label>
        </div>
      ))}
      {done.length > 0 && <h3 className="ll-h3">Looked back · {done.length}</h3>}
      {done.slice(0, 20).map((d) => (
        <div key={d.id} className="ll-row">
          <div className="ll-row-text"><span className="ll-title">{d.text}</span><span className="ll-why">{OUTCOMES.find(([o]) => o === d.outcome)?.[1] || d.outcome}{d.lesson ? ` · ${d.lesson}` : ''}</span></div>
        </div>
      ))}
      {decisions.length === 0 && data && <p className="ll-empty">No decisions logged yet. Capture “decision: …” or log one here.</p>}
    </div>
  );
}

export function FutureMePanel({ context = null } = {}) {
  return (
    <div className="ll-page">
      <h1 className="ll-h1">Future me</h1>
      <p className="ll-sub">Notes for the person you will be: letters that come back on a day you pick, and decisions you check later.</p>
      <div className="ll-cols">
        <div className="ll-col"><Letters focus={context && context.letterId} /></div>
        <div className="ll-col"><Decisions focus={context && context.decisionId} /></div>
      </div>
    </div>
  );
}

// ── Logbook + Choose for me ──────────────────────────────────────────────────

const PRESETS = ['restaurant', 'film', 'book', 'coffee'];

export function ChooseForMePanel() {
  const [log, loadLog] = useLoad('/api/life-loops/logbook');
  const [kind, setKind] = useState('restaurant');
  const [rules, setRules] = useState({ minRating: 7, skipDays: 14, weight: 0.6 });
  const [turn, setTurn] = useState(0);
  const [choice, setChoice] = useState(null);
  const [entry, setEntry] = useState({ kind: 'restaurant', title: '', rating: '', place: '', loggedOn: todayStr() });
  const [err, setErr] = useState('');

  const kinds = [...new Set([...PRESETS, ...((log && log.kinds) || []).map((k) => k.kind)])];
  useEffect(() => {
    get(`/api/life-loops/choose?kind=${encodeURIComponent(kind)}&minRating=${rules.minRating}&skipDays=${rules.skipDays}&weight=${rules.weight}&turn=${turn}`).then(setChoice);
  }, [kind, rules, turn, log]);

  const add = async () => {
    setErr('');
    const r = await post('/api/life-loops/logbook', { ...entry, rating: entry.rating === '' ? null : Number(entry.rating) });
    if (r.ok) { setEntry({ ...entry, title: '', rating: '', place: '' }); loadLog(); } else setErr(r.error);
  };

  return (
    <div className="ll-page">
      <h1 className="ll-h1">Logbook &amp; choose for me</h1>
      <p className="ll-sub">Log what you ate, watched, read or drank, with a rating. Choose for me picks from your own ratings by plain rules — no AI.</p>
      <div className="ll-cols">
        <div className="ll-col">
          <div className="ll-card">
            <div className="ll-head"><h2 className="ll-h2">Choose for me</h2></div>
            <div className="ll-form">{kinds.map((k) => <button key={k} className={`ll-chip${kind === k ? ' is-on' : ''}`} onClick={() => { setKind(k); setTurn(0); }}>{k}</button>)}</div>
            {choice && choice.pick ? (
              <div className="ll-pick">
                <span className="ll-pick-title">{choice.pick.title}</span>
                <span className="ll-why">Rated {choice.pick.rating}/10 · last {niceDate(choice.pick.last)}{choice.pick.place ? ` · ${choice.pick.place}` : ''} · {choice.qualifying} of {choice.pool.length} qualify</span>
                <button className="ll-btn ll-btn-primary" onClick={() => setTurn(turn + 1)}>Another idea</button>
              </div>
            ) : <p className="ll-empty">{choice && choice.pool && choice.pool.length ? 'Nothing qualifies under these rules — loosen them.' : `Nothing logged as “${kind}” yet.`}</p>}
            <div className="ll-rules">
              <label>Minimum rating <input type="range" min="1" max="10" value={rules.minRating} onChange={(e) => setRules({ ...rules, minRating: Number(e.target.value) })} /> {rules.minRating}</label>
              <label>Skip if done in the last <input type="range" min="0" max="90" value={rules.skipDays} onChange={(e) => setRules({ ...rules, skipDays: Number(e.target.value) })} /> {rules.skipDays}d</label>
              <label>Rating vs time since <input type="range" min="0" max="100" value={Math.round(rules.weight * 100)} onChange={(e) => setRules({ ...rules, weight: Number(e.target.value) / 100 })} /> {Math.round(rules.weight * 100)}%</label>
            </div>
            {choice && choice.pool && choice.pool.length > 0 && (
              <>
                <h3 className="ll-h3">Why this one</h3>
                {choice.top.map((t, i) => <div key={t.title} className="ll-why">{i + 1}. {t.title} — rated {t.rating} · {t.since} days ago · score {t.score}</div>)}
                {choice.pool.filter((p) => !p.qualifies).slice(0, 8).map((p) => <div key={p.title} className="ll-why ll-out">✕ {p.title} — {p.why}</div>)}
              </>
            )}
          </div>
        </div>
        <div className="ll-col">
          <div className="ll-card">
            <div className="ll-head"><h2 className="ll-h2">Log something</h2></div>
            <div className="ll-form">
              <label>Kind <input list="ll-kinds" value={entry.kind} onChange={(e) => setEntry({ ...entry, kind: e.target.value })} style={{ width: 120 }} /></label>
              <datalist id="ll-kinds">{kinds.map((k) => <option key={k} value={k} />)}</datalist>
              <label className="ll-grow">Name <input value={entry.title} onChange={(e) => setEntry({ ...entry, title: e.target.value })} /></label>
              <label>Rating <input type="number" min="1" max="10" value={entry.rating} onChange={(e) => setEntry({ ...entry, rating: e.target.value })} style={{ width: 60 }} />/10</label>
              <label>Where <input value={entry.place} onChange={(e) => setEntry({ ...entry, place: e.target.value })} placeholder="optional" /></label>
              <label>When <input type="date" value={entry.loggedOn} max={todayStr()} onChange={(e) => setEntry({ ...entry, loggedOn: e.target.value })} /></label>
              <button className="ll-btn ll-btn-primary" disabled={!entry.title.trim()} onClick={add}>Log it</button>
            </div>
            {err && <div className="ll-err">{err}</div>}
            <h3 className="ll-h3">Recent</h3>
            {((log && log.entries) || []).slice(0, 30).map((e) => (
              <div key={e.id} className="ll-row">
                <div className="ll-row-text"><span className="ll-title">{e.title}</span><span className="ll-why">{e.kind} · {e.rating != null ? `${e.rating}/10` : 'not rated'} · {niceDate(e.loggedOn)}{e.place ? ` · ${e.place}` : ''}</span></div>
                <button className="ll-btn ll-btn-quiet" onClick={async () => { await post(`/api/life-loops/logbook/${encodeURIComponent(e.id)}/remove`); loadLog(); }}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
