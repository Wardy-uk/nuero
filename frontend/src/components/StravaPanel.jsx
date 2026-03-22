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

// Decode Google encoded polyline into [lat, lng] pairs
function decodePolyline(encoded) {
  const points = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function RouteMap({ polyline }) {
  const canvasRef = React.useRef(null);

  useEffect(() => {
    if (!polyline || !canvasRef.current) return;
    const points = decodePolyline(polyline);
    if (points.length < 2) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    // Bounding box
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [lat, lng] of points) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }

    const padding = 12;
    const drawW = w - padding * 2;
    const drawH = h - padding * 2;
    const latRange = maxLat - minLat || 0.001;
    const lngRange = maxLng - minLng || 0.001;
    // Maintain aspect ratio using Mercator-ish correction
    const latMid = (minLat + maxLat) / 2;
    const lngScale = Math.cos(latMid * Math.PI / 180);
    const scaleX = drawW / (lngRange * lngScale);
    const scaleY = drawH / latRange;
    const scale = Math.min(scaleX, scaleY);

    const toX = (lng) => padding + ((lng - minLng) * lngScale * scale) + (drawW - lngRange * lngScale * scale) / 2;
    const toY = (lat) => padding + drawH - ((lat - minLat) * scale) - (drawH - latRange * scale) / 2;

    // Background
    ctx.fillStyle = 'rgba(252, 76, 2, 0.05)';
    ctx.fillRect(0, 0, w, h);

    // Route line
    ctx.beginPath();
    ctx.moveTo(toX(points[0][1]), toY(points[0][0]));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(toX(points[i][1]), toY(points[i][0]));
    }
    ctx.strokeStyle = '#fc4c02';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Start dot (green)
    ctx.beginPath();
    ctx.arc(toX(points[0][1]), toY(points[0][0]), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e';
    ctx.fill();

    // End dot (red)
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(toX(last[1]), toY(last[0]), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
  }, [polyline]);

  if (!polyline) return null;
  return <canvas ref={canvasRef} className="strava-map" />;
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
                <RouteMap polyline={a.map?.summary_polyline} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
