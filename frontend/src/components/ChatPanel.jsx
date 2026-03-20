import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiUrl } from '../api';
import './ChatPanel.css';

export default function ChatPanel() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState(() => `conv_${Date.now()}`);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setStreaming(true);

    // Add placeholder for assistant response
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    try {
      const response = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'text') {
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: last.content + data.content };
                }
                return updated;
              });
            } else if (data.type === 'error') {
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: `Error: ${data.content}` };
                return updated;
              });
            }
          } catch (e) { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: `Connection error: ${err.message}` };
        return updated;
      });
    }

    setStreaming(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <span className="chat-title">NUERO</span>
        <span className="chat-status">{streaming ? 'thinking...' : 'ready'}</span>
        {messages.length > 0 && !streaming && (
          <button className="chat-new-btn" onClick={() => { setMessages([]); setConversationId(`conv_${Date.now()}`); }}>
            New
          </button>
        )}
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask me anything about your queue, team, or priorities.
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-bubble ${msg.role}`}>
            {msg.role === 'assistant' ? (
              <ReactMarkdown>{msg.content || '...'}</ReactMarkdown>
            ) : (
              <span>{msg.content}</span>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message NUERO..."
          rows={1}
          disabled={streaming}
        />
        <button className="chat-send" onClick={sendMessage} disabled={streaming || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
