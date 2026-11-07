// "Start" (31 Oct 2026; one helper for every Start button since 7 Nov 2026) —
// the ONE way a shell starts a focus session on a task.
//
// PURE apart from the injected `call` ({status, body} over NEURO's own fetch).
//
// ⚠ NO SWITCH QUESTION (7 Nov 2026, audit C/F6). Five surfaces asked "Park it
// and start this instead?" — four of them with a blocking browser confirm — at
// the exact moment Nick's difficulty bites (starting). Parking is reversible, so
// a press SWITCHES straight away and the shell shows, in place,
// "Parked <previous task> — Resume it" (resumeParked). Never throws.

let _lastParked = null;

/** The switch it just made, for a screen that opens right after (the Task
 *  workflow screen). Read once, and only within a minute. */
export function takeParked() {
  const p = _lastParked;
  _lastParked = null;
  return p && Date.now() - p.at < 60_000 ? p : null;
}

async function post(call, body) {
  return call('/api/session/start', { method: 'POST', body });
}

/**
 * → { ok: true, session, parked?: { taskId, text, elapsedMinutes }, already? } | { ok: false, error }
 * `force` is accepted for older callers and changes nothing: a busy slot is always switched.
 */
export async function startTaskSession(call, { taskId, text = '', minutes = null, source = 'keep-my-word' } = {}) {
  if (!call) return { ok: false, error: 'This screen can’t start a focus session.' };
  const body = { taskId: taskId == null || taskId === '' ? null : Number(taskId), text: text || '', source };
  if (minutes != null && Number.isFinite(Number(minutes))) body.minutes = Number(minutes);
  try {
    const r = await post(call, body);
    const b = r && r.body;
    if (r && r.status === 409) {
      const s = (b && b.session) || null;
      // Already on THIS task: nothing to switch — the session running is the one asked for.
      if (s && body.taskId != null && s.taskId != null && Number(s.taskId) === body.taskId) return { ok: true, session: s, already: true };
      const forced = await post(call, { ...body, force: true });
      const fb = forced && forced.body;
      if (!(forced && forced.status >= 200 && forced.status < 300 && fb && fb.ok !== false)) {
        return { ok: false, error: (fb && fb.error) || `NEURO answered ${forced ? forced.status : 'nothing'}, so no focus session was started.` };
      }
      const parked = s ? { taskId: s.taskId == null ? null : Number(s.taskId), text: s.text || 'the last task', elapsedMinutes: s.elapsedMinutes ?? null } : null;
      if (parked) _lastParked = { ...parked, at: Date.now() };
      return { ok: true, session: fb.session || null, parked };
    }
    if (r && r.status >= 200 && r.status < 300 && b && b.ok !== false) return { ok: true, session: b.session || null };
    return { ok: false, error: (b && b.error) || `NEURO answered ${r ? r.status : 'nothing'}, so no focus session was started.` };
  } catch {
    return { ok: false, error: 'NEURO didn’t answer, so no focus session was started.' };
  }
}

/** "Resume it" — put the parked task back in focus (parking the current one). */
export async function resumeParked(call, parked, { source = 'manual' } = {}) {
  if (!parked) return { ok: false, error: 'Nothing was parked.' };
  return startTaskSession(call, { taskId: parked.taskId, text: parked.text, source });
}

/** "Parked X — Resume it", the words. PURE. */
export const parkedLine = (parked) => (parked ? `Parked “${parked.text}”${Number.isFinite(parked.elapsedMinutes) && parked.elapsedMinutes > 0 ? ` (${parked.elapsedMinutes} min in)` : ''}.` : null);

/**
 * "It's too big" (7 Nov 2026, audit H). Never hides the task: it starts a
 * 15-minute focus session on the smallest first step he named. The defer
 * reason `too-big` is recorded only when he chooses "Not today anyway"
 * (that is the caller's defer route, not this).
 * → { ok, session, parked?, step } | { ok: false, error }
 */
export async function startSmallestStep(call, { taskId = null, text = '', step = '', minutes = 15, source = 'manual' } = {}) {
  const s = String(step || '').trim();
  if (!s) return { ok: false, error: 'Name the smallest first step, then start.' };
  const r = await startTaskSession(call, { taskId, text, minutes, source });
  if (!r.ok) return r;
  try {
    const k = await call('/api/session/shrink', { method: 'POST', body: { step: s } });
    if (!(k && k.status >= 200 && k.status < 300)) {
      return { ...r, step: null, error: `Started 15 minutes on the task, but the step wasn’t saved (${(k && k.body && k.body.error) || (k && k.status)}).` };
    }
    return { ...r, session: (k.body && k.body.session) || r.session, step: s };
  } catch {
    return { ...r, step: null, error: 'Started 15 minutes on the task, but the step wasn’t saved — NEURO didn’t answer.' };
  }
}

/** Kept for older callers; no surface asks this any more. */
export const switchQuestion = (text) => `You’re on ${text || 'another task'}. Switch to this?`;
