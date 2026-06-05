#!/usr/bin/env python3
# SARA Watch-presence service — always-on passive BLE presence for the auto-lock.
#
# Proven this session: the Pi can passively detect the Apple Watch via its IRK
# (~2.4 adverts/sec, screen off, on wrist) with RSSI. No pairing, no Home Assistant.
#
# Detection rule (tuned with Nick via a step-distance test):
#   - Sample RSSI every 0.5s -> a rolling window of the last 10 samples (= 5 seconds).
#   - A sample is "near" if its RSSI is stronger than RSSI_THRESHOLD (default -60),
#     "far" if weaker OR if no advert was heard in that 0.5s slot (no signal = away).
#   - Flip to PRESENT when >=8 of the last 10 samples are "near".
#   - Flip to AWAY    when >=8 of the last 10 samples are "far".
#   - Otherwise hold current state (hysteresis kills 1-2 noisy samples).
# Measured bands: desk -52..-57; 2-3m -63..-76; doorway -69..-78. -60 cleanly splits
# "at desk" from "left the desk".
#
# Writes a small JSON status file atomically for the SARA backend to read.
# Status file fields: status, away, present, rssi, near_count (of last 10),
#   last_seen_s, hits, updated, source.
#
# Run (service):  sudo ./venv/bin/python watch-presence-service.py
# Env overrides:  WATCH_IRK, WATCH_RSSI_THRESHOLD, WATCH_NEEDED, WATCH_WINDOW,
#                 WATCH_SAMPLE_INTERVAL, WATCH_STATUS_FILE

import asyncio
import json
import os
import time
from collections import deque
from datetime import datetime, timezone

from bleak import BleakScanner
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

# IRK is a sensitive device key — never hardcoded. Read from WATCH_IRK env (set by the
# systemd unit via a local-only EnvironmentFile, /etc/sara-watch.env, which is NOT in git).
IRK_HEX = os.environ.get("WATCH_IRK", "").strip()
if not IRK_HEX:
    raise SystemExit("WATCH_IRK env var is required (set it in /etc/sara-watch.env)")
IRK_BYTES = bytes.fromhex(IRK_HEX)

RSSI_THRESHOLD = int(os.environ.get("WATCH_RSSI_THRESHOLD", "-60"))  # near if stronger
WINDOW = int(os.environ.get("WATCH_WINDOW", "10"))        # samples in rolling window
NEEDED = int(os.environ.get("WATCH_NEEDED", "8"))         # how many to flip (8 of 10)
SAMPLE_INTERVAL = float(os.environ.get("WATCH_SAMPLE_INTERVAL", "0.5"))  # seconds/sample
STATUS_FILE = os.environ.get("WATCH_STATUS_FILE", os.path.expanduser("~/watch-irk/presence.json"))

# Latest advert seen since the last sample tick (reset each tick).
latest = {"rssi": None, "t": 0.0}
state = {"status": "unknown", "hits": 0, "last_seen": 0.0}
window = deque(maxlen=WINDOW)  # booleans: True = "near"


def is_our_watch(address: str) -> bool:
    # Fresh cipher per call — get_cipher_for_irk returns a stateful object that
    # silently returns False if reused.
    try:
        return bool(resolve_private_address(get_cipher_for_irk(IRK_BYTES), address))
    except Exception:
        return False


def on_detect(device, adv):
    if is_our_watch(device.address):
        latest["rssi"] = adv.rssi
        latest["t"] = time.monotonic()
        state["hits"] += 1
        state["last_seen"] = time.monotonic()


def write_status(rssi_now, near_count):
    now = time.monotonic()
    age = (now - state["last_seen"]) if state["last_seen"] else None
    payload = {
        "status": state["status"],
        "away": state["status"] == "away",
        "present": state["status"] == "present",
        "rssi": rssi_now,
        "near_count": near_count,          # of last WINDOW samples
        "window": WINDOW,
        "needed": NEEDED,
        "threshold": RSSI_THRESHOLD,
        "last_seen_s": round(age, 1) if age is not None else None,
        "hits": state["hits"],
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": "watch-ble",
    }
    tmp = STATUS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, STATUS_FILE)  # atomic — SARA never reads a half-written file


async def main():
    assert is_our_watch("4B:7F:44:E3:37:88"), "IRK self-test failed — wrong key?"
    print(f"[watch-presence] self-test PASS; threshold={RSSI_THRESHOLD}dBm, "
          f"flip on {NEEDED}/{WINDOW} samples @ {SAMPLE_INTERVAL}s "
          f"(~{WINDOW*SAMPLE_INTERVAL:.0f}s window); file={STATUS_FILE}", flush=True)

    scanner = BleakScanner(detection_callback=on_detect, scanning_mode="active")
    await scanner.start()
    last_status = None
    ticks = 0
    try:
        while True:
            await asyncio.sleep(SAMPLE_INTERVAL)
            ticks += 1
            now = time.monotonic()
            # This tick's sample: use an advert seen within the last interval; if none,
            # it's a "far" sample (no signal => away-leaning, so power-off/out-of-range
            # correctly drives toward AWAY).
            fresh = latest["rssi"] is not None and (now - latest["t"]) <= SAMPLE_INTERVAL * 2
            rssi_now = latest["rssi"] if fresh else None
            near = fresh and rssi_now > RSSI_THRESHOLD
            window.append(bool(near))

            near_count = sum(window)
            far_count = len(window) - near_count
            # Only decide once the window is full, so we never flip on partial data.
            if len(window) == WINDOW:
                if near_count >= NEEDED:
                    state["status"] = "present"
                elif far_count >= NEEDED:
                    state["status"] = "away"
                # else hold

            # Write the status file at ~3s cadence (every 6 ticks) to limit disk churn.
            if ticks % 6 == 0:
                write_status(rssi_now, near_count)

            if state["status"] != last_status:
                write_status(rssi_now, near_count)
                print(f"[watch-presence] -> {state['status']} "
                      f"(near {near_count}/{WINDOW}, rssi={rssi_now})", flush=True)
                last_status = state["status"]
    finally:
        await scanner.stop()


if __name__ == "__main__":
    asyncio.run(main())
