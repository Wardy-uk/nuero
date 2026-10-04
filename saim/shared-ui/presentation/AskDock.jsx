import { useState } from 'react';

// AskDock — the conversation, as part of SAiM's surface (Build 12.1J).
//
// ONE text affordance and ONE voice affordance, never three. The field is the
// way to ask in writing; the trailing button is the mic while the field is
// empty and becomes Send once he has typed — so there is always exactly one
// thing to press, and it is the right one.
//
// ⚠ The mic is offered only where it EXISTS (`canListen`): Electron exposes
//   speech recognition with no service behind it, and a control that fails on
//   the tap is worse than none.
// ⚠ What he typed is cleared only once the ask is handed over, so a failed send
//   never eats the words.
export default function AskDock({ placeholder = 'Ask SAiM', onAsk, canListen = false, listening = false, onMic = null, busy = false }) {
  const [text, setText] = useState('');
  const typed = text.trim();
  const submit = (e) => {
    if (e) e.preventDefault();
    if (!typed || !onAsk) return;
    const q = typed;
    setText('');
    onAsk(q);
  };
  const showMic = !typed && canListen && onMic;
  return (
    <form className={`sit-dock${listening ? ' sit-dock--listening' : ''}`} onSubmit={submit} role="search" aria-label="Ask SAiM">
      <input
        className="sit-dock__input"
        type="text"
        value={listening ? '' : text}
        onChange={(e) => setText(e.target.value)}
        placeholder={listening ? 'Listening — tap to send' : placeholder}
        aria-label={placeholder}
        enterKeyHint="send"
        disabled={listening}
      />
      {showMic ? (
        <button
          type="button"
          className={`sit-dock__btn${listening ? ' sit-dock__btn--live' : ''}`}
          onClick={onMic}
          aria-pressed={listening}
          aria-label={listening ? 'Stop and send' : 'Talk to SAiM'}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            {listening
              ? <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
              : <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />}
          </svg>
        </button>
      ) : (
        <button type="submit" className="sit-dock__btn sit-dock__btn--send" disabled={!typed || busy} aria-label="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M12 4l-7 7 1.4 1.4L11 7.8V20h2V7.8l4.6 4.6L19 11z" />
          </svg>
        </button>
      )}
    </form>
  );
}
