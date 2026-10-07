import HouseholdCard from '../../../shared-ui/HouseholdCard';
import { apiFetch, apiFetchBlob } from '../api';

// Who's in the house (7 Oct 2026). The phone and the kiosk mount this same view
// (shared tab registry); apiFetch reaches NEURO with the PIN on the phone and
// through saim/backend's `household` door on the kiosk. Module-scope transports
// so the card's effects do not re-arm on every render.
const fetchHousehold = () => apiFetch('/api/household');
const fetchPhoto = async (id, version) => {
  const blob = await apiFetchBlob(`/api/household/photo/${encodeURIComponent(id)}?v=${version}`);
  return blob && blob.size ? URL.createObjectURL(blob) : null;
};

export default function Household() {
  return (
    <div style={{ padding: '16px' }}>
      <HouseholdCard fetchJson={fetchHousehold} fetchPhoto={fetchPhoto} />
    </div>
  );
}
