import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiFetchBlob, chatStream } from '../api';
import { speakSara, isVoiceOutEnabled, setVoiceOutEnabled, unlockAudio } from '../voiceUtils';
import './Chat.css';
import { speechRecognitionCtor, noMicReason } from '../speechRecognition';

// Chat = talk to the brain, with real vault reasoning behind it.
// Streams over POST /api/chat (SSE). If streaming fails, falls back to POST /api/chat/sync.

// Web Speech errors are terse codes. On a phone there is no console to read, so the
// reason has to reach the screen — a mic that fails silently is indistinguishable from
// a mic that isn't wired up at all.
// 50ms of silence. Played on the speaker tap purely to unlock <audio> playback for the
// server-TTS fallback, which arrives long after any gesture has passed.
const SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Feminine voices on gpt-audio-mini. Nick picks — I can't hear them, and guessing is
// what produced "a bored Stephen Hawking" in the first place.
const VOICE_CHOICES = [
  { id: 'coral', label: 'Coral' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'sage', label: 'Sage' },
  { id: 'marin', label: 'Marin' },
  { id: 'nova', label: 'Nova' },
];
const VOICE_KEY = 'sara_tts_voice';
const SAMPLE_LINE = 'Queue is at twelve, three at risk. Chase Abdi today, or hand it to Stephen.';

function getTtsVoice() {
  try { return localStorage.getItem(VOICE_KEY) || 'coral'; } catch { return 'coral'; }
}

const VOICE_ERRORS = {
  'not-allowed': 'Microphone blocked. Allow it in Settings → Safari → Microphone, then reload.',
  'service-not-allowed': 'iOS refused speech recognition here. Try opening SARA in Safari rather than the installed app.',
  'audio-capture': 'No microphone available.',
  'no-speech': 'Didn’t hear anything — try again, closer to the mic.',
  'network': 'Speech recognition needs the network and couldn’t reach it.',
  // Only reached when nothing was captured — an abort after a good turn returns early.
  aborted: 'Dictation was cut off before it caught anything. Tap 🎤 and try again.',
};

// What SARA reached for during a reply, in plain words.
//
// ⚠ NAMES ONLY, never arguments. A tool's input is the task text, the note path,
// the draft email — private content that has no business on a line under a chat
// bubble. The name is enough to say what she did.
//
// ⚠ "ran", never "done". NEURO reports WHICH tools ran (`type:'tool'` over SSE,
// `tools: [names]` from /api/chat/sync) and not whether each one worked — a
// `create_task` that refused still ran. Claiming success here would be a
// statement the payload cannot support.
const TOOL_LABELS = {
  get_tasks: 'Check your tasks',
  get_calendar: 'Check your calendar',
  search_vault: 'Search the vault',
  read_note: 'Read a note',
  create_task: 'Create a task',
  complete_task: 'Complete a task',
  append_daily_note: 'Add to today’s note',
  capture_feature: 'Capture a feature idea',
  draft_email_reply: 'Draft an email reply (for your approval)',
  get_urgent_emails: 'Check urgent email',
  schedule_focus_block: 'Book a focus block (for your approval)',
  create_meeting: 'Set up a meeting (for your approval)',
  escalate_ticket: 'Escalate a ticket (for your approval)',
};

function toolLabel(name) {
  const key = String(name || '').trim();
  if (!key) return 'A tool';
  if (Object.prototype.hasOwnProperty.call(TOOL_LABELS, key)) return TOOL_LABELS[key];
  const words = key.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The sync fallback's shape: `tools` is an array of names. `toolCalls` is
// accepted too (objects carrying `name`) in case a backend returns the raw
// provider shape — only the name is ever read from it.
function toolNamesFrom(res) {
  if (Array.isArray(res?.tools)) return res.tools.filter((t) => typeof t === 'string');
  if (Array.isArray(res?.toolCalls)) return res.toolCalls.map((c) => c && c.name).filter((t) => typeof t === 'string');
  return [];
}

export default function Chat() {
  const [messages, setMessages] = useState([]); // { role, content }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // 'api' | 'local'
  const [voiceOut, setVoiceOut] = useState(isVoiceOutEnabled);
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [ttsVoice, setTtsVoice] = useState(getTtsVoice);
  const [showVoices, setShowVoices] = useState(false);
  const convRef = useRef(null);
  const endRef = useRef(null);
  const recognitionRef = useRef(null);
  const dictatedRef = useRef('');   // onend fires from a stale closure — read the text from here
  const busyRef = useRef(false);    // ditto for the in-flight guard
  const audioRef = useRef(null);
  const serverSpeakingRef = useRef(false);
  // speakViaServer runs from a setTimeout inside an effect, so it must not read state.
  const ttsVoiceRef = useRef(ttsVoice);

  const SpeechRecognition = speechRecognitionCtor();

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  // Speak SARA's reply once it has finished arriving.
  // Gated on `busy`, NOT `messages` — keying on messages speaks every streamed token.
  useEffect(() => {
    if (busy || !voiceOut || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'assistant' || !last.content) return;

    say(last.content);
  }, [busy]);

  // One place that speaks, so the toggle's test phrase and the real replies share
  // exactly the same path — if one works and the other doesn't, that's the finding.
  function say(text) {
    const utterance = speakSara(text);
    if (!utterance) { setVoiceErr('Speech synthesis refused that.'); return; }
    // "Speaking…" appearing but nothing audible means the API worked and the phone
    // didn't — silent switch or volume. Never appearing means it never spoke at all.
    utterance.onstart = () => { setSpeaking(true); setVoiceErr(''); };
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = (evt) => {
      setSpeaking(false);
      if (evt?.error === 'interrupted' || evt?.error === 'canceled') return;
      setVoiceErr(`Couldn’t speak: ${evt?.error || 'unknown'}`);
      console.warn('[SARA Voice] utterance error', evt?.error, evt);
    };
    // Nothing fired at all — the call was accepted and silently dropped. That is the
    // signature of speechSynthesis in an installed iOS PWA, so fall back to audio the
    // backend speaks for us, which <audio> will play where the speech API won't.
    setTimeout(() => {
      if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) speakViaServer(text);
    }, 1200);
  }

  // Backend TTS: /api/tts/speak returns a WAV. Costs a fraction of a penny per reply,
  // so it is the fallback rather than the default — browser speech is free where it works.
  async function speakViaServer(text, voiceOverride) {
    if (serverSpeakingRef.current) return;
    serverSpeakingRef.current = true;
    setSpeaking(true);
    try {
      const blob = await apiFetchBlob('/api/tts/speak', {
        method: 'POST',
        body: JSON.stringify({ text, voice: voiceOverride || ttsVoiceRef.current }),
      });
      const el = audioRef.current;
      if (!el) throw new Error('no audio element');
      if (el.src) URL.revokeObjectURL(el.src);
      el.src = URL.createObjectURL(blob);
      await el.play();
      setVoiceErr('');
    } catch (err) {
      setSpeaking(false);
      setVoiceErr(`Couldn’t speak: ${err.message}`);
      console.warn('[SARA Voice] server TTS failed', err);
    } finally {
      serverSpeakingRef.current = false;
    }
  }

  function chooseVoice(id) {
    setTtsVoice(id);
    ttsVoiceRef.current = id;
    try { localStorage.setItem(VOICE_KEY, id); } catch {}
    // Audition it immediately — this tap is also the gesture that keeps <audio> unlocked.
    speakViaServer(SAMPLE_LINE, id);
  }

  const toggleVoiceOut = () => {
    // This tap is a guaranteed user gesture — the one moment iOS will accept an unlock.
    // Waiting for the generic first-touch listener is a coin flip on which tap wins.
    unlockAudio();
    // The <audio> element needs its own gesture unlock, separate from speechSynthesis —
    // play a silent clip now so the server-TTS fallback can play later without one.
    const el = audioRef.current;
    if (el) { el.src = SILENT_WAV; el.play().catch(() => {}); }
    setVoiceErr('');
    setVoiceOut((v) => {
      const next = !v;
      setVoiceOutEnabled(next);
      // Speak the confirmation from inside the tap — the case iOS is most permissive
      // about. Hearing this but not the replies narrows it to the async path; hearing
      // nothing at all means synthesis is dead in this context, not mis-wired.
      if (next) say('Voice on.');
      return next;
    });
  };

  // Dictation: tap 🎤 to talk, tap ⏺ to stop — stopping sends. Continuous, so a pause
  // mid-thought doesn't fire it off early. The stop tap is also the iOS audio-unlock gesture.
  function startVoice() {
    if (!SpeechRecognition || listening) return;
    const rec = new SpeechRecognition();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.continuous = true;
    dictatedRef.current = '';
    setVoiceErr('');
    rec.onresult = (evt) => {
      let chunk = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) chunk += evt.results[i][0].transcript;
      dictatedRef.current = (dictatedRef.current ? `${dictatedRef.current} ${chunk}` : chunk).trim();
      setInput(dictatedRef.current);
    };
    rec.onend = () => {
      setListening(false);
      const said = dictatedRef.current.trim();
      if (said) submit(said);
      // Ended with nothing and no error fired: iOS often cuts recognition off in a
      // standalone PWA without ever reporting why. Say so rather than sitting silent.
      else setVoiceErr((e) => e || 'Heard nothing. If that keeps happening, try Safari rather than the installed app.');
    };
    rec.onerror = (evt) => {
      setListening(false);
      const code = evt?.error || 'unknown';
      console.warn('[SARA Voice] recognition error', code, evt);
      // Whatever was said before the abort still counts — don't cry over a finished turn.
      if (dictatedRef.current.trim()) return;
      // hasOwnProperty, not `||`: a mapped empty string means "known and benign", and
      // `||` would fall through to the generic message and shout about it anyway.
      const known = Object.prototype.hasOwnProperty.call(VOICE_ERRORS, code);
      const msg = known ? VOICE_ERRORS[code] : `Mic error: ${code}`;
      if (msg) setVoiceErr(msg);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      // start() throws if one is already running — otherwise it's a real failure.
      console.warn('[SARA Voice] start() threw', err);
      setVoiceErr(`Couldn’t start the mic: ${err.message}`);
    }
  }

  function toggleVoice() {
    if (!SpeechRecognition) return;
    if (listening) recognitionRef.current?.stop(); else startVoice();
  }

  function send(e) {
    e.preventDefault();
    return submit(input);
  }

  async function submit(raw) {
    const text = raw.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    dictatedRef.current = '';

    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);

    const body = { message: text, conversationId: convRef.current || undefined };
    // ⚠ Spread the last message rather than rebuilding it — rebuilding as
    // {role, content} drops the `tools` a tool turn has already attached, and the
    // tool events arrive BEFORE the text.
    const appendToLast = (chunk) =>
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = { ...last, role: 'assistant', content: last.content + chunk };
        return copy;
      });
    const addToolToLast = (name) =>
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = { ...last, tools: [...(last.tools || []), name] };
        return copy;
      });

    try {
      let got = false;
      await chatStream(body, {
        onMode: setMode,
        onChunk: (c) => { got = true; appendToLast(c); },
        onTool: (name) => { if (name) addToolToLast(name); },
        onError: (msg) => appendToLast(got ? '' : `⚠️ ${msg}`),
      });
    } catch {
      // Streaming unavailable — fall back to the sync endpoint.
      try {
        const res = await apiFetch('/api/chat/sync', { method: 'POST', body: JSON.stringify(body) });
        convRef.current = res.conversationId || convRef.current;
        setMode(res.mode || null);
        setMessages((m) => {
          const copy = m.slice();
          const tools = toolNamesFrom(res);
          copy[copy.length - 1] = {
            role: 'assistant',
            content: res.message || '(no reply)',
            ...(tools.length ? { tools } : {}),
          };
          return copy;
        });
      } catch (err) {
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: 'assistant', content: `⚠️ Couldn’t reach the brain: ${err.message}` };
          return copy;
        });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="chat">
      <div className="chat__head">
        <div>
          <h1 className="view__title">Chat</h1>
          <p className="view__lede">Talk to the brain.</p>
        </div>
        <div className="chat__head-right">
          {'speechSynthesis' in window && (
            <button
              type="button"
              className={`chat__voice-toggle ${voiceOut ? 'is-on' : ''}`}
              onClick={toggleVoiceOut}
              title={voiceOut ? 'Voice on' : 'Voice off'}
            >
              {voiceOut ? '🔊' : '🔇'}
            </button>
          )}
          <button
            type="button"
            className="chat__voice-pick"
            onClick={() => setShowVoices((v) => !v)}
            title="Choose SARA's voice"
          >
            {VOICE_CHOICES.find((v) => v.id === ttsVoice)?.label || 'Voice'} ▾
          </button>
          {mode && <span className={`chat__mode chat__mode--${mode}`}>{mode === 'api' ? 'cloud' : 'local'}</span>}
        </div>
      </div>

      {showVoices && (
        <div className="chat__voices">
          {VOICE_CHOICES.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`chat__voice-chip${v.id === ttsVoice ? ' is-on' : ''}`}
              onClick={() => chooseVoice(v.id)}
            >
              {v.label}
            </button>
          ))}
          <span className="chat__voices-hint">Tap to hear it</span>
        </div>
      )}

      <div className="chat__thread">
        {messages.length === 0 && (
          <div className="chat__empty">Ask anything — the brain has your vault, queue and calendar in context.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat__turn chat__turn--${m.role}`}>
            <div className={`chat__msg chat__msg--${m.role}`}>
              {m.content || (busy && i === messages.length - 1 ? <span className="chat__typing">…</span> : '')}
            </div>
            {m.role === 'assistant' && Array.isArray(m.tools) && m.tools.length > 0 && (
              <ul className="chat__tools" title="NEURO reports which tools ran, not whether each one worked.">
                {m.tools.map((t, j) => (
                  <li key={`${t}-${j}`} className="chat__tool">
                    <span className="chat__toolname">{toolLabel(t)}</span>
                    <span className="chat__toolstate">ran</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {(voiceErr || listening || speaking) && (
        <div className={`chat__voice-note${voiceErr ? ' chat__voice-note--err' : ''}`}>
          {voiceErr || (listening ? 'Listening… tap ⏺ to send.' : 'Speaking…')}
        </div>
      )}
      {!SpeechRecognition && (
        <div className="chat__voice-note chat__voice-note--err">
          {noMicReason()}
        </div>
      )}

      <audio
        ref={audioRef}
        playsInline
        onEnded={() => setSpeaking(false)}
        onError={() => setSpeaking(false)}
        style={{ display: 'none' }}
      />

      <form className="chat__composer" onSubmit={send}>
        {SpeechRecognition && (
          <button
            type="button"
            className={`chat__mic${listening ? ' chat__mic--on' : ''}`}
            onClick={toggleVoice}
            aria-label={listening ? 'Stop and send' : 'Dictate'}
            title={listening ? 'Stop and send' : 'Dictate'}
          >
            {listening ? '⏺' : '🎤'}
          </button>
        )}
        <input
          className="chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message SARA…"
          autoFocus
        />
        <button className="chat__send" type="submit" disabled={busy || !input.trim()}>↑</button>
      </form>
    </section>
  );
}
