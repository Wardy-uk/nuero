import React, { useState } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './DoNextPanel.css';

const SOURCE_LABELS = {
  standup: 'Standup',
  chat: 'Chat',
  manual: 'Manual',
  vault: 'Vault',
};

const SOURCE_CLASS = {
  standup: 'dn-src-standup',
  chat: 'dn-src-chat',
  manual: 'dn-src-manual',
  vault: 'dn-src-vault',
};

function formatDue(dueDate) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  const today = new Date(new Date().toDateString());
  const diff = Math.floor((d - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function isOverdue(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}
export default function DoNextPanel({ onNavigate, compact = false }) {
  const { data, refresh } = useCachedFetch('/api/do-next', { interval: 30000 });
  const tasks = data?.tasks || [];
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [completing, setCompleting] = useState({});

  const complete = async (id) => {
    setCompleting(p => ({ ...p, [id]: true }));
    try {
      await fetch(apiUrl(`/api/do-next/${id}/complete`), { method: 'PATCH' });
      await refresh();
    } catch {}
    setCompleting(p => ({ ...p, [id]: false }));
  };

  const remove = async (id) => {
    try {
      await fetch(apiUrl(`/api/do-next/${id}`), { method: 'DELETE' });
      await refresh();
    } catch {}
  };

  const addTask = async () => {
    if (!newText.trim()) return;
    try {
      await fetch(apiUrl('/api/do-next'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newText.trim(), source: 'manual' })
      });
      setNewText('');
      setAdding(false);
      await refresh();
    } catch {}
  };

  const overdue = tasks.filter(t => isOverdue(t.due_date));
  const shown = compact ? tasks.slice(0, 5) : tasks;

  return (
    <div className={`dn-panel ${compact ? 'dn-compact' : ''}`}>
      <div className="dn-header">
        <span className="dn-title">
          Do Next
          {overdue.length > 0 && <span className="dn-badge-warn">{overdue.length} overdue</span>}
        </span>
        <div className="dn-header-actions">
          <button className="dn-add-btn" onClick={() => setAdding(a => !a)} title="Add task">+</button>
          {!compact && <button className="review-link" onClick={refresh}>Refresh</button>}
        </div>
      </div>

      {adding && (
        <div className="dn-add-row">
          <input
            className="dn-add-input"
            type="text"
            placeholder="What needs doing next?"
            value={newText}
            onChange={e => setNewText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addTask(); if (e.key === 'Escape') { setAdding(false); setNewText(''); } }}
            autoFocus
          />
          <button className="dn-add-confirm" onClick={addTask}>Add</button>
        </div>
      )}

      {tasks.length === 0 && !adding && (
        <div className="dn-empty">No tasks queued. Add one or run standup.</div>
      )}

      {shown.map(t => {
        const overdue = isOverdue(t.due_date);
        const dueLabel = formatDue(t.due_date);
        return (
          <div key={t.id} className={`dn-item ${overdue ? 'dn-overdue' : ''} dn-pri-${t.priority}`}>
            <button
              className={`dn-check ${completing[t.id] ? 'dn-checking' : ''}`}
              onClick={() => complete(t.id)}
              disabled={completing[t.id]}
              title="Mark done"
            />
            <div className="dn-text-col">
              <span className="dn-text">{t.text}</span>
              <div className="dn-meta">
                <span className={`dn-source ${SOURCE_CLASS[t.source] || 'dn-src-manual'}`}>
                  {SOURCE_LABELS[t.source] || t.source}
                </span>
                {dueLabel && <span className={`dn-due ${overdue ? 'dn-due-overdue' : ''}`}>{dueLabel}</span>}
              </div>
            </div>
            <button className="dn-remove" onClick={() => remove(t.id)} title="Remove">&#x2715;</button>
          </div>
        );
      })}

      {compact && tasks.length > 5 && (
        <button className="review-link dn-more" onClick={() => onNavigate?.('todos')}>
          +{tasks.length - 5} more
        </button>
      )}
    </div>
  );
}
