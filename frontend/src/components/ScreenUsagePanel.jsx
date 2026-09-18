import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../api';
import './ScreenUsagePanel.css';

/**
 * Which screens get opened, across NEURO, SAiM and VANTAGE.
 *
 * ⚠ THE ONE THING THIS SCREEN MUST NOT DO IS DRAW AN UNMEASURED WEEK AS ZERO.
 * NEURO's desktop has reported since 22 June 2026 and the other two report from
 * the day their hook shipped — so SAiM, the app Nick opens most, has months of
 * blank columns behind it. A sequential ramp's lightest step IS zero, which
 * means colour alone cannot tell "nobody opened it" from "nothing was watching".
 * They are told apart by FORM instead: an unknown cell is HATCHED and an empty
 * one is an outline. Three renderings, kept distinct, exactly as VESTA's
 * gap / empty / absent are.
 *
 * ⚠ IT COUNTS OPENS, NOT TIME. The server says so on the payload (`measures`)
 * and this renders that string rather than writing its own, so the panel and
 * anything else reading the feed cannot phrase the caveat differently.
 *
 * ── Chart decisions ─────────────────────────────────────────────────────────
 *
 * Magnitude over a grid, so: heatmap, SEQUENTIAL colour, one hue, more-is-
 * brighter (the ramp runs toward NEURO's own `--accent`, on a dark surface).
 * Never categorical — the surfaces are not the subject, the counts are.
 *
 * The lightest step sits just under 3:1 against the card, which obliges visible
 * values rather than colour alone: every cell carries a title with its exact
 * count, and the **Numbers** toggle is a real table view of the same data. That
 * is not optional decoration, it is what makes the low end of the ramp legible.
 *
 * Two grids, because Nick asked for both and they answer different questions:
 * screen × week says what has gone quiet, screen × hour says when he reaches for
 * what. They share the row set and the ramp, and each is scaled to its OWN max —
 * an hour column and a week column are not the same quantity.
 */

// Sequential, low → high. Validated: lightness monotonic, worst adjacent pair
// ΔE 9.5 deutan / 9.9 tritan. ⚠ Do not reorder or insert a step without
// re-running the check — a ramp that is not monotonic stops being readable as
// magnitude and starts looking like categories.
const RAMP = ['#3f6a9e', '#4b88c4', '#5aa3f9', '#93c6ff'];

const SURFACE_HINT = {
  neuro: 'The desktop app — 33 screens, reporting since June.',
  saim: 'The phone, the Pi kiosk and the laptop window — one shared screen set.',
  vantage: 'The service-desk and coaching app. Read from its own store, not over the bridge.',
};

/** Which ramp step a count falls in. PURE. 0 is NOT a step — it has its own mark. */
function step(value, max) {
  if (value === null || value === undefined) return null; // unknown
  if (value === 0) return -1;                             // measured, nothing
  if (!max || max <= 0) return 0;
  // Ratio bands rather than equal counts: usage is long-tailed, so equal-count
  // bands would put `today` (167) and a screen opened twice in the same bucket.
  const r = value / max;
  if (r > 0.6) return 3;
  if (r > 0.3) return 2;
  if (r > 0.1) return 1;
  return 0;
}

function cellClass(s) {
  if (s === null) return 'su-cell su-unknown';
  if (s === -1) return 'su-cell su-none';
  return `su-cell su-step-${s}`;
}

/** "14 Sep" from a key, SLICED not parsed — `new Date('2026-09-14')` is UTC
 *  midnight and renders as the 13th west of here. The BST bug, again. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(key) {
  if (typeof key !== 'string' || key.length < 10) return key || '';
  return `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;
}

function Legend({ hasUnknown }) {
  return (
    <div className="su-legend">
      <span className="su-legend-label">Fewer</span>
      <span className="su-cell su-none" aria-hidden="true" />
      {RAMP.map((_, i) => <span key={i} className={`su-cell su-step-${i}`} aria-hidden="true" />)}
      <span className="su-legend-label">More</span>
      <span className="su-legend-sep" />
      <span className="su-cell su-none" aria-hidden="true" />
      <span className="su-legend-label">opened nothing</span>
      {/* Only shown when the grid actually contains one — a permanent key for a
          state nobody is looking at is a line that stops being read. */}
      {hasUnknown ? (
        <>
          <span className="su-cell su-unknown" aria-hidden="true" />
          <span className="su-legend-label">not measured</span>
        </>
      ) : null}
    </div>
  );
}

const KIND_LABEL = { opened: 'Accessed', interacted: 'Interacted with' };

/**
 * One table, TWO column groups: accessed on the left, interacted on the right,
 * sharing a single row label.
 *
 * ⚠ Nick's layout (18 Sep 2026), and it is the right one — the comparison this
 * answers is "opened a lot, worked in rarely", which is a fact about ONE row.
 * Two separate tables would put the halves of that sentence in different
 * places and make the reader hold a row name in their head to compare.
 *
 * ⚠⚠ EACH HALF IS SCALED TO ITS OWN BUSIEST CELL, and the panel says so. Opens
 * and control-uses are different quantities — `TodoPanel` has 99 controls, so
 * its interaction counts dwarf every open count on the page. Sharing a scale
 * would wash the whole accessed grid out to nothing. The cost is that
 * brightness must NOT be compared across the divider, which is why the divider
 * is a real rule and each half carries its own "busiest" figure.
 */
function Grid({ rows, columns, label, columnLabel, cellTitle, kinds, scales }) {
  return (
    <div className="su-grid-wrap">
      <table className="su-grid">
        <caption className="su-caption">{label}</caption>
        <thead>
          <tr className="su-kindrow">
            <th scope="col" className="su-rowhead" />
            {kinds.map((kind, i) => (
              <th
                key={kind}
                scope="colgroup"
                colSpan={columns.length + 1}
                className={`su-kindhead${i > 0 ? ' su-kind-split' : ''}`}
              >
                {KIND_LABEL[kind]}
                <span className="su-kind-scale">busiest cell {scales[kind] || 0}</span>
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col" className="su-rowhead">Screen</th>
            {kinds.map((kind, ki) => [
              ...columns.map((c, i) => (
                <th
                  key={`${kind}-${c}`}
                  scope="col"
                  className={`su-colhead${ki > 0 && i === 0 ? ' su-kind-split' : ''}`}
                >
                  <span>{columnLabel(c, i)}</span>
                </th>
              )),
              <th key={`${kind}-all`} scope="col" className="su-total">All</th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.surface}/${r.screen}`}>
              <th scope="row" className="su-rowhead">
                <span className={`su-tag su-tag-${r.surface}`}>{r.surface}</span>
                <span className="su-screen">{r.screen}</span>
              </th>
              {kinds.map((kind, ki) => [
                ...columns.map((c, i) => {
                  const v = r[kind].weeks ? r[kind].weeks[columns.indexOf(c)] : null;
                  return (
                    <td key={`${kind}-${c}`} className={`su-td${ki > 0 && i === 0 ? ' su-kind-split' : ''}`}>
                      <span className={cellClass(step(v, scales[kind]))} title={cellTitle(r, c, v, kind)} />
                    </td>
                  );
                }),
                <td key={`${kind}-all`} className="su-total">{r[kind].total}</td>,
              ])}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Same shape for the hour grid, which indexes by hour rather than week key. */
function HourGrid({ rows, hours, label, kinds, scales }) {
  return (
    <div className="su-grid-wrap">
      <table className="su-grid">
        <caption className="su-caption">{label}</caption>
        <thead>
          <tr className="su-kindrow">
            <th scope="col" className="su-rowhead" />
            {kinds.map((kind, i) => (
              <th key={kind} scope="colgroup" colSpan={hours.length} className={`su-kindhead${i > 0 ? ' su-kind-split' : ''}`}>
                {KIND_LABEL[kind]}
                <span className="su-kind-scale">busiest cell {scales[kind] || 0}</span>
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col" className="su-rowhead">Screen</th>
            {kinds.map((kind, ki) => hours.map((h, i) => (
              <th key={`${kind}-${h}`} scope="col" className={`su-colhead${ki > 0 && i === 0 ? ' su-kind-split' : ''}`}>
                <span>{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>
              </th>
            )))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.surface}/${r.screen}`}>
              <th scope="row" className="su-rowhead">
                <span className={`su-tag su-tag-${r.surface}`}>{r.surface}</span>
                <span className="su-screen">{r.screen}</span>
              </th>
              {kinds.map((kind, ki) => hours.map((h, i) => {
                const v = r[kind].hours[h];
                return (
                  <td key={`${kind}-${h}`} className={`su-td${ki > 0 && i === 0 ? ' su-kind-split' : ''}`}>
                    <span
                      className={cellClass(step(v, scales[kind]))}
                      title={`${r.screen} · ${String(h).padStart(2, '0')}:00 — ${v} ${kind === 'opened' ? 'open' : 'interaction'}${v === 1 ? '' : 's'}`}
                    />
                  </td>
                );
              }))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The table view. Required, not optional: the ramp's lightest step sits under
 * 3:1 against the card, and a contrast warning obliges visible values.
 */
function Numbers({ rows, columns, columnLabel, kinds, valueOf }) {
  return (
    <div className="su-grid-wrap">
      <table className="su-grid su-numbers">
        <thead>
          <tr className="su-kindrow">
            <th className="su-rowhead" />
            {kinds.map((kind, i) => (
              <th key={kind} scope="colgroup" colSpan={columns.length + 1} className={`su-kindhead${i > 0 ? ' su-kind-split' : ''}`}>
                {KIND_LABEL[kind]}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col" className="su-rowhead">Screen</th>
            {kinds.map((kind, ki) => [
              ...columns.map((c, i) => (
                <th key={`${kind}-${c}`} scope="col" className={ki > 0 && i === 0 ? 'su-kind-split' : ''}>{columnLabel(c, i)}</th>
              )),
              <th key={`${kind}-all`} scope="col">All</th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.surface}/${r.screen}`}>
              <th scope="row" className="su-rowhead">
                <span className={`su-tag su-tag-${r.surface}`}>{r.surface}</span>
                <span className="su-screen">{r.screen}</span>
              </th>
              {kinds.map((kind, ki) => [
                ...columns.map((c, i) => {
                  const v = valueOf(r, c, kind);
                  // ⚠ An em dash, NEVER a 0. This table exists so the low end
                  // of the ramp is legible; printing 0 where nothing was
                  // measured reintroduces the exact lie the hatching avoids.
                  return (
                    <td
                      key={`${kind}-${c}`}
                      className={`${v === null ? 'su-num-unknown' : ''}${ki > 0 && i === 0 ? ' su-kind-split' : ''}`}
                    >
                      {v === null ? '—' : v}
                    </td>
                  );
                }),
                <td key={`${kind}-all`}>{r[kind].total}</td>,
              ])}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ScreenUsagePanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [weeks, setWeeks] = useState(12);
  const [showAll, setShowAll] = useState(false);
  const [asNumbers, setAsNumbers] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(apiUrl(`/api/screen-usage?weeks=${weeks}`))
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error || r.status)))))
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [weeks]);

  useEffect(load, [load]);

  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);

  if (loading && !data) return <div className="su-panel"><div className="su-loading">Reading screen usage…</div></div>;
  if (error && !data) {
    return (
      <div className="su-panel">
        <div className="su-error">
          Couldn’t load screen usage
          <span>{error}</span>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const { rows, weeks: columns, surfaces, findings, gaps, excluded, window: win } = data;
  const kinds = data.kinds || ['opened', 'interacted'];
  // ⚠ Long tail: ~50 screens across three apps. The top 20 is a readable grid;
  // the rest are still HERE, behind a toggle, because a screen hidden from the
  // list that says which screens are quiet is the one thing this cannot do.
  const shown = showAll ? rows : rows.slice(0, 20);
  const hasUnknown = shown.some((r) => kinds.some((k) => r[k].weeks.some((w) => w === null)));

  // ⚠ PER KIND, never shared. `TodoPanel` has 99 controls, so its interaction
  // counts dwarf every open count on the page — one scale would wash the whole
  // accessed half out to nothing. Computed over the ROWS SHOWN, so expanding
  // the list cannot change the brightness of the rows already on screen.
  const scaleOver = (pick) => {
    const m = {};
    for (const k of kinds) {
      let max = 0;
      for (const r of shown) for (const v of pick(r, k)) if (typeof v === 'number' && v > max) max = v;
      m[k] = max;
    }
    return m;
  };
  const weekScales = scaleOver((r, k) => r[k].weeks);
  const hourScales = scaleOver((r, k) => r[k].hours);

  const weekValue = (r, c, kind) => r[kind].weeks[columns.indexOf(c)];

  return (
    <div className="su-panel">
      <header className="su-head">
        <div>
          <h2>Screen usage</h2>
          <p className="su-sub">
            {win.from} → {win.to}
          </p>
        </div>
        <div className="su-controls">
          <label>
            Window
            <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
              <option value={4}>4 weeks</option>
              <option value={12}>12 weeks</option>
              <option value={26}>26 weeks</option>
              <option value={52}>52 weeks</option>
            </select>
          </label>
          <button
            type="button"
            className={asNumbers ? 'su-toggle on' : 'su-toggle'}
            onClick={() => setAsNumbers((v) => !v)}
          >
            {asNumbers ? 'Heatmap' : 'Numbers'}
          </button>
          <button type="button" className="su-refresh" onClick={load} title="Refresh">↻</button>
        </div>
      </header>

      <div className="su-surfaces">
        {surfaces.map((s) => (
          <div key={s.id} className={`su-surface su-surface-${s.known === false ? 'gap' : s.id}`}>
            <span className="su-surface-name">{s.label}</span>
            {s.known === false ? (
              // ⚠ A gap, never an empty surface. "I could not read VANTAGE" and
              // "Nick never opens VANTAGE" are opposite facts.
              <span className="su-surface-gap">Couldn’t read it — {s.reason}</span>
            ) : (
              <>
                <span className="su-surface-stat">{s.screens} screens</span>
                {/* ⚠ TWO since dates, because one surface genuinely has two.
                    NEURO has logged opens since June and interactions since
                    September; collapsing them would claim the interacted grid
                    covers three months it never saw. */}
                <span className="su-surface-since">
                  {s.opens} opens · {s.since.opened ? `since ${shortDate(s.since.opened)}` : 'none recorded'}
                </span>
                <span className="su-surface-since">
                  {s.interactions} interactions · {s.since.interacted ? `since ${shortDate(s.since.interacted)}` : 'none recorded'}
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      {findings.length > 0 && (
        <ul className="su-findings">
          {findings.map((f, i) => (
            <li key={i} className={`su-finding su-sev-${f.severity}`}>
              <span className="su-finding-title">{f.title}</span>
              <span className="su-finding-detail">{f.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <Legend hasUnknown={hasUnknown} />

      {asNumbers ? (
        <>
          <Numbers rows={shown} columns={columns} kinds={kinds} valueOf={weekValue} columnLabel={shortDate} />
          <Numbers
            rows={shown}
            columns={hours}
            kinds={kinds}
            valueOf={(r, h, kind) => r[kind].hours[h]}
            columnLabel={(h) => String(h).padStart(2, '0')}
          />
        </>
      ) : (
        <>
          <Grid
            rows={shown}
            columns={columns}
            kinds={kinds}
            scales={weekScales}
            label="By week — what has gone quiet, and what you actually work in"
            columnLabel={(c, i) => (i % 2 === 0 ? shortDate(c) : '')}
            cellTitle={(r, c, v, kind) => {
              const noun = kind === 'opened' ? 'open' : 'interaction';
              return v === null
                ? `${r.screen} · ${KIND_LABEL[kind].toLowerCase()} · week of ${shortDate(c)} — not measured; nothing was recording this yet`
                : `${r.screen} · ${KIND_LABEL[kind].toLowerCase()} · week of ${shortDate(c)} — ${v} ${noun}${v === 1 ? '' : 's'}`;
            }}
          />
          <HourGrid
            rows={shown}
            hours={hours}
            kinds={kinds}
            scales={hourScales}
            label="By hour of day — when you reach for what"
          />
        </>
      )}

      {rows.length > shown.length && (
        <button type="button" className="su-more" onClick={() => setShowAll(true)}>
          Show all {rows.length} screens
        </button>
      )}
      {showAll && rows.length > 20 && (
        <button type="button" className="su-more" onClick={() => setShowAll(false)}>Show top 20</button>
      )}

      <footer className="su-foot">
        {gaps.length > 0 && (
          <div className="su-gaps">
            {gaps.map((g, i) => <span key={i}>⚠ {g}</span>)}
          </div>
        )}
        <p className="su-note">
          <b>Accessed</b> counts {data.measures.opened}. <b>Interacted with</b> counts{' '}
          {data.measures.interacted}. Each half is scaled to its own busiest
          cell, so brightness compares down a column, never across the divider.
          {excluded.checkins > 0 && ` ${excluded.checkins} location check-ins excluded — they share the event type but are not screens.`}
        </p>
      </footer>
    </div>
  );
}
