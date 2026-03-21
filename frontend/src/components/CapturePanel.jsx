import React, { useState, useRef, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './CapturePanel.css';

const MODES = ['Note', 'Todo', 'Photo', 'File'];
const MAX_SIZE = 10 * 1024 * 1024;

const QUEUE_KEY = 'neuro_offline_queue';

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function addToQueue(item) {
  const q = getQueue();
  q.push({ ...item, queuedAt: Date.now() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

function clearQueue() {
  localStorage.removeItem(QUEUE_KEY);
}

async function drainQueue(onDrained) {
  const q = getQueue();
  if (q.length === 0) return;
  const remaining = [];
  for (const item of q) {
    try {
      const res = await fetch(item.url, {
        method: 'POST',
        headers: item.headers || { 'Content-Type': 'application/json' },
        body: item.body
      });
      if (!res.ok) remaining.push(item);
    } catch {
      remaining.push(item); // still offline
    }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  if (remaining.length < q.length && onDrained) onDrained(q.length - remaining.length);
}

export default function CapturePanel() {
  const [mode, setMode] = useState('Note');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [todoText, setTodoText] = useState('');
  const [todoPriority, setTodoPriority] = useState('normal');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);
  const [showRecent, setShowRecent] = useState(false);
  const [spellcheck, setSpellcheck] = useState(true);
  const [queueCount, setQueueCount] = useState(getQueue().length);
  const fileRef = useRef(null);

  const resetForm = () => {
    setTitle('');
    setContent('');
    setFile(null);
    setPreview(null);
    setTodoText('');
    setTodoPriority('normal');
    setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const fetchRecent = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/capture/recent'));
      const data = await res.json();
      setRecent(data.items || []);
    } catch {}
  }, []);

  useEffect(() => { fetchRecent(); }, [fetchRecent]);

  useEffect(() => {
    const drain = () => drainQueue((count) => {
      setQueueCount(getQueue().length);
      if (count > 0) fetchRecent();
    });

    drain(); // drain on mount

    const onVisible = () => { if (!document.hidden) drain(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchRecent]);

  const handleFileSelect = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MAX_SIZE) {
      setResult({ error: 'File too large — 10MB maximum' });
      return;
    }
    setFile(f);
    setResult(null);
    if (f.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => setPreview(ev.target.result);
      reader.readAsDataURL(f);
    } else {
      setPreview(null);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setResult(null);

    try {
      let res;
      if (mode === 'Note') {
        res = await fetch(apiUrl('/api/capture/note'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim() || null, content })
        });
      } else if (mode === 'Todo') {
        res = await fetch(apiUrl('/api/capture/todo'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: todoText.trim(), priority: todoPriority })
        });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        const endpoint = mode === 'Photo' ? '/api/capture/photo' : '/api/capture/file';
        res = await fetch(apiUrl(endpoint), {
          method: 'POST',
          body: formData
        });
      }

      const data = await res.json();
      if (!res.ok) {
        setResult({ error: data.error || 'Upload failed' });
      } else {
        setResult({ success: true, filename: data.filename || data.text });
        fetchRecent();
        setTimeout(resetForm, 2000);
      }
    } catch (err) {
      // Network error — queue for later if text-based
      if (mode === 'Note' && content.trim()) {
        addToQueue({
          url: apiUrl('/api/capture/note'),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim() || null, content })
        });
        setQueueCount(getQueue().length);
        setResult({ success: true, queued: true });
        setTimeout(resetForm, 2000);
      } else if (mode === 'Todo' && todoText.trim()) {
        addToQueue({
          url: apiUrl('/api/capture/todo'),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: todoText.trim(), priority: todoPriority })
        });
        setQueueCount(getQueue().length);
        setResult({ success: true, queued: true });
        setTimeout(resetForm, 2000);
      } else {
        setResult({ error: 'Offline — files cannot be queued' });
      }
    }

    setSubmitting(false);
  };

  const canSubmit = mode === 'Note'
    ? content.trim().length > 0
    : mode === 'Todo'
      ? todoText.trim().length > 0
      : !!file;

  return (
    <div className="capture-panel">
      <h2 className="capture-title">Capture</h2>

      <div className="capture-modes">
        {MODES.map(m => (
          <button
            key={m}
            className={`capture-mode-btn ${mode === m ? 'active' : ''}`}
            onClick={() => { setMode(m); resetForm(); }}
          >
            {m}
          </button>
        ))}
      </div>

      {result && (
        <div className={`capture-result ${result.error ? 'error' : 'success'}`}>
          {result.error || (result.queued ? `Queued — will sync when online ⏳` : `Captured ✓`)}
        </div>
      )}

      {mode === 'Note' && (
        <div className="capture-form">
          <input
            className="capture-input"
            type="text"
            placeholder="Title (optional)"
            value={title}
            onChange={e => setTitle(e.target.value)}
            inputMode="text"
          />
          <textarea
            className="capture-textarea"
            placeholder="What's on your mind?"
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={6}
            autoFocus
            inputMode="text"
            autoComplete="off"
            autoCorrect={spellcheck ? 'on' : 'off'}
            spellCheck={spellcheck}
          />
          <p className="capture-pencil-hint">✎ Apple Pencil: write directly in the box above</p>
          <div className="capture-spellcheck-row">
            <label className="capture-spellcheck-label">
              <input
                type="checkbox"
                checked={spellcheck}
                onChange={e => setSpellcheck(e.target.checked)}
              />
              Spellcheck
            </label>
          </div>
        </div>
      )}

      {mode === 'Todo' && (
        <div className="capture-form">
          <input
            className="capture-input"
            type="text"
            placeholder="What needs doing?"
            value={todoText}
            onChange={e => setTodoText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && canSubmit && !submitting && submit()}
            inputMode="text"
            autoFocus
          />
          <div className="capture-priority-row">
            {['low', 'normal', 'high'].map(p => (
              <button
                key={p}
                className={`capture-priority-btn ${todoPriority === p ? 'active priority-' + p : ''}`}
                onClick={() => setTodoPriority(p)}
                type="button"
              >
                {p === 'high' ? '🔴 High' : p === 'low' ? '🟢 Low' : '⚪ Normal'}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'Photo' && (
        <div className="capture-form">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="capture-file-input"
          />
          {preview && (
            <div className="capture-preview">
              <img src={preview} alt="Preview" className="capture-preview-img" />
            </div>
          )}
        </div>
      )}

      {mode === 'File' && (
        <div className="capture-form">
          <input
            ref={fileRef}
            type="file"
            onChange={handleFileSelect}
            className="capture-file-input"
          />
          {file && (
            <div className="capture-file-info">
              <span className="capture-file-name">{file.name}</span>
              <span className="capture-file-size">{(file.size / 1024).toFixed(1)} KB</span>
            </div>
          )}
        </div>
      )}

      <button
        className="capture-submit"
        onClick={submit}
        disabled={!canSubmit || submitting}
      >
        {submitting ? 'Saving...' : 'Capture'}
      </button>

      {queueCount > 0 && (
        <div className="capture-queue-notice">
          {queueCount} item{queueCount !== 1 ? 's' : ''} queued — will sync when online
        </div>
      )}

      {recent.length > 0 && (
        <div className="capture-recent">
          <button
            className="capture-recent-toggle"
            onClick={() => setShowRecent(o => !o)}
          >
            {showRecent ? '▾' : '▸'} Recent ({recent.length})
          </button>
          {showRecent && (
            <div className="capture-recent-list">
              {recent.map((item, i) => (
                <div key={i} className="capture-recent-item">
                  <span className="capture-recent-name">
                    {item.title || item.filename.replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-/, '').replace('.md', '')}
                  </span>
                  {item.preview && (
                    <span className="capture-recent-preview">{item.preview}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
