import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import AttentionCard from './AttentionCard';
import Situation from '../../../saim/shared-ui/presentation/Situation.jsx';
import { performCardTarget, kindsFor } from '../../../saim/shared-ui/presentation/cardOpen.mjs';
import MakeReady from '../../../saim/app/src/components/MakeReady.jsx';
import { loadEligible } from '../../../saim/app/src/makeReady.mjs';
import { openInVault } from '../openVault';
import { desktopCall } from '../desktopCall';
import { startTaskSession } from '../../../saim/shared-ui/startTask.mjs';

// ONE desktop rendering of the canonical presentation (Build Brief 003,
// 23 Oct 2026): the presentation-v1 `Situation` scene and every governed
// callback it carries, lifted VERBATIM out of AdhdPanel so Now and the SAiM
// workspace render the same scene from the same code. It decides nothing:
// order, wording and eligibility are the server's; each callback only invokes
// the route that already governs it (attention act, focus session, life
// declare, and "Start this task" — the focus-session route, then the Task
// workflow screen, which holds the promise's own controls). There is no second ranker here.

/**
 * PURE. Is the lead card this promise's own task? Only by an id the server gave both —
 * the card's task (capacity cards carry `meta.taskId`) or its promise link
 * (`open.ref`) — never by matching titles.
 */
export function leadIsThePromise(card, kmw) {
  const t = kmw && kmw.thread;
  if (!card || !t) return false;
  if (card.meta && card.meta.taskId != null && t.taskId != null && Number(card.meta.taskId) === Number(t.taskId)) return true;
  return Boolean(card.open && t.key && card.open.ref === `promise:${t.key}`);
}

/** PURE. Does this payload carry the presentation this scene renders? */
export function hasScene(data) {
  return Boolean(data && data.presentation && data.presentation.contract === 'presentation-v1');
}

async function postJson(path, body) {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json().catch(() => null);
}

/**
 * @param {object}   props.attention    the useAttention() result for /api/canonical/now
 * @param {Function} props.onNavigate   the shell's navigate
 * @param {Function} props.onStarted    called after a card starts a focus session
 * @param {Array}    props.blockTasks   the running block's tasks (already shown above; never repeated in Next)
 * @param {number}   props.focusTaskId  the one task Now shows context for, or null
 */
export default function NowScene({ attention, onNavigate, onStarted, blockTasks = [], focusTaskId = null }) {
  // Which Now rows SAiM can make ready — the SERVER's list, each with its exact ref (GET /api/prepared-moves/eligible).
  // Re-read whenever Now is; a failed read offers nothing, never a guess.
  const [eligible, setEligible] = useState(() => new Map());
  useEffect(() => {
    let live = true;
    loadEligible(desktopCall).then((m) => { if (live) setEligible(m); });
    return () => { live = false; };
  }, [attention.data]);
  const eligibleFor = (it) => {
    const ref = it && it.actionRef;
    return (ref && ref.cardId && eligible.get(`attention:${ref.cardId}`)) || (it && it.id && eligible.get(`attention:${it.id}`)) || null;
  };

  if (!hasScene(attention.data)) return null;
  return (
    <Situation
      presentation={attention.data.presentation}
      // NEURO's Now page uses the workspace (22 Oct 2026): the readout earns its space, and a
      // lead card that IS a promise's task shows that promise as its WHY (no repeated title).
      workspace
      kmwJoinsLead={leadIsThePromise(attention.primary, attention.data.presentation.keepMyWord)}
      // The running block's tasks are already the card above — never repeated in Next.
      omitNextIds={new Set((blockTasks || []).map((t) => `commitment:task:${t.taskId}`))}
      profile="desktop"
      renderPrimary={attention.primary ? () => (
        <AttentionCard card={attention.primary} onNavigate={onNavigate} onAct={attention.act} onStarted={onStarted} />
      ) : null}
      onOpen={(it) => {
        if (!onNavigate || !it) return;
        if (it.kind === 'event') onNavigate('calendar');
        else if (it.kind === 'commitment') onNavigate('commitments');
        // A readout card's route (22 Oct 2026): a view, or the exact task it is about.
        else if (it.kind === 'view' && it.view) onNavigate(it.view);
        else if (it.kind === 'task') onNavigate('todos', it.taskId != null ? { taskId: it.taskId, fromFocus: true } : null);
      }}
      // Holding the week (22 Oct 2026): each card's exact target, performed here — the
      // view, the exact task, the draft in the Vault, the block in Outlook, or the two
      // guarded actions (start a focus session; prepare a delivery note — nothing sent).
      cardKinds={kindsFor({ openView: onNavigate, openTask: onNavigate, openNote: true, openUrl: true, call: desktopCall })}
      onCardOpen={async (target) => {
        const r = await performCardTarget(target, {
          call: desktopCall,
          openView: (view, ctx) => onNavigate && onNavigate(view, ctx),
          openTask: (taskId) => onNavigate && onNavigate('todos', { taskId, fromFocus: true }),
          openNote: ({ path }) => openInVault(path),
          openUrl: (href) => { try { window.open(href, '_blank', 'noopener'); } catch { /* blocked: the link is still shown */ } },
        });
        if (r) attention.refresh();
        return r;
      }}
      onCorrect={async (doing) => {
        try { await postJson('/api/signals/life/declare', { doing }); } catch { /* the question stays */ }
        attention.refresh();
      }}
      onNotNow={async () => {
        try { await postJson('/api/signals/life/not-now'); } catch { /* stays */ }
        attention.refresh();
      }}
      // Keep my word (31 Oct 2026): the card's ONE control. Start a focus session on the
      // promise's task (asking first when another one runs) and open its Task workflow
      // screen; a start NEURO refuses for any other reason still opens it, saying why.
      onStartTask={onNavigate ? async ({ taskId, key, title, force }) => {
        const r = await startTaskSession(desktopCall, { taskId, text: title, force });
        if (r.conflict) return r;
        attention.refresh();
        onNavigate('task', { taskId, key, startError: r.ok ? null : r.error });
        return { ok: true };
      } : null}
      renderItemExtra={(it) => {
        const e = eligibleFor(it);
        return e ? <MakeReady item={e} call={desktopCall} onOpenDraft={onNavigate ? (recordId) => onNavigate('drafts', recordId ? { recordId } : null) : null} /> : null;
      }}
    />
  );
}
