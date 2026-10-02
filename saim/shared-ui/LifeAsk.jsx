import './LifeAsk.css';

// "What are you up to?" — asked only when SAiM's read of what Nick is doing is a
// guess.
//
// Nick, 2 Oct 2026: "something should probably ask me what I'm doing if there's
// ambiguity." The question and its options are composed by NEURO
// (`life-state.js` → `life.ask`), so the phone, the kiosks and iOS ask the same
// thing in the same words; this only draws it.
//
// ⚠ A PULL, NEVER A PUSH. It sits on a screen he is already looking at; nothing
// notifies. "Not now" quietens it for an hour, server-side, on every surface.
//
// ⚠ NO BUTTONS WITHOUT A WAY TO ANSWER. A shell that passes no `onAnswer` gets
// nothing at all rather than a row of taps that fail.

export default function LifeAsk({ ask, onAnswer, busy = false }) {
  if (!ask || !Array.isArray(ask.options) || !ask.options.length || !onAnswer) return null;
  return (
    <div className="lifeask" role="group" aria-label={ask.question}>
      <span className="lifeask__q">{ask.question}</span>
      <div className="lifeask__opts">
        {ask.options.map((o) => (
          <button key={o.doing} type="button" className="lifeask__opt" disabled={busy}
            onClick={() => onAnswer(o.doing)}>{o.label}</button>
        ))}
        <button type="button" className="lifeask__opt lifeask__opt--quiet" disabled={busy}
          onClick={() => onAnswer(null)}>Not now</button>
      </div>
    </div>
  );
}
