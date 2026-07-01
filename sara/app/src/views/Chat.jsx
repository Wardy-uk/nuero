import { useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../api';
import './Chat.css';

// Chat = talk to the brain, with real vault reasoning behind it.
// Streams over POST /api/chat (SSE). If streaming fails, falls back to POST /api/chat/sync.
export default function Chat() {
  const [messages, setMessages] = useState([]); // { role, content }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // 'api' | 'local'
  const convRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);

    const body = { message: text, conversationId: convRef.current || undefined };
    const appendToLast = (chunk) =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { role: 'assistant', content: copy[copy.length - 1].content + chunk };
        return copy;
      });

    try {
      let got = false;
      await chatStream(body, {
        onMode: setMode,
        onChunk: (c) => { got = true; appendToLast(c); },
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
          copy[copy.length - 1] = { role: 'assistant', content: res.message || '(no reply)' };
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
        {mode && <span className={`chat__mode chat__mode--${mode}`}>{mode === 'api' ? 'cloud' : 'local'}</span>}
      </div>

      <div className="chat__thread">
        {messages.length === 0 && (
          <div className="chat__empty">Ask anything — the brain has your vault, queue and calendar in context.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat__msg chat__msg--${m.role}`}>
            {m.content || (busy && i === messages.length - 1 ? <span className="chat__typing">…</span> : '')}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="chat__composer" onSubmit={send}>
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
