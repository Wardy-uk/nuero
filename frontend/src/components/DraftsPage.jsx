import Drafts from '../../../saim/app/src/views/Drafts.jsx';
import { desktopCall } from '../desktopCall';
import { openInVault } from '../openVault';

// NEURO desktop's Drafts (22 Oct 2026): the SAME view the SAiM app renders, over
// the desktop's own authenticated client — one list, one source, two shells.
// A saved draft opens in NEURO's Vault view; its task lands on that exact task (22 Oct 2026).
export default function DraftsPage({ context = null, onNavigate = null }) {
  const onOpenTask = onNavigate ? (t) => onNavigate('todos', { taskId: t.id, fromFocus: true }) : null;
  return <div className="main-view drafts-page"><Drafts call={desktopCall} context={context} onOpenNote={(w) => openInVault(w.path)} onOpenTask={onOpenTask} /></div>;
}
