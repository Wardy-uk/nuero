import { useSaraState } from '../state/saraState';
import { SARA_VIEWS } from '../state/views';
import MissionControl from '../screens/mission-control/MissionControl';
import ExecutiveDashboard from '../screens/executive-dashboard/ExecutiveDashboard';
import PresenceMode from '../screens/presence/PresenceMode';
import PlannedView from './PlannedView';

// ViewRouter — renders the screen for the current view (WS2-WP1 / WS2A-WP1).
//
// This is the seam that makes "one state, many views" real: the current view is a
// value in shared state, and the router maps it to a screen. WS2-WP1 wired Mission
// Control; WS2A-WP1 wires Executive Dashboard and Presence. Every still-planned view
// falls through to a calm PlannedView placeholder. Adding a real screen is a one-line
// case here — the shared state model and the rest of the app stay untouched.
export default function ViewRouter() {
  const { currentView } = useSaraState();

  switch (currentView) {
    case SARA_VIEWS.MISSION_CONTROL:
      return <MissionControl />;
    case SARA_VIEWS.EXECUTIVE_DASHBOARD:
      return <ExecutiveDashboard />;
    case SARA_VIEWS.PRESENCE:
      return <PresenceMode />;
    default:
      return <PlannedView viewId={currentView} />;
  }
}
