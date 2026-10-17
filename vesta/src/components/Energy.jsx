import Section from './Section.jsx';

/**
 * Household energy (the `energy` scope). Renders /api/v/home's `energy` block
 * verbatim: yesterday and this month per fuel, a 30-day bar per day, and how
 * fresh the meter data is. Every £ is an estimate and says so. A day with no
 * reading is a gap in the bars, never a zero-height bar.
 */

const NAME = { electricity: 'Electricity', gas: 'Gas' };
export const money = (p) => (p == null ? null : `£${(p / 100).toFixed(2)}`);

function Bars({ days }) {
  const vals = days.map((d) => d.kwh).filter((v) => v != null);
  const max = vals.length ? Math.max(...vals) : 0;
  return (
    <div className="energy__bars" role="img" aria-label="Daily use, last 30 days">
      {days.map((d) => (
        <span key={d.day} title={`${d.day}: ${d.kwh == null ? 'no reading' : `${d.kwh} kWh${d.complete ? '' : ' (so far)'}`}`}
          className={`energy__bar${d.kwh == null ? ' energy__bar--none' : d.complete ? '' : ' energy__bar--partial'}`}
          style={{ height: d.kwh == null || !max ? '0' : `${Math.max(4, (d.kwh / max) * 100)}%` }} />
      ))}
    </div>
  );
}

export function FuelLine({ fuel, f }) {
  const y = f.yesterday;
  return (
    <div className="energy__fuel">
      <h3 className="energy__name">{NAME[fuel]}</h3>
      <p className="energy__fact">
        Yesterday: {y && y.kwh != null ? `${y.kwh.toFixed(1)} kWh${y.complete ? '' : ' (so far)'}` : 'no reading yet'}
        {y && y.costP != null ? ` · ~${money(y.costP)}` : ''}
      </p>
      <p className="energy__fact">
        This month: {f.month.kwh != null ? `${Math.round(f.month.kwh)} kWh` : '—'}{f.month.costP != null ? ` · ~${money(f.month.costP)}` : ''}
      </p>
      <Bars days={f.days || []} />
    </div>
  );
}

export default function Energy({ energy, gap }) {
  const fuels = energy ? Object.entries(energy.fuels || {}) : [];
  return (
    <Section title="Energy" gap={gap} empty={!gap && energy && !fuels.length ? (energy.connected ? 'Waiting for the first meter readings.' : 'The meters aren’t connected yet.') : null}>
      {fuels.map(([fuel, f]) => <FuelLine key={fuel} fuel={fuel} f={f} />)}
      {energy && energy.monthCostP != null && <p className="energy__total">Both this month: ~{money(energy.monthCostP)}</p>}
      {energy && fuels.length > 0 && <p className="energy__note">{energy.note}</p>}
    </Section>
  );
}
