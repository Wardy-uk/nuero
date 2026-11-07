import CapabilityGaps from './CapabilityGaps';

// "What NEURO could do" — its own page (7 Nov 2026). It used to be a card on
// NEURO Health, under Her senses, and Nick could never find it. Same component,
// same routes (/api/setup/capabilities); only the door moved.
export default function CouldDoPage() {
  return (
    <div className="could-do-page" style={{ width: '100%', maxWidth: 'none', padding: '16px 24px' }}>
      <CapabilityGaps />
    </div>
  );
}
