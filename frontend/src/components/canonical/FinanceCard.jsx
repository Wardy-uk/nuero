import React, { useState } from 'react';
import { useCanonical, postCanonical, HowItWorks, Fold, Headline, StatTiles, Stat, TileGrid, Tile, Group, dayLabel } from './canonicalUi';

/**
 * Build 26 — Life → Finance, the OPERATIONAL view. Not a bank statement, not a
 * budget and not Tally's analytics: whether the money sources are healthy, the
 * state of things in Tally's own words, the one or two changes that matter,
 * what is coming, what needs Nick, and where money touches the rest of his life.
 * Every figure is Tally's (finance-intelligence-v1); NEURO calculates none, and
 * the detail lives one click away in Tally → Outlook.
 *
 * 13 Oct 2026 — reshaped to docs/design-rules.md: headline (pressure + what
 * needs you), Tally's figures in tiles, collections as tiles, editing folded.
 */

// Tally's pence, displayed — formatting only, never arithmetic.
const money = (p) => (p == null ? '—' : `${p < 0 ? '−' : ''}£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const HEALTH_WORDS = { healthy: 'live', partial: 'partly live', stale: 'stale', reconnect_required: 'reconnect needed', unknown: 'unknown' };
const PRESSURE_WORDS = { comfortable: 'Comfortable', tighter_than_usual: 'Tighter than usual', stretched: 'Stretched', insufficient_data: 'Not enough data' };
const PRESSURE_TONE = { comfortable: 'good', tighter_than_usual: 'warn', stretched: 'warn' };
const OB_KINDS = [['renewal', 'Renewal'], ['bill', 'Bill'], ['annual_fee', 'Annual fee'], ['subscription_renewal', 'Subscription renewal'], ['household_charge', 'Household charge'], ['other', 'Other']];
const OB_STATE = { overdue: 'Overdue', needs_you: 'Needs you', preparation_open: 'In hand', upcoming: 'Upcoming', later: 'Later', unknown: 'No date', complete: 'Done' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function FinanceCard() {
  const { data, error, reload } = useCanonical('/api/finance');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const act = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  if (error && !data) return <section className="cn-section"><h3>Finance</h3><div className="cn-error">Couldn’t read finance — {error}</div></section>;
  if (!data) return <section className="cn-section"><h3>Finance</h3><div className="cn-muted">Reading…</div></section>;
  return <FinanceView data={data} busy={busy} act={act} note={note} />;
}

/** The whole card for one payload. Exported so it can be rendered for real in a test. */
export function FinanceView({ data, busy, act, note = null }) {
  const op = data.operational;
  const tally = data.source && data.source.tallyUrl;
  const h = data.health || {};
  const feeds = `Bank feeds: ${HEALTH_WORDS[h.household] || h.household || 'unknown'}${h.label ? ` — ${h.label}` : ''}`;
  return (
    <section className="cn-section">
      <h3>Finance</h3>
      {note && <div className="cn-error">{note}</div>}
      {!op ? (
        <Headline pill="Not read" detail={feeds}>Tally’s finance intelligence has not been read yet.</Headline>
      ) : (
        <>
          <Headline tone={op.needsAction.length ? 'warn' : PRESSURE_TONE[op.pressure.state]}
            pill={PRESSURE_WORDS[op.pressure.state] || op.pressure.state} detail={feeds}>
            <span title={op.pressure.why.join(' ')}>
              {op.needsAction.length ? `${plural(op.needsAction.length, 'thing needs', 'things need')} you.` : (op.pressure.why[0] || 'Nothing needs you.')}
            </span>
          </Headline>
          <Feeds data={data} />
          <StatTiles>
            <Stat v={money(op.position.usablePence)} l="usable across the household now" title={op.position.statement} />
            <Stat v={op.toLook.unusual} l="unusual items to look at" />
            <Stat v={op.toLook.priceChanges} l="price changes to look at" />
          </StatTiles>
          <div className="cn-actions">
            {tally ? <a className="cn-btn cn-btn--primary" href={tally} target="_blank" rel="noreferrer">Open Tally → Outlook</a> : <span className="cn-muted cn-small">The detail is in Tally → Outlook.</span>}
          </div>
          <Forecast f={op.forecast} />
          {op.needsAction.length > 0 && (
            <Group label="Needs you" meta={op.needsAction.length}>
              <ul className="cn-list">{op.needsAction.map((n, i) => <li key={i}>{n.line}</li>)}</ul>
            </Group>
          )}
          {op.synthesis.length > 0 && (
            <Group label="Where money meets the rest of life" why="Each one joins a figure from Tally to something NEURO knows — hover for both.">
              <TileGrid wide>{op.synthesis.map((s) => (
                <Tile key={s.id} title={s.line}
                  why={`Because: ${s.facts.map((f) => `${f.system === 'tally' ? 'Tally' : 'NEURO'} — ${f.statement}`).join('; ')}`}
                  foot={s.facts.map((f, i) => <span key={i} className="cn-chip cn-chip--soft">{f.system === 'tally' ? 'Tally' : 'NEURO'}</span>)} />
              ))}</TileGrid>
            </Group>
          )}
          {op.changes.length > 0 && (
            <Group label="What changed">
              <TileGrid wide>{op.changes.map((c, i) => <Tile key={i} title={c.line} sub={c.timing || null} />)}</TileGrid>
            </Group>
          )}
          <Upcoming items={op.upcoming} />
        </>
      )}
      <Obligations obligations={data.obligations || []} linkable={data.linkable || []} busy={busy} act={act} personalAdmin={data.personalAdmin} />
      <SourceHealth data={data} op={op} />
      <HowItWorks>{data.rule}</HowItWorks>
    </section>
  );
}

/** Only the feeds that need a look, and a failed read — never the healthy ones. */
function Feeds({ data }) {
  const h = data.health || {};
  const age = data.source && data.source.ageMinutes;
  const bad = (h.accounts || []).filter((a) => a.state !== 'healthy');
  return (
    <>
      {data.lastRead && data.lastRead.ok === false && <div className="cn-error">Last read of Tally failed — {data.lastRead.error}{age != null ? ` (showing what Tally said ${age} min ago)` : ''}</div>}
      {bad.length > 0 && (
        <TileGrid>{bad.map((a) => (
          <Tile key={a.accountRef} title={a.owner === 'private' ? `${a.name}’s account` : a.name} why={a.why}
            sub={HEALTH_WORDS[a.state] || a.state} />
        ))}</TileGrid>
      )}
    </>
  );
}

function Forecast({ f }) {
  if (!f.d30) {
    return (
      <Group label="Next 30 days" why={`No forward view: ${(f.why || [])[0] || 'not enough current data'}.`}>
        {f.nextIncome && <StatTiles><Stat v={dayLabel(f.nextIncome.date)} l={`next income · ${f.nextIncome.label}`} /></StatTiles>}
      </Group>
    );
  }
  return (
    <Group label="Next 30 days" meta={`${f.confidence} confidence`} why="Known payments only. Day-to-day spending is not included.">
      <StatTiles>
        <Stat v={money(f.d30.projectedPence)} l={`left on ${dayLabel(f.d30.through)}`} />
        <Stat v={money(f.d30.lowestPoint.pence)} l={`lowest, ${dayLabel(f.d30.lowestPoint.date)}`} />
        {f.nextIncome && <Stat v={dayLabel(f.nextIncome.date)} l={`next income · ${f.nextIncome.label}`} />}
      </StatTiles>
    </Group>
  );
}

function Upcoming({ items }) {
  if (!items.length) return null;
  const chip = (u) => <span className="cn-chip">{u.source === 'tally' ? (u.kind === 'annual' ? 'annual (Tally)' : 'planned (Tally)') : (OB_STATE[u.state] || u.state)}</span>;
  return (
    <Group label="Coming up" meta={`${items.length} dated — not every direct debit`}>
      {items.length <= 12 ? (
        <TileGrid>{items.map((u, i) => (
          <Tile key={i} title={u.label} sub={`${u.date ? dayLabel(u.date) : 'no date'}${u.pence ? ` · ${money(u.pence)}` : ''}`} foot={chip(u)} />
        ))}</TileGrid>
      ) : (
        <ul className="cn-list cn-small">{items.map((u, i) => (
          <li key={i}>{u.date ? dayLabel(u.date) : 'no date'} — {u.label}{u.pence ? ` ${money(u.pence)}` : ''} {chip(u)}</li>
        ))}</ul>
      )}
    </Group>
  );
}

function SourceHealth({ data, op }) {
  const sh = data.sourceHealth;
  const cats = op && !op.categories.available && op.categories.why ? op.categories.why : null;
  if (!sh && !cats) return null;
  return (
    <Fold title="Sources" meta={cats ? 'category trends not available' : null}>
      <ul className="cn-list cn-small">
        {sh && sh.balances.map((b) => <li key={`b${b.accountId}`}>{b.owner === 'private' ? `${b.name}’s` : b.name} balance: {b.why}</li>)}
        {sh && sh.transactions.map((t) => <li key={`t${t.accountId}`}>{t.owner === 'private' ? `${t.name}’s` : t.name}: {t.why}</li>)}
        {sh && <li>Categories: {sh.categories.state} — {sh.categories.why}</li>}
        {sh && <li>Recurring payments: {sh.recurrence.state} — {sh.recurrence.why}</li>}
        {sh && <li>Forecast: {sh.forecast.state}</li>}
        {cats && <li>Category trends: not available ({cats}).</li>}
      </ul>
    </Fold>
  );
}

function Obligations({ obligations, linkable, busy, act, personalAdmin }) {
  const [f, setF] = useState({ kind: 'renewal', title: '', dueDate: '', amount: '', requiresDecision: false, seriesKey: '' });
  const open = obligations.filter((o) => o.status === 'open');
  const needs = open.filter((o) => o.state === 'needs_you' || o.state === 'overdue');
  const submit = (e) => {
    e.preventDefault();
    const body = { kind: f.kind, title: f.title, dueDate: f.dueDate || null, requiresDecision: f.requiresDecision, seriesKey: f.seriesKey || null };
    if (f.amount) body.expectedAmountPence = Math.round(Number(f.amount) * 100);
    act(() => postCanonical('/api/finance/obligations', body)).then(() => setF({ ...f, title: '', dueDate: '', amount: '' }));
  };
  return (
    <Fold title="Finance dates you recorded" meta={`${open.length} open${needs.length ? ` · ${needs.length} need you` : ''}`} open={needs.length > 0}>
      <div className="cn-group-why">Renewals and fees that need an action or a decision. A routine Direct Debit does not need one. Ticking a linked task is the action, not proof of payment.
        {personalAdmin && personalAdmin.note ? ` ${personalAdmin.note}` : ''}</div>
      <ul className="cn-list">
        {open.map((o) => (
          <li key={o.id} className="cn-row" style={{ padding: '8px 12px' }} title={`${o.stateWhy}${o.payment ? ` · ${o.payment}` : ''}`}>
            <div className="cn-rowtitle">{o.title} <span className="cn-chip">{OB_STATE[o.state] || o.state}</span></div>
            <div className="cn-muted cn-small">{o.dueDate ? dayLabel(o.dueDate) : 'no date'}{o.expectedAmountPence ? ` · ${money(o.expectedAmountPence)}` : ''}{o.task ? ` · task: ${o.task.title} (${o.task.status})` : o.linkedTaskRef ? ` · linked ${o.linkedTaskRef}` : ''}</div>
            <Resolve o={o} busy={busy} act={act} />
          </li>
        ))}
      </ul>
      <form className="cn-goalform" onSubmit={submit}>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind">{OB_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Home insurance renewal" aria-label="Title" />
        <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} aria-label="Due date" />
        <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="£ expected" aria-label="Expected amount" inputMode="decimal" />
        <select value={f.seriesKey} onChange={(e) => setF({ ...f, seriesKey: e.target.value })} aria-label="Recurring payment">
          <option value="">no recurring payment</option>
          {linkable.map((s) => <option key={s.key} value={s.key}>{s.label} ({money(s.typicalPence)})</option>)}
        </select>
        <label className="cn-small"><input type="checkbox" checked={f.requiresDecision} onChange={(e) => setF({ ...f, requiresDecision: e.target.checked })} /> needs my decision</label>
        <button className="cn-btn" disabled={busy || f.title.trim().length < 2}>Record</button>
      </form>
    </Fold>
  );
}

function Resolve({ o, busy, act }) {
  const [ev, setEv] = useState('');
  const [txt, setTxt] = useState('');
  return (
    <div className="cn-small">
      <select value={ev} onChange={(e) => setEv(e.target.value)} aria-label="Evidence">
        <option value="">resolve with…</option>
        <option value="payment-seen">payment seen in Tally</option><option value="renewed">renewed</option><option value="statement">statement / letter</option><option value="cancelled">cancelled</option>
      </select>
      {ev && ev !== 'payment-seen' && <input value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="what is the evidence?" aria-label="Evidence note" />}
      {ev && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/finance/obligations/${o.id}/resolve`, { evidence: ev, note: txt || null }))}>Resolve</button>}
    </div>
  );
}
