import { useSaraState } from '../state/saraState';
import { SARA_VIEWS } from '../state/views';
import MissionControl from '../screens/mission-control/MissionControl';
import PlannedView from './PlannedView';

// ViewRouter — renders the screen for the current view (WS2-WP1).
//
// This is the seam that makes "one state, many views" real: the current view is a
// value in shared state, and the router maps it to a screen. WS2-WP1 wires only
// Mission Control; every other declared view falls through to a calm PlannedView
// placeholder. Adding a real screen later is a one-line case here — the shared
// state model and the rest of the app stay untouched.
export default function ViewRouter() {
  const { currentView } = useSaraState();

  switch (currentView) {
    case SARA_VIEWS.MISSION_CONTROL:
      return <MissionControl />;
    default:
      return <PlannedView viewId={currentView} />;
  }
}
