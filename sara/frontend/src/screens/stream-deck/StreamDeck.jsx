import { useSaraState } from '../../state/saraState';
import { VIEW_REGISTRY } from '../../state/views';
import './StreamDeck.css';

// Stream Deck v0 — large touch-action grid for quick triggers (WS post-WS2A).
//
// A wall of big keys, built for fingers on the Pi touchscreen. Two key sources, both
// from shared state — the screen owns no data:
//   1. Action keys  — the shared placeholder Quick Actions (presentation.quickActions),
//      the same set Mission Control shows, here as full-size keys. Intent placeholders
//      in v0 (data-action, no handlers), consistent with Mission Control's honesty.
//   2. View keys    — jump straight to another view via the current-view system
//      (setCurrentView from shared state). This is the existing view switch, expressed
//      as touch keys; the active view is omitted (you're already there).
//
// No telemetry, no WS3 dependency.

export default function StreamDeck() {
  const { status, error, model, presentation, currentView, setCurrentView } = useSaraState();

  if (status === 'connecting') {
    return (
      <section className="deck deck--message">
        <p className="deck__waking">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="deck deck--message">
        <p className="deck__offline">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  const actions = presentation.quickActions ?? [];
  const jumpTargets = VIEW_REGISTRY.filter((v) => v.id !== currentView);

  return (
    <section className="deck" aria-label="Stream Deck">
      <p className="deck__label">Quick triggers</p>
      <div className="deck__grid" aria-label="Action keys">
        {actions.map((a) => (
          <button key={a.id} type="button" className="deck__key" data-action={a.action}>
            <span className="deck__key-icon" aria-hidden="true">{a.icon}</span>
            <span className="deck__key-label">{a.label}</span>
          </button>
        ))}
      </div>

      <p className="deck__label">Jump to a view</p>
      <div className="deck__grid" aria-label="View keys">
        {jumpTargets.map((v) => (
          <button
            key={v.id}
            type="button"
            className="deck__key deck__key--view"
            onClick={() => setCurrentView(v.id)}
          >
            <span className="deck__key-label deck__key-label--view">{v.label}</span>
            {v.status === 'planned' && <span className="deck__key-soon">soon</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
