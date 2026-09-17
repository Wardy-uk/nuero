import { useEffect, useRef } from 'react';

/**
 * Tell NEURO which SAiM screen is on.
 *
 * ⚠ WHY THIS EXISTS. The NEURO desktop has logged `tab_open` since 22 June 2026
 * and SAiM has logged NOTHING, on any of its three shells. So the usage heatmap
 * could see 33 desktop screens and none of the twelve on the app Nick actually
 * carries — and an empty SAiM row does not read as "not measured", it reads as
 * "never used", which would make the grid most wrong about the most-used
 * surface in the estate. This is the other half of that measurement.
 *
 * ⚠ ONE HOOK, BOTH SHELLS — the phone and the Pi kiosk (and, through the kiosk
 * build, the laptop's Electron window). Two copies is how `voiceUtils` drifted,
 * and a screen count that differs by shell is worse than none.
 *
 * ⚠ THE REPORTER IS INJECTED, exactly as `useFieldDrive` takes its fetcher: the
 * phone talks to NEURO directly with a PIN, the kiosk goes through
 * `saim/backend`'s allowlisted proxy with no credential in the browser. The
 * transport is the shell's business; what counts as a screen open is not.
 *
 * ⚠ IT REPORTS THE SCREEN ARRIVED AT, not the tap. So a notification landing on
 * a tab counts exactly as a deliberate navigation does — both are Nick looking
 * at that screen, which is what the grid measures. Keyed on the tab, so a
 * re-render never re-reports, and a tab re-selected while already active is not
 * an open.
 *
 * ⚠ FIRE AND FORGET, ALWAYS. A failed report costs one cell in a usage grid; a
 * report that could block or throw would cost a navigation on the surface whose
 * whole purpose is being reachable at a bad moment. It never awaits, never
 * retries and never surfaces an error — and it is deliberately NOT queued
 * through the outbox, which exists for captures: a lost screen open is a lost
 * observation, not a lost thought.
 */
export function useScreenTracking(tab, report) {
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    if (!tab || typeof reportRef.current !== 'function') return;
    try {
      const p = reportRef.current(tab);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* never costs a navigation */
    }
  }, [tab]);
}

export default useScreenTracking;
