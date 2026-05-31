import { getView } from '../state/views';

// PlannedView — calm placeholder for a declared-but-not-yet-built view (WS2-WP1).
//
// The architecture reserves several future views (Executive Dashboard, Presence,
// Focus, Companion, Stream Deck). They are real entries in the view registry but
// have no screen yet. Selecting one lands here. This exists so the many-views
// structure is demonstrable now without building those screens (out of scope), and
// proves the current view can change away from Mission Control — the app is not
// locked to a single home screen.
export default function PlannedView({ viewId }) {
  const view = getView(viewId);
  return (
    <section className="planned" aria-label={`${view?.label || 'View'} — planned`}>
      <p className="planned__tag">Planned view</p>
      <h2 className="planned__title">{view?.label || viewId}</h2>
      <p className="planned__blurb">{view?.blurb}</p>
      <p className="planned__note">
        This view is reserved by SARA's many-views architecture. It reads the same
        shared state as Mission Control and arrives in a later work package.
      </p>
    </section>
  );
}
