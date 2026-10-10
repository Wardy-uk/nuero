import HikeSafetyCard from './canonical/HikeSafetyCard';
import './HikeSafetyPanel.css';

/**
 * Life → Hike safety — its own page (Nick, 10 Oct 2026), not a fold inside
 * Outdoor: arming a walk, checking in, and watching it on the map. The card is
 * the whole page; Outdoor keeps the hike goal and route plans.
 */
export default function HikeSafetyPanel() {
  return (
    <div className="hike-panel">
      <h1 className="hike-panel__title">Hike safety</h1>
      <p className="hike-panel__lede">Arm a walk with its GPX and times. Check in when you’re back — if you don’t, the people below are emailed your route card and last known position.</p>
      <HikeSafetyCard />
    </div>
  );
}
