import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import { enqueue, flush, discard, retry, outcomeFor, pending as pendingOps, subscribe } from '../mobile/outbox';
import { Lit, LitLabel } from '../../../shared-ui/Lit.jsx';
import './Capture.css';
import { speechRecognitionCtor } from '../speechRecognition';
import { MEETING_KINDS, meetingLine, meetingPayload, receiptLine } from '../meetingCapture.mjs';

// CAPTURE — get it out of Nick's head immediately, and never lose it.
//
// ⚠ EVERY capture goes through the OUTBOX, online or off. It used to POST
// straight to /api/capture/* and had no offline path at all, so "I had signal"
// and "it saved" were the same code and the same words. One path now, with
// states that differ:
//
//   Queued on this device   — written locally. NOT in NEURO. Says exactly that.
//   Saved to NEURO          — only after NEURO acknowledged and named the record.
//   Needs attention         — refused or unappliable. Text intact, Nick decides.
//
// ⚠ THE DRAFT IS ONLY CLEARED ONCE THE OPERATION IS SAFELY QUEUED. If local
// persistence itself fails, the words in the box are the last copy in existence
// and clearing them is how a capture is destroyed by the thing built to save it
// (the kiosk bridge's rule, one layer down).
//
// Feature capture is deliberately NOT in the outbox: it appends to a vault
// markdown file through a service with no idempotency key, so a replay would
// write the row twice. It stays online-only and says so when there is no signal.
const RECENT_LIMIT = 5;

export default function Capture({ autoRecord = false, context = null }) {
  const [mode, setMode] = useState('note'); // 'note' | 'todo' | 'feature'
  // "Capture from this meeting" (21 Oct 2026): arrived from SAiM's home in a
  // meeting. `context.meeting` is NEURO's own { key, subject } or null when it
  // named none — this view never guesses one. Leaving the mode is one tap.
  const [inMeeting, setInMeeting] = useState(() => Boolean(context && Object.prototype.hasOwnProperty.call(context, 'meeting')));
  const meeting = inMeeting && context ? context.meeting || null : null;
  const [kind, setKind] = useState('decision');
  const kindSpec = MEETING_KINDS.find((k) => k.id === kind) || MEETING_KINDS[0];
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [priority, setPriority] = useState('normal'); // todo only
  const [system, setSystem] = useState('NEURO'); // feature only
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null); // { ok, msg }
  const [recent, setRecent] = useState([]);
  const [queue, setQueue] = useState([]);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  const SpeechRecognition = speechRecognitionCtor();

  const reloadQueue = useCallback(async () => {
    try { setQueue(await pendingOps()); } catch { /* never block capture on the queue view */ }
  }, []);

  async function loadRecent() {
    try {
      const data = await apiFetch('/api/capture/recent');
      setRecent((data.items || []).slice(0, RECENT_LIMIT));
    } catch { /* recent is a nicety — never block capture on it */ }
  }

  useEffect(() => {
    loadRecent();
    reloadQueue();
    return subscribe(() => reloadQueue());
  }, [reloadQueue]);

  // A feature is titled, not typed at — the one line IS the item.
  const ready = !inMeeting && mode === 'feature' ? title.trim().length > 0 : text.trim().length > 0;

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFlash(null);

    // ── Feature: online-only, and honest about it ────────────────────────────
    if (!inMeeting && mode === 'feature') {
      try {
        const res = await apiFetch('/api/capture/feature', {
          method: 'POST',
          body: JSON.stringify({
            title: title.trim(),
            notes: text.trim() || undefined,
            system,
            source: 'Neuro Mobile',
          }),
        });
        setFlash({ ok: true, msg: `Tracker #${res.number} — ${res.system}` });
        setTitle('');
        setText('');
      } catch (err) {
        // The words stay in the box. A feature idea is not queueable (the
        // tracker append has no idempotency key), so this is a real refusal and
        // must not look like a save.
        // ⚠ "NOT saved", in those letters. It is the contract's wording and the
        // emphasis is the point — this is the one message on the screen that
        // must not be skimmed past, and the other three failure paths here
        // already shout it. One of four saying it quietly is the one that gets
        // missed.
        setFlash({ ok: false, msg: `NOT saved — the tracker needs a connection. ${err.message}` });
      } finally {
        setBusy(false);
      }
      return;
    }

    // ── Note / todo: always through the outbox ──────────────────────────────
    // In a meeting it is still a plain `capture.note` — Nick's words, the kind
    // he picked, and the canonical meeting key for NEURO to confirm.
    const opKind = inMeeting || mode === 'note' ? 'capture.note' : 'capture.todo';
    const payload = inMeeting
      ? meetingPayload({ text, kind, meeting })
      : mode === 'note'
        ? { title: title.trim() || undefined, content: text.trim() }
        : { text: text.trim(), priority: priority === 'high' ? 'high' : undefined };
    const receiptFor = (outcome, receipt) => (inMeeting ? receiptLine(outcome, receipt, { kind, meeting }) : null);

    let queued;
    try {
      queued = await enqueue(opKind, payload);
    } catch (err) {
      // Local persistence failed. The draft is the ONLY copy — do not touch it.
      setFlash({ ok: false, msg: `NOT saved — this device couldn't store it (${err.message}). Your words are still here; don't close the app.` });
      setBusy(false);
      return;
    }

    // Safely on disk. Clearing the box now is correct: the text is in the outbox
    // and survives a reload, a crash and a cold start.
    setTitle('');
    setText('');
    setFlash(receiptFor({ state: 'pending' }, null) || { ok: true, msg: 'Queued on this device — not in NEURO yet.' });

    try {
      const result = await flush();
      // ⚠ THIS operation's receipt, never flush()'s aggregate counts. The queue
      // is drained whole, so `needsAttention >= 1` can be an older stuck item
      // while this capture merely failed on the network — which would tell Nick
      // NEURO refused something it never saw.
      const outcome = outcomeFor(result.receipts[queued.operationId]);
      const said = receiptFor(outcome, result.receipts[queued.operationId]);
      if (said) {
        setFlash(said);
        if (outcome.state === 'confirmed') loadRecent();
      } else if (outcome.state === 'confirmed') {
        setFlash({ ok: true, msg: mode === 'note' ? 'Saved to NEURO.' : 'Saved to NEURO — on your list.' });
        loadRecent();
      } else if (outcome.state === 'refused') {
        setFlash({ ok: false, msg: `${outcome.message} See Waiting below.` });
      } else {
        setFlash({ ok: true, msg: 'Queued on this device — I’ll send it when there’s signal.' });
      }
    } catch {
      setFlash(receiptFor({ state: 'pending' }, null) || { ok: true, msg: 'Queued on this device — I’ll send it when there’s signal.' });
    } finally {
      setBusy(false);
      reloadQueue();
    }
  }

  function startVoice() {
    if (!SpeechRecognition || listening) return;
    const rec = new SpeechRecognition();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (evt) => {
      let chunk = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) chunk += evt.results[i][0].transcript;
      setText((prev) => (prev ? `${prev} ${chunk}` : chunk).trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    try { rec.start(); setListening(true); } catch { /* start() throws if already running — ignore */ }
  }

  function stopVoice() { recognitionRef.current?.stop(); }

  function toggleVoice() {
    if (!SpeechRecognition) return;
    if (listening) stopVoice(); else startVoice();
  }

  // "Talk now" entry point — the Voice nav button mounts Capture with autoRecord,
  // so dictation starts immediately. The nav tap is the gesture that unlocks the mic.
  useEffect(() => {
    if (autoRecord) startVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const waiting = queue.filter((o) => o.status !== 'needs-attention');
  const stuck = queue.filter((o) => o.status === 'needs-attention');

  return (
    <section>
      <h1 className="view__title">Capture</h1>
      <p className="view__lede">Get it out of your head. Zero friction.</p>

      {inMeeting ? (
        <div className="cap__meeting">
          <p className="cap__meeting-name">{meetingLine(meeting)}</p>
          <div className="cap__modes" role="group" aria-label="What is it?">
            {MEETING_KINDS.map((k) => (
              <button key={k.id} type="button" className={`cap__mode${kind === k.id ? ' cap__mode--on' : ''}`}
                aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</button>
            ))}
          </div>
          <button type="button" className="cap__plain" onClick={() => setInMeeting(false)}>Plain capture instead</button>
        </div>
      ) : (
      <div className="cap__modes">
        <button type="button" className={`cap__mode${mode === 'note' ? ' cap__mode--on' : ''}`} onClick={() => setMode('note')}>Note</button>
        <button type="button" className={`cap__mode${mode === 'todo' ? ' cap__mode--on' : ''}`} onClick={() => setMode('todo')}>Todo</button>
        <button type="button" className={`cap__mode${mode === 'feature' ? ' cap__mode--on' : ''}`} onClick={() => setMode('feature')}>Feature</button>
      </div>
      )}

      <form className="cap__form" onSubmit={submit}>
        {!inMeeting && (mode === 'note' || mode === 'feature') && (
          <input
            className="cap__title"
            type="text"
            placeholder={mode === 'feature' ? 'What should it do? (one line)' : 'Title (optional)'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus={mode === 'feature'}
          />
        )}
        <div className="cap__textwrap">
          <textarea
            className="cap__text"
            placeholder={inMeeting ? kindSpec.placeholder : mode === 'note' ? "What's on your mind?"
              : mode === 'todo' ? 'What needs doing?'
              : 'Why does it matter? (optional, but it needs one before it can be ranked)'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            autoFocus={mode !== 'feature'}
          />
          {SpeechRecognition && (
            <button
              type="button"
              className={`cap__mic${listening ? ' cap__mic--on' : ''}`}
              onClick={toggleVoice}
              aria-label={listening ? 'Stop dictation' : 'Dictate'}
              title={listening ? 'Stop dictation' : 'Dictate'}
            >
              {listening ? '⏺' : '🎤'}
            </button>
          )}
        </div>

        {!inMeeting && mode === 'todo' && (
          <label className="cap__prio">
            <input
              type="checkbox"
              checked={priority === 'high'}
              onChange={(e) => setPriority(e.target.checked ? 'high' : 'normal')}
            />
            High priority
          </label>
        )}

        {!inMeeting && mode === 'feature' && (
          <div className="cap__modes cap__modes--sub">
            {['NEURO', 'SAiM', 'NOVA'].map((s) => (
              <button
                key={s}
                type="button"
                className={`cap__mode${system === s ? ' cap__mode--on' : ''}`}
                onClick={() => setSystem(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <button className="cap__submit" type="submit" disabled={busy || !ready}>
          {busy ? 'Saving…' : inMeeting ? `Save ${kindSpec.label.toLowerCase()}` : mode === 'note' ? 'Save note' : mode === 'todo' ? 'Add todo' : 'Add to tracker'}
        </button>
        {!inMeeting && mode === 'feature' && (
          <p className="cap__hint">A feature idea needs a connection — it goes into the tracker, not the queue.</p>
        )}
      </form>

      {/* ⚠⚠ THE ONE MESSAGE ON THIS SCREEN THAT MUST NOT BE MISSED, and it
          differed from "Saved to NEURO." by TEXT COLOUR ALONE — same box, same
          border, no icon. "NOT saved — your words are still here; don't close
          the app" is the sentence the whole capture path exists to be able to
          say, and it was a slightly different shade of the same thing.

          Now the SHAPE carries it too: a failure is the fault treatment with a
          mark beside it, a success is a plain statement. Colour alone fails on
          a phone in sunlight and for anyone who cannot separate the hues — the
          same reason iOS's queued-vs-lost note gained an icon. */}
      {flash && (
        <Lit
          tone={flash.ok ? 'statement' : 'normal'}
          className={`cap__flash${flash.ok ? '' : ' cap__flash--fault err'}`}
          role={flash.ok ? undefined : 'alert'}
        >
          <span className="cap__flash-mark" aria-hidden="true">{flash.ok ? '✓' : '⚠'}</span>
          {flash.msg}
        </Lit>
      )}

      {(waiting.length > 0 || stuck.length > 0) && (
        <div className="cap__queue">
          <LitLabel className="cap__queue-h">
            Waiting on this device
            <button type="button" className="cap__queue-send" onClick={() => flush({ force: true })}>Send now</button>
          </LitLabel>
          {waiting.map((o) => (
            /* ⚠ A STATEMENT, not a warning. "Queued on this device" is the
               offline path WORKING — the words are safe and on their way. The
               same conflation was fixed on iOS's task note the day before: a
               queued tick and a lost one must not look alike. */
            <Lit tone="statement" className="cap__q" key={o.operationId}>
              <div className="cap__q-text">{previewOf(o)}</div>
              <div className="cap__q-meta">
                Queued on this device — not in NEURO yet
                {o.attempts > 0 ? ` · ${o.attempts} attempt${o.attempts === 1 ? '' : 's'}` : ''}
              </div>
            </Lit>
          ))}
          {stuck.map((o) => (
            /* The only fault treatment on this screen: NEURO refused it and
               the words exist nowhere else. */
            <Lit className="cap__q cap__q--stuck" key={o.operationId}>
              <div className="cap__q-text">{previewOf(o)}</div>
              <div className="cap__q-meta err">
                NOT saved — {o.lastError || 'NEURO could not apply it'}
              </div>
              <div className="cap__q-actions">
                <button type="button" onClick={() => retry(o.operationId)}>Try again</button>
                <button type="button" onClick={() => discard(o.operationId)}>Discard</button>
              </div>
            </Lit>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="cap__recent">
          <LitLabel className="cap__recent-h">Recent captures</LitLabel>
          {recent.map((r) => (
            /* Read-only — what already landed. Nothing to act on, so nothing
               that looks pressable. */
            <Lit tone="statement" className="cap__recent-item" key={r.relativePath}>
              <div className="cap__recent-title">{r.title || r.filename}</div>
              {r.preview && <div className="cap__recent-preview">{r.preview}</div>}
            </Lit>
          ))}
        </div>
      )}
    </section>
  );
}

/** The captured words, shown back so a stuck item is recoverable by reading it. */
function previewOf(op) {
  const p = op.payload || {};
  if (op.kind === 'capture.note') return p.title ? `${p.title} — ${p.content}` : p.content;
  if (op.kind === 'capture.todo') return p.text;
  if (op.kind === 'todo.complete') return `Complete task #${p.taskId}`;
  return op.kind;
}
