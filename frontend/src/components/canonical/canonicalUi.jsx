import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../api';

/**
 * Shared pieces for screens that read the canonical contract (/api/canonical,
 * Build 10A). Every one of them renders the same three honesty rules:
 *  • a failed read is an ERROR state, never an empty list;
 *  • unknown stays visibly unknown (domain, identity, freshness);
 *  • fact / observation / inference are told apart where they change how much
 *    to believe a line.
 */

export function useCanonical(path, { interval = 0 } = {}) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const load = useCallback(async () => {
    try {
      const res = await apiFetch(path);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || `${res.status}`);
      setState({ loading: false, error: null, data: json });
    } catch (e) {
      // Keep the previous answer on a failed refresh; blanking it would draw an
      // outage as an empty world.
      setState((s) => ({ loading: false, error: e.message, data: s.data }));
    }
  }, [path]);
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    load();
    if (!interval) return undefined;
    const t = setInterval(load, interval);
    return () => clearInterval(t);
  }, [load, interval]);
  return { ...state, reload: load };
}

export async function postCanonical(path, body) {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `${res.status}`);
  return json;
}

const DOMAIN_LABELS = {
  work: 'Work', health: 'Health', home: 'Home', family: 'Family', finance: 'Finance', fitness: 'Fitness',
  ember: 'Ember', travel: 'Travel', learning: 'Learning', projects: 'Projects', admin: 'Admin', leisure: 'Leisure',
};

const BASIS_NOTE = {
  declared: 'you set this',
  classified: 'you classified the calendar or list it is on',
  intrinsic: 'what the data is',
  set: 'a flag you set',
  'source-process': 'where it was recorded',
  inference: 'inferred',
  default: 'default, not evidence',
};

/** Life-domain chips. Unknown is shown as unknown, never omitted. */
export function DomainChips({ domains, showUnknown = true }) {
  const list = domains && domains.domains ? domains.domains : [];
  if (!list.length) {
    if (!showUnknown) return null;
    return <span className="cn-chip cn-chip--unknown" title="No evidence says which part of your life this belongs to">domain unknown</span>;
  }
  return (
    <span className="cn-chips">
      {list.map((d) => (
        <span key={d.domain} className={`cn-chip cn-chip--${d.basis === 'default' || d.basis === 'inference' ? 'soft' : 'firm'}`}
          title={`${BASIS_NOTE[d.basis] || d.basis}${d.why ? ` — ${d.why}` : ''}`}>
          {DOMAIN_LABELS[d.domain] || d.domain}{d.basis === 'default' ? ' (default)' : d.basis === 'inference' ? '?' : ''}
        </span>
      ))}
    </span>
  );
}

/** Fact / observation / inference, said once, the same way everywhere. */
export function ProvenanceBadge({ kind, confidence }) {
  if (!kind) return null;
  const words = { fact: 'fact', observation: 'observed', inference: 'inferred' };
  return (
    <span className={`cn-prov cn-prov--${kind}`} title={confidence != null ? `confidence ${Math.round(confidence * 100)}%` : undefined}>
      {words[kind] || kind}
    </span>
  );
}

export function Freshness({ projection }) {
  if (!projection) return null;
  if (projection.current === true) return <span className="cn-fresh">world model current</span>;
  if (projection.current === false) return <span className="cn-fresh cn-fresh--behind">world model {projection.lag ?? '?'} event(s) behind — read it as a little out of date</span>;
  return <span className="cn-fresh cn-fresh--behind">world model freshness unknown</span>;
}

export function when(iso) {
  if (!iso) return '—';
  const s = String(iso);
  // Wall-clock strings (YYYY-MM-DDTHH:MM) are sliced, never parsed into a zone.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}`;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const DOMAIN_IDS = Object.keys(DOMAIN_LABELS);

// PersonalImportance (Build 11G) — explicit only; absent means "not said".
export const IMPORTANCE_LABELS = {
  'critical-to-me': 'Critical to me',
  'important-to-me': 'Important to me',
  normal: 'Normal',
  restorative: 'Restorative',
  optional: 'Optional',
  'work-critical': 'Work-critical',
};
export const IMPORTANCE_IDS = Object.keys(IMPORTANCE_LABELS);

/** "Important to me" with where it came from (your own, or a goal you linked it to). */
export function ImportanceChip({ value, basis }) {
  if (!value) return null;
  return (
    <span className="cn-chip cn-chip--firm" title={basis === 'goal' ? 'from a goal you linked it to' : 'you set this'}>
      {IMPORTANCE_LABELS[value] || value}{basis === 'goal' ? ' (via goal)' : ''}
    </span>
  );
}
export { DOMAIN_LABELS };

/**
 * 8 Oct 2026 — the Life page showed tasks with no way to finish them. Only a
 * task NEURO OWNS can be ticked here (`task:neuro:<n>`); a reminder belongs to
 * Apple and is ticked in Reminders, so it says so instead of offering a button
 * that cannot work. Returns null for anything else.
 */
export function neuroTaskNumber(id) {
  const m = /^task:neuro:(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
}
export function DoneTick({ id, source, busy, onDone }) {
  const n = neuroTaskNumber(id);
  if (n == null) {
    if (/^task:eventkit-reminders:/.test(String(id || ''))) return <span className="cn-done cn-done--elsewhere" title="Apple owns this — tick it in Reminders and it closes here on the next push">○</span>;
    return null;
  }
  return (
    <button type="button" className="cn-done" disabled={busy} aria-label="Mark done" title="Mark done"
      onClick={(e) => { e.stopPropagation(); onDone(n); }}>✓</button>
  );
}
/** The explanation a card owes, kept one click away rather than on the page. */
export function HowItWorks({ children }) {
  if (!children) return null;
  return <details className="cn-details cn-how"><summary>How this works</summary><div className="cn-small cn-muted">{children}</div></details>;
}

/**
 * 8 Oct 2026 (second pass) — every card had its add/edit forms permanently
 * open, so the Life page read as a wall of empty inputs. A Fold shows the
 * STATE in its summary line ("Mileage — not recorded") and keeps the editing
 * one click away. `open` only for something that needs Nick now.
 */
export function Fold({ title, meta = null, open = false, children }) {
  return (
    <details className="cn-fold" open={open}>
      <summary><span className="cn-fold-title">{title}</span>{meta != null && meta !== '' && <span className="cn-fold-meta">{meta}</span>}</summary>
      <div className="cn-fold-body">{children}</div>
    </details>
  );
}

/**
 * What the carried environment logger measured on a walk (server-shaped by
 * environment.walkConditions). Numbers only when the logger was carried;
 * otherwise one quiet line saying why there are none. `quietIfUnknown` hides
 * that line, for lists where most walks never had the logger.
 */
export function LoggerConditions({ c, quietIfUnknown = false }) {
  if (!c) return null;
  if (!c.carried) {
    if (quietIfUnknown && c.state !== 'not-carried') return null;
    return <div className="cn-muted cn-small" data-testid="logger-conditions">Logger: no conditions — {c.why || 'it does not look carried'}.</div>;
  }
  const temp = c.tempMinC === c.tempMaxC ? `${c.tempMinC} °C` : `${c.tempMinC}–${c.tempMaxC} °C (mean ${c.tempMeanC})`;
  const parts = [temp,
    c.humidityMeanPct != null ? `humidity ${Math.round(c.humidityMeanPct)}%` : null,
    c.dewPointMeanC != null ? `dew point ${c.dewPointMeanC} °C` : null,
    c.baroAscentM != null ? `~${c.baroAscentM} m climb by pressure` : null].filter(Boolean);
  return (
    <div className="cn-small" data-testid="logger-conditions" title={`${c.readings} readings · carried: ${c.why}`}>
      Logger: {parts.join(' · ')}
    </div>
  );
}

/* ── Card building blocks (13 Oct 2026) ─────────────────────────────────────
 * The rules these enforce are in docs/design-rules.md. A Life card is built
 * from these and nothing else at its top level:
 *   <Headline>     one status badge + one short sentence — the card's answer
 *   <StatTiles>    numbers, each in a tile, never inside a sentence
 *   <TileGrid>     a collection (≤ ~12) as small cards
 *   <PrimaryAction> the one thing to do here, as a real button
 *   <Fold>         things you edit or rarely open
 *   <HowItWorks>   the only grey paragraph
 */

// tone: good | plan | warn | bad | neutral. A tone is a MEANING, never a colour
// a caller liked; "warn" and "bad" are for things that need him.
export function Pill({ tone = 'neutral', children, title }) {
  const cls = tone && tone !== 'neutral' ? ` cn-pill--${tone}` : '';
  return <span className={`cn-pill${cls}`} title={title}>{children}</span>;
}

/** The card's answer in one line: badge + sentence (+ optional detail line). */
export function Headline({ tone, pill, children, detail = null, testid }) {
  return (
    <div className="cn-headline-wrap" data-testid={testid} data-ui="headline">
      <div className="cn-headline">
        {pill && <Pill tone={tone}>{pill}</Pill>}
        <span className="cn-headline-text">{children}</span>
      </div>
      {detail && <div className="cn-headline-detail">{detail}</div>}
    </div>
  );
}

/** A number and what it counts. `v` null renders "—", never 0. */
export function Stat({ v, l, title, tone }) {
  return (
    <div className={`cn-stattile${tone ? ` cn-stattile--${tone}` : ''}`} title={title}>
      <div className="cn-stattile-v">{v == null || v === '' ? '—' : v}</div>
      <div className="cn-stattile-l">{l}</div>
    </div>
  );
}
export function StatTiles({ children }) {
  return <div className="cn-tiles-stat" data-ui="stats">{children}</div>;
}

/** A small card: title, optional sub line, optional footer (chips, actions). */
export function Tile({ title, sub = null, foot = null, children = null, accent = false, why, testid, as = 'li' }) {
  const Tag = as;
  return (
    <Tag className={`cn-tile${accent ? ' cn-tile--next' : ''}`} title={why || undefined} data-testid={testid}>
      {title != null && <span className="cn-tile-title">{title}</span>}
      {sub != null && <span className="cn-tile-sub">{sub}</span>}
      {children}
      {foot != null && <span className="cn-tile-foot">{foot}</span>}
    </Tag>
  );
}
export function TileGrid({ children, testid, wide = false }) {
  return <ul className={`cn-tiles${wide ? ' cn-tiles--wide' : ''}`} data-testid={testid} data-ui="tiles">{children}</ul>;
}

/** A labelled group inside a card. `why` is a reason shared by everything in it — said once. */
export function Group({ label, meta = null, why = null, children }) {
  return (
    <div className="cn-group" data-ui="group">
      <h4 className="cn-h4 cn-group-label">{label}{meta != null && meta !== '' && <span className="cn-group-meta">{meta}</span>}</h4>
      {why && <div className="cn-group-why">{why}</div>}
      {children}
    </div>
  );
}

export function PrimaryAction({ children, onClick, disabled, title }) {
  return <button type="button" className="cn-btn cn-btn--primary" onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}

/** A date key as "Sat 21 Nov" — built from its parts, never parsed as UTC. */
const _DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${_DOW[d.getDay()]} ${Number(m[3])} ${_MON[Number(m[2]) - 1]}`;
}
