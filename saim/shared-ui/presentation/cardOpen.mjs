// Holding the week (22 Oct 2026) — performing a card's target, ONE implementation
// for NEURO desktop and the SAiM phone. The server chose the target (keep-my-word-cards-v1);
// this only carries it out with the shell's own openers and its authenticated
// `call` ({ status, body }), and reports what actually happened in plain words.
//
// The two targets that change anything use routes that already exist and already
// guard themselves: a focus session (POST /api/session/start) and a governed
// delivery note that is PREPARED only (POST /api/promises/:key/prepare — it waits
// in Actions for the approval code; nothing is sent). A read-only shell (the kiosk)
// is never given this function.

/** The kinds a shell can perform, given the openers it has. */
export function kindsFor({ openView = null, openTask = null, openNote = null, openUrl = null, call = null } = {}) {
  const k = [];
  if (openView) k.push('view');
  if (openTask) k.push('task');
  if (openNote) k.push('note');
  if (openUrl) k.push('url');
  if (call) k.push('session-start', 'prepare-delivery');
  return k;
}

/** → { ok, say } for an action, or null for a plain navigation. */
export async function performCardTarget(target, { call = null, openView = null, openTask = null, openNote = null, openUrl = null } = {}) {
  if (!target) return null;
  switch (target.kind) {
    case 'view': if (openView) openView(target.view, target.context || null); return null;
    case 'task': if (openTask) openTask(target.taskId); return null;
    case 'note': {
      // An opener that cannot open THIS note returns where it is, rather than doing nothing in silence.
      const m = openNote ? openNote({ path: target.path, obsidianUrl: target.obsidianUrl || null }) : null;
      return typeof m === 'string' ? { ok: false, say: m } : null;
    }
    case 'url': if (openUrl) openUrl(target.href); return null;
    case 'session-start': {
      let r;
      try {
        r = await call('/api/session/start', { method: 'POST', body: { taskId: target.taskId, minutes: target.minutes, text: target.text || '', source: 'manual' } });
      } catch { return { ok: false, say: 'NEURO didn’t answer — no session was started.' }; }
      const b = (r && r.body) || {};
      if (r && r.status === 200 && b.ok !== false) return { ok: true, say: `Focus session started — ${target.minutes} minutes on “${target.text || 'this block'}”.` };
      if (b.reason === 'session-active') return { ok: false, say: `A focus session on “${(b.session && b.session.text) || 'another task'}” is already running — finish or pause it first. No new session was started.` };
      return { ok: false, say: b.error || b.message || `NEURO answered ${r ? r.status : 'nothing'} — no session was started.` };
    }
    case 'prepare-delivery': {
      let r;
      try {
        r = await call(`/api/promises/${encodeURIComponent(target.key)}/prepare`, { method: 'POST', body: {} });
      } catch { return { ok: false, say: 'NEURO didn’t answer — nothing was drafted.' }; }
      const b = (r && r.body) || {};
      if (r && r.status === 200 && b.ok) return { ok: true, say: b.already ? 'The delivery note was already drafted — nothing new was created. It waits in Actions for your approval; nothing was sent.' : 'Delivery note drafted. It waits in Actions for your approval code — nothing was sent.' };
      return { ok: false, say: b.error || `NEURO answered ${r ? r.status : 'nothing'} — nothing was drafted.` };
    }
    default: return null;
  }
}
