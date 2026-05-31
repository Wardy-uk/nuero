import { getView } from '../state/views';

// PlannedView — calm placeholder for a declared-but-not-yet-built view.
//
// Any future product screen can land here until it is implemented without changing the
// shared-state model or the surrounding app shell.
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
