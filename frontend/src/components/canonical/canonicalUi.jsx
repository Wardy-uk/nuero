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
