import { useState } from 'react';
import { useSaraState } from '../../state/saraState';
import './CompanionView.css';

// Companion v1 — bounded conversation bridge.
//
// This is still not the final voice-first SARA surface, but it now closes the dead-shell
// gap honestly: the screen reads the shared state model for context, and sends text
// prompts through the backend's NEURO chat bridge. Conversation state lives in the shared
// frontend provider rather than being invented per screen.

export default function CompanionView() {
  const { status, error, model, chatMessages, chatStatus, chatError, sendChat } = useSaraState();
  const [draft, setDraft] = useState('');

  if (status === 'connecting') {
    return (
      <section className="companion companion--message">
        <p className="companion__waking">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="companion companion--message">
        <p className="companion__offline">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  return (
    <section className="companion" aria-label="SARA">
      <header className="companion__header">
        <span className="companion__mark">SARA</span>
        <span className="companion__status" data-state={model.sara?.status}>
          {model.sara?.status}
        </span>
        <span className="companion__shell-tag">SARA</span>
      </header>

      <div className="companion__thread" aria-label="Conversation">
        {chatMessages.map((message) => (
          <div
            key={message.id}
            className={`companion__msg ${message.role === 'user' ? 'companion__msg--user' : 'companion__msg--sara'}`}
          >
            <span className="companion__msg-who">{message.role === 'user' ? 'Nick' : 'SARA'}</span>
            <p className={`companion__msg-text ${message.error ? 'companion__msg-text--error' : ''}`}>
              {message.text || (message.pending ? 'Thinking…' : '')}
            </p>
          </div>
        ))}
      </div>

      <form
        className="companion__composer"
        aria-label="Message SARA"
        onSubmit={async (e) => {
          e.preventDefault();
          const sent = await sendChat(draft);
          if (sent) setDraft('');
        }}
      >
        <input
          type="text"
          className="companion__input"
          placeholder="Ask SARA what matters, what's slipping, or what to do next…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="companion__send" disabled={!draft.trim() || chatStatus === 'sending' || chatStatus === 'streaming'}>
          {chatStatus === 'sending' || chatStatus === 'streaming' ? 'Sending…' : 'Send'}
        </button>
      </form>
      {chatError && (
        <p className={`companion__note ${chatStatus === 'unavailable' || chatStatus === 'error' ? 'companion__note--warn' : ''}`}>
          {chatStatus === 'unavailable'
            ? `NEURO chat is unavailable: ${chatError}`
            : chatStatus === 'error'
              ? `Chat failed: ${chatError}`
              : chatError}
        </p>
      )}
      <p className="companion__note">
        Companion now reuses the existing NEURO chat path when configured. If that upstream
        is missing, SARA says so plainly instead of faking a reply.
      </p>
    </section>
  );
}
