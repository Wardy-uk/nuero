import { useSaraState } from '../../state/saraState';
import './MissionControl.css';

// Mission Control v0 — the first usable SARA screen (WS2-WP1).
//
// This screen is a pure representation of shared state. It reads everything from
// useSaraState() and owns NO data of its own: the WS1 State Engine model supplies
// current state / location / confidence / current goal; the shared presentation
// layer supplies the placeholder What Matters Now / Up Next / Quick Actions; the
// shared clock supplies current time. The screen only formats, orders and styles —
// it never becomes a source of truth (charter principle 7).
//
// Visual direction (behavioural spec): calm, light, low-clutter, readable from desk
// distance, comfortable on a 7-inch touchscreen. Teal accent #5ec1ca, dark neutral
// ink #272c33.

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
  return date.toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export default function MissionControl() {
  const { status, error, model, now, presentation } = useSaraState();

  // Calm connection states — the screen still reads from shared state, it just
  // hasn't arrived (or can't) yet. No data is invented locally.
  if (status === 'connecting') {
    return (
      <section className="mc mc--message">
        <p className="mc__waking">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="mc mc--message">
        <p className="mc__offline">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  const goal = model.domains?.focus?.current;
  const confidenceLevel = model.confidence?.level;
  const mc = presentation;

  return (
    <section className="mc" aria-label="Mission Control">
      {/* SARA header + live situational band — all from shared state */}
      <header className="mc__header">
        <div className="mc__brand">
          <span className="mc__mark">SARA</span>
          <span className="mc__state" data-state={model.sara?.status}>
            {model.sara?.status}
          </span>
          {model.dataSource === 'seed' && <span className="mc__seed">seed data</span>}
        </div>
        <div className="mc__clock">
          <span className="mc__time">{formatTime(now)}</span>
          <span className="mc__date">{formatDate(now)}</span>
        </div>
      </header>

      <div className="mc__situational">
        <div className="mc__chip">
          <span className="mc__chip-label">Location</span>
          <span className="mc__chip-value">{model.location?.label}</span>
        </div>
        <div className="mc__chip">
          <span className="mc__chip-label">Confidence</span>
          <span className={`mc__chip-value mc__confidence mc__confidence--${confidenceLevel}`}>
            {confidenceLevel}
            {typeof model.confidence?.score === 'number' && ` · ${model.confidence.score}`}
          </span>
        </div>
      </div>

      {/* Current goal — sourced from the engine's focus domain */}
      <section className="mc__goal" aria-label="Current goal">
        <p className="mc__section-label">Current goal</p>
        {goal ? (
          <>
            <p className="mc__goal-title">{goal.title}</p>
            {goal.reason && <p className="mc__goal-reason">{goal.reason}</p>}
          </>
        ) : (
          <p className="mc__goal-title mc__muted">Nothing set — pick the highest-leverage thing.</p>
        )}
      </section>

      <div className="mc__columns">
        {/* What Matters Now — placeholder content from shared presentation state */}
        <section className="mc__panel" aria-label="What matters now">
          <p className="mc__section-label">What Matters Now</p>
          <ul className="mc__list">
            {mc.whatMattersNow.map((item) => (
              <li key={item.id} className={`mc__matter mc__matter--${item.tone}`}>
                <span className="mc__matter-title">{item.title}</span>
                <span className="mc__matter-detail">{item.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Up Next — placeholder content from shared presentation state */}
        <section className="mc__panel" aria-label="Up next">
          <p className="mc__section-label">Up Next</p>
          <ul className="mc__list">
            {mc.upNext.map((item) => (
              <li key={item.id} className="mc__next">
                <span className="mc__next-time">{item.time}</span>
                <span className="mc__next-label">{item.label}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Quick Actions — large touch targets; intents are placeholders in WS2-WP1 */}
      <section className="mc__actions" aria-label="Quick actions">
        <p className="mc__section-label">Quick Actions</p>
        <div className="mc__action-grid">
          {mc.quickActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="mc__action"
              data-action={action.action}
            >
              <span className="mc__action-icon" aria-hidden="true">
                {action.icon}
              </span>
              <span className="mc__action-label">{action.label}</span>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}
