import { useSaraState } from '../state/saraState';
import { VIEW_REGISTRY, normalizeViewId } from '../state/views';

// ViewSwitcher — manual, touch-friendly selector for the current view (WS2-WP1).
//
// Charter principle 7 requires SARA to support a manually user-selected view. This
// is the minimal expression of that: a row of chips, one per declared view, that
// sets `currentView` in shared state. Planned views are selectable too (they land
// on PlannedView) so the many-views architecture is visible and exercisable now.
// Automatic recommended-view logic and swipe navigation are deliberately out of
// scope for this work package.
export default function ViewSwitcher() {
  const { currentView, setCurrentView } = useSaraState();

  return (
    <nav className="switcher" aria-label="SARA views">
      {VIEW_REGISTRY.map((view) => {
        const active = view.id === normalizeViewId(currentView);
        return (
          <button
            key={view.id}
            type="button"
            className={`switcher__chip${active ? ' switcher__chip--active' : ''}`}
            aria-pressed={active}
            onClick={() => setCurrentView(view.id)}
          >
            {view.label}
            {view.status === 'planned' && <span className="switcher__soon">soon</span>}
          </button>
        );
      })}
    </nav>
  );
}
