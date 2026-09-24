import Field from '../../../shared-ui/Field';
import './ClockScreen.css';

// The middle state: Nick is at home (or in the building), but not in this room.
//
// ⚠ NOT A LOCK, AND IT MUST NOT LOOK LIKE ONE. There is nothing to unlock and
// nothing to tap — the moment he walks back in, SAiM returns on her own. A
// padlock or a "tap to continue" would teach him this screen needs dealing
// with, when the whole point is that it does not.
//
// ⚠ THE MESSAGE LEADS AND THE TIME SUPPORTS IT (Nick, 24 Sep 2026, of the office
// tablet). This used to be a wall-height clock with the message whispered under
// it at 0.4 opacity — which put the one piece of information only SAiM has
// (where he is, when he is due back) below the one thing every phone, laptop and
// wall in the building already tells you. Anyone walking past the office read
// the time and missed "back at 17:00". So the message is the hero when there IS
// one; the clock is what it falls back to when there is not — a big blank room
// with a small clock in the corner of it would be worse than either.
//
// It still shows nothing else. Anything more is content displayed to an empty
// room, which is what the state exists to avoid.
//
// On burn-in: the panel has a real 0-31 backlight and an OLED has none, so it
// is an IPS LCD and does not burn in — at worst temporary image persistence.
// The clock can sit still. (The `locked` state blanks the backlight outright,
// which is the display agent's job, not this component's.)
export default function ClockScreen({ now, say }) {
  const d = now instanceof Date ? now : new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  // ⚠ A blank or whitespace-only line is NO LINE, not a hero with nothing in it.
  // `say` is legitimately null on several of the states that land here
  // ('not-at-this-desk', an unreadable room), and promoting an empty string
  // would leave the screen led by a gap.
  const message = typeof say === 'string' && say.trim() ? say.trim() : null;

  return (
    <div
      className={`clockscreen${message ? ' clockscreen--message' : ''}`}
      aria-label="SAiM is idle — you are not in this room"
    >
      {/* ⚠ Presence, not content. The rule above — "it shows nothing else" — is
          about CONTENT displayed to an empty room, and the field is neither
          content nor something to deal with: it is what SAiM looks like, and
          Nick walking back in sees her before the verdict flips. Driven
          `quiet`, so it is dim and near-still and stops dead when the page is
          hidden. */}
      <Field quiet confidenceLevel="low" />
      {/* Where he is, in NEURO's words, not ours — and only when it knows.
          Silence beats a guessed room on a screen nobody is standing at.
          DOM order follows reading order, so the hero is first on the page as
          well as first on the screen. */}
      {message ? <div className="clockscreen__say">{message}</div> : null}
      <div className="clockscreen__time">{time}</div>
      <div className="clockscreen__date">{date}</div>
    </div>
  );
}
