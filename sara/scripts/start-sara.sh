#!/usr/bin/env bash
# SARA Mission Control — Pi 5 desktop launcher (WS2-WP1).
#
# Opens the SARA UI full-screen on the Pi 5 desktop. This is the *display* launcher
# (what the SARA.desktop icon runs); the *runtime* is brought up separately and kept
# alive by PM2 (see runtime/start.sh + runtime/ecosystem.config.js). If the runtime
# is not answering, this script gives PM2 a best-effort nudge before opening a window.
set -euo pipefail

SARA_URL="${SARA_URL:-http://localhost:3005/}"
SARA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

health_ok() {
  curl -fsS "${SARA_URL}api/health" >/dev/null 2>&1
}

# Make sure the backend is actually answering before we open a window.
if ! health_ok; then
  echo "[sara] runtime not responding on ${SARA_URL} — nudging PM2"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 start "$SARA_DIR/runtime/ecosystem.config.js" --update-env >/dev/null 2>&1 \
      || pm2 restart sara-backend --update-env >/dev/null 2>&1 \
      || true
  fi
  # Give it up to ~10s to come up.
  for _ in $(seq 1 20); do
    health_ok && break
    sleep 0.5
  done
fi

if ! health_ok; then
  echo "[sara] backend still unreachable on ${SARA_URL}." >&2
  echo "[sara] bring the runtime up first:  bash ${SARA_DIR}/runtime/start.sh" >&2
  exit 1
fi

echo "[sara] opening Mission Control at ${SARA_URL}"

# Prefer Chromium in app/kiosk mode (Pi OS default browser); fall back gracefully.
if command -v chromium-browser >/dev/null 2>&1; then
  exec chromium-browser --kiosk --app="$SARA_URL" --noerrdialogs --disable-infobars
elif command -v chromium >/dev/null 2>&1; then
  exec chromium --kiosk --app="$SARA_URL" --noerrdialogs --disable-infobars
elif command -v firefox >/dev/null 2>&1; then
  exec firefox --kiosk "$SARA_URL"
else
  exec xdg-open "$SARA_URL"
fi
