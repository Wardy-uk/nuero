import { useSaraState } from '../state/saraState';
import { SARA_VIEWS } from '../state/views';
import './SettingsShortcut.css';

export default function SettingsShortcut() {
  const { currentView, setCurrentView } = useSaraState();
  const active = currentView === SARA_VIEWS.SETTINGS;

  return (
    <button
      type="button"
      className={`settings-shortcut${active ? ' settings-shortcut--active' : ''}`}
      aria-label="Open Settings"
      aria-pressed={active}
      onClick={() => setCurrentView(SARA_VIEWS.SETTINGS)}
    >
      <span className="settings-shortcut__icon">⚙</span>
      <span className="settings-shortcut__label">Settings</span>
    </button>
  );
}
