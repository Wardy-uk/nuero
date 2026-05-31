import { useSaraState } from '../../state/saraState';
import './MissionControl.css';

// Mission Control v1 — premium "appliance" home screen (WS2-WP2 visual uplift).
//
// Same shared-state discipline as v0 (charter principle 7): this screen reads
// everything from useSaraState() and owns NO data of its own. It only formats,
// orders and styles — it never becomes a source of truth. The v1 change is purely
// presentational: it brings the screen up to the Reference A "Mission Control"
// concept — spacious light layout, strong hierarchy, premium frosted cards over a
// calm gradient, and Stream-Deck-style quick launch tiles. All data bindings are
// unchanged from v0; new fields (location detail, up-next relative time, weather)
// are rendered ONLY when shared state supplies them, so nothing is invented here.

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

// Greeting is derived from the shared clock — presentation only, not invented data.
function greeting(date) {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// What-Matters tone → glyph. Keeps v0's tone vocabulary (urgent / attention /
// watch) but renders it as a glanceable status mark like the reference concept.
const TONE_GLYPH = {
  urgent: '▲',
  attention: '◆',
  watch: '●',
};

export default function MissionControl() {
  const { status, error, model, now, presentation } = useSaraState();

  // Calm connection states — still pure reflections of shared state, just not
  // arrived (or unreachable) yet. No data is invented locally.
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
  const confidenceScore = model.confidence?.score;
  const confidencePct =
    typeof confidenceScore === 'number'
      ? Math.max(0, Math.min(100, confidenceScore > 1 ? confidenceScore : confidenceScore * 100))
      : null;
  const name = model.user?.name || 'Nick';
  // Location sub-line: prefer an explicit detail, else humanise the zone slug
  // ("home-office" -> "Home Office"), else a calm fallback.
  const humanise = (s) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const locationSub =
    model.location?.detail ||
    (model.location?.zone && humanise(model.location.zone)) ||
    (model.location?.context && humanise(model.location.context)) ||
    'Tracked';

  const mc = presentation;
  const matters = mc.whatMattersNow || [];
  const upNext = mc.upNext || [];
  const actions = mc.quickActions || [];
  const weather = mc.weather; // optional placeholder; only renders when present

  return (
    <section className="mc" aria-label="Mission Control">
      {/* Header: brand · greeting · clock */}
      <header className="mc__header">
        <div className="mc__brand">
          <span className="mc__orb" aria-hidden="true" data-state={model.sara?.status} />
          <span className="mc__mark">SARA</span>
          {model.dataSource === 'seed' && <span className="mc__seed">seed data</span>}
        </div>
        <div className="mc__greeting">
          <p className="mc__hello">
            {greeting(now)}, {name}
          </p>
          <p className="mc__date">{formatDate(now)}</p>
        </div>
        <div className="mc__clock">
          <span className="mc__time">{formatTime(now)}</span>
        </div>
      </header>

      {/* Situational stat cards: state · location · confidence */}
      <div className="mc__stats">
        <article className="mc__card mc__stat">
          <p className="mc__stat-label">State</p>
          <p className="mc__stat-value" data-state={model.sara?.status}>
            {model.sara?.status || '—'}
          </p>
          <p className="mc__stat-sub">{goal?.title || 'No active focus'}</p>
        </article>

        <article className="mc__card mc__stat">
          <p className="mc__stat-label">Location</p>
          <p className="mc__stat-value">{model.location?.label || '—'}</p>
          <p className="mc__stat-sub">{locationSub}</p>
        </article>

        <article className="mc__card mc__stat mc__stat--confidence">
          <p className="mc__stat-label">Confidence</p>
          <p className={`mc__stat-value mc__confidence--${confidenceLevel}`}>
            {confidencePct != null ? `${Math.round(confidencePct)}%` : '—'}
            {confidenceLevel && <span className="mc__confidence-word">{confidenceLevel}</span>}
          </p>
          {confidencePct != null && (
            <div className="mc__meter" role="presentation">
              <span
                className={`mc__meter-fill mc__meter-fill--${confidenceLevel}`}
                style={{ width: `${confidencePct}%` }}
              />
            </div>
          )}
        </article>
      </div>

      {/* Current goal — required by the behavioural spec; the one thing that matters */}
      <section className="mc__card mc__goal" aria-label="Current goal">
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
        {/* Today's priorities (What Matters Now) */}
        <section className="mc__card mc__priorities" aria-label="What matters now">
          <p className="mc__section-label">Today's priorities</p>
          <ul className="mc__list">
            {matters.map((item) => (
              <li key={item.id} className={`mc__matter mc__matter--${item.tone}`}>
                <span
                  className={`mc__matter-glyph mc__matter-glyph--${item.tone}`}
                  aria-hidden="true"
                >
                  {TONE_GLYPH[item.tone] || '●'}
                </span>
                <span className="mc__matter-body">
                  <span className="mc__matter-title">{item.title}</span>
                  {item.detail && <span className="mc__matter-detail">{item.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Up next (+ optional weather) */}
        <aside className="mc__side">
          <section className="mc__card mc__upnext" aria-label="Up next">
            <p className="mc__section-label">Up next</p>
            {upNext.length > 0 ? (
              <ul className="mc__list mc__list--next">
                {upNext.map((item, i) => (
                  <li key={item.id} className={`mc__next${i === 0 ? ' mc__next--lead' : ''}`}>
                    <span className="mc__next-time">{item.time}</span>
                    <span className="mc__next-label">{item.label}</span>
                    {item.relative && <span className="mc__next-rel">{item.relative}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mc__muted">Nothing scheduled.</p>
            )}
          </section>

          {weather && (
            <section className="mc__card mc__weather" aria-label="Weather">
              <span className="mc__weather-icon" aria-hidden="true">
                {weather.icon || '⛅'}
              </span>
              <span className="mc__weather-temp">{weather.temp}</span>
              <span className="mc__weather-desc">{weather.description}</span>
            </section>
          )}
        </aside>
      </div>

      {/* Quick launch — Stream-Deck-style tiles (Reference C) */}
      <section className="mc__launch" aria-label="Quick launch">
        <p className="mc__section-label">Quick launch</p>
        <div className="mc__tiles">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="mc__tile"
              data-action={action.action}
            >
              <span className="mc__tile-icon" aria-hidden="true">
                {action.icon}
              </span>
              <span className="mc__tile-label">{action.label}</span>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}
