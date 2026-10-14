import { useState } from 'react';
import { apiFetch, chatStream } from '../src/api';
import { enqueue, flush, outcomeFor } from '../src/mobile/outbox';
import { matchSaid } from '../../../shared/heard.cjs';

// The compact Ask / Capture route on the SAiM page.
//
// Capture goes through the SAME outbox as the Capture tab (on this device first,
// then sent). It is called saved ONLY when NEURO acknowledged it; anything else
// says what actually happened. If the words cannot even be stored on this
// device, they stay in the box — the box is cleared only once they are safe.
//
// Ask: a sentence SAiM offered is acted on (string equality against her own
// phrases, never parsed here); anything else is a question for the brain.

export function captureNote(outcome) {
  if (!outcome) return { ok: true, msg: 'Queued on this device — not in NEURO yet.' };
  if (outcome.state === 'confirmed') return { ok: true, msg: 'Saved to NEURO.' };
  if (outcome.state === 'refused') return { ok: false, msg: `${outcome.message} It’s waiting in Capture.` };
  return { ok: true, msg: 'Queued on this device — not in NEURO yet. I’ll send it when there’s signal.' };
}

/**
 * The whole capture flow, without React: store on this device, then send.
 * `clear` is true ONLY once the words are safely stored — a failure to store
 * leaves them in the box. `note.msg` says "Saved to NEURO" only on NEURO's ack.
 */
export async function runCapture(content, io) {
  let queued;
  try {
    queued = await io.enqueue('capture.note', { content });
  } catch (err) {
    return { clear: false, note: { ok: false, msg: `NOT saved — this device couldn’t store it (${err.message}). Your words are still here.` } };
  }
  try {
    const result = await io.flush();
    return { clear: true, note: captureNote(io.outcomeFor(result && result.receipts ? result.receipts[queued.operationId] : null)) };
  } catch {
    return { clear: true, note: captureNote(null) };
  }
}

export default function Dock({ utterances, onSay, deps = null }) {
  const io = deps || { enqueue, flush, outcomeFor, chatStream, apiFetch };
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [answer, setAnswer] = useState(null);

  async function capture() {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setNote(null);
    const r = await runCapture(content, io);
    if (r.clear) setText((t) => (t.trim() === content ? '' : t));
    setNote(r.note);
    setBusy(false);
  }

  async function ask() {
    const question = text.trim();
    if (!question || busy) return;
    const heard = matchSaid(question, utterances);
    if (heard && heard.kind === 'utterance' && onSay) {
      setAnswer({ question, text: heard.utterance.say, thinking: false, error: null });
      setText('');
      await onSay(heard.utterance);
      return;
    }
    setBusy(true);
    setText('');
    setAnswer({ question, text: '', thinking: true, error: null });
    let acc = '';
    try {
      await io.chatStream({ message: question }, {
        onChunk: (c) => { acc += c; setAnswer((a) => (a ? { ...a, text: acc } : a)); },
        onError: (msg) => setAnswer((a) => (a ? { ...a, error: msg } : a)),
      });
    } catch {
      try {
        const res = await io.apiFetch('/api/chat/sync', { method: 'POST', body: JSON.stringify({ message: question }) });
        acc = (res && (res.reply || res.content)) || '';
      } catch (e2) {
        setAnswer((a) => (a ? { ...a, thinking: false, error: e2.message } : a));
        setText(question);
        setBusy(false);
        return;
      }
    }
    setAnswer((a) => (a ? { ...a, text: acc, thinking: false } : a));
    setBusy(false);
  }

  return (
    <div className="v2-dockbox" aria-label="Ask SAiM or capture">
      {answer && (
        <div className="v2-answer">
          <p className="v2-answer__q">{answer.question}</p>
          <p className="v2-answer__a">{answer.error ? `I couldn’t answer — ${answer.error}` : (answer.text || (answer.thinking ? '…' : ''))}</p>
          <button type="button" className="v2-link" onClick={() => setAnswer(null)}>Clear</button>
        </div>
      )}
      <div className="v2-dockrow">
        <input
          className="v2-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } }}
          placeholder="Ask SAiM, or capture a thought"
          aria-label="Ask SAiM, or capture a thought"
        />
        <button type="button" className="v2-pill v2-pill--strong" disabled={busy || !text.trim()} onClick={ask}>Ask</button>
        <button type="button" className="v2-pill" disabled={busy || !text.trim()} onClick={capture}>Capture</button>
      </div>
      {note && <p className={`v2-docknote${note.ok ? '' : ' is-bad'}`} role="status">{note.msg}</p>}
    </div>
  );
}
