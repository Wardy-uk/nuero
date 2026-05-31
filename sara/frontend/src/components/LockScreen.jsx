import './LockScreen.css';

// LockScreen — privacy lock overlay for the Pi wall display (WS2-WP3).
//
// SARA runs on an always-on touchscreen with no login, so "lock" here is a PRIVACY
// screen, not authentication: it hides the dashboard the moment you walk away (idle or
// Home Assistant proximity), so a glance at your desk display doesn't expose your queue,
// people notes, or calendar. Tap to unlock — there is no PIN because there is no auth
// layer behind it, and a wall-display PIN would live in the bundle anyway. It covers
// everything (above the Exit button) so nothing leaks behind it.
const REASON_TEXT = {
  idle: 'Locked after inactivity',
  away: 'Locked — you stepped away',
  manual: 'Locked',
};

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function LockScreen({ reason, now, onUnlock }) {
  return (
    <div
      className="lock"
      role="button"
      tabIndex={0}
      aria-label="SARA locked — tap to unlock"
      onClick={onUnlock}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onUnlock();
      }}
    >
      <div className="lock__panel">
        <span className="lock__mark">SARA</span>
        <span className="lock__orb" aria-hidden="true" />
        {now && <span className="lock__time">{formatTime(now)}</span>}
        <span className="lock__reason">{REASON_TEXT[reason] || 'Locked'}</span>
        <span className="lock__hint">Tap to unlock</span>
      </div>
    </div>
  );
}
