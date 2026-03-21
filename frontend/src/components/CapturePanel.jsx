import React, { useState, useRef, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './CapturePanel.css';

const MODES = ['Note', 'Todo', 'Photo', 'File'];
const MAX_SIZE = 10 * 1024 * 1024;

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
      setResult({ error: err.message });
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
          {result.error || `Captured \u2713`}
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
            autoCorrect="off"
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
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="capture-pencil-hint">✎ Apple Pencil: write directly in the box above</p>
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
            autoCorrect="off"
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
