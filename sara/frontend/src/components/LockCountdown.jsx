import './LockCountdown.css';

// LockCountdown — the "you're about to be locked" grace warning (WS2-WP3 fusion).
//
// Shown when SARA's presence layer thinks you've walked away (Watch gone quiet AND no
// keyboard/mouse for the grace period). It is a LAST-CHANCE warning, not the lock: any
// activity — moving the mouse, a key, the Watch coming back, or tapping the button —
// cancels it before the count reaches zero. Only a countdown that runs out actually locks.
export default function LockCountdown({ seconds, onStay }) {
  return (
    <div className="lockcd" role="alertdialog" aria-live="assertive">
      <div className="lockcd__card">
        <div className="lockcd__ring">
          <span className="lockcd__num">{seconds}</span>
        </div>
        <div className="lockcd__title">Locking SARA</div>
        <div className="lockcd__sub">No one seems to be here. Move or tap to stay unlocked.</div>
        <button type="button" className="lockcd__btn" onClick={onStay}>I’m here</button>
      </div>
    </div>
  );
}
