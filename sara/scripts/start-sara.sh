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

# --- Clear a stale Chromium profile lock ---
# A kiosk session that was killed un-cleanly (power-off, crash, closing the panel
# trap mid-launch) can leave SingletonLock/Cookie/Socket pointing at a dead PID.
# Under --kiosk --noerrdialogs Chromium then suppresses the "profile in use" dialog
# and simply never opens a window — i.e. "SARA won't load from the desktop". Only
# remove the locks when NO chromium is running, so we never disturb a live session.
if ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then
  rm -f "$HOME/.config/chromium/SingletonLock" \
        "$HOME/.config/chromium/SingletonCookie" \
        "$HOME/.config/chromium/SingletonSocket" 2>/dev/null || true
fi

# --- Hide the Pi taskbar (wf-panel-pi) for the SARA session ---
# On Pi OS labwc the panel is supervised by lwrespawn (it respawns if simply
# killed) and reserves a layer-shell zone, so a kiosk window can't cover it. We
# stop the supervisor + panel for the duration of the SARA session and restore
# them on exit. No-op on desktops without wf-panel-pi (other distros, X11, etc.).
PANEL_HIDDEN=0
restore_panel() {
  if [ "$PANEL_HIDDEN" = "1" ]; then
    # Respawn exactly as the desktop autostart does, so it's supervised again.
    nohup /usr/bin/lwrespawn /usr/bin/wf-panel-pi >/dev/null 2>&1 &
    PANEL_HIDDEN=0
  fi
}
if command -v wf-panel-pi >/dev/null 2>&1 && pgrep -x wf-panel-pi >/dev/null 2>&1; then
  trap restore_panel EXIT INT TERM
  pkill -f 'lwrespawn .*wf-panel-pi' 2>/dev/null || true  # stop the respawner first
  pkill -x wf-panel-pi 2>/dev/null || true                # then the panel itself
  PANEL_HIDDEN=1
fi

# Open the UI full-screen (kiosk). Run in the FOREGROUND (no exec) so the panel is
# restored when the browser closes. Canonical kiosk is just `--kiosk <url>`; the
# previous `--app` flag is redundant under kiosk and can suppress fullscreen.
#
# --password-store=basic: this is an auto-login kiosk with no login password, so the
# GNOME "login" keyring is never unlocked at boot. Without this flag Chromium tries to
# use the Secret Service for its cookie store and throws an "Unlock Keyring" dialog on
# every launch — un-dismissable on a touchscreen with no keyboard. `basic` keeps the
# cookie store in a plain local file instead, so there is no keyring prompt. SARA holds
# no secrets in the browser, so there is nothing to protect here.
# --disk-cache-size=1 / --disable-application-cache: the SARA frontend is redeployed
# often; without this the kiosk serves a stale cached bundle after an update ("I can't
# see my change"). Disabling the HTTP cache makes every launch load the current build.
KIOSK_FLAGS="--kiosk --noerrdialogs --disable-infobars --password-store=basic --disk-cache-size=1 --disable-application-cache --aggressive-cache-discard"
if command -v chromium-browser >/dev/null 2>&1; then
  chromium-browser $KIOSK_FLAGS "$SARA_URL"
elif command -v chromium >/dev/null 2>&1; then
  chromium $KIOSK_FLAGS "$SARA_URL"
elif command -v firefox >/dev/null 2>&1; then
  firefox --kiosk "$SARA_URL"
else
  xdg-open "$SARA_URL"
fi
