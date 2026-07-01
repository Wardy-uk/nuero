import { useState } from 'react';
import { setPin } from '../api';
import './LockScreen.css';

// PIN gate. The NEURO backend enforces the PIN on every /api call; this just captures
// it once and stashes it in localStorage (same key the NEURO app uses). No round-trip
// here — the first real API call (Focus) is what actually validates it.
export default function LockScreen({ onUnlock }) {
  const [value, setValue] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!value.trim()) return;
    setPin(value.trim());
    onUnlock();
  }

  return (
    <div className="lock">
      <form className="lock__box" onSubmit={submit}>
        <div className="lock__brand">SARA</div>
        <p className="lock__hint">Enter your NEURO PIN</p>
        <input
          className="lock__input"
          type="password"
          inputMode="numeric"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="NEURO PIN"
        />
        <button className="lock__btn" type="submit">Unlock</button>
      </form>
    </div>
  );
}
