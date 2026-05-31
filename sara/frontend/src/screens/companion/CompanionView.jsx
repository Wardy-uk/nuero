import { useSaraState } from '../../state/saraState';
import './CompanionView.css';

// Companion v0 — conversational companion mode, shell only (WS post-WS2A).
//
// Companion is the one planned view that genuinely needs an input channel SARA does not
// have yet: the WS1 contract exposes read-only state over /api/state, with no chat
// endpoint. So v0 is an HONEST SHELL — it presents what SARA can already say from shared
// state as opening messages, and shows a deliberately DISABLED composer with a clear
// note that live conversation arrives in a later work package. It invents no replies and
// owns no data: messages are derived from the engine model (greeting from status/location,
// then the derived briefing line) and the shared clock. No telemetry, no WS3 dependency.

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function CompanionView() {
  const { status, error, model, now } = useSaraState();

  if (status === 'connecting') {
    return (
      <section className="companion companion--message">
        <p className="companion__waking">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="companion companion--message">
        <p className="companion__offline">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  // Opening messages — all derived from shared state, none invented.
  const messages = [
    `Hi Nick. It's ${formatTime(now)} and you're at ${model.location?.label || 'an unknown spot'}.`,
  ];
  if (model.briefing?.line) messages.push(model.briefing.line);

  return (
    <section className="companion" aria-label="Companion">
      <header className="companion__header">
        <span className="companion__mark">SARA</span>
        <span className="companion__status" data-state={model.sara?.status}>
          {model.sara?.status}
        </span>
        <span className="companion__shell-tag">companion · v0 shell</span>
      </header>

      <div className="companion__thread" aria-label="Conversation">
        {messages.map((text, i) => (
          <div key={i} className="companion__msg companion__msg--sara">
            <span className="companion__msg-who">SARA</span>
            <p className="companion__msg-text">{text}</p>
          </div>
        ))}
      </div>

      {/* Composer is deliberately disabled — there is no chat channel in the WS1
          contract yet. Honest placeholder rather than a fake reply loop. */}
      <form className="companion__composer" aria-label="Message SARA" onSubmit={(e) => e.preventDefault()}>
        <input
          type="text"
          className="companion__input"
          placeholder="Conversation arrives in a later work package…"
          disabled
          aria-disabled="true"
        />
        <button type="submit" className="companion__send" disabled aria-disabled="true">
          Send
        </button>
      </form>
      <p className="companion__note">
        Companion is a shell for now: SARA shows what it already knows from shared state.
        Live chat needs an input channel the current state contract doesn't expose yet.
      </p>
    </section>
  );
}
