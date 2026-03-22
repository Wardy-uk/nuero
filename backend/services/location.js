'use strict';

const db = require('../db/database');

const RECORDER_URL = process.env.OWNTRACKS_RECORDER_URL || 'http://localhost:8083';
const OT_USER = process.env.OWNTRACKS_USER || 'nick';
const OT_DEVICE = process.env.OWNTRACKS_DEVICE || 'iphone';

// Minimum dwell time to count as a meaningful location (minutes)
const MIN_DWELL_MINUTES = 20;

function isConfigured() {
  return !!(process.env.OWNTRACKS_RECORDER_URL);
}

// Fetch today's location points from OwnTracks Recorder
async function getTodayPoints() {
  try {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0].replace(/-/g, '/');

    const url = `${RECORDER_URL}/api/0/locations?user=${OT_USER}&device=${OT_DEVICE}&from=${dateStr}T00:00:00Z&to=${dateStr}T23:59:59Z`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Recorder API error: ${res.status}`);
    const data = await res.json();
    return data.data || [];
  } catch (e) {
    console.warn('[Location] Failed to fetch OwnTracks data:', e.message);
    return [];
  }
}

// Group points into clusters (nearby points = same place)
// Uses simple distance threshold — 200m radius counts as same place
function clusterPoints(points) {
  if (!points || points.length === 0) return [];

  // Sort by time
  const sorted = [...points].sort((a, b) => a.tst - b.tst);

  function distanceMetres(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const CLUSTER_RADIUS_M = 200;
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentCluster[currentCluster.length - 1];
    const curr = sorted[i];
    const dist = distanceMetres(prev.lat, prev.lon, curr.lat, curr.lon);

    if (dist <= CLUSTER_RADIUS_M) {
      currentCluster.push(curr);
    } else {
      clusters.push(currentCluster);
      currentCluster = [curr];
    }
  }
  clusters.push(currentCluster);
  return clusters;
}

// Reverse geocode a lat/lng using Nominatim (already used in claude.js)
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NEURO-personal-agent/1.0 (nick.ward@nurtur.tech)' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};

    // Build a human-readable name — prefer specific to general
    const specific = addr.amenity || addr.shop || addr.office || addr.building ||
      addr.leisure || addr.tourism || addr.sport;
    const road = addr.road || addr.pedestrian;
    const area = addr.suburb || addr.neighbourhood || addr.quarter ||
      addr.village || addr.town || addr.city;

    if (specific && area) return `${specific}, ${area}`;
    if (specific) return specific;
    if (road && area) return `${road}, ${area}`;
    if (area) return area;
    return data.display_name?.split(',').slice(0, 2).join(',').trim() || null;
  } catch {
    return null;
  }
}

// Build a dwell summary for today
// Returns array of { placeName, lat, lng, arrivalTime, departureTime, durationMinutes }
async function getTodayDwells() {
  const points = await getTodayPoints();
  if (points.length === 0) return [];

  const clusters = clusterPoints(points);
  const dwells = [];

  for (const cluster of clusters) {
    if (cluster.length < 2) continue; // single point — ignore

    const first = cluster[0];
    const last = cluster[cluster.length - 1];
    const durationMinutes = Math.round((last.tst - first.tst) / 60);

    if (durationMinutes < MIN_DWELL_MINUTES) continue; // brief stop — ignore

    // Use centre of cluster for geocoding
    const avgLat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
    const avgLng = cluster.reduce((s, p) => s + p.lon, 0) / cluster.length;

    const placeName = await reverseGeocode(avgLat, avgLng);

    const arrival = new Date(first.tst * 1000);
    const departure = new Date(last.tst * 1000);
    const arrivalStr = arrival.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const departureStr = departure.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    dwells.push({
      placeName: placeName || `unknown location`,
      lat: avgLat,
      lng: avgLng,
      arrivalTime: arrivalStr,
      departureTime: departureStr,
      durationMinutes
    });
  }

  return dwells;
}

// Cache today's dwells in agent_state (avoid repeated Nominatim calls)
async function getCachedDwells() {
  const todayKey = new Date().toISOString().split('T')[0];
  const cacheKey = `location_dwells_${todayKey}`;
  const cacheTime = `location_dwells_time_${todayKey}`;

  // Use cache if less than 30 minutes old
  const lastFetch = parseInt(db.getState(cacheTime) || '0', 10);
  if (Date.now() - lastFetch < 30 * 60 * 1000) {
    try {
      const cached = db.getState(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {}
  }

  const dwells = await getTodayDwells();
  db.setState(cacheKey, JSON.stringify(dwells));
  db.setState(cacheTime, String(Date.now()));
  return dwells;
}

// Get a plain-English location summary for journal prompts
async function getLocationSummaryForJournal() {
  if (!isConfigured()) return null;
  try {
    const dwells = await getCachedDwells();
    if (dwells.length === 0) return null;

    // Describe each meaningful dwell
    const descriptions = dwells.map(d => {
      const hrs = Math.floor(d.durationMinutes / 60);
      const mins = d.durationMinutes % 60;
      const duration = hrs > 0
        ? `${hrs}h${mins > 0 ? ` ${mins}m` : ''}`
        : `${mins} min`;
      return `${d.placeName} (${d.arrivalTime}–${d.departureTime}, ${duration})`;
    });

    if (descriptions.length === 1) {
      return `Location today: ${descriptions[0]}`;
    }
    return `Locations today: ${descriptions.join('; ')}`;
  } catch (e) {
    console.warn('[Location] Summary failed:', e.message);
    return null;
  }
}

// Get a context block for Claude chat
async function getLocationContextBlock() {
  if (!isConfigured()) return null;
  try {
    const dwells = await getCachedDwells();
    if (dwells.length === 0) return null;

    const lines = dwells.map(d => {
      const hrs = Math.floor(d.durationMinutes / 60);
      const mins = d.durationMinutes % 60;
      const duration = hrs > 0 ? `${hrs}h${mins > 0 ? ` ${mins}m` : ''}` : `${mins}min`;
      return `- ${d.arrivalTime}–${d.departureTime}: ${d.placeName} (${duration})`;
    });

    return `## Today's Locations\n${lines.join('\n')}`;
  } catch (e) {
    return null;
  }
}

module.exports = {
  isConfigured,
  getTodayPoints,
  getTodayDwells,
  getCachedDwells,
  getLocationSummaryForJournal,
  getLocationContextBlock
};
