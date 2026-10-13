import { useEffect, useState } from 'react';

/**
 * Work only (13 Oct 2026, Nick): one switch that hides everything in NEURO that
 * is not work — the LIFE menu, Life sources, the personal blocks on Now and
 * personal tasks. Per device (this browser), because it is about what is on
 * THIS screen right now — a work laptop at the office — not a fact about him.
 *
 * It hides navigation and personal content; it never blocks a page. A push that
 * lands on a Life page (a hike check-in) still opens it — a safety prompt must
 * never be hidden by a display preference.
 */
const KEY = 'neuro_work_only';
const EVENT = 'neuro-work-only';

export function readWorkOnly() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setWorkOnly(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* still applies this session */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: !!on }));
}

export function useWorkOnly() {
  const [on, setOn] = useState(readWorkOnly);
  useEffect(() => {
    const local = (e) => setOn(!!e.detail);
    const other = (e) => { if (e.key === KEY) setOn(e.newValue === '1'); };
    window.addEventListener(EVENT, local);
    window.addEventListener('storage', other);
    return () => { window.removeEventListener(EVENT, local); window.removeEventListener('storage', other); };
  }, []);
  return [on, setWorkOnly];
}

// Sidebar groups and items that are not work. The LIFE group is all personal.
export const WORK_ONLY_HIDDEN_GROUPS = new Set(['life']);
export const WORK_ONLY_HIDDEN_ITEMS = new Set(['life-sources']);
