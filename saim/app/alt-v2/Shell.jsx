import Field from '../../shared-ui/Field';
import { surfaceRgb } from '../../shared-ui/fieldDrive.mjs';
import { TABS } from './model.mjs';

// The SAiM Alt v2 frame. Her field — the control's `Field`, driven exactly as
// the control drives it — fills the screen; the page sits over it; a
// persistent bottom bar holds the six destinations and when NEURO was read.
export default function Shell({ active, onGo, drive, updated = null, footer = null, marker = null, onLock = null, onRefresh = null, debug = false, children }) {
  return (
    <div className="v2 lit-scope" style={{ '--saim-rgb': surfaceRgb(drive) }}>
      <div className="v2__field" aria-hidden="true"><Field {...drive} /></div>
      <div className="v2__corner">
        <span className="v2__marker" title="Experimental treatment — not the everyday SAiM">SAiM Alt</span>
        {/* Operational chrome — the control link, refresh and lock — only in debug mode
            (?debug=1). Locking lives in Controls; the page polls on its own. */}
        {debug && marker}
        {debug && onRefresh && <button type="button" className="v2__lock v2__refresh" onClick={onRefresh} aria-label="Refresh SAiM" title="Refresh SAiM">↻</button>}
        {debug && onLock && <button type="button" className="v2__lock" onClick={onLock} aria-label="Lock / change PIN" title="Lock / change PIN">🔒</button>}
      </div>
      <main className="v2__view">{children}</main>
      <footer className="v2__bar">
        {footer && <span className="v2__footcopy">{footer}</span>}
        <nav className="v2__nav" aria-label="SAiM">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`v2__tab${active === t.id ? ' is-on' : ''}`}
              aria-current={active === t.id ? 'page' : undefined}
              onClick={() => onGo && onGo(t.id)}
            >
              <span className="v2__tabicon" aria-hidden="true">{t.icon}</span>
              <span className="v2__tablabel">{t.label}</span>
            </button>
          ))}
        </nav>
        <span className="v2__updated" role="status">{updated || 'Not read yet'}</span>
      </footer>
    </div>
  );
}
