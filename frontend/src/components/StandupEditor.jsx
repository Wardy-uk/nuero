import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './StandupEditor.css';

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

export default function StandupEditor() {
  const [content, setContent] = useState('');
  const [contentSet, setContentSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [showBackup, setShowBackup] = useState(false);

  const { data: standupData, status: standupStatus } = useCachedFetch('/api/standup');
  const { data: ritualData } = useCachedFetch('/api/standup/ritual-state');
  const loading = standupData === null && standupStatus !== 'unavailable';

  // Set content from fetched data once
  useEffect(() => {
    if (standupData && !contentSet) {
      setContent(standupData.content || '# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
      setContentSet(true);
    } else if (standupStatus === 'unavailable' && !contentSet) {
      setContent('# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
      setContentSet(true);
    }
  }, [standupData, standupStatus, contentSet]);

  // Auto-show backup button based on ritual state
  useEffect(() => {
    if (!ritualData) return;
    const now = new Date();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const isLate = now.getHours() >= 10;
    if (isWeekend || (isLate && !ritualData.standupDoneToday)) {
      setShowBackup(true);
    }
  }, [ritualData]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(apiUrl('/api/standup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      setMessage('Saved to vault');
      setTimeout(() => setMessage(''), 2000);
    } catch (e) {
      setMessage('Save failed');
    }
    setSaving(false);
  };

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
    } catch (e) {
      setMessage('Save failed');
    }
    setSaving(false);
  };

  if (loading) return <div className="standup-loading">Loading standup...</div>;

  return (
    <div className="standup-editor">
      {showBackup && (
        <BackupStandup onDone={() => setShowBackup(false)} />
      )}
      <div className="standup-header">
        <h2>Standup Draft</h2>
        <div className="standup-actions">
          {message && <span className="standup-message">{message}</span>}
          {!showBackup && (
            <button className="btn btn-secondary" onClick={() => setShowBackup(true)} style={{ marginRight: '8px' }}>
              Quick backup
            </button>
          )}
          <button className="btn btn-secondary" onClick={handleSave} disabled={saving}>
            Save to vault
          </button>
          <button className="btn btn-primary" onClick={handleSaveToDaily} disabled={saving}>
            Save to daily note
          </button>
        </div>
      </div>
      <textarea
        className="standup-textarea"
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
