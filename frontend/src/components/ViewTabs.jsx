import React from 'react';
import './ViewTabs.css';

/**
 * Views that share one sidebar entry and switch by tab (Life overhaul,
 * 13 Oct 2026). Each tab is still its OWN view id — deep links, `?view=`
 * launch intents and notifications (hike_checkin → hike-safety) keep landing
 * exactly where they did; the sidebar entry is the group's first id and stays
 * lit for every tab in it.
 */
export const VIEW_GROUPS = Object.freeze({
  health: [
    { id: 'my-health', label: 'My Health' },
    { id: 'health', label: 'Apple Health' },
    { id: 'jc-ring', label: 'JC Ring' },
    { id: 'medical', label: 'Medical' },
  ],
  home: [
    { id: 'home', label: 'Home' },
    { id: 'catalogues', label: 'Catalogues' },
  ],
  outdoor: [
    { id: 'outdoor', label: 'Outdoor' },
    { id: 'hike-safety', label: 'Hike safety' },
    { id: 'weather', label: 'Weather' },
  ],
});

const GROUP_BY_VIEW = new Map(
  Object.entries(VIEW_GROUPS).flatMap(([g, tabs]) => tabs.map((t) => [t.id, g])),
);

export function groupOfView(id) {
  return GROUP_BY_VIEW.get(id) || null;
}

export default function ViewTabs({ active, onNavigate }) {
  const group = groupOfView(active);
  if (!group) return null;
  return (
    <div className="view-tabs" role="tablist">
      {VIEW_GROUPS[group].map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === active}
          className={`view-tab${t.id === active ? ' view-tab--active' : ''}`}
          onClick={() => t.id !== active && onNavigate(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
