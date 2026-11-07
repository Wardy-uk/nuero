import React from 'react';
import SharedDelegateTasks, { setDelegatePool, delegateItemOf } from '../../../saim/shared-ui/DelegateTasks.jsx';
import { desktopCall } from '../desktopCall';

/**
 * Delegate (6 Nov 2026) — backend/services/task-delegation.js.
 *
 * The panel itself lives in saim/shared-ui/DelegateTasks.jsx since 7 Nov 2026,
 * so SAiM's Tasks and the Task workflow screen mount the SAME one. This is the
 * desktop's transport for it.
 */
export { setDelegatePool, delegateItemOf };

export default function DelegateTasks(props) {
  return <SharedDelegateTasks call={desktopCall} {...props} />;
}
