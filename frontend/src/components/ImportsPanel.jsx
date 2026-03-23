import React, { useState, useMemo, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './ImportsPanel.css';

function extractJiraKey(text) {
  const match = (text || '').match(/\b([A-Za-z]{2,10}-\d+)\b/);
  return match ? match[1].toUpperCase() : null;
}

function EscalateButton({ ticketKey, onDone }) {
  const [state, setState] = useState('idle');

  const handleEscalate = async () => {
    setState('loading');
    try {
      const res = await fetch(apiUrl(`/api/jira/flagged/${ticketKey}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Flagged from Imports panel' })
      });
      const data = await res.json();
      if (data.ok) {
        setState('done');
        if (onDone) onDone();
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  };

  if (state === 'done') return <span className="btn-escalate-done">Flagged</span>;

  return (
    <button
      className="btn btn-escalate"
      onClick={handleEscalate}
      disabled={state === 'loading'}
      title={`Flag ${ticketKey} as informal escalation`}
    >
      {state === 'loading' ? 'Flagging...' : `Flag ${ticketKey}`}
    </button>
  );
}

const VAULT_FOLDERS = [
  { label: 'Meetings', destination: 'Meetings/' },
  { label: 'Calls', destination: 'Calls/' },
  { label: 'People', destination: 'People/' },
  { label: 'Ideas', destination: 'Ideas/' },
  { label: 'Projects', destination: 'Projects/' },
  { label: 'Areas', destination: 'Areas/' },
  { label: 'Decisions', destination: 'Decision Log/' },
  { label: 'Reflections', destination: 'Reflections/' },
  { label: 'PLAUD', destination: 'Imports/PLAUD/' },
  { label: 'Archive', destination: 'Archive/' },
];

export default function ImportsPanel() {
  const [classifying, setClassifying] = useState(null);
  const [classifications, setClassifications] = useState({});
  const [acting, setActing] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepProgress, setSweepProgress] = useState(null);
  const [toast, setToast] = useState(null);
  const [manualRouting, setManualRouting] = useState(null); // filePath being manually routed
  const [transcriptResults, setTranscriptResults] = useState([]); // processed transcript entities

  const transform = useMemo(() => (json) => json.files || [], []);
  const { data: files, refresh: fetchPending } = useCachedFetch('/api/imports/pending', {
    interval: 15000,
    transform
  });
  const { data: status, refresh: fetchStatus } = useCachedFetch('/api/imports/status', { interval: 30000 });
  const loading = files === null;

  // Seed sweeping state from server (so all devices show correct state on load)
  useEffect(() => {
    if (status?.sweepRunning !== undefined) {
      setSweeping(status.sweepRunning);
    }
  }, [status?.sweepRunning]);

  // SSE — real-time sync across devices
  useEffect(() => {
    let es;
    try {
      es = new EventSource(apiUrl('/api/nudges/stream'));
      es.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'sweep_started') {
          setSweeping(true);
          setSweepProgress({ current: 0, total: data.total, currentFile: null });
        }

        else if (data.type === 'sweep_progress') {
          setSweepProgress({
            current: data.index + 1,
            total: data.total,
            currentFile: data.file,
            currentCls: data.classification
          });
          // Update stored classification in file list immediately
          if (data.classification && data.relativePath) {
            setClassifications(prev => ({
              ...prev,
              [data.relativePath]: data.classification
            }));
          }
        }

        else if (data.type === 'sweep_complete') {
          setSweeping(false);
          setSweepProgress(null);
          setToast(`Sweep done — ${data.routed} routed, ${data.flagged} flagged`);
          setTimeout(() => setToast(null), 5000);
          fetchPending();
          fetchStatus();

          // Push notification if user is not looking at the app
          const appVisible = document.visibilityState === 'visible' && document.hasFocus();
          if (!appVisible) {
            fetch(apiUrl('/api/imports/notify-complete'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                routed: data.routed,
                flagged: data.flagged,
                errors: data.errors
              })
            }).catch(() => {});
          }
        }

        else if (data.type === 'classification_ready') {
          // Single file classified on any device — update this device immediately
          if (data.classification && (data.filePath || data.relativePath)) {
            const key = data.filePath || data.relativePath;
            setClassifications(prev => ({ ...prev, [key]: data.classification }));
          }
          fetchPending();
        }

        else if (data.type === 'transcript_processed') {
          // PLAUD transcript was processed — show extracted entities
          if (data.result) {
            setTranscriptResults(prev => [data.result, ...prev.slice(0, 4)]);
          }
        }

        else if (data.type === 'file_actioned') {
          // File was routed/flagged/dismissed — refresh the list
          if (data.filePath) {
            setClassifications(prev => {
              const next = { ...prev };
              delete next[data.filePath];
              return next;
            });
          }
          fetchPending();
        }
      };
    } catch {}
    return () => { if (es) es.close(); };
  }, [fetchPending, fetchStatus]);

  const classify = async (filePath) => {
    setClassifying(filePath);
    try {
      const res = await fetch(apiUrl('/api/imports/classify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      const data = await res.json();
      setClassifications(prev => ({ ...prev, [filePath]: data }));
      // Refresh list so other devices see the classification too
      fetchPending();
    } catch (e) {
      setClassifications(prev => ({ ...prev, [filePath]: { type: 'error', reason: e.message } }));
    }
    setClassifying(null);
  };

  const classifyAll = async () => {
    try {
      const res = await fetch(apiUrl('/api/imports/classify-all'), { method: 'POST' });
      const data = await res.json();
      if (data.started) {
        setSweeping(true);
        // SSE sweep_started event will arrive shortly and set sweepProgress
      } else {
        // Nothing to classify — show a brief toast and stay idle
        setToast(data.reason || 'Nothing to classify');
        setTimeout(() => setToast(null), 3000);
        setSweeping(false);
      }
    } catch {
      setSweeping(false);
    }
  };

  const doAction = async (endpoint, body, filePath) => {
    setActing(filePath);
    try {
      const res = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        setClassifications(prev => {
          const next = { ...prev };
          delete next[filePath];
          return next;
        });
        fetchPending();
      }
    } catch (e) {
      console.error('Action failed:', e);
    }
    setActing(null);
  };

  const routeFile = (filePath, cls) => {
    doAction('/api/imports/route', {
      filePath,
      destination: cls.destination,
      type: cls.type
    }, filePath);
  };

  const flagFile = (filePath) => {
    doAction('/api/imports/flag', { filePath, reason: 'Flagged from UI' }, filePath);
  };

  const dismissFile = (filePath) => {
    doAction('/api/imports/dismiss', { filePath }, filePath);
  };

  const deleteFile = (filePath) => {
    if (!window.confirm('Permanently delete this file? This cannot be undone.')) return;
    doAction('/api/imports/delete', { filePath }, filePath);
  };

  const manualRoute = (filePath, destination) => {
    const typeMap = {
      'Meetings/': 'meeting-note',
      'Calls/': 'call-note',
      'People/': 'person-update',
      'Ideas/': 'idea',
      'Projects/': 'reference',
      'Areas/': 'reference',
      'Decision Log/': 'decision',
      'Reflections/': 'reflection',
      'Imports/PLAUD/': 'plaud-transcript',
      'Archive/': 'reference',
    };
    const type = typeMap[destination] || 'reference';
    doAction('/api/imports/route', { filePath, destination, type }, filePath);
    setManualRouting(null);
  };

  const lastSweep = status?.lastSweep;
  const lastSweepTime = lastSweep?.timestamp
    ? new Date(lastSweep.timestamp).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  const ManualRoutePicker = ({ file, suggestedDestination }) => (
    <div className="manual-route-picker">
      <div className="manual-route-label">
        {suggestedDestination
          ? `Suggested: ${suggestedDestination} — or pick another:`
          : 'Where does this belong?'}
      </div>
      <div className="manual-route-folders">
        {VAULT_FOLDERS.map(folder => (
          <button
            key={folder.destination}
            className={`manual-route-btn ${suggestedDestination === folder.destination ? 'suggested' : ''}`}
            onClick={() => manualRoute(file.filePath, folder.destination)}
            disabled={acting === file.filePath}
          >
            {folder.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (loading) return <div className="imports-loading">Loading imports...</div>;

  return (
    <div className="imports-panel">
      <div className="imports-header">
        <h2>Imports</h2>
        <div className="imports-header-actions">
          {lastSweepTime && (
            <span className="imports-sweep-time">Last sweep: {lastSweepTime}</span>
          )}
          <button
            className="btn btn-secondary"
            onClick={classifyAll}
            disabled={sweeping || (files || []).length === 0}
          >
            {sweeping
              ? sweepProgress
                ? `${sweepProgress.current}/${sweepProgress.total}`
                : 'Starting...'
              : 'Classify All'}
          </button>
          <button className="btn btn-secondary" onClick={fetchPending}>Refresh</button>
        </div>
      </div>

      {toast && <div className="imports-toast">{toast}</div>}

      {sweeping && sweepProgress && (
        <div className="imports-progress">
          <div className="imports-progress-bar">
            <div
              className="imports-progress-fill"
              style={{ width: `${Math.round((sweepProgress.current / sweepProgress.total) * 100)}%` }}
            />
          </div>
          <div className="imports-progress-label">
            {sweepProgress.current}/{sweepProgress.total}
            {sweepProgress.currentFile && ` — ${sweepProgress.currentFile}`}
          </div>
        </div>
      )}

      {sweeping && !sweepProgress && (
        <div className="imports-progress">
          <div className="imports-progress-label">Starting sweep...</div>
        </div>
      )}

      {transcriptResults.length > 0 && (
        <div className="transcript-results">
          <div className="transcript-results-title">Recent Transcript Extractions</div>
          {transcriptResults.map((tr, i) => (
            <div key={`${tr.sourceFile}-${i}`} className="transcript-result-card">
              <div className="transcript-result-header">
                <span className="transcript-source">{tr.sourceFile}</span>
                {tr.is121 && <span className="transcript-badge">1-2-1</span>}
                {tr.meetingDate && <span className="transcript-date">{tr.meetingDate}</span>}
              </div>
              {tr.summary && <div className="transcript-summary">{tr.summary}</div>}
              {tr.people.length > 0 && (
                <div className="transcript-people">
                  <span className="transcript-label">People:</span>
                  {tr.people.map((p, j) => (
                    <span key={j} className={`transcript-person ${p.vaultMatch ? 'matched' : ''}`}>
                      {p.mentioned}{p.updated121 ? ' (1-2-1 updated)' : p.vaultMatch ? ' (linked)' : ''}
                    </span>
                  ))}
                </div>
              )}
              {tr.actionItems.length > 0 && (
                <div className="transcript-actions-list">
                  <span className="transcript-label">Actions:</span>
                  <ul>
                    {tr.actionItems.map((a, j) => <li key={j}>{a}</li>)}
                  </ul>
                </div>
              )}
              {tr.keyTopics.length > 0 && (
                <div className="transcript-topics">
                  {tr.keyTopics.map((t, j) => (
                    <span key={j} className="transcript-topic">{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(files || []).length === 0 ? (
        <div className="imports-empty">No unprocessed files in Imports/</div>
      ) : (
        <div className="imports-list">
          {(files || []).map(file => {
            const cls = classifications[file.filePath] || file.storedClassification;
            const isActing = acting === file.filePath;
            const showRoute = cls && !cls.error && (cls.confidence === 'high' || cls.confidence === 'medium') && cls.destination;
            return (
              <div key={file.filePath} className="import-card">
                <div className="import-card-header">
                  <div>
                    <span className="import-filename">{file.fileName}</span>
                    {file.subdir && <span className="import-subdir">{file.subdir}/</span>}
                    {file.status === 'needs-review' && (
                      <span className="import-needs-review">needs review</span>
                    )}
                  </div>
                  <span className="import-date">{new Date(file.modified).toLocaleDateString()}</span>
                </div>

                {file.preview && (
                  <div className="import-preview">{file.preview}</div>
                )}

                {cls && !cls.error && (
                  <div className={`import-classification ${cls.confidence === 'high' ? 'high' : cls.confidence === 'medium' ? 'medium' : 'low'}`}>
                    <span className="cls-type">{cls.type}</span>
                    {cls.destination && <span className="cls-dest">{cls.destination}</span>}
                    <span className="cls-confidence">{cls.confidence}</span>
                    {cls.backend && <span className="cls-backend">{cls.backend}</span>}
                    {cls.reason && <span className="cls-reason">{cls.reason}</span>}
                  </div>
                )}

                {cls && cls.error && (
                  <div className="import-classification low">
                    <span className="cls-type">error</span>
                    <span className="cls-reason">{cls.error || cls.reason}</span>
                  </div>
                )}

                {!cls && file.status === 'needs-review' && (
                  <div className="import-classification low">
                    <span className="cls-type">needs review</span>
                    <span className="cls-reason">{file.reviewReason || 'Low confidence — needs manual filing'}</span>
                  </div>
                )}

                {/* Manual route picker — show for needs-review or low-confidence */}
                {(file.status === 'needs-review' || (cls && !cls.error && cls.confidence === 'low')) && (
                  <ManualRoutePicker
                    file={file}
                    suggestedDestination={cls?.destination || null}
                  />
                )}

                <div className="import-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => classify(file.filePath)}
                    disabled={classifying === file.filePath || isActing}
                  >
                    {classifying === file.filePath ? 'Classifying...' : cls ? 'Re-classify' : 'Classify'}
                  </button>

                  {showRoute && (
                    <button
                      className="btn btn-route"
                      onClick={() => routeFile(file.filePath, cls)}
                      disabled={isActing}
                    >
                      {isActing ? 'Routing...' : `Route → ${cls.destination}`}
                    </button>
                  )}

                  {cls && !cls.error && cls.confidence !== 'low' && (
                    <button
                      className="btn btn-flag"
                      onClick={() => flagFile(file.filePath)}
                      disabled={isActing}
                    >
                      Flag for review
                    </button>
                  )}

                  {(cls || file.status === 'needs-review') && (
                    <button
                      className="btn btn-dismiss"
                      onClick={() => dismissFile(file.filePath)}
                      disabled={isActing}
                    >
                      Dismiss
                    </button>
                  )}

                  {(() => {
                    const jiraKey = extractJiraKey(file.preview) || extractJiraKey(file.fileName);
                    return jiraKey ? <EscalateButton ticketKey={jiraKey} onDone={() => fetchPending()} /> : null;
                  })()}

                  <button
                    className="btn btn-delete"
                    onClick={() => deleteFile(file.filePath)}
                    disabled={isActing}
                    title="Permanently delete this file"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
