import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';

/**
 * The canonical attention feed, for the desktop.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `/api/attention` is the NEURO-owned decision and lifecycle contract; the
 * phone, the kiosk, the widget and every push already consume it. Desktop
 * Briefing and Focus did not — they read `/api/focus` and wrote to
 * `/api/focus/{dismiss,snooze,hide-today,action-done}`, which is a suppression
 * TIMER, not a lifecycle. So "seen it", "not now" and "not mine" all collapsed
 * into one gesture on one surface and stayed distinct on the others, and a card
 * acknowledged on the phone came straight back on the desktop.
 *
 * ── The rules this hook enforces ────────────────────────────────────────────
 * 1. **No reranking, no rewording, no urgency invented in React.** `title`,
 *    `say`, `reason`, `tab`, `urgency` and the permitted `actions` all come off
 *    the record. A client that composes its own is a second opinion and drifts.
 * 2. **`actions` is a bounded set and it is honoured.** A button the record
 *    does not permit is not rendered — offering one the server will refuse is
 *    worse than not offering it (`action-presenter`'s blockers rule).
 * 3. **Opening is not an action.** `open` navigates and calls nothing. Giving
 *    it a request is how it acquires a side effect later, which is exactly how
 *    Briefing's "Do it" came to log a completed outcome at the moment work
 *    STARTED.
 * 4. **There is no legacy path any more (Build 10O).** `/api/focus` is
 *    retired; a card with no `recordId` cannot be acted on and SAYS so,
 *    rather than writing to a suppression timer nothing else reads.
 * 5. **The Now read model is the same decision.** `/api/canonical/now`
 *    embeds `/api/attention`'s build verbatim and adds world-model
 *    `situation`; Now reads it so the decision and the world come from one
 *    moment.
 */

const DEFER_REASONS = {
  'not-now': 'Not now',
  'no-context': 'Needs context first',
  'waiting-on-someone': 'Waiting on someone',
  'too-big': 'Too big as it stands',
};

async function postJson(path, body) {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

export default function useAttention({ interval = 30000, path = '/api/attention' } = {}) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(path);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `${res.status}`);
      setState({ loading: false, error: null, data: json });
    } catch (e) {
      // ⚠ The previous payload is KEPT on a failed refresh. Blanking the feed
      // would render an outage as a calm day, which is the one thing every
      // layer of this contract refuses to do.
      setState((s) => ({ loading: false, error: e.message, data: s.data }));
    }
  }, [path]);

  useEffect(() => {
    load();
    if (!interval) return undefined;
    timer.current = setInterval(load, interval);
    return () => clearInterval(timer.current);
  }, [load, interval]);

  /**
   * Submit an action against a card.
   *
   * `action` is one of the record's own `actions`. Returns
   * `{ok, canonical, taskCompleted, taskWhy, why}` — `canonical:false` means
   * the legacy fallback ran, which the surface says out loud rather than
   * presenting as the same thing.
   */
  const act = useCallback(async (card, action, opts = {}) => {
    if (!card) return { ok: false, why: 'no card' };

    if (card.recordId) {
      const json = await postJson(`/api/attention/records/${card.recordId}/act`, {
        action,
        minutes: opts.minutes,
        reason: opts.reason,
        note: opts.note,
      });
      await load();
      return {
        ok: true,
        canonical: true,
        taskCompleted: json.taskCompleted ?? null,
        taskWhy: json.taskWhy ?? null,
        record: json.record || null,
      };
    }

    // No record means the lifecycle could not be reconciled for this card.
    // There is no fallback: the legacy /api/focus suppression timer is retired.
    return { ok: false, canonical: false, why: `"${action}" needs a canonical attention record and this card has none` };
  }, [load]);

  const data = state.data;
  const primary = data && data.primary && data.primary.kind === 'item' ? data.primary : null;
  const contextCard = data && data.primary && data.primary.kind === 'context' ? data.primary : null;
  const secondary = (data?.secondary || []).filter((c) => c && c.kind === 'item');

  return {
    loading: state.loading,
    error: state.error,
    data,
    primary,
    contextCard,
    secondary,
    // Everything the surface may render as a card, primary first.
    cards: primary ? [primary, ...secondary] : secondary,
    // Carried straight through — a client must not re-derive any of these.
    quiet: data?.quiet ?? false,
    speech: data?.speech ?? null,
    poolAvailable: data?.poolAvailable ?? null,
    gaps: data?.gaps || [],
    dropped: data?.dropped || [],
    transition: data?.transition || null,
    // World-model situation (only when reading /api/canonical/now).
    situation: data?.situation || null,
    lifecycleAvailable: data?.attention?.available ?? false,
    refresh: load,
    act,
  };
}

export { DEFER_REASONS };
