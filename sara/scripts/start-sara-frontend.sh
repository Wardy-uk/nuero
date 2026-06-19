#!/usr/bin/env bash
# SARA frontend-node kiosk launcher (Pi 4 / pi-dev and future frontend Pis).
#
# Opens the SARA UI full-screen, pointed at a REMOTE sara-backend. Unlike
# start-sara.sh (which co-hosts the backend on the same box), a frontend node runs
# NO backend of its own — it is a pure display surface. The backend lives on the
# central brain (pi5). If the backend is briefly unreachable (e.g. this node booted
# first), we wait, then open anyway so the screen self-heals when the backend returns.
#
# Default target is pi5's TAILNET IP over plain HTTP. We deliberately avoid the
# pi5 :8443 tailnet-serve HTTPS URL: this node's MagicDNS resolves the funnel name
# to the public ingress, so :8443 (tailnet-only) TLS-fails here. IP:3005 sidesteps
# DNS + TLS entirely. sara-backend binds 0.0.0.0, so this is reachable over the tailnet.
set -uo pipefail

SARA_URL="${SARA_URL:-http://100.100.28.58:3005/}"   # pi5 tailnet IP, sara-backend :3005

health_ok() { curl -fsS "${SARA_URL}api/health" >/dev/null 2>&1; }

# Wait up to ~60s for the remote backend, then open regardless.
for _ in $(seq 1 120); do health_ok && break; sleep 0.5; done
health_ok || echo "[sara-fe] backend ${SARA_URL} unreachable — opening anyway, will recover" >&2

echo "[sara-fe] opening SARA at ${SARA_URL}"

# Clear a stale chromium profile lock ONLY when no chromium is running, so an
# un-clean previous kiosk session can't leave SARA stuck "in use, never opens".
if ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then
  rm -f "$HOME/.config/chromium/SingletonLock" \
        "$HOME/.config/chromium/SingletonCookie" \
        "$HOME/.config/chromium/SingletonSocket" 2>/dev/null || true
fi

# Hide the Pi taskbar (wf-panel-pi) for the SARA session; restore on exit. The panel
# is supervised by lwrespawn and reserves a layer-shell zone, so a kiosk window can't
# cover it unless we stop the supervisor + panel first.
PANEL_HIDDEN=0
restore_panel() {
  if [ "$PANEL_HIDDEN" = "1" ]; then
    nohup /usr/bin/lwrespawn /usr/bin/wf-panel-pi >/dev/null 2>&1 &
    PANEL_HIDDEN=0
  fi
}
if command -v wf-panel-pi >/dev/null 2>&1 && pgrep -x wf-panel-pi >/dev/null 2>&1; then
  trap restore_panel EXIT INT TERM
  pkill -f 'lwrespawn .*wf-panel-pi' 2>/dev/null || true
  pkill -x wf-panel-pi 2>/dev/null || true
  PANEL_HIDDEN=1
fi

# Canonical kiosk flags (mirrors start-sara.sh). --password-store=basic avoids the
# keyring prompt on an auto-login kiosk; cache-disabling flags make every launch load
# the current SARA build instead of a stale bundle. --ozone-platform=wayland is
# REQUIRED here: pi-dev has the raw Debian `chromium` (no rpi `chromium-browser`
# wrapper), which otherwise defaults to X11 ozone and dies with "Missing X server".
KIOSK_FLAGS="--ozone-platform=wayland --kiosk --noerrdialogs --disable-infobars --password-store=basic --disk-cache-size=1 --disable-application-cache --aggressive-cache-discard"
if command -v chromium-browser >/dev/null 2>&1; then
  chromium-browser $KIOSK_FLAGS "$SARA_URL"
elif command -v chromium >/dev/null 2>&1; then
  chromium $KIOSK_FLAGS "$SARA_URL"
elif command -v firefox >/dev/null 2>&1; then
  firefox --kiosk "$SARA_URL"
else
  xdg-open "$SARA_URL"
fi
