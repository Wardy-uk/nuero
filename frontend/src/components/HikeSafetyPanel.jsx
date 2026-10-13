import HikeSafetyCard from './canonical/HikeSafetyCard';
import './HikeSafetyPanel.css';

/**
 * Life → Hike safety — its own page (Nick, 10 Oct 2026), not a fold inside
 * Outdoor: arming a walk, checking in, and watching it on the map. The card is
 * the whole page; Outdoor keeps the hike goal and route plans. The card opens
 * with its own answer (armed / overdue / no walk armed); what it does and its
 * limits are in the card's "How this works".
 */
export default function HikeSafetyPanel() {
  return (
    <div className="hike-panel">
      <h1 className="hike-panel__title">Hike safety</h1>
      <HikeSafetyCard />
    </div>
  );
}
