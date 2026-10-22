import Drafts from '../../../saim/app/src/views/Drafts.jsx';
import { desktopCall } from '../desktopCall';

// NEURO desktop's Drafts (22 Oct 2026): the SAME view the SAiM app renders, over
// the desktop's own authenticated client — one list, one source, two shells.
export default function DraftsPage({ context = null }) {
  return <div className="main-view drafts-page"><Drafts call={desktopCall} context={context} /></div>;
}
