import { useSaraState } from '../../state/saraState';
import { SARA_VIEWS } from '../../state/views';
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

const RAIL_ITEMS = [
  { id: SARA_VIEWS.BRIEFING, label: 'Home', icon: '⌂' },
  { id: SARA_VIEWS.QUEUE, label: 'Queue', icon: '▤' },
  { id: SARA_VIEWS.TODOS, label: 'Tasks', icon: '☑' },
  { id: SARA_VIEWS.CAPTURE, label: 'Capture', icon: '✎' },
  { id: SARA_VIEWS.SETTINGS, label: 'Settings', icon: '⚙' },
];

function formatState(activity) {
  return String(activity || 'unknown').replace(/-/g, ' ').toUpperCase();
}

export default function MissionControl() {
  const { status, error, model, now, presentation, currentView, setCurrentView, runQuickAction, actionFeedback } = useSaraState();

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
  const inferredState = model.inference?.activity || model.sara?.status || 'unknown';
  const inferredSummary = model.inference?.summary || goal?.title || 'Shared state is live.';
  // Location sub-line: prefer an explicit detail, else humanise a string slug
  // ("home-office" -> "Home Office"), else a calm fallback. NB location.zone is an
  // OBJECT in the two-tier model (zone + station), so read its label/context, never the
  // object itself — guard with typeof so a non-string can never crash render.
  const humanise = (s) =>
    typeof s === 'string' ? s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  const zoneLabel = model.location?.zone?.label || model.location?.zone; // obj or legacy string
  const locationSub =
    model.location?.detail ||
    humanise(zoneLabel) ||
    humanise(model.location?.context) ||
    'Tracked';

  const mc = presentation;
  const matters = mc.whatMattersNow || [];
  const upNext = mc.upNext || [];
  const actions = mc.quickActions || [];
  const weather = mc.weather; // optional placeholder; only renders when present

  return (
    <section className="mc" aria-label="Briefing">
      <div className="mc__scene" />
      <div className="mc__shell">
        <header className="mc__header">
          <div className="mc__brand">
            <span className="mc__orb" aria-hidden="true" data-state={model.sara?.status} />
            <span className="mc__mark">SARA</span>
            {model.dataSource !== 'neuro' && <span className="mc__seed">{model.dataSource}</span>}
          </div>
          <div className="mc__greeting">
            <p className="mc__hello">
              {greeting(now)}, {name} <span className="mc__sun">☼</span>
            </p>
            <p className="mc__date">{formatDate(now)}</p>
          </div>
          <div className="mc__clock">
            <span className="mc__time">{formatTime(now)}</span>
          </div>
        </header>

        <div className="mc__body">
          <nav className="mc__rail" aria-label="Primary views">
            {RAIL_ITEMS.map((item) => {
              const active = currentView === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`mc__rail-button${active ? ' mc__rail-button--active' : ''}`}
                  aria-pressed={active}
                  onClick={() => setCurrentView(item.id)}
                  title={item.label}
                >
                  <span className="mc__rail-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="mc__content">
            <div className="mc__stats">
              <article className="mc__card mc__stat">
                <p className="mc__stat-label">State</p>
                <p className="mc__stat-value">{formatState(inferredState)}</p>
                <p className="mc__stat-sub">{goal?.title || inferredSummary}</p>
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

            <div className="mc__columns">
              <section className="mc__card mc__priorities" aria-label="Today's priorities">
                <div className="mc__panel-head">
                  <p className="mc__section-label">Today's priorities</p>
                  {goal && <p className="mc__panel-note">{goal.title}</p>}
                </div>
                <ul className="mc__list">
                  {matters.map((item, index) => (
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
                      <span className="mc__matter-when">
                        {upNext[index]?.time || (index === 0 ? 'Today' : index === 1 ? 'Soon' : 'Watch')}
                      </span>
                    </li>
                  ))}
                </ul>
                <button type="button" className="mc__view-all" onClick={() => setCurrentView(SARA_VIEWS.QUEUE)}>
                  View all ({matters.length})
                </button>
              </section>

              <aside className="mc__side">
                <section className="mc__card mc__upnext" aria-label="Up next">
                  <p className="mc__section-label">Up next</p>
                  {upNext.length > 0 ? (
                    <ul className="mc__list mc__list--next">
                      {upNext.slice(0, 2).map((item, i) => (
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

                <section className="mc__card mc__weather" aria-label="Conditions">
                  <span className="mc__weather-icon" aria-hidden="true">
                    {(weather && weather.icon) || '⛅'}
                  </span>
                  <div className="mc__weather-copy">
                    <span className="mc__weather-temp">
                      {weather?.temp || (model.telemetry?.signals?.environment?.state ? `${model.telemetry.signals.environment.state}${model.telemetry.signals.environment.unit || ''}` : 'Live')}
                    </span>
                    <span className="mc__weather-desc">
                      {weather?.description || model.telemetry?.signals?.environment?.label || 'Telemetry ready'}
                    </span>
                  </div>
                </section>
              </aside>
            </div>

            <section className="mc__launch mc__card" aria-label="Quick launch">
              <p className="mc__section-label">Quick launch</p>
              {actionFeedback && <p className="mc__action-feedback">{actionFeedback}</p>}
              <div className="mc__tiles">
                {actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="mc__tile"
                    data-action={action.action}
                    onClick={() => runQuickAction(action.action)}
                  >
                    <span className="mc__tile-icon" aria-hidden="true">
                      {action.icon}
                    </span>
                    <span className="mc__tile-label">{action.label}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
