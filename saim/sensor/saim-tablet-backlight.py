#!/usr/bin/env python3
"""SAiM tablet backlight - the room tablets' half of night mode (22 Oct 2026).

Nick: the bedroom Fire was "too bright past lights out". The page already draws
a night overlay, but Fully's free version has no JavaScript brightness
interface, so the panel itself stayed at whatever it was set to (88/255) - an
overlay on a lit LCD is still a lit LCD in a dark bedroom.

This runs on pi5, which already holds ADB to the house tablets, and does for them
what saim-display-agent.py does for the Pi's panel: it reads the SAME verdict
(`/api/presence/display?room=<room>`) and sets the Android backlight -
`night.dim` (or the house being empty, `locked`) takes it to the floor, anything
else puts back what it found.

ONE DECISION, MORE OBEYERS. When it is night and whether he has just touched
the screen are decided by saim/backend's night.js and nowhere else.

IT FAILS TOWARDS LIGHT. No verdict, an unknown state, an ADB error - the
brightness it found at start is put back. A dark tablet that cannot be told
from a dead one is the worse failure.

Config (environment):
  SAIM_TABLETS        room=host:port;room=host:port   e.g. bedroom=192.168.1.101:5555
  SAIM_DISPLAY_URL    e.g. http://localhost:3005/api/presence/display
  SAIM_TABLET_NIGHT   brightness at night, 0-255 (default 1 - dim, never off)
  SAIM_TABLET_POLL_S  seconds between verdicts (default 5)
"""

import json
import os
import subprocess
import time
import urllib.parse
import urllib.request

TABLETS = {}
for pair in os.environ.get("SAIM_TABLETS", "").split(";"):
    if "=" in pair:
        room, host = pair.split("=", 1)
        if room.strip() and host.strip():
            TABLETS[room.strip()] = host.strip()
BASE = os.environ.get("SAIM_DISPLAY_URL", "http://localhost:3005/api/presence/display").strip()
NIGHT = max(0, min(255, int(os.environ.get("SAIM_TABLET_NIGHT", "1"))))
POLL_S = float(os.environ.get("SAIM_TABLET_POLL_S", "5"))
# Re-assert the level now and then even when nothing changed: the tablet can be
# touched, rebooted or have its own settings changed under us.
REASSERT_S = 300

if not TABLETS:
    raise SystemExit("SAIM_TABLETS is required (room=host:port;...)")


def adb(host, *args, timeout=8):
    try:
        r = subprocess.run(["adb", "-s", host, *args], stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, (r.stdout or "").strip()
    except Exception as e:
        return False, str(e)


def connected(host):
    ok, out = adb(host, "get-state", timeout=4)
    if ok and out == "device":
        return True
    try:
        subprocess.run(["adb", "connect", host], stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=6)
    except Exception:
        return False
    ok, out = adb(host, "get-state", timeout=4)
    return ok and out == "device"


def read_level(host):
    ok, out = adb(host, "shell", "settings", "get", "system", "screen_brightness")
    try:
        return int(out) if ok else None
    except ValueError:
        return None


def set_level(host, level):
    adb(host, "shell", "settings", "put", "system", "screen_brightness_mode", "0")
    ok, _ = adb(host, "shell", "settings", "put", "system", "screen_brightness", str(int(level)))
    return ok


def verdict(room):
    url = BASE + ("&" if "?" in BASE else "?") + "room=" + urllib.parse.quote(room)
    try:
        with urllib.request.urlopen(url, timeout=8) as r:
            d = json.loads(r.read())
        if d.get("state") not in ("full", "clock", "locked"):
            return None
        return d
    except Exception:
        return None


def main():
    state = {}  # room -> {"on": int, "last": int|None, "at": float}
    for room, host in TABLETS.items():
        on = read_level(host) if connected(host) else None
        # Started at night, the level found may already be the night level;
        # never adopt a dim level as "on".
        if on is None or on <= NIGHT + 4:
            on = int(os.environ.get("SAIM_TABLET_ON", "88"))
        state[room] = {"on": on, "last": None, "at": 0.0}
        print("[tablet] %s (%s) on=%d night=%d" % (room, host, on, NIGHT), flush=True)

    while True:
        for room, host in TABLETS.items():
            s = state[room]
            d = verdict(room)
            dim = bool(d and (d.get("state") == "locked"
                              or (isinstance(d.get("night"), dict) and d["night"].get("dim"))))
            want = NIGHT if dim else s["on"]
            now = time.time()
            if want == s["last"] and now - s["at"] < REASSERT_S:
                continue
            if not connected(host):
                if s["last"] is not None:
                    print("[tablet] %s unreachable over ADB" % room, flush=True)
                s["last"] = None
                continue
            if set_level(host, want):
                if want != s["last"]:
                    print("[tablet] %s -> %s (backlight %d)" % (room, "night" if dim else "lit", want), flush=True)
                s["last"], s["at"] = want, now
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
