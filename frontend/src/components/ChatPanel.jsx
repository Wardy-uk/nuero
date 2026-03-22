import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiUrl } from '../api';
import './ChatPanel.css';

const STORAGE_KEY = 'neuro_last_conversation_id';

// Detect if a message contains actionable language
function extractActionableItems(text) {
  const ACTION_PATTERNS = [
    /you should (.+?)(?:\.|$)/gi,
    /(?:follow up|follow-up) (?:with|on) (.+?)(?:\.|$)/gi,
    /(?:don't forget|remember) to (.+?)(?:\.|$)/gi,
    /(?:make sure|ensure) (?:you |to )?(.+?)(?:\.|$)/gi,
    /(?:book|schedule|arrange) (.+?)(?:\.|$)/gi,
    /(?:send|email|message|ping|contact) (.+?)(?:\.|$)/gi,
    /(?:action|task|todo)[:\s]+(.+?)(?:\.|$)/gi,
    /\[ADD TODO:\s*(.+?)\]/gi,
  ];

  const items = [];
  for (const pattern of ACTION_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const item = match[1].trim();
      if (item.length > 5 && item.length < 120) {
        items.push(item);
      }
    }
  }
  // Deduplicate
  return [...new Set(items)].slice(0, 3);
}

function TodoSaveButton({ messageContent, apiUrlFn }) {
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [showPicker, setShowPicker] = React.useState(false);
  const [items, setItems] = React.useState([]);

  React.useEffect(() => {
    const detected = extractActionableItems(messageContent);
    setItems(detected);
  }, [messageContent]);

  if (items.length === 0) return null;

  const saveTodo = async (text) => {
    setSaving(true);
    try {
      const res = await fetch(apiUrlFn('/api/capture/todo'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, priority: 'normal' })
      });
      if (res.ok) {
        setSaved(true);
        setShowPicker(false);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {}
    setSaving(false);
  };

  if (saved) {
    return <div className="chat-todo-saved">✓ Added to Master Todo</div>;
  }

  return (
    <div className="chat-todo-wrapper">
      {!showPicker ? (
        <button
          className="chat-todo-btn"
          onClick={() => setShowPicker(true)}
          title="Save action to Master Todo"
        >
          → Todo
        </button>
      ) : (
        <div className="chat-todo-picker">
          <div className="chat-todo-picker-label">Save to Master Todo:</div>
          {items.map((item, i) => (
            <button
              key={i}
              className="chat-todo-item-btn"
              onClick={() => saveTodo(item)}
              disabled={saving}
            >
              {saving ? '...' : item}
            </button>
          ))}
          <button className="chat-todo-cancel" onClick={() => setShowPicker(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export default function ChatPanel({ location }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) || `conv_${Date.now()}`;
  });
  const [conversations, setConversations] = useState([]);
  const [showConvList, setShowConvList] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [confirmation, setConfirmation] = React.useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);

  // Detect vault write markers in latest assistant message
  useEffect(() => {
    if (streaming || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'assistant') return;

    // [ADD TODO] — show confirmation
    const todoMatch = last.content.match(/\[ADD TODO:\s*(.+?)\]/);
    if (todoMatch) {
      // Already handled server-side — just show a toast
      setConfirmation({ type: 'todo', text: todoMatch[1].trim() });
      setTimeout(() => setConfirmation(null), 4000);
    }

    // [MEETING NOTE] — show confirmation
    const meetingMatch = last.content.match(/\[MEETING NOTE:\s*(.+?)\]/);
    if (meetingMatch) {
      setConfirmation({ type: 'meeting', text: meetingMatch[1].trim() });
      setTimeout(() => setConfirmation(null), 4000);
    }

    // [UPDATE PERSON] — show person update UI
    const personMatch = last.content.match(/\[UPDATE PERSON:\s*(.+?)\]/);
    if (personMatch) {
      setConfirmation({ type: 'person', text: personMatch[1].trim() });
      setTimeout(() => setConfirmation(null), 8000);
    }
  }, [messages, streaming]);

  // Persist conversationId
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, conversationId);
  }, [conversationId]);

  // Load last conversation on mount
  useEffect(() => {
    const savedId = localStorage.getItem(STORAGE_KEY);
    if (savedId) {
      loadConversation(savedId);
    }
  }, []);

  // Fetch recent conversations list
  const refreshConvList = () => {
    fetch(apiUrl('/api/chat/conversations'))
      .then(r => r.json())
      .then(data => setConversations(data.conversations || []))
      .catch(() => {});
  };

  useEffect(() => { refreshConvList(); }, []);

  const loadConversation = async (convId) => {
    setLoadingHistory(true);
    try {
      const res = await fetch(apiUrl(`/api/chat/history/${encodeURIComponent(convId)}`));
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        const msgs = [...data.messages].reverse().map(m => ({ role: m.role, content: m.content }));
        setMessages(msgs);
        setConversationId(convId);
      }
    } catch { /* ignore */ }
    setLoadingHistory(false);
    setShowConvList(false);
  };

  const startNew = () => {
    const newId = `conv_${Date.now()}`;
    setMessages([]);
    setConversationId(newId);
    setShowConvList(false);
    refreshConvList();
  };

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
        body: JSON.stringify({
          message: text,
          conversationId,
          location: location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy } : null
        })
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
    refreshConvList();
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
        <span className="chat-title" onClick={() => setShowConvList(!showConvList)} style={{ cursor: 'pointer' }}>
          NUERO {conversations.length > 0 && <span className="chat-conv-toggle">▾</span>}
        </span>
        <span className="chat-status">{streaming ? 'thinking...' : loadingHistory ? 'loading...' : 'ready'}</span>
        <button className="chat-new-btn" onClick={startNew}>New</button>
      </div>

      {showConvList && conversations.length > 0 && (
        <div className="chat-conv-list">
          {conversations.map(c => (
            <div
              key={c.conversation_id}
              className={`chat-conv-item ${c.conversation_id === conversationId ? 'active' : ''}`}
              onClick={() => loadConversation(c.conversation_id)}
            >
              <span className="chat-conv-preview">{c.preview || 'Empty'}</span>
              <span className="chat-conv-meta">{c.message_count} msgs</span>
            </div>
          ))}
        </div>
      )}

      <div className="chat-messages">
        {messages.length === 0 && !loadingHistory && (
          <div className="chat-empty">
            Ask me anything about your queue, team, or priorities.
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-bubble ${msg.role}`}>
            {msg.role === 'assistant' ? (
              <>
                <ReactMarkdown>{msg.content || '...'}</ReactMarkdown>
                {msg.content && msg.content.length > 20 && !streaming && (
                  <TodoSaveButton messageContent={msg.content} apiUrlFn={apiUrl} />
                )}
              </>
            ) : (
              <span>{msg.content}</span>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {confirmation && (
        <div className={`chat-vault-confirmation ${confirmation.type}`}>
          {confirmation.type === 'todo' && `✓ Added to Master Todo: "${confirmation.text}"`}
          {confirmation.type === 'meeting' && `✓ Meeting note saved: "${confirmation.text}"`}
          {confirmation.type === 'person' && (
            <>
              Person update for <strong>{confirmation.text}</strong> — open People tab to update
            </>
          )}
        </div>
      )}

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
