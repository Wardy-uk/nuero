import React, { useEffect, useState } from 'react';
import { apiUrl } from '../api';

/**
 * How many rows SAiM's home "Needs you" list shows before folding the rest
 * into "and N more" (Nick, 1 Nov 2026). Default 5; 1–20, refused otherwise.
 */
export default function NeedsYouCapSetting() {
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState({ busy: false, msg: null, error: null });

  useEffect(() => {
    fetch(apiUrl('/api/attention/settings'))
      .then((r) => r.json())
      .then((j) => { const s = j.settings || j; setSettings(s); setDraft(String(s.needsYouCap ?? 5)); })
      .catch((e) => setState({ busy: false, msg: null, error: `Couldn’t read the setting: ${e.message}` }));
  }, []);

  const save = async (value) => {
    setState({ busy: true, msg: null, error: null });
    try {
      const res = await fetch(apiUrl('/api/attention/settings'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needsYouCap: value }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setSettings(j.settings);
      setDraft(String(j.settings.needsYouCap));
      setState({ busy: false, msg: 'Saved.', error: null });
    } catch (e) {
      setState({ busy: false, msg: null, error: `Not saved — ${e.message}` });
    }
  };

  if (!settings) return <p className="admin-hint">{state.error || 'Loading…'}</p>;
  return (
    <div>
      <p className="admin-hint">
        SAiM’s home keeps everything that needs you right now — anything urgent, and anything she pushed you about
        that you haven’t answered. This is how many rows it shows before folding the rest into “and N more”.
      </p>
      <label className="admin-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>Rows shown</span>
        <input
          type="number" min={1} max={20} step={1} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: 70 }}
        />
        <button type="button" className="admin-btn" disabled={state.busy || draft === String(settings.needsYouCap)}
          onClick={() => save(Number(draft))}>Save</button>
        {settings.needsYouCapSource === 'setting' && (
          <button type="button" className="admin-btn" disabled={state.busy} onClick={() => save(null)}>Back to default (5)</button>
        )}
      </label>
      {state.msg && <p className="admin-hint">{state.msg}</p>}
      {state.error && <p className="admin-error">{state.error}</p>}
    </div>
  );
}
