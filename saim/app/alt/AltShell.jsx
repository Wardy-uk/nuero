import Field from '../../shared-ui/Field';
import { surfaceRgb } from '../../shared-ui/fieldDrive.mjs';
import { ALT_TABS, ALT_TAGLINE, updatedLabel } from './model.mjs';

// The SAiM Alt frame, as a pure view: her field full-screen behind everything,
// a discreet corner marker, the page, and a persistent bottom bar.
//
// ⚠ The field is the control's, UNCHANGED: the same `Field` component, driven
//   by the same five inputs (`useFieldDrive`'s shape) and coloured by the same
//   `surfaceRgb`. Nothing here restyles or replaces it.
//
// Bottom bar: left — the line that says what this surface is for; centre —
// the FIVE destinations and nothing else; right — when NEURO was last read.
export default function AltShell({
  active, onGo, drive, updatedAt = null,
  controlUrl = null, neuroUrl = null, buildLabel = null, onLock = null,
  handoff = null, onClearHandoff = null,
  scenario = null,
  children,
}) {
  const updated = updatedLabel(updatedAt);
  return (
    <div className="app lit-scope alt-app" style={{ '--saim-rgb': surfaceRgb(drive) }}>
      <div className="app__field alt-app__field" aria-hidden="true"><Field {...drive} /></div>

      <div className="alt-corner">
        <span className="alt-marker" title="Experimental treatment — not the everyday SAiM">SAiM Alt</span>
        {scenario && (
          <span className="alt-scenario" title="Development scenario — fixture data, nothing is sent">
            scenario: {scenario.id} · <a className="alt-scenario__live" href={scenario.liveHref}>live data</a>
          </span>
        )}
        {buildLabel && <span className="alt-corner__build">{buildLabel}</span>}
        {controlUrl && <a className="alt-corner__link" href={controlUrl}>Control SAiM ↗</a>}
        {neuroUrl && <a className="alt-corner__link" href={neuroUrl} target="_blank" rel="noopener noreferrer">NEURO ↗</a>}
        {onLock && (
          <button className="alt-corner__lock" type="button" onClick={onLock} aria-label="Lock / change PIN" title="Lock / change PIN">🔒</button>
        )}
      </div>

      <main className="alt-app__view">
        {handoff && (
          <p className="alt-app__handoff" role="status">
            “{handoff}” lives in NEURO — opened it in a new tab.
            {onClearHandoff && <button type="button" className="alt-link" onClick={onClearHandoff}>OK</button>}
          </p>
        )}
        {children}
      </main>

      <footer className="alt-bar">
        <span className="alt-bar__tagline">{ALT_TAGLINE}</span>
        <nav className="alt-bar__nav" aria-label="SAiM Alt">
          {ALT_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`alt-bar__tab${active === t.id ? ' is-on' : ''}`}
              aria-current={active === t.id ? 'page' : undefined}
              onClick={() => onGo && onGo(t.id)}
            >
              <span className="alt-bar__icon" aria-hidden="true">{t.icon}</span>
              <span className="alt-bar__label">{t.label}</span>
            </button>
          ))}
        </nav>
        <span className="alt-bar__updated" role="status">{updated || 'Not read yet'}</span>
      </footer>
    </div>
  );
}
