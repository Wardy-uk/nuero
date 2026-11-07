import { apiFetch, apiUrl, authHeaders } from './api';
import { makeCall } from './preparedMove.mjs';
import { completeTask as sharedComplete, outcomeLine } from '../../shared-ui/completeTask.mjs';

// Completing a task means different things depending on who owns it, and there
// are three owners. The owner order and the reading of what the server answered
// (done / repeated / rolled / held / refused) live ONCE, in
// saim/shared-ui/completeTask.mjs, shared with NEURO's desktop (7 Nov 2026).
// This file is the phone's transport for it plus the wins headline.

export const saimCall = makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders });

/**
 * What the day comes to, asked for straight after a completion lands.
 *
 * NEVER allowed to fail the completion. The task IS closed by the time this
 * runs; a bookkeeping error must not surface as "that didn't work" and send
 * Nick back to tick it again. The WORDS come from the server (wins.headline).
 */
export async function headlineAfterCompletion() {
  try {
    const data = await apiFetch('/api/wins');
    return data?.headline || null;
  } catch {
    return null;
  }
}

/**
 * The outcome-aware tick. → { ...outcome, headline } where outcome is the
 * shared helper's ({ kind: done|repeated|rolled|held|refused|error, ... }).
 * The headline is asked for only when something was closed.
 */
export async function completeTaskOutcome(item, opts = {}) {
  const outcome = await sharedComplete(saimCall, item, opts);
  const closed = outcome.kind === 'done' || outcome.kind === 'repeated' || outcome.kind === 'rolled';
  return { ...outcome, headline: closed ? await headlineAfterCompletion() : null };
}

/**
 * The older contract (NotificationActionCard): resolves to the wins headline,
 * THROWS when nothing was closed — with the server's own words, so a Jira-linked
 * task says which ticket closes it rather than failing silently.
 */
export async function completeTask(item) {
  if (!item) throw new Error('No task given');
  const o = await completeTaskOutcome(item);
  if (o.kind === 'refused' || o.kind === 'error' || o.kind === 'held') throw new Error(outcomeLine(o));
  return o.headline || (o.kind === 'repeated' || o.kind === 'rolled' ? outcomeLine(o) : null);
}
