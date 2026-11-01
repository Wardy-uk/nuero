import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { openInVault } from '../openVault';
import { planHike } from '../hikePrefill';

/**
 * Personal offers on Now (1 Nov 2026): a hike suggestion for the coming weekend,
 * and a GP pack written for an appointment in the next two days. Both are the
 * server's decision (`/api/personal-auto`); this renders them and offers ONE
 * action each. Renders nothing when there is nothing to offer — Now carries no
 * empty panel.
 */

const UI = {
  now: { box: 'adhd__card', h: 'adhd__h', p: 'adhd__empty', row: 'adhd__session-actions', go: 'adhd__do', quiet: 'adhd__later' },
  life: { box: 'cn-section', h: 'cn-h3', p: 'cn-muted cn-small', row: 'cn-actions', go: 'cn-btn cn-btn--primary', quiet: 'cn-btn' },
};

export function HikeSuggestionView({ suggestion, onPlan, onDismiss, busy = false, ui = 'now' }) {
  if (!suggestion) return null;
  const c = UI[ui] || UI.now;
  return (
    <section className={c.box} data-testid="hike-suggestion">
      <h3 className={c.h}>{suggestion.line}</h3>
      <p className={c.p}>{suggestion.weather}</p>
      <div className={c.row}>
        <button type="button" className={c.go} disabled={busy} onClick={() => onPlan(suggestion.prefill)}>Plan it</button>
        <button type="button" className={c.quiet} disabled={busy} onClick={() => onDismiss(suggestion.weekend)}>Not this weekend</button>
      </div>
    </section>
  );
}

export function GpPacksView({ packs, onOpen }) {
  if (!packs || !packs.length) return null;
  return (
    <section className="adhd__card" data-testid="gp-packs">
      {packs.map((p) => (
        <div key={p.path}>
          <h3 className="adhd__h">{p.line}</h3>
          <p className="adhd__empty">{p.title}{p.time ? ` at ${p.time}` : ''} — a page of your readings and records to take with you.</p>
          <div className="adhd__session-actions"><button type="button" className="adhd__do" onClick={() => onOpen(p.path)}>Open</button></div>
        </div>
      ))}
    </section>
  );
}

export function useHikeSuggestion() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const r = await apiFetch('/api/personal-auto/hike-suggestion'); setData(await r.json()); } catch { setData(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const dismiss = async (weekend) => {
    setBusy(true);
    try {
      await apiFetch('/api/personal-auto/hike-suggestion/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekend }) });
      await load();
    } finally { setBusy(false); }
  };
  return { suggestion: data && data.suggestion, dismiss, busy };
}

/** The Outdoor page's copy of the hike suggestion. */
export function HikeSuggestion() {
  const { suggestion, dismiss, busy } = useHikeSuggestion();
  return <HikeSuggestionView ui="life" suggestion={suggestion} busy={busy} onPlan={planHike} onDismiss={dismiss} />;
}

export default function PersonalAutoOffers() {
  const { suggestion, dismiss, busy } = useHikeSuggestion();
  const [packs, setPacks] = useState([]);
  useEffect(() => {
    let live = true;
    apiFetch('/api/personal-auto/gp-packs').then((r) => r.json()).then((d) => { if (live) setPacks(d.packs || []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return (
    <>
      <GpPacksView packs={packs} onOpen={openInVault} />
      <HikeSuggestionView suggestion={suggestion} busy={busy} onPlan={planHike} onDismiss={dismiss} />
    </>
  );
}
