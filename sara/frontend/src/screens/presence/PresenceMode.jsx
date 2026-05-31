import { useSaraState } from '../../state/saraState';
import './PresenceMode.css';

// Presence Mode v0 — the calm ambient SARA view (WS2A-WP1).
//
// The same shared state as Mission Control and Executive Dashboard, distilled to its
// quietest form: a large clock, where you are, the one line SARA would say, and the
// next thing on the runway. It is a pure representation of `useSaraState()` and owns
// NO data — the WS1 State Engine model supplies the briefing line, location, focus and
// status; the shared placeholder presentation supplies Up Next; the shared clock
// supplies the time. Where the dashboard expands, Presence subtracts: it shows less of
// the same model, never a different model (charter principle 7).
//
// No Home Assistant / WS3 telemetry: everything here is from the existing WS1 contract.

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function PresenceMode() {
  const { status, error, model, now, presentation } = useSaraState();

  if (status === 'connecting') {
    return (
      <section className="presence presence--message">
        <p className="presence__waking">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="presence presence--message">
        <p className="presence__offline">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  const goal = model.domains?.focus?.current;
  const next = presentation.upNext?.[0];

  return (
    <section className="presence" aria-label="Presence">
      {/* Large ambient clock — read from the shared clock, not a screen timer */}
      <div className="presence__clock">
        <span className="presence__time">{formatTime(now)}</span>
        <span className="presence__date">{formatDate(now)}</span>
      </div>

      {/* Where you are + SARA's quiet status — situational, from shared state */}
      <div className="presence__situational">
        <span className="presence__location">{model.location?.label}</span>
        <span className="presence__dot" aria-hidden="true">·</span>
        <span className="presence__status" data-state={model.sara?.status}>
          SARA {model.sara?.status}
        </span>
      </div>

      {/* The one line SARA would say — the engine's derived briefing, read verbatim */}
      {model.briefing?.line && <p className="presence__briefing">{model.briefing.line}</p>}

      {/* The single next thing, softly. The current goal grounds it. */}
      <div className="presence__runway">
        {goal && (
          <div className="presence__focus">
            <span className="presence__focus-label">Now</span>
            <span className="presence__focus-title">{goal.title}</span>
          </div>
        )}
        {next && (
          <div className="presence__next">
            <span className="presence__next-label">Next · {next.time}</span>
            <span className="presence__next-title">{next.label}</span>
          </div>
        )}
      </div>
    </section>
  );
}
