# NEURO OwnTracks Setup Results — 2026-03-22

## Part 1 — Pi Infrastructure

| Component | Status |
|---|---|
| Mosquitto MQTT broker | installed, running, enabled on boot |
| Mosquitto config | `/etc/mosquitto/conf.d/owntracks.conf` — listener 1883, anonymous allowed |
| MQTT pub/sub test | passed |
| OwnTracks Recorder | Docker container (`owntracks/recorder:latest`), running, restart=unless-stopped |
| Recorder HTTP API | responding — `http://localhost:8083/api/0/version` returns `{"version":"1.0.1"}` |
| OWNTRACKS_* env vars | added to Pi `/home/nickw/nuero/backend/.env` |
| PM2 restart | done — nuero online |

### Docker container details
```
docker run -d --name owntracks-recorder \
  --restart unless-stopped \
  --network host \
  -e OTR_HOST=127.0.0.1 \
  -e OTR_PORT=1883 \
  -e OTR_HTTPPORT=8083 \
  -e OTR_STORAGEDIR=/store \
  -v /var/lib/owntracks-recorder:/store \
  owntracks/recorder:latest
```

Note: The prompt's `--mqtt-host` CLI flags don't work with the Docker image. Used `OTR_*` env vars instead.

## Part 2 — NEURO Service

| File | Action |
|---|---|
| `backend/services/location.js` | Created — dwell detection, clustering, geocoding, caching |
| `backend/routes/location.js` | Created — `/api/location/today` and `/api/location/status` |
| `backend/server.js` | Modified — registered location route, added location to `/api/status` |
| `backend/routes/journal.js` | Modified — location context injected after health block, system prompt updated |
| `backend/services/claude.js` | Modified — OwnTracks location block added after health block |
| `frontend/src/components/AdminPanel.jsx` | Modified — OwnTracks added to integrations list |

### Verification
- `node --check` passed on all 5 backend files
- `npm run build` passed — frontend builds clean
- `/api/location/status` returns `{"configured":true}`
- `/api/location/today` returns `{"dwells":[],"configured":true}` (correct — no phone data yet)
- `/api/status` includes `location: { configured: true, recorderUrl: "http://localhost:8083" }`

## iPhone OwnTracks App Setup

Configure in OwnTracks iOS app → Settings → Connection:

```
Mode:       MQTT
Host:       100.69.158.50  (Pi's Tailscale IP)
Port:       1883
TLS:        OFF  (Tailscale provides encryption)
Client ID:  neuro-nick-iphone
Username:   (leave blank)
Password:   (leave blank)
```

Under Settings → Reporting:
```
Monitoring:  Significant Changes  (battery-friendly)
```

The MQTT topic will be `owntracks/nick/iphone` by default.

**Important**: The phone must be on the Tailscale network to reach the Pi's MQTT broker. Make sure Tailscale is running on the iPhone.

## Errors Encountered
- OwnTracks Recorder Docker image does not accept `--mqtt-host` CLI flags (unrecognized option). Fixed by using `OTR_HOST`, `OTR_PORT`, `OTR_HTTPPORT` environment variables instead.

## Not committed to git
As instructed, no git commit was made.
