import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../api';
import actionSurfaces from '../../../../shared/action-surfaces.cjs';
// ⚠ The matcher, not a parser. The server composes the exact phrases that mean
// each sentence; this compares what was said against that list. See
// `shared/heard.cjs` — nothing here works out what Nick meant.
import { matchSaid } from '../../../../shared/heard.cjs';
import { speakIfEnabled, isAudioUnlocked, unlockAudio, isVoiceOutEnabled, setVoiceOutEnabled } from '../voiceUtils';
// ⚠ ONE source, shared with the Pi kiosk (`saim/shared-ui`). SAiM's presence
// must look the same wherever she is; two copies would drift, which is exactly
// what happened to `voiceUtils.js` when the phone and the desktop each kept
// their own. Field itself is size-agnostic — its density is per AREA, not a
// node count — so the same file reads correctly on a 390px phone and a 1280px
// desk panel without re-tuning.
import Field from '../../../shared-ui/Field';
import AttentionSurface from '../../../shared-ui/AttentionSurface';
import './Surface.css';
import { speechRecognitionCtor, noMicReason } from '../speechRecognition';

// Surface — SAiM without a menu.
//
// The rest of this app is a tab strip: Nick chooses, SAiM renders. This is the
// other way round. It renders GET /api/attention — ONE thing the brain decided
// is worth his attention, in the context it decided it in — and the nine views
// become places the brain routes TO rather than things to go and find.
//
// ── Presence ────────────────────────────────────────────────────────────────
// SAiM is `components/Field`: the vault as a pinned noisy substrate, with her
// visible only as order arriving in it. No orb, no avatar, no face. The field
// is driven by the brain's OWN state, so the coherence on screen is the
// coherence of the read — informative before a word is read, which is what
// keeps it from being a screensaver.
//
// ── Ears ────────────────────────────────────────────────────────────────────
// SAiM is the voice/ears/eyes layer, and until now her own screen had neither a
// mic nor a speech toggle: talking to her meant "Show me everything" → Chat,
// i.e. going through a menu to reach the thing that exists so you don't need
// one. The mic is here, and the exchange is deliberately EPHEMERAL — one
// question, one answer, then back to the ambient state. The Chat tab owns
// conversation and history; this owns the passing question. Two surfaces
// keeping two versions of the same thread is the drift this avoids.
//
// The mic tap is also the iOS audio-unlock gesture, which is why `unlockAudio`
// is called there explicitly rather than left to whichever touch wins the race.
//
// Three things it must still get right, all of them about honesty:
//   * SILENCE IS A CORRECT ANSWER. Most of a calm day has no primary.
//   * NOTHING IS HIDDEN SILENTLY. What was gated out is named.
//   * "COULDN'T LOOK" IS NOT "NOTHING THERE" — hence `context.cannotSee`, which
//     the brain now filters to gaps that could actually have changed the answer.
const POLL_MS = 60_000;

// How long "not now" means, said in Nick's words rather than in minutes.
//
// The REASON travels with each one because a thing pushed back three times for
// `too-big` is a different problem from one pushed back for `not-now`, and that
// distinction is what Work Package C is built on. It costs nothing to record it
// at the moment the gesture is made and cannot be recovered afterwards.
const { resolveSaimLiteTab } = actionSurfaces;

// Straight from Chat.jsx — iOS fails dictation in specific, explicable ways and
// saying which one beats a spinner that stops.
const VOICE_ERRORS = {
  'not-allowed': 'Microphone permission is off for SAiM.',
  'service-not-allowed': 'iOS refused speech recognition here. Try Safari rather than the installed app.',
  'audio-capture': 'No microphone available.',
  network: 'Speech recognition needs the network and couldn’t reach it.',
  aborted: 'Cut off before it caught anything. Tap the mic and try again.',
};

// Where a card goes when tapped. Reuses the notification router, so a card and
// the notification for the same thing can never land on different tabs.
function tabFor(card) {
  if (!card || card.kind !== 'item') return null;
  return resolveSaimLiteTab({ type: card.type, meta: card.meta });
}

// ⚠ Can this device be spoken to AT ALL? Checked once, at module load.
//
// The kiosk mounts this same component (one app, both surfaces) but the Pi 4
// has no microphone and Chromium on Debian has no Web Speech backend — so the
// desk screen was offering "🎤 Talk to me" and would have failed on the tap.
// The documented rule is that a kiosk carrying a mic it cannot use is worse
// than one without, so the button is not rendered rather than rendered broken.
//
// It is a CAPABILITY check, not a device check: nothing here asks whether it is
// "the kiosk". If a mic is ever plugged into the Pi the button returns on its
// own, which is the outcome Nick's principle actually wants.
const CAN_LISTEN = Boolean(speechRecognitionCtor());

export default function Surface({ onNavigate, onShowAll, arrivedFrom, onClearArrival }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState(false);
  const [voiceOut, setVoiceOut] = useState(() => isVoiceOutEnabled());

  // The passing question. Null most of the time — this is an ambient screen
  // that can be spoken to, not a chat window.
  const [exchange, setExchange] = useState(null); // { question, answer, thinking, error }
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState('');
  const recognitionRef = useRef(null);
  const dictatedRef = useRef('');

  const load = useCallback(async ({ quiet = false, ask = null } = {}) => {
    if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      // ⚠ `ask` moves the DASHBOARD to match the question — Nick's principle is
      // that everything is achievable conversationally, and until this a
      // question streamed an answer while the screen went on showing whatever
      // it had been showing. The brain routes it deterministically; a question
      // it does not recognise leaves the dashboard exactly where it was.
      const data = await apiFetch(`/api/attention${ask ? `?ask=${encodeURIComponent(ask)}` : ''}`);
      setState({ loading: false, error: null, data });
    } catch (error) {
      // An error is NOT an empty feed. Keep the last good payload on screen
      // beside the error rather than blanking to something that looks calm.
      setState((s) => ({ loading: false, error: error.message, data: s.data }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll, and re-read the moment the phone comes back — the context this rests
  // on (in a meeting, mid-session, before a 1-2-1) is exactly what changed
  // while the screen was off. Paused while an exchange is open so an answer
  // never gets swept away mid-read.
  useEffect(() => {
    const timer = setInterval(() => { if (!exchange) load({ quiet: true }); }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !exchange) load({ quiet: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load, exchange]);

  // Speak the brain's line, once per distinct line. `speech` is already null
  // whenever it decided to stay quiet, so there is no second opinion here.
  // The gesture retry is what makes it work on iOS at all (#111): a cold start
  // lands here before any touch, so it is left UNSPOKEN and retried rather than
  // dropped — a dropped utterance is indistinguishable from a broken toggle.
  const spokenRef = useRef(null);
  const speech = exchange ? null : (state.data?.speech || null);
  useEffect(() => {
    if (!speech || speech === spokenRef.current) return;
    const say = () => { spokenRef.current = speech; speakIfEnabled(speech); };
    if (isAudioUnlocked()) { say(); return; }
    const onGesture = () => say();
    document.addEventListener('pointerdown', onGesture, { once: true });
    return () => document.removeEventListener('pointerdown', onGesture);
  }, [speech]);

  async function ask(question) {
    // ── Was that a COMMAND? ──────────────────────────────────
    //
    // SAiM's principle is that everything she can do is achievable
    // conversationally, and until this the sentences she offers could only be
    // TAPPED — saying "not now" streamed a chat answer ABOUT deferring rather
    // than deferring anything.
    //
    // ⚠ NOTHING IS PARSED HERE. The brain composed the phrases that mean each
    //   sentence; this is string equality against that list, and a phrase two
    //   sentences claim matches NEITHER. Anything unmatched is a QUESTION and
    //   goes to chat exactly as before — never reported as a failed command.
    //
    // ⚠ It is checked against the utterances ON SCREEN, so a verb NEURO would
    //   refuse is no more reachable by voice than by thumb.
    const heard = matchSaid(question, state.data?.utterances);
    if (heard?.kind === 'control' && heard.control === 'stop') {
      // Speech only. A write already sent is out of this shell's hands, and
      // claiming to have recalled it is "a request sent is not an action
      // completed" pointed backwards.
      try { window.speechSynthesis?.cancel(); } catch { /* not every shell has one */ }
      endExchange();
      return;
    }
    if (heard?.kind === 'utterance') {
      // Shown, then done — he must be able to see what she heard, or a
      // misheard word becomes an action with no explanation. The utterance's
      // own words are the echo, never the raw dictation, because THAT is what
      // is about to happen.
      setExchange({ question, answer: heard.utterance.say, thinking: false, error: null, acted: true });
      await onSay(heard.utterance, state.data?.primary);
      return;
    }

    setExchange({ question, answer: '', thinking: true, error: null });
    // Fire-and-forget, in PARALLEL with the answer: the dashboard should change
    // as he finishes speaking, not after the model has finished replying. A
    // failure here must never cost him the answer, so it is deliberately not
    // awaited and its rejection is swallowed.
    load({ quiet: true, ask: question }).catch(() => {});
    let acc = '';
    try {
      await chatStream(
        { message: question },
        {
          onChunk: (c) => { acc += c; setExchange((e) => (e ? { ...e, answer: acc } : e)); },
          onError: (msg) => setExchange((e) => (e ? { ...e, error: msg } : e)),
        },
      );
    } catch {
      // Streaming failed outright — the sync endpoint is the documented fallback.
      try {
        const res = await apiFetch('/api/chat/sync', { method: 'POST', body: JSON.stringify({ message: question }) });
        acc = res?.reply || res?.content || '';
      } catch (e2) {
        setExchange((x) => (x ? { ...x, thinking: false, error: e2.message } : x));
        return;
      }
    }
    setExchange((e) => (e ? { ...e, answer: acc, thinking: false } : e));
    if (acc) speakIfEnabled(acc);
  }

  function toggleMic() {
    // The tap that starts dictation is also the gesture iOS needs before it will
    // ever speak. Doing it here explicitly beats relying on a {once:true} race.
    unlockAudio();
    setVoiceErr('');

    if (listening) { recognitionRef.current?.stop(); return; }

    const SpeechRecognition = speechRecognitionCtor();
    if (!SpeechRecognition) { setVoiceErr(noMicReason() || 'No speech recognition here.'); return; }

    const rec = new SpeechRecognition();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.continuous = true;          // the STOP tap is what sends
    dictatedRef.current = '';
    rec.onresult = (evt) => {
      let chunk = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) chunk += evt.results[i][0].transcript;
      dictatedRef.current = (dictatedRef.current ? `${dictatedRef.current} ${chunk}` : chunk).trim();
    };
    // onend fires from a stale closure, hence dictatedRef rather than state.
    rec.onend = () => {
      setListening(false);
      const said = dictatedRef.current.trim();
      if (said) ask(said);
      else setVoiceErr((e) => e || 'Heard nothing. If that keeps happening, try Safari rather than the installed app.');
    };
    rec.onerror = (evt) => {
      setListening(false);
      const code = evt?.error || 'unknown';
      if (dictatedRef.current.trim()) return;   // a finished turn is not a failure
      const known = Object.prototype.hasOwnProperty.call(VOICE_ERRORS, code);
      setVoiceErr(known ? VOICE_ERRORS[code] : `Mic error: ${code}`);
    };
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  function endExchange() {
    setExchange(null);
    setVoiceErr('');
    load({ quiet: true });
  }

  /**
   * Act on the card's RECORD.
   *
   * ⚠ This used to POST `/api/focus/dismiss` — the engine's per-item
   * suppression, which is a TIMER. It could not tell "I have seen this" from
   * "hide it for 30 minutes" from "this is finished", so every gesture here
   * collapsed into the same one and nothing Nick did was recoverable later.
   *
   * The record is the one place that distinction lives, so this submits an
   * ACTION and lets NEURO decide the state — the contract's rule that clients
   * never write state directly.
   *
   * It FALLS BACK to the old route when a card has no `recordId`, which is the
   * case against a backend that has not been deployed yet. A phone in Nick's
   * pocket running an older bundle must not lose the ability to clear a card.
   */
  // Answer a room offer — lights or heating in the room presence says he is in.
  //
  // ⚠ THE KEY IS ALL THAT TRAVELS. The server re-derives from a fresh read what
  //   that key actually meant, so this cannot name an entity and a stale screen
  //   cannot switch something on that has stopped being a sensible offer.
  //
  // ⚠ Refetch after either answer, including a decline: the offer has to leave
  //   the screen or a press looks like it did nothing, which is how a control
  //   stops being trusted.
  // Ask for something to be opened on the laptop, then FOLLOW IT until the
  // machine says what happened. Without the follow-up this could only claim to
  // have sent something, which is the weaker of the two things it could say.
  const [deskStates, setDeskStates] = useState({});
  // null = not yet known, false = this surface cannot reach the route.
  const [deskReachable, setDeskReachable] = useState(null);
  async function deskOpen(app) {
    setDeskStates(s => ({ ...s, [app]: 'waiting' }));
    let id = null;
    try {
      const r = await apiFetch('/api/desktop/intents', {
        method: 'POST',
        body: JSON.stringify({ app, host: state.data?.work?.host || null }),
      });
      if (!r || !r.ok) throw new Error((r && r.reason) || 'refused');
      id = r.intent.id;
    } catch (e) {
      // ⚠ A SURFACE THAT CANNOT REACH THE ROUTE STOPS OFFERING THE BUTTONS.
      //   `setDeskReachable` was DECLARED AND NEVER CALLED, so `deskReachable`
      //   stayed null for ever, the guard below could never fire, and the
      //   buttons rendered on every surface - including the kiosk and the
      //   desktop Electron window, which reach NEURO through a proxy where
      //   `desktop` is not a door. Every press there failed instantly, which
      //   is what Nick reported on 13 Sep 2026. A reader with no writer, the
      //   species this codebase keeps finding.
      //
      // ⚠ Only a TRANSPORT failure hides them. A refusal NEURO actually sent
      //   (an unknown app, a full queue) is an ANSWER, and withdrawing the
      //   control because one press was declined would be the surface drawing
      //   a conclusion from a single no.
      if (e && /not found|404|unreachable|failed to fetch/i.test(e.message || '')) {
        setDeskReachable(false);
      }
      setDeskStates(s => ({ ...s, [app]: 'failed' }));
      return;
    }
    // Watch fast, then patiently. The agent claims on its OWN 5s poll now, so
    // the normal case settles in about two seconds and a 5s first tick would
    // make a working button look slow. After that the deadline is what
    // matters: the watch runs PAST it, so the server's own `expired` is
    // always seen rather than the button being left on 'waiting' for ever.
    //
    // ⚠ A FAILED POLL IS NOT AN OUTCOME — it is a poll that failed, so the
    //   watch continues rather than painting a verdict over a request that
    //   may well be about to open. Only the route's own words end it.
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, i < 15 ? 2000 : 10000));
      try {
        const st = await apiFetch('/api/desktop/intents/' + encodeURIComponent(id));
        setDeskStates(s => ({ ...s, [app]: st.state }));
        if (['opened', 'failed', 'expired'].includes(st.state)) return;
      } catch { /* a failed poll is not an outcome — keep watching */ }
    }
  }

  // Accepting an offer is the one press on this screen with a PHYSICAL effect,
  // so it gets the same honesty as a desk intent: it is in flight while it is in
  // flight, and a refusal stays on screen in NEURO's own words.
  //
  // ⚠⚠ IT USED TO SWALLOW THE FAILURE into a `console.warn` and refetch — so a
  //   light that did not come on was INDISTINGUISHABLE from one that did, and
  //   the only thing Nick saw either way was the offer disappearing. A card that
  //   clears itself on an error is one he believes worked, which is the failure
  //   this whole layer exists to remove.
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomFailure, setRoomFailure] = useState(null);
  async function roomAct(key, decision) {
    const path = decision === 'accept' ? 'accept' : 'decline';
    setRoomFailure(null);
    setRoomBusy(true);
    try {
      const res = await apiFetch(`/api/rooms/${encodeURIComponent(key)}/${path}`, { method: 'POST' });
      // ⚠ A 200 carrying `ok:false` is NOT an acknowledgement — `neuroCapture`'s
      //   rule, and the same one the kiosk capture bridge is built on. The
      //   offer is re-derived server-side from a fresh read, so one that has
      //   stopped being true is refused rather than executed late, and that
      //   refusal is a thing Nick needs to see.
      if (res && res.ok === false) {
        setRoomFailure(res.reason || res.error || (decision === 'accept' ? 'That could not be done.' : 'That could not be recorded.'));
      }
    } catch (e) {
      setRoomFailure(e.message || 'That could not be done.');
    } finally {
      setRoomBusy(false);
    }
    load();
  }

  async function act(card, action, opts = {}) {
    if (!card || card.kind !== 'item') return undefined;
    // ⚠ `complete` NEVER takes the legacy route. A dismissal is not a completion,
    // and substituting one for the other is the bug the attention contract
    // removed — so a card with no record says it could not be done.
    if (action === 'complete' && !card.recordId) {
      return { ok: false, error: 'This card has no record to complete — nothing was changed.' };
    }
    setBusy(true);
    try {
      let res = { ok: true };
      if (card.recordId) {
        // The response carries `taskCompleted` / `taskWhy` — what "done"
        // actually closed — and is handed back so the surface can say it.
        res = await apiFetch(`/api/attention/records/${card.recordId}/act`, {
          method: 'POST',
          body: JSON.stringify({ action, ...opts }),
        });
      } else {
        await apiFetch('/api/focus/dismiss', {
          method: 'POST',
          body: JSON.stringify({ itemId: card.id, itemType: card.type }),
        });
      }
      await load({ quiet: true });
      return res;
    } catch (e) {
      // Leave it on screen if it failed — a card that vanishes on an error is a
      // card Nick believes he has dealt with. The refusal is returned in NEURO's
      // own words where the body carried them (apiFetch flattens it into the
      // message), so "record is resolved" is not reported as a network fault.
      const msg = String((e && e.message) || 'failed');
      const inBody = msg.match(/"error"\s*:\s*"([^"]+)"/);
      return { ok: false, error: inBody ? inBody[1] : msg };
    } finally { setBusy(false); }
  }

  function open(card) {
    const tab = tabFor(card);
    if (tab) onNavigate?.(tab);
  }

  /**
   * A sentence Nick said — or tapped, which is the same sentence.
   *
   * ⚠ THE INTENT IS STRUCTURED AND IS NEVER PARSED HERE. The brain composed
   * both the words and what they mean (`backend/services/saim-surface.js`), for
   * the same reason it composes `say`, `speech` and `tab`: the moment a client
   * works out what a sentence means, there are two answers to that question and
   * they are free to drift.
   *
   * ⚠ The kinds are a CLOSED set and an unrecognised one does nothing rather
   * than guessing. A surface that falls through to a default action on a verb
   * it does not understand is how a tap comes to do something nobody asked for.
   */
  async function onSay(utterance, card) {
    const intent = utterance && utterance.intent;
    if (!intent) return;

    switch (intent.kind) {
      case 'act':
        // The record is the identity, and the brain named it. `card` is only a
        // fallback for the legacy route inside `act`.
        return act(
          intent.recordId ? { ...card, kind: 'item', recordId: intent.recordId } : card,
          intent.action,
          { minutes: intent.minutes, reason: intent.reason },
        );

      case 'session':
        // ⚠ A DIFFERENT API from `act`. Shrink, step-away and finish live on
        // `/api/session/*`; the attention lifecycle refuses all three, so
        // sending them there would be a sentence NEURO cannot honour.
        setBusy(true);
        try {
          if (intent.action === 'start') {
            // "I'm on it" names what the session is about; the brain composed
            // the words. No `force` — nothing already running is switched
            // without Nick saying so (the brain does not offer this sentence
            // while a session runs, so a 409 here is a race and is left alone).
            await apiFetch('/api/session/start', {
              method: 'POST',
              body: JSON.stringify({ text: intent.text, source: 'attention' }),
            });
            // Told, not moved: the record keeps its state and gains the
            // evidence. A failure here must not read as the start failing.
            if (intent.recordId) {
              await apiFetch(`/api/attention/records/${intent.recordId}/act`, {
                method: 'POST',
                body: JSON.stringify({ action: 'start' }),
              }).catch(() => {});
            }
          } else {
            await apiFetch(`/api/session/${intent.action}`, { method: 'POST', body: JSON.stringify({}) });
            // "That's done" on a card he was working: the session is closed,
            // and the card it was about is completed in the same breath. The
            // brain only attaches a record when that card allows completion.
            if (intent.action === 'finish' && intent.recordId) {
              await apiFetch(`/api/attention/records/${intent.recordId}/act`, {
                method: 'POST',
                body: JSON.stringify({ action: 'complete' }),
              });
            }
          }
          await load({ quiet: true });
        } catch { /* left on screen — a card that vanishes on an error is one
                     Nick believes he has dealt with */ }
        finally { setBusy(false); }
        return undefined;

      case 'meeting':
        // ⚠ A THIRD API, and for the same reason `session` is a second one:
        // this releases the quiet state on an OCCURRENCE, which the attention
        // lifecycle knows nothing about and would refuse. The key travels so
        // the server can check it against the meeting actually running — a
        // polled screen can be holding the one before this.
        setBusy(true);
        try {
          await apiFetch(`/api/attention/meeting/${intent.action === 'finished' ? 'finished' : 'resume'}`, {
            method: 'POST',
            body: JSON.stringify({ key: intent.key }),
          });
          await load({ quiet: true });
        } catch { /* left on screen — a button that clears itself on an error is
                     one Nick believes worked */ }
        finally { setBusy(false); }
        return undefined;

      case 'navigate':
        if (intent.tab) onNavigate?.(intent.tab);
        return undefined;

      case 'ask':
        // Straight into the passing question — the same ephemeral exchange the
        // mic uses. Chat owns conversation and history; this owns the one
        // question, and two surfaces keeping two versions of one thread is the
        // drift that split avoids.
        return ask(intent.text || utterance.say);

      case 'refresh':
        return load();

      case 'reveal':
        onShowAll?.();
        return undefined;

      default:
        return undefined;
    }
  }

  const { loading, error, data } = state;
  // The bare states keep their own words — a cold start and an unreachable
  // brain are not the same fact, and neither is the shared component's job.
  if (loading && !data) {
    return (
      <div className="surface surface--bare">
        <Field confidenceLevel="low" degraded />
        <p className="surface__bareline">Reading the room…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="surface surface--bare">
        <Field confidenceLevel="low" degraded />
        <p className="surface__saylead">I can't reach the brain.</p>
        {error && <p className="surface__whyline">{error}</p>}
        <button type="button" className="surface__btn" onClick={() => load()}>Try again</button>
      </div>
    );
  }

  // ⚠ Everything the feed MEANS now lives in `saim/shared-ui/AttentionSurface`,
  // shared file-for-file with the Pi kiosk: the three distinct silences, the
  // transition, the defer row with its reasons, what is held back. This file
  // keeps only what is genuinely the PHONE's — fetching, speech, the mic, the
  // passing question and the notification arrival — and passes them in as slots.
  //
  // The rules are shared so the two surfaces cannot drift; the chrome is not,
  // because a kiosk carrying a mic it cannot use is worse than one without.
  // Which arrangement this DEVICE gets. One component serves the phone, the
  // kiosk and the Electron window, so there is no per-build switch to throw.
  // The opt-in is the URL, which IS per device: the tablets and the wall panel
  // are started at a fixed address, so `?look=approach` there turns the corridor
  // on for that screen and nothing else. Never persisted — a look a device
  // cannot be talked out of by changing its start URL needs a deploy to undo.
  // ⚠ APPROACH IS THE DEFAULT, and `?look=list` is the way back. It is written
  // this way round on purpose: the first cut asked for `?look=approach` and
  // ALSO set the default on the component, so the explicit prop passed from
  // here beat the default and every device kept the old stack — a switch that
  // looked thrown and was not. An explicit value always beats a default.
  // ── The phase THIS DEVICE knows ─────────────────────────────
  //
  // Everything else on `data.operation` is the brain's and is rendered verbatim.
  // This is the deliberate exception: "I am waiting on my own request" is a fact
  // about this shell, not an inference about Nick's day, and the server has no
  // way to observe it.
  //
  // ⚠ TRANSIENT BY CONSTRUCTION. The moment the request settles this is null
  //   and the server's answer is back, so a client-local phase can never survive
  //   contrary server data — which is what keeps it from becoming a second store.
  //
  // ⚠ The WORDS are not ours. `AttentionSurface` looks the label up in the
  //   shared vocabulary; this only names which phase it is in.
  //
  // ⚠ A question is ASSESSING, a write is EXECUTING. They are different halves
  //   of the loop and collapsing them into one "busy" would throw away exactly
  //   the distinction this feature is about.
  const localPhase = exchange?.thinking ? 'assessing'
    : (busy || roomBusy) ? 'executing'
      : null;

  const look = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('look') === 'list'
    ? 'list' : 'approach';

  // Does the brain's own sentence list already carry the way out?
  const hasRevealUtterance = Boolean(onSay)
    && Array.isArray(data?.utterances)
    && data.utterances.some((u) => u && u.intent && u.intent.kind === 'reveal');

  // ⚠⚠ THE MIC IS SHELF HARDWARE, NOT FOOT FURNITURE. Nick, 14 Sep 2026: "talk
  // to me should be part of the suggest cards, they should all look the same."
  // It sat in the foot as a pill of its own, beside a row of cards it shared
  // nothing with — while MANIFESTATION.md already says the bottom-right corner
  // is HARDWARE: the weather, the apps where the laptop answered, the doors
  // where the house answered. A microphone is a capability of the device,
  // exactly like those.
  //
  // ⚠ It carries `shelf__btn` so it IS one of them rather than something that
  // resembles one — a second definition of "a card on the shelf" is how the row
  // comes to have two looks. Only `--live` is its own, because listening is a
  // state none of the others have.
  //
  // ⚠ And it is offered only where it EXISTS: "talk to me is on the fire tablet,
  // not the laptop" (Nick, same day). Electron exposes `webkitSpeechRecognition`
  // with no service behind it, so `CAN_LISTEN` answers false there and the slot
  // is empty rather than carrying a control that fails on the tap.
  const micCard = CAN_LISTEN ? (
    <button
      type="button"
      className={`shelf__btn${listening ? ' shelf__btn--live' : ''}`}
      onClick={toggleMic}
      aria-pressed={listening}
      aria-label={listening ? 'Stop and send' : 'Talk to SAiM'}
    >
      {listening ? 'LISTENING — TAP TO SEND' : 'TALK TO ME'}
    </button>
  ) : null;

  return (
    <AttentionSurface
      layout={look}
      data={data}
      error={error}
      busy={busy}
      rootClassName="surface"
      onOpen={open}
      onAct={act}
      onRoomAct={roomAct}
      onDeskOpen={deskReachable === false ? null : deskOpen}
      deskStates={deskStates}
      onSay={onSay}
      onNavigate={(tab) => onNavigate?.(tab)}
      hideSecondary={Boolean(exchange)}
      crownExtra={(
        <button
          type="button"
          className={`surface__ear${voiceOut ? ' surface__ear--on' : ''}`}
          onClick={() => { unlockAudio(); const next = !voiceOut; setVoiceOutEnabled(next); setVoiceOut(next); }}
          aria-pressed={voiceOut}
          aria-label={voiceOut ? 'Stop SAiM speaking' : 'Let SAiM speak'}
        >{voiceOut ? '🔊' : '🔇'}</button>
      )}
      beforeSay={arrivedFrom?.body && !exchange ? (
        // Why he is here, when he arrived by tapping a notification. Without it
        // the push and the screen are two unconnected events.
        <button type="button" className="surface__arrival" onClick={() => onClearArrival?.()}>
          <span className="surface__arrivallabel">you tapped</span>
          <span className="surface__arrivalbody">{arrivedFrom.body}</span>
        </button>
      ) : null}
      sayOverride={exchange ? (
        <>
          <p className="surface__asked">“{exchange.question}”</p>
          {/* ⚠ WHAT SHE HEARD, SHOWN BEFORE IT IS ACTED ON. A misheard word that
              defers a card with no explanation is worse than one that produces a
              wrong chat answer — this is the "report" half of the loop, and it
              echoes the SENTENCE that ran rather than the raw dictation, because
              the sentence is what actually happened. */}
          {exchange.acted && <p className="surface__saysub">Heard as a command · doing it</p>}
          {exchange.error ? (
            <p className="surface__saysub surface__saysub--warn">{exchange.error}</p>
          ) : (
            <p className="surface__saylead">
              {exchange.answer || (exchange.thinking ? (
                /* ⚠ A THIN SHIFTING LINE, never spinner dots. Dots are furniture
                   that says only "something is happening"; this is her field
                   resolving, which is the same language the rest of the screen
                   already speaks — and under `prefers-reduced-motion` it becomes
                   a steady line rather than nothing, because that is a request
                   for less movement, not less information. */
                <span className="surface__thinking" role="status" aria-label="Thinking" />
              ) : '')}
            </p>
          )}
          <div className="surface__acts">
            <button type="button" className="surface__btn" onClick={endExchange}>Done</button>
          </div>
        </>
      ) : null}
      localPhase={localPhase}
      footAside={(voiceErr || roomFailure) ? (
        <>
          {voiceErr && <p className="surface__aside surface__aside--warn">{voiceErr}</p>}
          {/* ⚠ STAYS UNTIL READ, and is tappable to clear — a note that fades on
              its own is one he may never see, which is `outcome`'s rule one
              component along. It says what NEURO said rather than a house
              phrasing of it. */}
          {roomFailure && (
            <button
              type="button"
              className="surface__aside surface__aside--warn"
              onClick={() => setRoomFailure(null)}
              aria-label="Clear this note"
            >Nothing changed in the house — {roomFailure}</button>
          )}
        </>
      ) : null}
      deviceSlot={micCard}
      footExtra={/* ⚠⚠ NOTHING, NOT AN EMPTY ROW. This rendered a flex row with
          `padding-top: 0.5rem` whether or not the hatch inside it was showing —
          and it usually is not, because the composer already ends the utterances
          with "Show me everything". So the foot reserved ~22px of nothing below
          its text and, being bottom-anchored, pushed the held line that far
          ABOVE the middle of the shelf cards beside it (photographed 14 Sep
          2026: "the alignment here doesn't look right").

          Same shape as `Dashboard`'s `bare` earlier the same day: a container
          drawn for content it does not have. A box with nothing in it is
          invisible and still takes the room. */
        !hasRevealUtterance ? (
        <div className="surface__footrow">
          {/* ⚠ THE ESCAPE HATCH, ONCE. The composer already ends every utterance
              list with "Show me everything" (`kind: reveal`, always last, never
              dropped), so where the sentences are on screen this button printed
              it a SECOND time — on the wall it read twice, a foot apart.

              ⚠ Hidden only where the sentence exists AND this shell can act on
              one. Either missing and the button comes back: the one screen with
              no menu must always have a way round it, and a hatch that vanishes
              because a composition failed is the failure that strands him. */}
          <button type="button" className="surface__all" onClick={() => onShowAll?.()}>Show me everything</button>
        </div>
      ) : null}
    />
  );
}
