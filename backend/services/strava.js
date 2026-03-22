'use strict';

const db = require('../db/database');

const BASE_URL = 'https://www.strava.com/api/v3';

function isConfigured() {
  return !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
}

function isAuthenticated() {
  const token = db.getState('strava_access_token');
  const expiry = parseInt(db.getState('strava_token_expiry') || '0', 10);
  return !!(token && Date.now() < expiry * 1000);
}

function getAuthUrl() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = process.env.STRAVA_REDIRECT_URI;
  if (!clientId || !redirectUri) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read'
  });
  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

async function exchangeCode(code) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code'
    })
  });
  if (!res.ok) throw new Error(`Strava token exchange failed: ${res.status}`);
  const data = await res.json();
  db.setState('strava_access_token', data.access_token);
  db.setState('strava_refresh_token', data.refresh_token);
  db.setState('strava_token_expiry', String(data.expires_at));
  db.setState('strava_athlete_name', data.athlete?.firstname || '');
  console.log('[Strava] Authenticated as', data.athlete?.firstname, data.athlete?.lastname);
  return data;
}

async function refreshToken() {
  const storedRefreshToken = db.getState('strava_refresh_token');
  if (!storedRefreshToken) throw new Error('No refresh token stored');
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: storedRefreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`);
  const data = await res.json();
  db.setState('strava_access_token', data.access_token);
  db.setState('strava_refresh_token', data.refresh_token);
  db.setState('strava_token_expiry', String(data.expires_at));
  return data.access_token;
}

async function getAccessToken() {
  const expiry = parseInt(db.getState('strava_token_expiry') || '0', 10);
  if (Date.now() >= expiry * 1000 - 60000) {
    // Refresh 60 seconds before expiry
    return await refreshToken();
  }
  return db.getState('strava_access_token');
}

// Fetch today's activities (and optionally yesterday's)
async function getTodayActivities() {
  if (!isAuthenticated() && !db.getState('strava_refresh_token')) return null;
  try {
    const token = await getAccessToken();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const after = Math.floor(today.getTime() / 1000); // start of today UTC

    const res = await fetch(
      `${BASE_URL}/athlete/activities?after=${after}&per_page=10`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Strava API error: ${res.status}`);
    const activities = await res.json();
    return activities;
  } catch (e) {
    console.error('[Strava] Failed to fetch activities:', e.message);
    return null;
  }
}

// Format activity for human-readable context
function formatActivity(activity) {
  const typeMap = {
    'Run': 'run', 'Ride': 'ride', 'Swim': 'swim', 'Walk': 'walk',
    'Hike': 'hike', 'WeightTraining': 'weight training', 'Workout': 'workout',
    'Yoga': 'yoga', 'Rowing': 'rowing', 'Crossfit': 'CrossFit'
  };
  const type = typeMap[activity.type] || activity.type.toLowerCase();
  const distanceKm = activity.distance ? (activity.distance / 1000).toFixed(1) : null;
  const durationMin = activity.moving_time ? Math.round(activity.moving_time / 60) : null;
  const elevationM = activity.total_elevation_gain ? Math.round(activity.total_elevation_gain) : null;
  const avgHr = activity.average_heartrate ? Math.round(activity.average_heartrate) : null;
  const sufferScore = activity.suffer_score || null;

  const parts = [];
  if (distanceKm) parts.push(`${distanceKm}km`);
  if (durationMin) parts.push(`${durationMin} min`);
  if (elevationM && elevationM > 10) parts.push(`${elevationM}m elevation`);
  if (avgHr) parts.push(`avg HR ${avgHr}bpm`);
  if (sufferScore) parts.push(`suffer score ${sufferScore}`);

  return `${type}${parts.length > 0 ? ': ' + parts.join(', ') : ''}`;
}

// Get a summary string suitable for injecting into context
async function getActivityContext() {
  const activities = await getTodayActivities();
  if (!activities || activities.length === 0) return null;

  const summaries = activities.map(formatActivity);
  if (summaries.length === 1) return `Today's Strava activity: ${summaries[0]}`;
  return `Today's Strava activities: ${summaries.join('; ')}`;
}

function disconnect() {
  db.setState('strava_access_token', '');
  db.setState('strava_refresh_token', '');
  db.setState('strava_token_expiry', '0');
  console.log('[Strava] Disconnected');
}

module.exports = {
  isConfigured,
  isAuthenticated,
  getAuthUrl,
  exchangeCode,
  getTodayActivities,
  getActivityContext,
  formatActivity,
  disconnect
};
