import React, { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import ReactMarkdown from 'react-markdown';
import './StandupEditor.css';

function EodCapture({ onDone }) {
  const [win, setWin] = React.useState('');
  const [didntGo, setDidntGo] = React.useState('');
  const [feeling, setFeeling] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const handleSave = async () => {
    if (!win.trim() && !didntGo.trim() && !feeling.trim()) { setMessage('Fill in at least one field'); return; }
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/standup/eod'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ win: win.trim() || null, didntGo: didntGo.trim() || null, feeling: feeling.trim() || null })
      });
      if (res.ok) { setMessage('Saved to daily note ✓'); setTimeout(() => { if (onDone) onDone(); }, 1500); }
      else setMessage('Save failed');
    } catch { setMessage('Save failed'); }
    setSaving(false);
  };
  return (
    <div className="backup-standup">
      <h3>End of Day — Quick</h3>
      <p style={{ color: '#888', fontSize: '13px', margin: '0 0 16px' }}>2 minutes. Then close the laptop.</p>
      <input className="backup-input" type="text" placeholder="One win today..." value={win} onChange={e => setWin(e.target.value)} inputMode="text" autoFocus />
      <input className="backup-input" type="text" placeholder="One thing that didn't go to plan..." value={didntGo} onChange={e => setDidntGo(e.target.value)} inputMode="text" />
      <input className="backup-input" type="text" placeholder="How are you feeling?" value={feeling} onChange={e => setFeeling(e.target.value)} inputMode="text" />
      <div className="standup-actions" style={{ marginTop: '12px' }}>
        {message && <span className="standup-message">{message}</span>}
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save EOD'}</button>
      </div>
    </div>
  );
}

function GuidedEod({ onDone }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState('start');
  const [noteSaved, setNoteSaved] = useState(false);
  const [started, setStarted] = useState(false);
  const [guidedError, setGuidedError] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendToNeuro = useCallback(async (userMessage, isStart = false) => {
    const newMessages = isStart ? [] : [...messages, { role: 'user', content: userMessage }];
    if (!isStart) setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    setStreaming(true);
    setInput('');

    try {
      const res = await fetch(apiUrl('/api/standup/eod/interactive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, phase: isStart ? 'start' : phase })
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let hadError = false;

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
              fullText += data.content;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: fullText };
                return updated;
              });
            } else if (data.type === 'done') {
              if (data.noteSaved) { setNoteSaved(true); setPhase('done'); }
            } else if (data.type === 'error') {
              hadError = true;
              if (isStart) setGuidedError(true);
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: `Error: ${data.content}` };
                return updated;
              });
            }
          } catch {}
        }
      }

      if (isStart && (hadError || !fullText)) setGuidedError(true);
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: fullText };
        return updated;
      });
      setPhase(prev => prev === 'start' ? 'answering' : prev);
    } catch (err) {
      if (isStart) setGuidedError(true);
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: `Connection error: ${err.message}` };
        return updated;
      });
    }
    setStreaming(false);
    inputRef.current?.focus();
  }, [messages, phase]);

  useEffect(() => {
    if (!started) { setStarted(true); sendToNeuro('', true); }
  }, [started, sendToNeuro]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming || phase === 'done') return;
    sendToNeuro(text, false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const cleanContent = (content) => {
    return content.replace(/===EOD_NOTE_START===[\s\S]*?===EOD_NOTE_END===/g, '').trim();
  };

  if (guidedError) {
    return (
      <div className="standup-done-banner" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
        <span>Guided EOD unavailable — falling back to quick mode.</span>
        <button className="btn btn-secondary" onClick={onDone}>Switch to Quick</button>
      </div>
    );
  }

  if (noteSaved) {
    return (
      <div className="guided-done">
        <div className="guided-done-icon">✓</div>
        <div className="guided-done-title">EOD written</div>
        <div className="guided-done-sub">Have a good evening.</div>
        {onDone && <button className="btn btn-secondary" style={{ marginTop: '16px' }} onClick={onDone}>Close</button>}
      </div>
    );
  }

  return (
    <div className="guided-standup">
      <div className="guided-messages">
        {messages.length === 0 && <div className="guided-loading">Starting your EOD...</div>}
        {messages.map((msg, i) => {
          const content = msg.role === 'assistant' ? cleanContent(msg.content) : msg.content;
          if (!content && msg.role === 'assistant' && i === messages.length - 1 && streaming) {
            return <div key={i} className="guided-bubble assistant"><span className="guided-thinking">thinking...</span></div>;
          }
          if (!content) return null;
          return (
            <div key={i} className={`guided-bubble ${msg.role}`}>
              {msg.role === 'assistant' ? <ReactMarkdown>{content}</ReactMarkdown> : <span>{content}</span>}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {phase !== 'done' && (
        <div className="guided-input-row">
          <textarea ref={inputRef} className="guided-input" value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown} placeholder={streaming ? '' : 'Your answer...'} rows={2}
            disabled={streaming} autoFocus spellCheck={true} autoCorrect="on" />
          <button className="guided-send" onClick={handleSend} disabled={streaming || !input.trim()}>→</button>
        </div>
      )}
    </div>
  );
}

function BackupStandup({ onDone }) {
  const [items, setItems] = useState(['', '', '']);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const updateItem = (idx, val) => {
    const next = [...items];
    next[idx] = val;
    setItems(next);
  };

  const handleSave = async () => {
    const focusItems = items.filter(i => i.trim());
    if (focusItems.length === 0) {
      setMessage('Add at least one focus item');
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/standup/backup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focusItems })
      });
      if (res.ok) {
        setMessage('Backup standup saved to daily note');
        if (onDone) onDone();
      } else {
        const data = await res.json();
        setMessage(data.error || 'Save failed');
      }
    } catch (e) {
      setMessage('Save failed');
    }
    setSaving(false);
    setTimeout(() => setMessage(''), 3000);
  };

  return (
    <div className="backup-standup">
      <h3>Quick Standup (max 3 items)</h3>
      <p style={{ color: '#888', fontSize: '13px', margin: '0 0 16px' }}>
        Lightweight backup — what matters today?
      </p>
      {items.map((item, i) => (
        <input
          key={i}
          type="text"
          className="backup-input"
          placeholder={`Focus item ${i + 1}${i === 0 ? ' (required)' : ' (optional)'}`}
          value={item}
          onChange={e => updateItem(i, e.target.value)}
        />
      ))}
      <div className="standup-actions" style={{ marginTop: '12px' }}>
        {message && <span className="standup-message">{message}</span>}
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save backup standup'}
        </button>
      </div>
    </div>
  );
}

// ── Guided standup ────────────────────────────────────────────────────────

function GuidedStandup({ onDone }) {
  const [messages, setMessages] = useState([]); // { role: 'user'|'assistant', content: string }
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState('start');
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState(null);
  const [started, setStarted] = useState(false);
  const [guidedError, setGuidedError] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendToNeuro = useCallback(async (userMessage, isStart = false) => {
    const newMessages = isStart
      ? []
      : [...messages, { role: 'user', content: userMessage }];

    if (!isStart) {
      setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    }

    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    setStreaming(true);
    setInput('');

    try {
      const res = await fetch(apiUrl('/api/standup/interactive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          phase: isStart ? 'start' : phase
        })
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let hadError = false;

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
              fullText += data.content;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: fullText };
                return updated;
              });
            } else if (data.type === 'done') {
              if (data.noteSaved) {
                setNoteSaved(true);
                setPhase('done');
              }
            } else if (data.type === 'error') {
              hadError = true;
              if (isStart) {
                setGuidedError(true);
              }
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: `Error: ${data.content}` };
                return updated;
              });
            }
          } catch {}
        }
      }

      // If first message errored, flag guided mode as unavailable
      if (isStart && (hadError || !fullText)) {
        setGuidedError(true);
      }

      // Update messages with the full assistant response for next round
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: fullText };
        return updated;
      });

      setPhase(prev => {
        if (prev === 'start') return 'answering';
        return prev;
      });

    } catch (err) {
      if (isStart) setGuidedError(true);
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: `Connection error: ${err.message}` };
        return updated;
      });
    }

    setStreaming(false);
    inputRef.current?.focus();
  }, [messages, phase]);

  // Auto-start on mount
  useEffect(() => {
    if (!started) {
      setStarted(true);
      sendToNeuro('', true);
    }
  }, [started, sendToNeuro]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming || phase === 'done') return;
    sendToNeuro(text, false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Filter out the daily note markers from display
  const cleanContent = (content) => {
    return content
      .replace(/===DAILY_NOTE_START===[\s\S]*?===DAILY_NOTE_END===/g, '')
      .trim();
  };

  if (guidedError) {
    return (
      <div className="standup-done-banner" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
        <span>Guided mode unavailable — Claude API may be down.</span>
        <button className="btn btn-secondary" onClick={onDone}>Switch to Manual</button>
      </div>
    );
  }

  if (noteSaved) {
    return (
      <div className="guided-done">
        <div className="guided-done-icon">✓</div>
        <div className="guided-done-title">Daily note written</div>
        <div className="guided-done-sub">Standup complete. Have a good one.</div>
        {onDone && (
          <button className="btn btn-secondary" style={{ marginTop: '16px' }} onClick={onDone}>
            Close
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="guided-standup">
      <div className="guided-messages">
        {messages.length === 0 && (
          <div className="guided-loading">Starting your standup...</div>
        )}
        {messages.map((msg, i) => {
          const content = msg.role === 'assistant' ? cleanContent(msg.content) : msg.content;
          if (!content && msg.role === 'assistant' && i === messages.length - 1 && streaming) {
            return (
              <div key={i} className="guided-bubble assistant">
                <span className="guided-thinking">thinking...</span>
              </div>
            );
          }
          if (!content) return null;
          return (
            <div key={i} className={`guided-bubble ${msg.role}`}>
              {msg.role === 'assistant'
                ? <ReactMarkdown>{content}</ReactMarkdown>
                : <span>{content}</span>
              }
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {phase !== 'done' && (
        <div className="guided-input-row">
          <textarea
            ref={inputRef}
            className="guided-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={streaming ? '' : 'Your answer...'}
            rows={2}
            disabled={streaming}
            autoFocus
            spellCheck={true}
            autoCorrect="on"
          />
          <button
            className="guided-send"
            onClick={handleSend}
            disabled={streaming || !input.trim()}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main StandupEditor ────────────────────────────────────────────────────

function TodayStandup() {
  const [content, setContent] = React.useState(null);

  React.useEffect(() => {
    fetch(apiUrl('/api/obsidian/daily'))
      .then(r => r.json())
      .then(data => {
        if (!data.content) return;
        // Extract standup and focus sections from daily note
        const lines = data.content.split('\n');
        const sections = [];
        let capture = false;
        let current = [];

        for (const line of lines) {
          if (/^## (Standup|Focus Today|Carry)/i.test(line)) {
            if (current.length > 0) sections.push(current.join('\n'));
            current = [line];
            capture = true;
          } else if (/^## /.test(line) && capture) {
            if (current.length > 0) sections.push(current.join('\n'));
            current = [];
            capture = false;
          } else if (capture) {
            current.push(line);
          }
        }
        if (current.length > 0) sections.push(current.join('\n'));

        if (sections.length > 0) {
          setContent(sections.join('\n\n'));
        }
      })
      .catch(() => {});
  }, []);

  if (!content) return null;

  return (
    <div className="today-standup">
      <div className="today-standup-label">Today's standup</div>
      <div className="today-standup-content">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

export default function StandupEditor() {
  const [mode, setMode] = useState('guided'); // 'guided' | 'manual'
  const [content, setContent] = useState('');
  const [contentSet, setContentSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [showEod, setShowEod] = useState(false);
  const [eodMode, setEodMode] = useState('guided'); // 'guided' | 'quick'
  const [guidedDone, setGuidedDone] = useState(false);

  const { data: standupData, status: standupStatus } = useCachedFetch('/api/standup');
  const { data: ritualData } = useCachedFetch('/api/standup/ritual-state');

  // Check if standup already done today
  const standupDone = ritualData?.standupDoneToday || guidedDone;

  useEffect(() => {
    if (standupData && !contentSet) {
      setContent(standupData.content || '# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
      setContentSet(true);
    } else if (standupStatus === 'unavailable' && !contentSet) {
      setContent('# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
      setContentSet(true);
    }
  }, [standupData, standupStatus, contentSet]);

  // Auto-show EOD after 5pm
  useEffect(() => {
    const now = new Date();
    if (now.getDay() >= 1 && now.getDay() <= 5 && now.getHours() >= 17) setShowEod(true);
  }, []);

  const handleSaveToDaily = async () => {
    setSaving(true);
    try {
      await fetch(apiUrl('/api/standup/save-to-daily'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      setMessage('Saved to daily note');
      setTimeout(() => setMessage(''), 2000);
    } catch {
      setMessage('Save failed');
    }
    setSaving(false);
  };

  return (
    <div className="standup-editor">

      {/* EOD section */}
      {showEod && (
        <div style={{ marginBottom: '16px' }}>
          <div className="standup-mode-toggle" style={{ marginBottom: '12px' }}>
            <button className={`mode-btn ${eodMode === 'guided' ? 'active' : ''}`} onClick={() => setEodMode('guided')}>Guided</button>
            <button className={`mode-btn ${eodMode === 'quick' ? 'active' : ''}`} onClick={() => setEodMode('quick')}>Quick</button>
          </div>
          {eodMode === 'guided'
            ? <GuidedEod onDone={() => { setShowEod(false); setEodMode('quick'); }} />
            : <EodCapture onDone={() => setShowEod(false)} />
          }
        </div>
      )}

      {/* Mode toggle + EOD button */}
      <div className="standup-header">
        <div className="standup-mode-toggle">
          <button
            className={`mode-btn ${mode === 'guided' ? 'active' : ''}`}
            onClick={() => setMode('guided')}
          >
            Guided
          </button>
          <button
            className={`mode-btn ${mode === 'manual' ? 'active' : ''}`}
            onClick={() => setMode('manual')}
          >
            Manual
          </button>
        </div>
        <div className="standup-header-actions">
          {message && <span className="standup-message">{message}</span>}
          {!showEod && (
            <button className="btn btn-secondary" onClick={() => setShowEod(true)}>
              EOD
            </button>
          )}
        </div>
      </div>

      {/* Already done banner */}
      {standupDone && mode === 'guided' && !guidedDone && (
        <div className="standup-done-banner">
          ✓ Standup already done today.
          <button className="standup-redo-btn" onClick={() => setGuidedDone(false)}>
            Redo
          </button>
        </div>
      )}

      {/* Guided mode */}
      {mode === 'guided' && !standupDone && (
        <GuidedStandup onDone={() => { setGuidedDone(true); setMode('manual'); }} />
      )}

      {/* Guided done */}
      {mode === 'guided' && (standupDone || guidedDone) && !showEod && (
        <div className="guided-done">
          <div className="guided-done-icon">✓</div>
          <div className="guided-done-title">Standup complete</div>
          <div className="guided-done-sub">Daily note written to vault.</div>
        </div>
      )}

      {/* Today's standup content — shown when standup is done */}
      {standupDone && <TodayStandup />}

      {/* Manual mode */}
      {mode === 'manual' && (
        <>
          <textarea
            className="standup-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
          />
          <div className="standup-actions" style={{ marginTop: '8px' }}>
            <button className="btn btn-primary" onClick={handleSaveToDaily} disabled={saving}>
              {saving ? 'Saving...' : 'Save to daily note'}
            </button>
          </div>
        </>
      )}

    </div>
  );
}
