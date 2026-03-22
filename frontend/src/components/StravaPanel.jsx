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

const OS_API_KEY = import.meta.env.VITE_OS_API_KEY || '';
const OS_TILE_URL = OS_API_KEY
  ? `https://api.os.uk/maps/raster/v1/zxy/Outdoor_3857/{z}/{x}/{y}.png?key=${OS_API_KEY}`
  : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Web Mercator helpers
function lat2y(lat) { return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)); }
function lngToTileX(lng, z) { return Math.floor((lng + 180) / 360 * (1 << z)); }
function latToTileY(lat, z) { return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * (1 << z)); }
function tileXToLng(x, z) { return x / (1 << z) * 360 - 180; }
function tileYToLat(y, z) { const n = Math.PI - 2 * Math.PI * y / (1 << z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); }

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

    // Determine zoom level that fits the bounding box with padding
    const padding = 20;
    let zoom = 18;
    for (let z = 18; z >= 1; z--) {
      const x1 = lngToTileX(minLng, z);
      const x2 = lngToTileX(maxLng, z);
      const y1 = latToTileY(maxLat, z);
      const y2 = latToTileY(minLat, z);
      const tilesX = x2 - x1 + 1;
      const tilesY = y2 - y1 + 1;
      if (tilesX * 256 <= (w + 256) && tilesY * 256 <= (h + 256)) {
        zoom = z;
        break;
      }
    }

    // Centre of the route in Mercator pixel space
    const n = 1 << zoom;
    const centLng = (minLng + maxLng) / 2;
    const centLat = (minLat + maxLat) / 2;
    const centPxX = ((centLng + 180) / 360) * n * 256;
    const centPxY = ((1 - Math.log(Math.tan(centLat * Math.PI / 180) + 1 / Math.cos(centLat * Math.PI / 180)) / Math.PI) / 2) * n * 256;

    // Pixel origin (top-left of canvas in world pixel coords)
    const originX = centPxX - w / 2;
    const originY = centPxY - h / 2;

    // Determine which tiles we need
    const tileMinX = Math.floor(originX / 256);
    const tileMaxX = Math.floor((originX + w) / 256);
    const tileMinY = Math.floor(originY / 256);
    const tileMaxY = Math.floor((originY + h) / 256);

    // Convert lat/lng to canvas pixel coordinates
    const toCanvasX = (lng) => {
      const px = ((lng + 180) / 360) * n * 256;
      return px - originX;
    };
    const toCanvasY = (lat) => {
      const py = ((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2) * n * 256;
      return py - originY;
    };

    // Grey background while tiles load
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    // Draw route immediately (before tiles load)
    function drawRoute() {
      ctx.beginPath();
      ctx.moveTo(toCanvasX(points[0][1]), toCanvasY(points[0][0]));
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(toCanvasX(points[i][1]), toCanvasY(points[i][0]));
      }
      ctx.strokeStyle = '#fc4c02';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      // Start dot (green)
      ctx.beginPath();
      ctx.arc(toCanvasX(points[0][1]), toCanvasY(points[0][0]), 5, 0, Math.PI * 2);
      ctx.fillStyle = '#22c55e';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // End dot (red)
      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.arc(toCanvasX(last[1]), toCanvasY(last[0]), 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    drawRoute();

    // Load tiles and redraw with map background
    let loadedCount = 0;
    const totalTiles = (tileMaxX - tileMinX + 1) * (tileMaxY - tileMinY + 1);
    const tiles = [];

    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      for (let ty = tileMinY; ty <= tileMaxY; ty++) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const drawX = tx * 256 - originX;
        const drawY = ty * 256 - originY;
        tiles.push({ img, drawX, drawY });

        img.onload = () => {
          loadedCount++;
          // Redraw everything once all tiles are loaded
          if (loadedCount === totalTiles) {
            ctx.clearRect(0, 0, w, h);
            for (const t of tiles) {
              try { ctx.drawImage(t.img, t.drawX, t.drawY, 256, 256); } catch {}
            }
            drawRoute();
          }
        };
        img.onerror = () => {
          loadedCount++;
          if (loadedCount === totalTiles) {
            ctx.clearRect(0, 0, w, h);
            for (const t of tiles) {
              try { ctx.drawImage(t.img, t.drawX, t.drawY, 256, 256); } catch {}
            }
            drawRoute();
          }
        };
        img.src = OS_TILE_URL.replace('{z}', zoom).replace('{x}', tx).replace('{y}', ty);
      }
    }
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
