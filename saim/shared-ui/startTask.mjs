// "Start this task" (31 Oct 2026) — the ONE way a shell starts a focus session
// on a task from SAiM's Keep my word card or the Task workflow screen.
//
// PURE apart from the injected `call` ({status, body} over NEURO's own fetch).
// The focus-session route answers 409 when another session is running, with
// that session in the body — so the caller can ask "You're on X. Switch to
// this?" and retry with `force` only after Nick says yes. Never throws.

/** → { ok: true, session } | { ok: false, conflict: { text } } | { ok: false, error } */
export async function startTaskSession(call, { taskId, text = '', force = false, source = 'keep-my-word' } = {}) {
  if (!call) return { ok: false, error: 'This screen can’t start a focus session.' };
  try {
    const r = await call('/api/session/start', { method: 'POST', body: { taskId: taskId == null ? null : Number(taskId), text: text || '', force: Boolean(force), source } });
    const b = r && r.body;
    if (r && r.status === 409) {
      const s = b && b.session;
      // Already on THIS task: nothing to switch — the session running is the one asked for.
      if (s && taskId != null && s.taskId != null && Number(s.taskId) === Number(taskId)) return { ok: true, session: s, already: true };
      return { ok: false, conflict: { text: (s && s.text) || 'another task' } };
    }
    if (r && r.status >= 200 && r.status < 300 && b && b.ok !== false) return { ok: true, session: b.session || null };
    return { ok: false, error: (b && b.error) || `NEURO answered ${r ? r.status : 'nothing'}, so no focus session was started.` };
  } catch {
    return { ok: false, error: 'NEURO didn’t answer, so no focus session was started.' };
  }
}

/** The switch question, in one place. */
export const switchQuestion = (text) => `You’re on ${text || 'another task'}. Switch to this?`;
