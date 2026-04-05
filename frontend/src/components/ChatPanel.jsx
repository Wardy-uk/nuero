import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiUrl, apiFetch } from '../api';
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

function detectPersonDraft(userMessage, assistantMessage) {
  if (!userMessage || !assistantMessage) return null;
  const TEAM_MEMBERS = [
    'Abdi', 'Arman', 'Luke', 'Stephen', 'Willem', 'Nathan',
    'Adele', 'Heidi', 'Hope', 'Maria', 'Naomi', 'Sebastian', 'Zoe',
    'Isabel', 'Kayleigh'
  ];
  const mentionedPerson = TEAM_MEMBERS.find(name =>
    userMessage.toLowerCase().includes(name.toLowerCase())
  );
  if (!mentionedPerson) return null;

  const isDraft = /draft|write|put together|performance|review|feedback|pip|summary/i.test(userMessage);
  if (!isDraft) return null;

  const DOC_TYPES = {
    'performance': 'performance-review',
    'pip': 'pip',
    'feedback': 'feedback',
    '1-2-1': '1-2-1-summary',
    'summary': '1-2-1-summary'
  };

  const docType = Object.keys(DOC_TYPES).find(k =>
    userMessage.toLowerCase().includes(k)
  );

  return { personName: mentionedPerson, docType: DOC_TYPES[docType] || 'general' };
}

function SaveDocButton({ userMessage, assistantContent }) {
  const draft = detectPersonDraft(userMessage, assistantContent);
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  if (!draft) return null;
  if (saved) return <span className="chat-export-result">Saved to vault</span>;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/vault/person-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personName: draft.personName,
          docType: draft.docType,
          content: assistantContent
        })
      });
      if ((await res.json()).ok) setSaved(true);
    } catch {}
    setSaving(false);
  };

  return (
    <button className="chat-export-btn" onClick={handleSave} disabled={saving}>
      {saving ? 'Saving...' : `Save to ${draft.personName}'s vault folder`}
    </button>
  );
}

function detectExportIntent(message) {
  const patterns = [
    /export (this|that) as (a |an )?(word |docx )?doc(ument)?/i,
    /save (this|that) as (a |an )?(word |docx )?doc(ument)?/i,
    /create (a |an )?(word |docx )?doc(ument)? (from|with) this/i,
    /turn this into (a |an )?(word |docx )?doc(ument)?/i,
    /(download|get) (this |that )?as (a |an )?(word |docx )?doc(ument)?/i
  ];
  return patterns.some(p => p.test(message));
}

function ExportButton({ content }) {
  const [exporting, setExporting] = React.useState(false);
  const [exported, setExported] = React.useState(null);

  const handleExport = async () => {
    setExporting(true);
    const firstLine = content.split('\n')[0]
      .replace(/^#+\s*/, '')
      .replace(/[^a-z0-9\s]/gi, '')
      .trim()
      .substring(0, 40) || 'neuro-export';

    try {
      const res = await apiFetch('/api/vault/export-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, filename: firstLine })
      });
      const data = await res.json();
      if (data.ok) setExported(data);
    } catch {}
    setExporting(false);
  };

  if (exported) {
    return (
      <div className="chat-export-result">
        Saved to vault: <code>{exported.path}</code>
        {exported.converted && ' (Word doc)'}
      </div>
    );
  }

  return (
    <button className="chat-export-btn" onClick={handleExport} disabled={exporting}>
      {exporting ? 'Exporting...' : 'Export as Document'}
    </button>
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
        const msgs = data.messages.map(m => ({ role: m.role, content: m.content }));
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
      // Use non-streaming sync endpoint (Tailscale Funnel buffers SSE)
      const response = await fetch(apiUrl('/api/chat/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationId,
          location: location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy } : null
        })
      });

      const data = await response.json();
      if (data.message) {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: data.message };
          return updated;
        });
        if (data.conversationId) setConversationId(data.conversationId);
      } else if (data.error) {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: `Error: ${data.error}` };
          return updated;
        });
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
        {messages.map((msg, i) => {
          const prevMsg = i > 0 ? messages[i - 1] : null;
          const showExport = msg.role === 'assistant' && msg.content && msg.content.length > 200
            && !streaming && prevMsg?.role === 'user' && detectExportIntent(prevMsg.content);
          return (
            <div key={i} className={`chat-bubble ${msg.role}`}>
              {msg.role === 'assistant' ? (
                <>
                  <ReactMarkdown>{msg.content || '...'}</ReactMarkdown>
                  {msg.content && msg.content.length > 20 && !streaming && (
                    <TodoSaveButton messageContent={msg.content} apiUrlFn={apiUrl} />
                  )}
                  {showExport && <ExportButton content={msg.content} />}
                  {msg.role === 'assistant' && !streaming && prevMsg?.role === 'user' && (
                    <SaveDocButton userMessage={prevMsg.content} assistantContent={msg.content} />
                  )}
                </>
              ) : (
                <span>{msg.content}</span>
              )}
            </div>
          );
        })}
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
