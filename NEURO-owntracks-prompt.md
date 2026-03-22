# NEURO — OwnTracks Location Awareness Integration

## Overview

Add location dwell detection to NEURO using OwnTracks. The iPhone app sends location
updates to a Mosquitto MQTT broker on the Pi. The OwnTracks Recorder stores them and
exposes an HTTP API. NEURO queries this API at journal time to build a plain-English
summary of where Nick has been and stayed during the day — injected into journal
prompts and Claude chat context.

Goal: "You spent 2 hours somewhere other than home this afternoon" as journal context.
Not live tracking. Not real-time. Just end-of-day awareness.

## Files to read before changing anything

- `backend/services/strava.js` (pattern for external service integration)
- `backend/services/health.js` (pattern for context injection)
- `backend/routes/journal.js` (where location context gets injected)
- `backend/services/claude.js` (where chat context gets injected)
- `backend/server.js` (where new routes get registered)
- `backend/db/database.js` (agent_state pattern)

Read all files in full before making any changes.

---

## Part 1 — Pi infrastructure setup

### Step 1 — Install Mosquitto MQTT broker on the Pi

SSH into the Pi and run:

```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
```

Verify it's running:
```bash
sudo systemctl status mosquitto
```

Configure Mosquitto to accept connections from the Tailscale network.
Create/edit `/etc/mosquitto/conf.d/owntracks.conf`:

```
listener 1883
allow_anonymous true
```

Note: anonymous is fine here — the Pi is only accessible via Tailscale (private network).
If Nick later wants auth, add `password_file` config.

Restart Mosquitto:
```bash
sudo systemctl restart mosquitto
```

Test it works:
```bash
mosquitto_sub -t test -v &
mosquitto_pub -t test -m "hello"
```

Should see "test hello". Kill the background sub process after.

---

### Step 2 — Install OwnTracks Recorder on the Pi

The Recorder receives MQTT messages and stores them. It also exposes an HTTP API.

```bash
# Install dependencies
sudo apt install -y build-essential libcurl4-openssl-dev libmosquitto-dev \
  libsodium-dev libssl-dev pkg-config

# Create directory
sudo mkdir -p /opt/owntracks
cd /opt/owntracks

# Download latest recorder release
# Check https://github.com/owntracks/recorder/releases for latest version
RECORDER_VERSION=0.9.5
wget https://github.com/owntracks/recorder/releases/download/${RECORDER_VERSION}/owntracks-recorder_${RECORDER_VERSION}_arm64.deb 2>/dev/null || \
wget https://github.com/owntracks/recorder/releases/download/${RECORDER_VERSION}/owntracks-recorder_${RECORDER_VERSION}_armhf.deb 2>/dev/null

# If .deb not available for ARM, build from source:
cd /tmp
git clone https://github.com/owntracks/recorder.git
cd recorder
make STORAGEDEFAULT=/var/lib/owntracks-recorder
sudo make install STORAGEDEFAULT=/var/lib/owntracks-recorder
```

If building from source fails, use the Docker approach instead:

```bash
# Docker alternative (simpler)
# First check if Docker is installed
docker --version 2>/dev/null && echo "Docker available" || echo "Docker not installed"

# If Docker available:
sudo mkdir -p /var/lib/owntracks-recorder
docker run -d --name owntracks-recorder \
  --restart unless-stopped \
  -p 8083:8083 \
  -v /var/lib/owntracks-recorder:/store \
  owntracks/recorder:latest \
  --mqtt-host localhost \
  --mqtt-port 1883
```

Document which approach worked and the Recorder's port (default 8083).

---

### Step 3 — Create systemd service for Recorder (if built from source)

Create `/etc/systemd/system/owntracks-recorder.service`:

```ini
[Unit]
Description=OwnTracks Recorder
After=mosquitto.service
Requires=mosquitto.service

[Service]
ExecStart=/usr/local/sbin/ot-recorder --mqtt-host 127.0.0.1 --mqtt-port 1883 \
  --http-port 8083 --storage /var/lib/owntracks-recorder
Restart=on-failure
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable owntracks-recorder
sudo systemctl start owntracks-recorder
sudo systemctl status owntracks-recorder
```

---

### Step 4 — Test the Recorder HTTP API

```bash
curl http://localhost:8083/api/0/version
curl http://localhost:8083/api/0/list?user=nick&device=iphone
```

The version endpoint should return JSON. The list endpoint returns location history.

---

### Step 5 — iPhone OwnTracks app setup

Document these settings for Nick to configure in the OwnTracks iOS app:

```
Mode: MQTT (not HTTP)
Host: pi-dev.tailecb90f.ts.net
Port: 1883
TLS: OFF (Tailscale provides encryption)
Topic: owntracks/nick/iphone
Client ID: neuro-nick-iphone
Username: (leave blank)
Password: (leave blank)
Monitoring: Significant Changes (battery-friendly)
```

These go in OwnTracks → Settings → Connection.

Add to Pi `.env`:
```
OWNTRACKS_RECORDER_URL=http://localhost:8083
OWNTRACKS_USER=nick
OWNTRACKS_DEVICE=iphone
```

Add to `backend/.env.example`:
```
# OwnTracks location dwell detection
# Requires Mosquitto + OwnTracks Recorder running on Pi
# See NEURO-owntracks-prompt.md for setup instructions
OWNTRACKS_RECORDER_URL=http://localhost:8083
OWNTRACKS_USER=nick
OWNTRACKS_DEVICE=iphone
```

---

## Part 2 — NEURO location service

### Step 6 — Create `backend/services/location.js`

```js
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
```

`node --check backend/services/location.js`

---

### Step 7 — Add location endpoint `backend/routes/location.js`

```js
'use strict';

const express = require('express');
const router = express.Router();
const location = require('../services/location');

// GET /api/location/today — today's dwell summary
router.get('/today', async (req, res) => {
  try {
    const dwells = await location.getCachedDwells();
    res.json({ dwells, configured: location.isConfigured() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/location/status
router.get('/status', (req, res) => {
  res.json({ configured: location.isConfigured() });
});

module.exports = router;
```

Register in `backend/server.js` — read the file, add:
```js
app.use('/api/location', require('./routes/location'));
```

`node --check backend/routes/location.js`
`node --check backend/server.js`

---

### Step 8 — Inject location into journal prompts

Read `backend/routes/journal.js`. After the Apple Health context block, add:

```js
    // Add OwnTracks location context
    try {
      const locationService = require('../services/location');
      if (locationService.isConfigured()) {
        const locationSummary = await locationService.getLocationSummaryForJournal();
        if (locationSummary) {
          contextSummary = contextSummary === 'No daily note found for today.'
            ? locationSummary
            : contextSummary + '\n\n' + locationSummary;
          console.log('[Journal] Location context added:', locationSummary);
        }
      }
    } catch (e) {
      console.warn('[Journal] Location context failed:', e.message);
    }
```

Also update the Claude system prompt in journal.js to mention location data:

Find:
```
- If no health data at all, ask about physical energy/wellbeing in general terms
```

Add after it:
```
- If location data is present showing somewhere other than usual, ask about it — "you spent time at X, what was that about?"
- If location shows Nick was out and about, factor that into energy/recovery questions
- Do not reference specific coordinates — only named places
```

`node --check backend/routes/journal.js`

---

### Step 9 — Inject location into Claude chat context

Read `backend/services/claude.js`. After the Apple Health context block, add:

```js
  // OwnTracks location context
  try {
    const locationService = require('./location');
    if (locationService.isConfigured()) {
      const locationBlock = await locationService.getLocationContextBlock();
      if (locationBlock) {
        parts.push(locationBlock);
        diagnostics.push('location: yes');
      }
    }
  } catch (e) {
    diagnostics.push('location: error');
  }
```

Note: `buildContextBlock` is already async (made async for Strava). This await is fine.

`node --check backend/services/claude.js`

---

### Step 10 — Add location status to AdminPanel

Read `backend/server.js`. Find the `/api/status` endpoint. Add to the response:

```js
    location: {
      configured: require('./services/location').isConfigured(),
      recorderUrl: process.env.OWNTRACKS_RECORDER_URL || null
    }
```

Read `frontend/src/components/AdminPanel.jsx`. Add location to the integrations array:

```js
    {
      name: 'OwnTracks (Location)',
      status: status.location?.configured ? 'connected' : 'unconfigured',
      detail: status.location?.configured
        ? `Recorder at ${status.location.recorderUrl}`
        : 'OWNTRACKS_RECORDER_URL not set — see setup guide'
    }
```

---

## Verification

```
node --check backend/services/location.js
node --check backend/routes/location.js
node --check backend/routes/journal.js
node --check backend/services/claude.js
node --check backend/server.js
cd frontend && npm run build
```

---

## After all changes

1. Write `NEURO-owntracks-results.md` with:
   - Mosquitto: installed and running yes/no
   - Recorder: installed via which method (deb/source/Docker), running yes/no
   - Recorder API responding yes/no (`curl http://localhost:8083/api/0/version`)
   - OWNTRACKS_* env vars added to Pi .env yes/no
   - `pm2 restart neuro` run yes/no
   - Any errors encountered

2. iPhone setup instructions for Nick (include in results file):
   ```
   OwnTracks iOS App Settings:
   Mode: MQTT
   Host: pi-dev.tailecb90f.ts.net (or 100.69.158.50)
   Port: 1883
   TLS: OFF
   Topic base: owntracks/nick/iphone
   Monitoring mode: Significant Changes
   Username/Password: leave blank
   ```

3. Do not commit to git

---

## How it works end-to-end

1. OwnTracks iOS app runs in background, uses iOS Significant Location Changes
   (battery efficient — only updates when you actually move somewhere)
2. Updates sent via MQTT to Mosquitto on Pi (over Tailscale)
3. OwnTracks Recorder stores them with timestamps in /var/lib/owntracks-recorder
4. At journal time (21:00), NEURO queries Recorder HTTP API for today's points
5. Points are clustered by proximity (200m radius = same place)
6. Short stops (<20 min) are filtered out
7. Remaining dwells are reverse geocoded via Nominatim
8. "Locations today: gym (07:15–08:30, 1h15m); town centre (12:30–14:00, 1h30m)"
9. This goes into journal prompt context — Claude asks about it specifically
10. Also injected into every NEURO chat message context
