import { useEffect, useState } from 'react';
import { apiFetch } from './api';
import { flagEnabled } from './saimWorkspace';

/**
 * Read ONE server switch (GET /api/feature-flags). READ-ONLY.
 * `enabled` is false until a readable answer says exactly `enabled: true`, and
 * stays false on any error, so a dead endpoint leaves every gated screen as
 * it was. `known` tells "read: off" apart from "could not read".
 */
export default function useFeatureFlag(key) {
  const [state, setState] = useState({ enabled: false, known: false });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await apiFetch('/api/feature-flags');
        const json = res.ok ? await res.json().catch(() => null) : null;
        if (live) setState({ enabled: flagEnabled(json, key), known: Boolean(json) });
      } catch {
        if (live) setState({ enabled: false, known: false });
      }
    })();
    return () => { live = false; };
  }, [key]);
  return state;
}
