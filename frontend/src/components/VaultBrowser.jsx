import React, { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiUrl, apiFetch } from '../api';
import './VaultBrowser.css';

function RelatedNotes({ notePath, onNavigate }) {
  const [related, setRelated] = React.useState([]);

  React.useEffect(() => {
    if (!notePath) return;
    apiFetch(`/api/vault/related?path=${encodeURIComponent(notePath)}&limit=3`)
      .then(r => r.json())
      .then(d => setRelated(d.related || []))
      .catch(() => {});
  }, [notePath]);

  if (related.length === 0) return null;

  return (
    <div className="vault-related">
      <div className="vault-related-label">Related</div>
      {related.map(r => (
        <button
          key={r.path}
          className="vault-related-item"
          onClick={() => onNavigate && onNavigate(r.path)}
        >
          <span className="vault-related-name">{r.name}</span>
          {r.excerpts?.[0] && (
            <span className="vault-related-excerpt">
              {r.excerpts[0].substring(0, 80)}...
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function BacklinksPanel({ notePath }) {
  const [data, setData] = React.useState(null);

  React.useEffect(() => {
    if (!notePath) return;
    apiFetch(`/api/vault/backlinks?path=${encodeURIComponent(notePath)}`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {});
  }, [notePath]);

  if (!data) return null;
  const { backlinks = [], entities = [] } = data;
  if (backlinks.length === 0 && entities.length === 0) return null;

  const people = entities.filter(e => e.entity_type === 'person');
  const tasks = entities.filter(e => e.entity_type === 'task');
  const decisions = entities.filter(e => e.entity_type === 'decision');

  return (
    <div className="vault-related">
      {people.length > 0 && (
        <>
          <div className="vault-related-label">People mentioned</div>
          {people.map((e, i) => (
            <div key={i} className="vault-backlink-tag">{e.entity_value}</div>
          ))}
        </>
      )}
      {tasks.length > 0 && (
        <>
          <div className="vault-related-label">Tasks</div>
          {tasks.map((e, i) => (
            <div key={i} className="vault-backlink-item">{e.entity_value}</div>
          ))}
        </>
      )}
      {decisions.length > 0 && (
        <>
          <div className="vault-related-label">Decisions</div>
          {decisions.map((e, i) => (
            <div key={i} className="vault-backlink-item">{e.entity_value}</div>
          ))}
        </>
      )}
      {backlinks.length > 0 && (
        <>
          <div className="vault-related-label">Linked from</div>
          {backlinks.slice(0, 5).map((l, i) => (
            <div key={i} className="vault-backlink-item">{l.source_path}</div>
          ))}
        </>
      )}
    </div>
  );
}

export default function VaultBrowser({ initialOpenPath, onClearInitialPath }) {
  const [currentDir, setCurrentDir] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);

  // Editor state
  const [openFile, setOpenFile] = useState(null); // { path, content }
  const [edited, setEdited] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  // Preview mode
  const [previewMode, setPreviewMode] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);

  const loadDir = useCallback(async (dir) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/vault/list?dir=${encodeURIComponent(dir)}`);
      const data = await res.json();
      const sorted = (data.files || []).sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(sorted);
      setCurrentDir(dir);
      setSearchResults(null);
    } catch (err) {
      console.error('Failed to list vault:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadDir(''); }, [loadDir]);

  useEffect(() => {
    if (initialOpenPath) {
      openFileHandler(initialOpenPath);
      if (onClearInitialPath) onClearInitialPath();
    }
  }, [initialOpenPath]);

  const openFileHandler = async (relativePath) => {
    try {
      const res = await apiFetch(`/api/vault/read?path=${encodeURIComponent(relativePath)}`);
      const data = await res.json();
      if (data.content !== undefined) {
        setOpenFile({ path: relativePath, content: data.content });
        setEdited(data.content);
        setSaveMsg(null);
      }
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  };

  const saveFile = async () => {
    if (!openFile) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await apiFetch('/api/vault/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: openFile.path, content: edited })
      });
      if (res.ok) {
        setOpenFile({ ...openFile, content: edited });
        setSaveMsg('Saved');
        setTimeout(() => setSaveMsg(null), 2000);
      } else {
        setSaveMsg('Save failed');
      }
    } catch {
      setSaveMsg('Save failed');
    }
    setSaving(false);
  };

  const doSearch = async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/vault/search?query=${encodeURIComponent(searchQuery)}&dir=${encodeURIComponent(currentDir)}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    }
    setLoading(false);
  };

  const navigateUp = () => {
    const parts = currentDir.split('/').filter(Boolean);
    parts.pop();
    loadDir(parts.join('/'));
  };

  const navigateEntry = (entry) => {
    const newPath = currentDir ? `${currentDir}/${entry.name}` : entry.name;
    if (entry.type === 'directory') {
      loadDir(newPath);
    } else {
      openFileHandler(newPath);
    }
  };

  const breadcrumbs = currentDir ? currentDir.split('/') : [];
  const isDirty = openFile && edited !== openFile.content;

  // Preprocess markdown for preview: handle wiki-links and dataview blocks
  const preprocessMarkdown = (md) => {
    return md
      .replace(/\[\[([^\]]+)\]\]/g, '**$1**')
      .replace(/```dataview[\s\S]*?```/g, (m) => m.replace('```dataview', '```'))
      .replace(/^```dataviewjs[\s\S]*?```/gm, (m) => m.replace('```dataviewjs', '```js'));
  };

  // Editor view
  if (openFile) {
    return (
      <div className="vault-browser">
        <div className="vault-editor-header">
          <button className="vault-back" onClick={() => { setOpenFile(null); setPreviewMode(false); }}>
            ← Back
          </button>
          <span className="vault-filepath">{openFile.path}</span>
          <div className="vault-editor-actions">
            <button
              className={`vault-toggle-btn ${previewMode ? 'active' : ''}`}
              onClick={() => setPreviewMode(!previewMode)}
            >
              {previewMode ? 'Edit' : 'Preview'}
            </button>
            {saveMsg && <span className={`vault-save-msg ${saveMsg === 'Saved' ? 'ok' : 'err'}`}>{saveMsg}</span>}
            <button className="vault-save-btn" onClick={saveFile} disabled={saving || !isDirty}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
        {previewMode ? (
          <div className="vault-preview">
            <ReactMarkdown>{preprocessMarkdown(edited)}</ReactMarkdown>
          </div>
        ) : (
          <textarea
            className="vault-editor"
            value={edited}
            onChange={e => setEdited(e.target.value)}
            spellCheck={true}
          />
        )}
        <BacklinksPanel notePath={openFile.path} />
        <RelatedNotes notePath={openFile.path} onNavigate={openFileHandler} />
      </div>
    );
  }

  // Browser view
  return (
    <div className="vault-browser">
      <div className="vault-header">
        <h2 className="vault-title">Vault</h2>
        <div className="vault-search">
          <input
            className="vault-search-input"
            type="text"
            placeholder="Search vault..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch()}
          />
          <button className="vault-search-btn" onClick={doSearch}>Go</button>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="vault-breadcrumb">
        <button className="vault-crumb" onClick={() => loadDir('')}>vault</button>
        {breadcrumbs.map((part, i) => (
          <React.Fragment key={i}>
            <span className="vault-crumb-sep">/</span>
            <button className="vault-crumb" onClick={() => loadDir(breadcrumbs.slice(0, i + 1).join('/'))}>
              {part}
            </button>
          </React.Fragment>
        ))}
      </div>

      {loading && <div className="vault-loading">Loading...</div>}

      {/* Search results */}
      {searchResults && !loading && (
        <div className="vault-results">
          <div className="vault-results-header">
            <span>{searchResults.length} result{searchResults.length !== 1 ? 's' : ''}</span>
            <button className="vault-clear-search" onClick={() => setSearchResults(null)}>Clear</button>
          </div>
          {searchResults.map((r, i) => (
            <div key={i} className="vault-result" onClick={() => openFileHandler(r.path)}>
              <span className="vault-result-path">{r.path}</span>
              {r.matches?.slice(0, 2).map((m, j) => (
                <div key={j} className="vault-result-match">L{m.line}: {m.text}</div>
              ))}
            </div>
          ))}
          {searchResults.length === 0 && <div className="vault-empty">No matches</div>}
        </div>
      )}

      {/* File list */}
      {!searchResults && !loading && (
        <div className="vault-list">
          {currentDir && (
            <div className="vault-entry vault-entry-up" onClick={navigateUp}>
              <span className="vault-entry-icon">↑</span>
              <span className="vault-entry-name">..</span>
            </div>
          )}
          {entries.map(entry => (
            <div key={entry.name} className={`vault-entry ${entry.type === 'directory' ? 'vault-entry-dir' : ''}`} onClick={() => navigateEntry(entry)}>
              <span className="vault-entry-icon">{entry.type === 'directory' ? '▸' : '·'}</span>
              <span className="vault-entry-name">{entry.name}</span>
            </div>
          ))}
          {entries.length === 0 && <div className="vault-empty">Empty directory</div>}
        </div>
      )}
    </div>
  );
}
