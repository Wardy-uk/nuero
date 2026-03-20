import React, { useState, useMemo } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './ImportsPanel.css';

export default function ImportsPanel() {
  const [classifying, setClassifying] = useState(null);
  const [classifications, setClassifications] = useState({});

  const transform = useMemo(() => (json) => json.files || [], []);
  const { data: files, refresh: fetchPending } = useCachedFetch('/api/imports/pending', { transform });
  const loading = files === null;

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
    } catch (e) {
      setClassifications(prev => ({ ...prev, [filePath]: { type: 'error', reason: e.message } }));
    }
    setClassifying(null);
  };

  if (loading) return <div className="imports-loading">Loading imports...</div>;

  return (
    <div className="imports-panel">
      <div className="imports-header">
        <h2>Imports</h2>
        <button className="btn btn-secondary" onClick={fetchPending}>Refresh</button>
      </div>

      {(files || []).length === 0 ? (
        <div className="imports-empty">No unprocessed files in Imports/</div>
      ) : (
        <div className="imports-list">
          {(files || []).map(file => {
            const cls = classifications[file.filePath];
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

                {cls && (
                  <div className={`import-classification ${cls.confidence === 'high' ? 'high' : cls.confidence === 'medium' ? 'medium' : 'low'}`}>
                    <span className="cls-type">{cls.type}</span>
                    {cls.destination && <span className="cls-dest">{cls.destination}</span>}
                    <span className="cls-confidence">{cls.confidence}</span>
                    {cls.reason && <span className="cls-reason">{cls.reason}</span>}
                  </div>
                )}

                <div className="import-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => classify(file.filePath)}
                    disabled={classifying === file.filePath}
                  >
                    {classifying === file.filePath ? 'Classifying...' : cls ? 'Re-classify' : 'Classify'}
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
