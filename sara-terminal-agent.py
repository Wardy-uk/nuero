#!/usr/bin/env python3
# SARA terminal agent — turns this Pi into a presence-aware SARA terminal.
#
# Watches the local watch-presence service (presence.json) and acts on STATE
# TRANSITIONS only (not every tick), implementing the agreed behaviour:
#
#   -> PRESENT (you arrived at this station):
#        * wake the display            (wlopm --on)
#        * launch the SARA kiosk if it isn't running
#        * report station present=true to SARA   (POST /api/location/station)
#
#   -> AWAY (you left):
#        * report station present=false to SARA
#        * blank the display           (wlopm --off)
#        * fallback: if blanking fails, lock SARA in-app (best-effort)
#
# Stage 1: SARA backend is this same Pi. Stage 2 (central NEURO server, many terminals):
# only SARA_URL changes — the agent already speaks to SARA purely over HTTP, exactly as a
# remote terminal would. STATION_NAME identifies which terminal this is.
#
# Deliberately dependency-light: stdlib only (urllib), reads the presence file the
# watch-presence service already writes, shells out to wlopm / the kiosk launcher.

import json
import os
import subprocess
import time
import urllib.request

STATION_NAME = os.environ.get("STATION_NAME", "living-room")
SARA_URL = os.environ.get("SARA_URL", "http://localhost:3005").rstrip("/")
PRESENCE_FILE = os.environ.get("WATCH_STATUS_FILE", "/home/nickw/watch-irk/presence.json")
DISPLAY_OUTPUT = os.environ.get("DISPLAY_OUTPUT", "DSI-1")
KIOSK_LAUNCHER = os.environ.get("KIOSK_LAUNCHER", "/mnt/data/nuero/sara/scripts/start-sara.sh")
POLL_S = float(os.environ.get("AGENT_POLL_S", "1.0"))

# Wayland env the display/kiosk commands need (this Pi: labwc on wayland-0).
WL_ENV = {
    **os.environ,
    "XDG_RUNTIME_DIR": "/run/user/1000",
    "WAYLAND_DISPLAY": "wayland-0",
    "DISPLAY": ":0",
}


def log(msg):
    print(f"[terminal-agent] {msg}", flush=True)


def read_presence():
    """Return 'present' | 'away' | None (unknown/unreadable)."""
    try:
        with open(PRESENCE_FILE) as f:
            d = json.load(f)
        st = d.get("status")
        return st if st in ("present", "away") else None
    except Exception:
        return None


def display(on: bool):
    try:
        subprocess.run(["wlopm", "--on" if on else "--off", DISPLAY_OUTPUT],
                       env=WL_ENV, timeout=8, check=False)
        return True
    except Exception as e:
        log(f"display {'on' if on else 'off'} failed: {e}")
        return False


def kiosk_running() -> bool:
    try:
        r = subprocess.run(["pgrep", "-x", "chromium"], timeout=5,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return r.returncode == 0
    except Exception:
        return False


def launch_kiosk():
    try:
        subprocess.Popen(
            ["setsid", "bash", KIOSK_LAUNCHER],
            env=WL_ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, start_new_session=True,
        )
        log("kiosk launch dispatched")
    except Exception as e:
        log(f"kiosk launch failed: {e}")


def post_json(path, payload):
    try:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{SARA_URL}{path}", data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception as e:
        log(f"POST {path} failed: {e}")
        return False


def report_station(present: bool):
    ok = post_json("/api/location/station",
                   {"station": STATION_NAME, "present": present, "source": "watch-ble"})
    log(f"reported station present={present} -> {'ok' if ok else 'FAILED'}")


def on_present():
    # Station reporting ONLY. The lock is the in-app SARA overlay (driven by
    # /api/presence), and the kiosk stays running full-time — so the agent must NOT
    # touch the display or relaunch chromium (that caused the white-screen failures:
    # power-cycling the panel corrupted Chromium's GL render).
    log("TRANSITION -> PRESENT (arrived)")
    report_station(True)


def on_away():
    log("TRANSITION -> AWAY (left)")
    report_station(False)


def main():
    log(f"station={STATION_NAME} sara={SARA_URL} presence_file={PRESENCE_FILE} "
        f"(station-reporting only; display untouched)")
    last = None
    while True:
        cur = read_presence()
        if cur and cur != last:
            if cur == "present":
                on_present()
            elif cur == "away":
                on_away()
            last = cur
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
