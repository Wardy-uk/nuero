import { useSaraState } from '../state/saraState';
import { SARA_VIEWS } from '../state/views';
import MissionControl from '../screens/mission-control/MissionControl';
import ExecutiveDashboard from '../screens/executive-dashboard/ExecutiveDashboard';
import PresenceMode from '../screens/presence/PresenceMode';
import FocusView from '../screens/focus/FocusView';
import CompanionView from '../screens/companion/CompanionView';
import StreamDeck from '../screens/stream-deck/StreamDeck';
import PlannedView from './PlannedView';

// ViewRouter — renders the screen for the current view.
//
// This is the seam that makes "one state, many views" real: the current view is a
// value in shared state, and the router maps it to a screen. All six declared views
// are now wired to real screens; PlannedView remains the safe fallback for any future
// view id added to the registry before its screen lands. The shared state model and
// the rest of the app stay untouched as views are added.
export default function ViewRouter() {
  const { currentView } = useSaraState();

  switch (currentView) {
    case SARA_VIEWS.MISSION_CONTROL:
      return <MissionControl />;
    case SARA_VIEWS.EXECUTIVE_DASHBOARD:
      return <ExecutiveDashboard />;
    case SARA_VIEWS.PRESENCE:
      return <PresenceMode />;
    case SARA_VIEWS.FOCUS:
      return <FocusView />;
    case SARA_VIEWS.COMPANION:
      return <CompanionView />;
    case SARA_VIEWS.STREAM_DECK:
      return <StreamDeck />;
    default:
      return <PlannedView viewId={currentView} />;
  }
}
