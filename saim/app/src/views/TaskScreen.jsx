import { useMemo } from 'react';
import { apiUrl, authHeaders } from '../api';
import { makeCall } from '../preparedMove.mjs';
import { prepareDelivery, promiseMove } from '../promiseDelivery.mjs';
import TaskWorkflow from '../../../shared-ui/TaskWorkflow.jsx';
import TaskAgent from '../../../shared-ui/TaskAgent.jsx';
import TaskContext from '../../../shared-ui/TaskContext.jsx';
import PromiseSave from '../components/PromiseSave.jsx';
import PreparedMove from '../components/PreparedMove.jsx';
import { platformNow } from '../../../shared-ui/presentation/platform.mjs';

// SAiM's Task workflow screen (31 Oct 2026): a pushed secondary screen with the
// shell's own Back, opened by "Start this task" on the Keep my word card
// (onNavigate('task', { context: { taskId, key, startError } })). Never in the
// More menu. Read-only on the kiosk (which has no Start button to reach it).
export default function TaskScreen({ context = null, onNavigate = null }) {
  const call = useMemo(() => makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders }), []);
  const taskId = context && context.taskId != null ? context.taskId : null;
  const key = (context && context.key) || null;
  const kiosk = platformNow() === 'kiosk';
  if (taskId == null && !key) {
    return <div className="twf"><div className="twf__card"><p>No task was named. Start a task from SAiM’s home.</p></div></div>;
  }
  return (
    <TaskWorkflow
      taskId={taskId}
      promiseKey={key}
      call={call}
      readOnly={kiosk}
      startError={(context && context.startError) || null}
      onPrepareDelivery={(k) => prepareDelivery(k)}
      onPromiseMove={(op) => promiseMove(op)}
      renderPromiseSave={({ recordId }) => <PromiseSave recordId={recordId} hideContextFor={taskId} />}
      renderTools={({ taskId: id }) => (
        <>
          <TaskAgent taskId={id} call={call} readOnly={kiosk} renderSave={(recordId, done) => <PreparedMove call={call} recordId={recordId} embedded onChanged={done} />} />
          <TaskContext taskId={id} call={call} editable={!kiosk} />
        </>
      )}
      onBack={null}
      onOpenTask={onNavigate && !kiosk ? () => onNavigate('tasks') : null}
    />
  );
}
