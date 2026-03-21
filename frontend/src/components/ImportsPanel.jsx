import React, { useState, useMemo, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './ImportsPanel.css';

export default function ImportsPanel() {
  const [classifying, setClassifying] = useState(null);
  const [classifications, setClassifications] = useState({});
  const [acting, setActing] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [toast, setToast] = useState(null);

  const transform = useMemo(() => (json) => json.files || [], []);
  const { data: files, refresh: fetchPending } = useCachedFetch('/api/imports/pending', {
    interval: 15000,
    transform
  });
  const { data: status, refresh: fetchStatus } = useCachedFetch('/api/imports/status', { interval: 30000 });
  const loading = files === null;

  // Poll for sweep completion when sweeping
  useEffect(() => {
    if (!sweeping) return;
    const sweepStart = Date.now();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(apiUrl('/api/imports/status'));
        const data = await res.json();
        const sweep = data.lastSweep;
        if (sweep && new Date(sweep.timestamp).getTime() > sweepStart) {
          setSweeping(false);
          setToast(`Sweep done — ${sweep.routed} routed, ${sweep.flagged} flagged`);
          setTimeout(() => setToast(null), 5000);
          fetchPending();
          fetchStatus();
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [sweeping, fetchPending, fetchStatus]);

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
    setSweeping(true);
    try {
      await fetch(apiUrl('/api/imports/classify-all'), { method: 'POST' });
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

  const lastSweep = status?.lastSweep;
  const lastSweepTime = lastSweep?.timestamp
    ? new Date(lastSweep.timestamp).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

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
            {sweeping ? 'Sweeping...' : 'Classify All'}
          </button>
          <button className="btn btn-secondary" onClick={fetchPending}>Refresh</button>
        </div>
      </div>

      {toast && <div className="imports-toast">{toast}</div>}

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

                  {cls && !cls.error && (
                    <>
                      <button
                        className="btn btn-flag"
                        onClick={() => flagFile(file.filePath)}
                        disabled={isActing}
                      >
                        Flag for review
                      </button>
                      <button
                        className="btn btn-dismiss"
                        onClick={() => dismissFile(file.filePath)}
                        disabled={isActing}
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
