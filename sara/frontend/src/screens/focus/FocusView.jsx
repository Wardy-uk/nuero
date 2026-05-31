import { useSaraState } from '../../state/saraState';
import './FocusView.css';

// Focus v0 — one thing, timeboxed (WS post-WS2A).
//
// The narrowest SARA view: the single current do-next and nothing competing with it.
// A pure representation of `useSaraState()` — it owns NO data. The do-next, its
// reason, timebox and defer history come from the WS1 engine's focus domain; the
// "then" peek comes from the shared placeholder presentation; the clock is the shared
// clock. The screen formats and orders only (charter principle 7).
//
// Honesty: there is no running countdown here. A live timer would need a start-time in
// shared state, which the WS1 contract does not provide, so the timebox is shown as the
// target it is — not a fabricated screen-owned clock. No telemetry, no WS3 dependency.

export default function FocusView() {
  const { status, error, model, presentation } = useSaraState();

  if (status === 'connecting') {
    return (
      <section className="focus focus--message">
        <p className="focus__waking">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="focus focus--message">
        <p className="focus__offline">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  const focus = model.domains?.focus;
  const goal = focus?.current;
  // The escalation ladder is indexed by how many times this has been deferred.
  const nudge = goal?.deferCount > 0 ? focus?.deferEscalation?.[Math.min(goal.deferCount - 1, (focus.deferEscalation.length || 1) - 1)] : null;
  const then = presentation.upNext?.[0];

  if (!goal) {
    return (
      <section className="focus focus--message" aria-label="Focus">
        <p className="focus__none">Nothing set — pick the highest-leverage thing and start.</p>
      </section>
    );
  }

  return (
    <section className="focus" aria-label="Focus">
      <p className="focus__label">Your one thing</p>
      <h2 className="focus__title">{goal.title}</h2>
      {goal.reason && <p className="focus__reason">{goal.reason}</p>}

      <div className="focus__meta">
        {typeof goal.timeboxMins === 'number' && (
          <span className="focus__timebox">{goal.timeboxMins} min timebox</span>
        )}
        {goal.deferCount > 0 && (
          <span className="focus__deferred">deferred ×{goal.deferCount}</span>
        )}
      </div>

      {nudge && <p className="focus__nudge">{nudge}</p>}

      {then && (
        <p className="focus__then">
          Then · {then.time} {then.label}
        </p>
      )}

      {/* Large touch intents — placeholders in v0 (no handlers), same honesty as
          Mission Control's Quick Actions. `data-action` is the stable id a later
          work package wires up. */}
      <div className="focus__actions" aria-label="Focus actions">
        <button type="button" className="focus__action focus__action--primary" data-action="start-focus">
          Start
        </button>
        <button type="button" className="focus__action" data-action="defer">
          Defer
        </button>
        <button type="button" className="focus__action" data-action="done">
          Done
        </button>
      </div>
    </section>
  );
}
