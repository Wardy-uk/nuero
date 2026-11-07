// Kept out of PreparedMove.jsx so a Now row's "Make this ready" can use it without
// pulling the whole prepared-move card into the first screen's bundle.
import { askToConfirm, interviewOf } from '../preparedMove.mjs';

/**
 * "Make this ready" lands on the Confirm step (7 Nov 2026, Nick: a prepared move
 * cost a press to make it, a trip to Drafts and a press to "Open the
 * confirmation" before he could say yes). Given the state a Make-ready press
 * just reached, ask for the confirmation IN THAT SAME PRESS — on the same route
 * the save button uses — when there is exactly one obvious thing to confirm.
 * Anything that still needs Nick first (an open interview, a question, a held
 * move, nothing to choose) is returned unchanged: never auto-asks for the
 * "save it unfinished" option, never a confirmation he did not press for.
 */
export async function confirmIfReady(call, s, sessionId, ask = askToConfirm) {
  const m = s && s.kind === 'ready' && s.view && s.view.move;
  if (!m || m.held || m.plan === 'ask' || !(m.options || []).length || !s.option) return s;
  const iv = interviewOf(m);
  if (iv && iv.next) return s;
  return ask(call, { view: s.view, option: s.option, sessionId });
}
