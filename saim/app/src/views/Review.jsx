import { useCallback, useEffect, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { useNickNow, stampFor } from '../mobile/useNickNow';
import { describeStorage, clearLocalData, SCHEMA_VERSION } from '../mobile/localStore';
import { pending as pendingOps, subscribe, flush } from '../mobile/outbox';
import Freshness from '../components/Freshness';
import { Lit, LitLabel } from '../../../shared-ui/Lit.jsx';
import './Review.css';

// REVIEW — morning orientation, shutdown, and the weekly reset.
//
// Built from the SAME snapshot as Now, deliberately: two screens fetching two
// payloads is two screens free to disagree about the same day. Which of the
// three modes it opens in is chosen from the clock, because Nick arriving here
// at 08:10 and at 17:40 wants opposite things — but all three are always
// reachable, because a guess about the time of day is a guess.
//
// The local-data controls live here rather than on Capture or Now. This is the
// screen you come to on purpose; the other two are used in a hurry.

const MODES = [
  { id: 'morning', label: 'Orientation' },
  { id: 'shutdown', label: 'Shutdown' },
  { id: 'week', label: 'Week' },
];

function defaultMode(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'morning';
  if (h >= 16) return 'shutdown';
  return 'morning';
}

export default function Review() {
  const { snapshot, freshness, fetchedAt, error, busy, refresh } = useNickNow();
  const [mode, setMode] = useState(() => defaultMode());
  const [storage, setStorage] = useState(null);
  const [queue, setQueue] = useState([]);
  const [clearing, setClearing] = useState(null);

  const reload = useCallback(async () => {
    try { setQueue(await pendingOps()); } catch {}
    try { setStorage(await describeStorage()); } catch (e) { setStorage({ available: false, error: e.message }); }
  }, []);

  useEffect(() => {
    reload();
    return subscribe(() => reload());
  }, [reload]);

  async function onClear(force) {
    setClearing('working');
    try {
      const result = await clearLocalData({ force });
      if (!result.ok) {
        // The refusal is the feature: clearing while things are unsent would
        // delete the only copy of something Nick typed.
        setClearing(`Refused — ${result.unsent} capture${result.unsent === 1 ? '' : 's'} on this device haven't reached NEURO yet.`);
      } else {
        setClearing(force
          ? `Cleared, including ${result.clearedOperations} unsent item${result.clearedOperations === 1 ? '' : 's'}.`
          : 'Cached data cleared. Your queue was left alone.');
      }
    } catch (e) {
      setClearing(`Couldn't clear: ${e.message}`);
    } finally {
      reload();
    }
  }

  const s = snapshot;
  const unsent = queue.length;

  return (
    <section className="rev">
      <h1 className="view__title">Review</h1>
      <p className="view__lede">
        {s ? `Snapshot from ${stampFor(s.generatedAt) || '—'}` : 'Loading…'}
      </p>

      <div className="rev__modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`rev__mode${mode === m.id ? ' rev__mode--on' : ''}`}
            onClick={() => setMode(m.id)}
          >{m.label}</button>
        ))}
      </div>

      <Freshness
        freshness={freshness}
        fetchedAt={fetchedAt}
        error={error}
        busy={busy}
        onRetry={() => refresh()}
      />

      {s && mode === 'morning' && (
        <>
          <LitLabel as="h2" className="rev__h">The shape of today</LitLabel>
          {s.agenda.known === false ? (
            <Lit tone="statement" className="rev__unread">I couldn&rsquo;t read the diary — {s.agenda.why}.</Lit>
          ) : s.agenda.items.length === 0 ? (
            <Lit tone="statement" className="rev__calm">Nothing in the diary{s.agenda.scope !== 'today' ? ` until ${s.agenda.scope}` : ''}.</Lit>
          ) : (
            s.agenda.items.map((e) => (
              <Lit tone="row" className="rev__row" key={e.id}>
                <span className="rev__row-title">{e.title}</span>
                <span className="rev__row-meta">{e.allDay ? 'all day' : String(e.start || '').slice(11, 16)}</span>
              </Lit>
            ))
          )}

          <LitLabel as="h2" className="rev__h">Where your body is</LitLabel>
          {s.readiness && s.readiness.known ? (
            <Lit tone="statement">
              {/* ⚠⚠ THE BARE NUMBER SAID NOTHING ABOUT WHICH WAY IT RUNS. Same
                  defect fixed on iOS's Review on 13 Sep and missed here: a 34pt
                  "62" over the word "ok", where 62 is ELEVATED STRESS —
                  `stress-score` computes `50 - 18z`, so better recovery gives a
                  LOWER number. Read as recovery it is a decent day; read
                  correctly it is a poor one, and nothing on the card said which.

                  `status` was never the field for that job: it only says "ok",
                  "calibrating" or "stale". The brain's own `label` IS the
                  reading, and it licenses nothing — which is why the advice
                  ladder was deleted rather than relabelled. */}
              <div className="rev__bigrow">
                <span className="rev__big">{s.readiness.score ?? '—'}</span>
                <span className="rev__bigunit">
                  {s.readiness.label ? `${s.readiness.label} stress` : 'stress'}
                </span>
              </div>
              <div className="rev__row-meta">
                {s.readiness.status || 'no reading'}
                {/* stress-score's caveats are inherited, never quietly dropped. */}
                {Array.isArray(s.readiness.caveats) && s.readiness.caveats.length > 0 && (
                  <> · {s.readiness.caveats.join(' · ')}</>
                )}
              </div>
            </Lit>
          ) : (
            <Lit tone="statement" className="rev__unread">
              No reading{s.readiness && s.readiness.why ? ` — ${s.readiness.why}` : ''}.
            </Lit>
          )}
        </>
      )}

      {s && mode === 'shutdown' && (
        <>
          <LitLabel as="h2" className="rev__h">Still open</LitLabel>
          {s.tasks.known === false ? (
            <Lit tone="statement" className="rev__unread">I couldn&rsquo;t read your tasks — {s.tasks.why}.</Lit>
          ) : (
            <Lit tone="statement">
              <div className="rev__big">{s.tasks.total}</div>
              <div className="rev__row-meta">open task{s.tasks.total === 1 ? '' : 's'} in NEURO</div>
            </Lit>
          )}

          <LitLabel as="h2" className="rev__h">Captured today</LitLabel>
          {s.captures.known === false ? (
            <Lit tone="statement" className="rev__unread">I couldn&rsquo;t read your captures — {s.captures.why}.</Lit>
          ) : s.captures.items.length === 0 ? (
            <Lit tone="statement" className="rev__calm">Nothing captured recently.</Lit>
          ) : (
            s.captures.items.slice(0, 5).map((c) => (
              <Lit tone="row" className="rev__row" key={c.id}>
                <span className="rev__row-title">{c.title || c.preview || c.path}</span>
                <span className="rev__row-meta">{stampFor(c.updatedAt)}</span>
              </Lit>
            ))
          )}

          <LitLabel as="h2" className="rev__h">Anything still on this device</LitLabel>
          {unsent === 0 ? (
            <Lit tone="statement" className="rev__calm">Nothing waiting — everything reached NEURO.</Lit>
          ) : (
            /* ⚠ NOT A GAP. `rev__unread` means "I couldn't read this"; this is
               something NEURO has not been TOLD yet — she can see it perfectly
               well and he can act on it, there is a button right there.
               Amber-means-unread is the one colour whose meaning is fixed across
               both apps, and spending it on a thing that is merely pending is
               how it stops meaning anything. Her colour, like any live state. */
            <Lit className="rev__pending">
              {unsent} item{unsent === 1 ? '' : 's'} still on this device.
              <button type="button" className="rev__btn" onClick={() => flush({ force: true })}>Send now</button>
            </Lit>
          )}
        </>
      )}

      {s && mode === 'week' && (
        <>
          <LitLabel as="h2" className="rev__h">This week</LitLabel>
          {s.weeklyTarget ? (
            <Lit tone="statement">
              {/* Four states, kept apart on purpose: `unset` is not a target of
                  zero, and `unknown` is not a target that was missed. */}
              <div className="rev__big">
                {s.weeklyTarget.done ?? '—'}
                {s.weeklyTarget.target ? ` / ${s.weeklyTarget.target}` : ''}
              </div>
              <div className="rev__row-meta">{s.weeklyTarget.say || s.weeklyTarget.state}</div>
            </Lit>
          ) : (
            <Lit tone="statement" className="rev__unread">No weekly target reading.</Lit>
          )}
          <WeeklyTargetSetter onSet={() => refresh()} />

          <LitLabel as="h2" className="rev__h">People in the diary</LitLabel>
          {s.people.known === false ? (
            <Lit tone="statement" className="rev__unread">I couldn&rsquo;t read this — {s.people.why}.</Lit>
          ) : s.people.items.length === 0 ? (
            <Lit tone="statement" className="rev__calm">Nobody matched.</Lit>
          ) : (
            s.people.items.map((p) => (
              <Lit tone="row" className="rev__row" key={p.id}>
                <span className="rev__row-title">{p.name}</span>
                <span className="rev__row-meta">{p.meeting}</span>
              </Lit>
            ))
          )}
        </>
      )}

      {/* ── This device ───────────────────────────────────────────────────── */}
      <LitLabel as="h2" className="rev__h">This device</LitLabel>
      <Lit tone="statement" className="rev__storage">
        <p className="rev__note">
          This app keeps a small working set in its own browser storage, on this device only, so
          it still works with no connection. <strong>It is not encrypted</strong>, and the browser
          or operating system may clear it &mdash; for example when the app has gone unused or the
          device runs low on space. Your PIN is not kept in this store.
          NEURO remains the only canonical copy of anything.
        </p>
        {storage && storage.available === false && (
          <p className="err">Local storage is unavailable{storage.error ? ` — ${storage.error}` : ''}. Offline capture will not work.</p>
        )}
        {storage && storage.available && (
          <ul className="rev__stats">
            <li>Store version {SCHEMA_VERSION}</li>
            <li>Snapshot cached {storage.snapshotFetchedAt ? stampFor(storage.snapshotFetchedAt) : 'never'}</li>
            <li>{storage.operations.queued} queued · {storage.operations.failed} failed · {storage.operations.needsAttention} need attention</li>
            <li>{storage.receipts} receipt{storage.receipts === 1 ? '' : 's'} kept</li>
            {storage.estimate && storage.estimate.usage != null && (
              <li>{Math.round(storage.estimate.usage / 1024)} KB used</li>
            )}
          </ul>
        )}
        <div className="rev__clear">
          <button type="button" className="rev__btn" onClick={() => onClear(false)}>Clear cached data</button>
          <button type="button" className="rev__btn rev__btn--danger" onClick={() => onClear(true)}>
            Clear everything, including unsent
          </button>
        </div>
        {clearing && <p className="rev__row-meta">{clearing === 'working' ? 'Clearing…' : clearing}</p>}
        <p className="rev__note rev__note--small">
          This app does not read your Obsidian vault or a Notion workspace directly. NEURO ingests
          and indexes those, and this app syncs only the derived working set above.
          Nothing is sent in the background &mdash; the queue goes when this app is open.
        </p>
      </Lit>
    </section>
  );
}

// ── Setting the weekly target ───────────────────────────────────────────────
//
// GET/POST /api/weekly-target. The number is Nick's. NEURO's proposal is shown
// WITH its basis so it can be argued with, and choosing it only fills the box —
// nothing is set without the Set press. Once a target exists this does not ask
// again; "Change" is there if he goes looking for it (the route allows it).
//
// Its own fetch rather than apiFetch, because the answers worth reading are in
// the body: setTarget's refusal sentence (400) and the kiosk's `not-a-door`.
async function readJson(path, options = {}) {
  const res = await fetch(apiUrl(path), { ...options, headers: authHeaders(path, options.headers) });
  let body = null;
  try { body = await res.json(); } catch { /* nothing to read */ }
  return { ok: res.ok, status: res.status, body };
}

function WeeklyTargetSetter({ onSet }) {
  const [state, setState] = useState({ loading: true, error: null, notHere: false, data: null });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await readJson('/api/weekly-target');
      if (r.status === 403 && r.body?.reason === 'not-a-door') {
        return setState({ loading: false, error: null, notHere: true, data: null });
      }
      if (!r.ok) return setState({ loading: false, error: r.body?.error || `${r.status}`, notHere: false, data: null });
      setState({ loading: false, error: null, notHere: false, data: r.body });
    } catch (e) {
      setState({ loading: false, error: e.message, notHere: false, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    if (saving || value === '') return;
    setSaving(true);
    setRefusal(null);
    try {
      const r = await readJson('/api/weekly-target', {
        method: 'POST',
        body: JSON.stringify({ target: Number(value), source: 'manual' }),
      });
      if (!r.ok) {
        // setTarget reports in words ("target must be a whole number").
        setRefusal(r.body?.error || `${r.status}`);
      } else {
        setEditing(false);
        setValue('');
        onSet?.();
        await load();
      }
    } catch (err) {
      setRefusal(err.message);
    }
    setSaving(false);
  }

  const { loading, error, notHere, data } = state;
  if (loading) return null;
  if (notHere) return <Lit tone="statement" className="rev__calm">Setting the weekly target isn&rsquo;t available on this screen.</Lit>;
  if (error) return <Lit tone="statement" className="rev__unread">Couldn&rsquo;t check the weekly target &mdash; {error}.</Lit>;
  if (!data) return null;

  const isSet = data.target != null;
  if (isSet && !editing) {
    return (
      <div className="rev__target-change">
        <button type="button" className="rev__btn" onClick={() => { setEditing(true); setValue(String(data.target)); }}>
          Change this week&rsquo;s target
        </button>
      </div>
    );
  }

  const suggestion = data.suggestion;

  return (
    <Lit as="form" className="rev__target" onSubmit={submit}>
      <div className="rev__row-title">
        {isSet ? 'Change this week’s target' : 'No target set for this week'}
      </div>
      {!isSet && (
        <p className="rev__note">Unset is not a target of zero &mdash; it means nobody has said what the week is for yet.</p>
      )}

      {suggestion == null ? (
        <p className="rev__note">No proposal &mdash; past weeks couldn&rsquo;t be read.</p>
      ) : suggestion.value == null ? (
        <p className="rev__note">No proposal yet &mdash; {suggestion.basis}.</p>
      ) : (
        <p className="rev__note">
          Proposal: {suggestion.value}, the {suggestion.basis}
          {Array.isArray(suggestion.weeks) && suggestion.weeks.length > 0 && ` (${suggestion.weeks.join(', ')})`}.{' '}
          <button type="button" className="rev__btn" onClick={() => setValue(String(suggestion.value))}>
            Use {suggestion.value}
          </button>
        </p>
      )}

      <div className="rev__target-row">
        <input
          className="rev__target-input"
          type="number"
          inputMode="numeric"
          min="1"
          max={data.maxTarget || undefined}
          step="1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Tasks to close this week"
          placeholder="tasks"
        />
        <button type="submit" className="rev__btn" disabled={saving || value === ''}>
          {saving ? 'Setting…' : 'Set'}
        </button>
        {isSet && (
          <button type="button" className="rev__btn" onClick={() => { setEditing(false); setRefusal(null); }}>Cancel</button>
        )}
      </div>
      {refusal && <p className="err rev__note">Not set &mdash; {refusal}</p>}
    </Lit>
  );
}
