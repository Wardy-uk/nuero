import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './NutritionSection.css';

/**
 * Nutrition on the Apple Health page — what MyFitnessPal writes to Apple Health,
 * as NEURO holds it. Renders `/api/health/nutrition` (nutrition-v1) and decides
 * nothing: which days count, the reference values and the states all come from
 * the service, so this page and My Health cannot disagree.
 *
 * ⚠ Three distinctions the payload carries and this keeps visible:
 *   • a day with nothing logged reads "not logged", never 0 kcal;
 *   • every logged day counts, however low (a fast day is a real day) — only
 *     today is left out of the averages, because it is still being eaten;
 *   • vitamins and minerals are FLOORS (MyFitnessPal writes 0 for missing data),
 *     so they are shown muted and never coloured as "too low".
 */

const RANGES = [7, 14, 30, 90];
const DAY_COLS = [
  ['dietary_protein', 'Protein', 'g'],
  ['dietary_carbohydrates', 'Carbs', 'g'],
  ['dietary_fat_total', 'Fat', 'g'],
  ['dietary_fat_saturated', 'Sat fat', 'g'],
  ['dietary_sugar', 'Sugars', 'g'],
  ['dietary_fiber', 'Fibre', 'g'],
  ['dietary_sodium', 'Salt', 'g'],
];
const GROUP_LABEL = {
  energy: 'Energy', macros: 'Macronutrients', fats: 'Fats', salt: 'Salt',
  minerals: 'Minerals', vitamins: 'Vitamins', other: 'Other',
};
const STATE_WORD = { over: 'over', under: 'under', ok: 'within', floor: 'floor', ref: '', noref: '', unknown: '' };

/** 'Sun 11' from a day key — sliced, never parsed as an instant. */
function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d}`;
}

export function NutritionView({ data, range, onRange, showAll, onToggleAll }) {
  const s = data.summary;
  const anyLogged = data.days.some((d) => d.logged);
  const nutrients = data.nutrients.filter((n) => showAll || n.daysWithData > 0);
  const hidden = data.nutrients.length - data.nutrients.filter((n) => n.daysWithData > 0).length;
  const groups = data.groups.map((g) => [g, nutrients.filter((n) => n.group === g)]).filter(([, rows]) => rows.length);

  return (
    <section className="hp-section nut">
      <h3 className="hp-h3">
        Nutrition
        <span className="hp-h3-note">MyFitnessPal, via Apple Health</span>
        <span className="nut-ranges">
          {RANGES.map((r) => (
            <button key={r} className={`hp-range${r === range ? ' hp-range--on' : ''}`} onClick={() => onRange(r)}>{r}d</button>
          ))}
        </span>
      </h3>

      {!anyLogged ? (
        <div className="hp-quiet">
          Nothing logged in the last {data.windowDays} days{s.lastLoggedDay ? ` — the last entry NEURO holds is from ${s.lastLoggedDay}` : ''}.
        </div>
      ) : (
        <>
          <div className="nut-summary">
            <span><b>{s.loggedDays}</b> day{s.loggedDays === 1 ? '' : 's'} logged</span>
            <span><b>{s.unloggedDays}</b> not logged</span>
            {s.todayKcal != null && <span>today so far <b>{s.todayKcal}</b> kcal</span>}
          </div>

          <div className="nut-scroll">
            <table className="hp-table nut-days">
              <thead>
                <tr>
                  <th>Day</th><th className="hp-num">kcal</th>
                  {DAY_COLS.map(([, l, u]) => <th key={l} className="hp-num">{l} <span className="nut-unit">{u}</span></th>)}
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.day} className={!d.logged ? 'nut-row--none' : ''}>
                    <td>
                      {dayLabel(d.day)}
                      {d.today && <span className="nut-tag">today</span>}
                    </td>
                    {d.logged ? (
                      <>
                        <td className="hp-num">{d.kcal}</td>
                        {DAY_COLS.map(([m, l]) => <td key={l} className="hp-num">{d.totals[m] ?? '—'}</td>)}
                      </>
                    ) : (
                      <td className="nut-none" colSpan={DAY_COLS.length + 1}>not logged</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 className="nut-h4">Daily average over {s.loggedDays} logged day{s.loggedDays === 1 ? '' : 's'}</h4>
          {s.loggedDays === 0 ? (
            <div className="hp-quiet">No logged day before today in this window yet, so there is nothing to average.</div>
          ) : (
            <table className="hp-table nut-avg">
              <thead>
                <tr><th>Nutrient</th><th className="hp-num">Average</th><th className="hp-num">Reference</th><th className="nut-barcol" /></tr>
              </thead>
              {groups.map(([g, rows]) => (
                <tbody key={g}>
                  <tr className="nut-group"><td colSpan={4}>{GROUP_LABEL[g]}</td></tr>
                  {rows.map((n) => {
                    const pct = n.pctOfRef;
                    return (
                      <tr key={n.metric} className={n.floor ? 'nut-row--floor' : ''}>
                        <td title={n.note || undefined}>{n.label}{n.floor && <span className="nut-tag" title="MyFitnessPal records 0 when a food's entry lacks this, so the true figure is at least this">floor</span>}</td>
                        <td className="hp-num">{n.avg == null ? '—' : `${n.avg} ${n.unit}`}</td>
                        <td className="hp-num" title={n.ref ? n.ref.source : undefined}>
                          {n.ref ? `${n.ref.kind === 'max' ? '≤ ' : n.ref.kind === 'target' ? '≥ ' : ''}${n.ref.value} ${n.unit}` : ''}
                        </td>
                        <td className="nut-barcol">
                          {pct != null && (
                            <span className={`nut-bar nut-bar--${n.state}`} title={`${pct}% of reference${STATE_WORD[n.state] ? ` · ${STATE_WORD[n.state]}` : ''}`}>
                              <i style={{ width: `${Math.min(pct, 200) / 2}%` }} />
                              <span className="nut-pct">{pct}%</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          )}
          {hidden > 0 && (
            <button className="hp-more" onClick={onToggleAll}>
              {showAll ? 'Hide nutrients with no data' : `Show ${hidden} nutrient${hidden === 1 ? '' : 's'} with no data`}
            </button>
          )}
          <p className="nut-note">{data.note}</p>
        </>
      )}
    </section>
  );
}

export default function NutritionSection() {
  const [range, setRange] = useState(14);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    apiFetch(`/api/health/nutrition?days=${range}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body) throw new Error(body?.error || `HTTP ${r.status}`);
        return body;
      })
      .then((b) => { if (live) setData(b); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [range]);

  if (error) {
    return (
      <section className="hp-section nut">
        <h3 className="hp-h3">Nutrition</h3>
        <div className="hp-quiet">Could not read nutrition: {error}. This is not the same as nothing logged.</div>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="hp-section nut">
        <h3 className="hp-h3">Nutrition</h3>
        <div className="hp-quiet">Loading…</div>
      </section>
    );
  }
  return <NutritionView data={data} range={range} onRange={setRange} showAll={showAll} onToggleAll={() => setShowAll((v) => !v)} />;
}
