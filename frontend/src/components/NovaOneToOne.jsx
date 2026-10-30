import React, { useState } from 'react';
import { apiUrl } from '../api';
import './NovaOneToOne.css';

/*
 * NOVA's 1-2-1 Overview, on NEURO's People board (30 Oct 2026).
 *
 * Every number here is NOVA's own (`GET /api/1to1/overview` → the bridge → the SAME
 * `getOne21Overview()` the NOVA screen reads). Nothing is recomputed in this file, so the
 * board and NOVA cannot disagree about who is overdue, stalled or still to log. Booking,
 * moving and cancelling stay NEURO's existing card buttons.
 */

const fmtDay = (s) => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');

const ragClass = (r) => `nova121-rag-${r === 'green' || r === 'amber' || r === 'red' ? r : 'grey'}`;
const rateClass = (r) => (r === null || r === undefined ? 'nova121-rag-grey'
  : r >= 80 ? 'nova121-rag-green' : r >= 50 ? 'nova121-rag-amber' : 'nova121-rag-red');

/** NOVA's status pill, same order as the NOVA screen: stalled outranks overdue. */
export function novaStatus(a) {
  if (a.stalled) return { label: 'Stalled', tone: 'red' };
  if (a.overdue) return { label: 'Overdue', tone: 'red' };
  if (a.awaitingPrep) return { label: 'Awaiting prep', tone: 'amber' };
  if (a.prepSubmitted) return { label: 'Prep in', tone: 'green' };
  if (a.dueThisWeek) return { label: 'Due this week', tone: 'teal' };
  if (a.nextDate) return { label: 'Scheduled', tone: 'grey' };
  return { label: 'Not scheduled', tone: 'muted' };
}

function Tile({ label, value, tone, hint }) {
  return (
    <div className="nova121-tile" title={hint}>
      <div className="nova121-tile-label">{label}</div>
      <div className={`nova121-tile-value nova121-tone-${tone}`}>{value}</div>
    </div>
  );
}

/** The summary tiles. `state` is `{ ok, data, error }` from the board's fetch. */
export function NovaOverviewTiles({ state, onRefresh }) {
  if (!state) return null;
  if (!state.ok) {
    // Said out loud: a missing strip would read as a team with nothing to worry about.
    return <div className="nova121-unavailable">NOVA 1-2-1 health not available: {state.error || 'NOVA could not be asked'}.</div>;
  }
  const s = state.data.summary;
  const n = (v, bad) => (v > 0 ? bad : 'plain');
  return (
    <div className="nova121-overview">
      <div className="nova121-overview-head">
        <span className="nova121-overview-title">1-2-1 health <span className="nova121-src">from NOVA</span></span>
        <span className="nova121-overview-sub">{s.total} agents</span>
        {onRefresh && <button className="nova121-refresh" onClick={onRefresh} title="Re-read from NOVA">↻</button>}
      </div>
      <div className="nova121-tiles">
        <Tile label="Overdue" value={s.overdue} tone={n(s.overdue, 'red')} />
        <Tile label="Stalled" value={s.stalled} tone={n(s.stalled, 'red')} hint="Opened but never completed — blocks prep and the next booking" />
        <Tile label="Awaiting prep" value={s.awaitingPrep} tone={n(s.awaitingPrep, 'amber')} />
        <Tile label="To confirm" value={s.awaitingConfirmation} tone={n(s.awaitingConfirmation, 'teal')} hint="Closed per a 1-2-1 recording — confirmed at the next 1-2-1. Not counted as delivered until then." />
        <Tile label="Over 8 weeks" value={s.cadenceRed} tone={n(s.cadenceRed, 'red')} hint="Last held 1-2-1 more than 8 weeks ago — the hard limit." />
        <Tile label="6–8 weeks" value={s.cadenceAmber} tone={n(s.cadenceAmber, 'amber')} hint="Last held 1-2-1 more than 6 weeks ago — past the target, not yet the limit." />
        <Tile label="Write-up overdue" value={s.writeUpOverdue} tone={n(s.writeUpOverdue, 'red')} hint="Last 1-2-1 not imported, or not logged in PeopleHR, within 2 working days of being held." />
        <Tile label="To log in PeopleHR" value={s.peoplehrPending} tone={n(s.peoplehrPending, 'amber')} hint="Held 1-2-1s not yet ticked as written up. NOVA cannot see PeopleHR; this counts your own ticks." />
        <Tile label="Due this week" value={s.dueThisWeek} tone="teal" />
        <Tile label="Scheduled" value={s.scheduled} tone="plain" />
        <Tile label="Never scheduled" value={s.neverScheduled} tone={n(s.neverScheduled, 'amber')} />
        <Tile label="Action delivery" value={s.deliveryRate === null ? '—' : `${s.deliveryRate}%`}
          tone={s.deliveryRate === null ? 'plain' : s.deliveryRate >= 80 ? 'green' : s.deliveryRate >= 50 ? 'amber' : 'red'} />
      </div>
    </div>
  );
}

/**
 * The NOVA block on one person's card. `agent` is that person's overview row, or
 * undefined when NOVA does not track them (renders nothing — not tracked is not "all fine").
 */
export function NovaCardBlock({ agent: a, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  if (!a) return null;
  const status = novaStatus(a);

  const toggleHr = async (sessionId, logged) => {
    setSaving(true); setError(null);
    try {
      const r = await fetch(apiUrl(`/api/1to1/peoplehr/${sessionId}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ logged }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) setError(j.error || `Not saved (${r.status})`);
    } catch (e) { setError(`Not saved — ${e.message}`); }
    // NOVA decides which session the box acts on next, so re-read rather than guess.
    if (onChanged) await onChanged();
    setSaving(false);
  };

  // PeopleHR box: acts on the oldest held 1-2-1 still to log, else the latest (ticked).
  let hr;
  if (a.lastSessionId === null || (a.hrTargetSessionId === null && !a.measured)) {
    hr = <span className="nova121-muted" title={a.lastSessionId === null ? 'No 1-2-1 held yet' : `Last 1-2-1 (${fmtDay(a.lastDate)}) was before the 9 Oct reset`}>—</span>;
  } else {
    const sid = a.hrTargetSessionId ?? a.lastSessionId;
    const logged = a.hrTargetSessionId === null;
    const on = logged ? a.lastDate : a.hrTargetDate;
    hr = (
      <label className="nova121-hr" title={logged ? `${fmtDay(on)} 1-2-1 is logged in PeopleHR — click to undo` : `Tick once the ${fmtDay(on)} 1-2-1 is written up in PeopleHR`}>
        <input type="checkbox" checked={logged} disabled={saving} onChange={(e) => toggleHr(sid, e.target.checked)} />
        <span className={logged ? 'nova121-muted' : 'nova121-tone-amber'}>
          {saving ? 'Saving…' : logged ? 'Logged' : `To log · ${fmtDay(on)}`}{a.hrToLog > 1 ? ` (+${a.hrToLog - 1})` : ''}
        </span>
      </label>
    );
  }

  return (
    <div className="nova121-card" onClick={(e) => e.stopPropagation()}>
      <div className="nova121-card-head">
        <span className="nova121-src">NOVA</span>
        <span className={`nova121-pill nova121-pill-${status.tone}`}>{status.label}</span>
      </div>
      <div className="nova121-grid">
        <span className="nova121-k">Next</span>
        <span className={a.overdue ? 'nova121-tone-red nova121-strong' : a.bookedLate ? 'nova121-tone-amber nova121-strong' : ''}>
          {a.nextDate ? fmtDay(a.nextDate) : 'not set'}
          {a.bookedLate && <span className="nova121-late" title="Booked past the 8-week limit since the last 1-2-1"> late</span>}
        </span>

        <span className="nova121-k">Last</span>
        <span title={a.cadenceDays === null ? 'No 1-2-1 held yet' : `${a.cadenceDays} days since the last held 1-2-1 — target 6 weeks, limit 8`}>
          {fmtDay(a.lastDate)}
          {a.cadenceDays !== null && <span className={`nova121-weeks ${ragClass(a.cadenceRag)}`}> {Math.floor(a.cadenceDays / 7)}w</span>}
        </span>

        <span className="nova121-k">Write-up</span>
        <span>
          {a.lastSessionId === null || !a.measured ? <span className="nova121-muted">—</span> : (
            <>
              <span className={ragClass(a.importRag)} title={a.imported ? `Imported${a.importedOn ? ` ${fmtDay(a.importedOn)}` : ''} — due ${fmtDay(a.writeUpDue)}` : `Not imported — due ${fmtDay(a.writeUpDue)}`}>● Notes</span>{' '}
              <span className={ragClass(a.hrRag)} title={a.hrLoggedOn ? `Logged in PeopleHR ${fmtDay(a.hrLoggedOn)} — due ${fmtDay(a.writeUpDue)}` : `Not logged in PeopleHR — due ${fmtDay(a.writeUpDue)}`}>● HR</span>
            </>
          )}
        </span>

        <span className="nova121-k">Actions</span>
        <span>
          {a.outstandingActions > 0 ? `${a.outstandingActions} open` : <span className="nova121-muted">none open</span>}
          {a.awaitingConfirmation > 0 && <span className="nova121-tone-teal" title="Closed per a recording — confirm at the next 1-2-1"> · {a.awaitingConfirmation} to confirm</span>}
        </span>

        <span className="nova121-k">Delivery</span>
        <span className={`nova121-strong ${rateClass(a.deliveryRate)}`}>
          {a.deliveryRate === null ? '—' : `${a.deliveryRate}%`}
          {(a.delivered + a.missed) > 0 && <span className="nova121-muted"> ({a.delivered}/{a.delivered + a.missed})</span>}
        </span>

        <span className="nova121-k">PeopleHR</span>
        <span>{hr}</span>
      </div>
      {error && <div className="nova121-error">{error}</div>}
    </div>
  );
}
