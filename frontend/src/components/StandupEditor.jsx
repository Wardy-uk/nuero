import React, { useState, useEffect } from 'react';
import './StandupEditor.css';

export default function StandupEditor() {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetch('/api/standup')
      .then(res => res.json())
      .then(data => {
        setContent(data.content || '# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
        setLoading(false);
      })
      .catch(() => {
        setContent('# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch('/api/standup', {
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
      await fetch('/api/standup/save-to-daily', {
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
      <div className="standup-header">
        <h2>Standup Draft</h2>
        <div className="standup-actions">
          {message && <span className="standup-message">{message}</span>}
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
