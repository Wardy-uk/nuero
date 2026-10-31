import { apiFetch } from '../api';
import TaskWorkflow from '../../../saim/shared-ui/TaskWorkflow.jsx';
import TaskContext from '../../../saim/shared-ui/TaskContext.jsx';
import TaskAgent from '../../../saim/shared-ui/TaskAgent.jsx';
import PromiseSave from '../../../saim/app/src/components/PromiseSave.jsx';
import PreparedMove from '../../../saim/app/src/components/PreparedMove.jsx';
import { promiseMoveRequest } from '../../../saim/app/src/promiseMoveRequest.mjs';
import { openInVault } from '../openVault';
import { desktopCall } from '../desktopCall';

// NEURO desktop's Task workflow screen (31 Oct 2026): view id `task`, opened by
// "Start this task" on the Keep my word card (onNavigate('task', { taskId, key,
// startError })) or by `?view=task&taskId=N&key=promise:N`. Not in the sidebar.
// Every control goes through the route that already governs it.

async function postJson(path, body) {
  try {
    const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const b = await res.json().catch(() => null);
    return b && typeof b === 'object' ? (res.ok ? b : { ...b, ok: false }) : { ok: false, error: `NEURO answered ${res.status}.` };
  } catch { return { ok: false, error: 'NEURO didn’t answer.' }; }
}

export default function TaskWorkflowPage({ context = null, onNavigate = null }) {
  const taskId = context && context.taskId != null ? context.taskId : null;
  const key = (context && context.key) || null;
  const openActions = onNavigate ? () => onNavigate('actions') : null;
  return (
    <TaskWorkflow
      taskId={taskId}
      promiseKey={key}
      call={desktopCall}
      startError={(context && context.startError) || null}
      onBack={onNavigate ? () => onNavigate('today') : null}
      onOpenTask={onNavigate ? (id) => onNavigate('todos', { taskId: id, fromFocus: true }) : null}
      onOpenActions={openActions}
      // Only PREPARES the governed delivery note — it waits in Actions for the approval.
      onPrepareDelivery={(k) => postJson(`/api/promises/${encodeURIComponent(k)}/prepare`, {})}
      // Take the promise forward as a prepared move: stores a proposal or Nick's answer only.
      onPromiseMove={async (op) => {
        const req = promiseMoveRequest(op);
        if (!req) return { ok: false, error: 'That isn’t something this screen can do.' };
        return postJson(req.path, req.body);
      }}
      renderPromiseSave={({ recordId }) => <PromiseSave recordId={recordId} call={desktopCall} onOpenContext={openInVault} onOpenNote={(n) => openInVault(n.path)} hideContextFor={taskId} />}
      renderTools={({ taskId: id }) => (
        <>
          <TaskAgent taskId={id} call={desktopCall} onOpenNote={(x) => x.path && openInVault(x.path)} onOpenActions={openActions}
            renderSave={(recordId, done) => <PreparedMove call={desktopCall} recordId={recordId} embedded onChanged={done} />} />
          <TaskContext taskId={id} call={desktopCall} onOpen={openInVault} editable />
        </>
      )}
    />
  );
}
