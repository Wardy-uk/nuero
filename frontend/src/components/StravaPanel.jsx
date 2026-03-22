import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './StravaPanel.css';

function formatDuration(secs) {
  if (!secs) return '';
  const m = Math.round(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function formatPace(distMeters, timeSecs) {
  if (!distMeters || !timeSecs) return null;
  const paceSecsPerKm = timeSecs / (distMeters / 1000);
  const mins = Math.floor(paceSecsPerKm / 60);
  const secs = Math.round(paceSecsPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}/km`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function StravaPanel() {
  const { data: status } = useCachedFetch('/api/strava/status', { interval: 30000 });
  const [activities, setActivities] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const pull = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/strava/activities/today'));
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setActivities(data.activities || []);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  // Auto-pull on mount if authenticated
  useEffect(() => {
    if (status?.authenticated && activities === null) {
      pull();
    }
  }, [status]);

  if (!status) return <div className="strava-panel"><div className="strava-loading">Loading...</div></div>;

  if (!status.configured) {
    return (
      <div className="strava-panel">
        <h2 className="strava-title">Strava</h2>
        <div className="strava-empty">
          Strava not configured. Add STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and
          STRAVA_REDIRECT_URI to the Pi's .env file.
        </div>
      </div>
    );
  }

  if (!status.authenticated) {
    return (
      <div className="strava-panel">
        <h2 className="strava-title">Strava</h2>
        <div className="strava-empty">
          <p>Connect your Strava account to pull today's activities.</p>
          <button
            className="strava-connect-btn"
            onClick={() => window.open(apiUrl('/api/strava/auth'), '_blank')}
          >
            Connect Strava
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="strava-panel">
      <div className="strava-header">
        <h2 className="strava-title">Strava</h2>
        <button className="strava-pull-btn" onClick={pull} disabled={loading}>
          {loading ? 'Pulling...' : 'Pull Activities'}
        </button>
      </div>

      {error && <div className="strava-error">Failed to fetch: {error}</div>}

      {activities !== null && activities.length === 0 && (
        <div className="strava-empty">No activities recorded today.</div>
      )}

      {activities && activities.length > 0 && (
        <div className="strava-activities">
          {activities.map((a, i) => {
            const distKm = a.distance ? (a.distance / 1000).toFixed(1) : null;
            const pace = formatPace(a.distance, a.moving_time);
            return (
              <div key={i} className="strava-card">
                <div className="strava-card-top">
                  <span className="strava-card-name">{a.name}</span>
                  <span className="strava-card-type">{a.type}</span>
                </div>
                <div className="strava-card-time">{formatDate(a.start_date_local)}</div>
                <div className="strava-card-stats">
                  {distKm && <div className="strava-stat"><span className="strava-stat-val">{distKm}</span><span className="strava-stat-lbl">km</span></div>}
                  {a.moving_time && <div className="strava-stat"><span className="strava-stat-val">{formatDuration(a.moving_time)}</span><span className="strava-stat-lbl">time</span></div>}
                  {pace && <div className="strava-stat"><span className="strava-stat-val">{pace}</span><span className="strava-stat-lbl">pace</span></div>}
                  {a.total_elevation_gain > 10 && <div className="strava-stat"><span className="strava-stat-val">{Math.round(a.total_elevation_gain)}m</span><span className="strava-stat-lbl">elev</span></div>}
                  {a.average_heartrate && <div className="strava-stat"><span className="strava-stat-val">{Math.round(a.average_heartrate)}</span><span className="strava-stat-lbl">avg HR</span></div>}
                  {a.max_heartrate && <div className="strava-stat"><span className="strava-stat-val">{Math.round(a.max_heartrate)}</span><span className="strava-stat-lbl">max HR</span></div>}
                  {a.suffer_score && <div className="strava-stat"><span className="strava-stat-val">{a.suffer_score}</span><span className="strava-stat-lbl">suffer</span></div>}
                  {a.kilojoules && <div className="strava-stat"><span className="strava-stat-val">{Math.round(a.kilojoules)}</span><span className="strava-stat-lbl">kJ</span></div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
