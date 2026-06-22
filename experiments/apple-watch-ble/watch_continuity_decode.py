#!/usr/bin/env python3
# Decode the Watch's Continuity "Nearby Info" advert EMPIRICALLY.
#
# We capture every Apple manufacturer advert from our Watch and show how the bytes
# change over time. Rather than asserting bit meanings from memory (error-prone), we
# DIFF: bytes that change when you lock/unlock/raise-wrist are usable state; bytes that
# rotate randomly are the auth tag. Prompts you through interactions and timestamps
# each change so we can correlate.
#
# Run:  sudo ./venv/bin/python watch_continuity_decode.py [seconds]   (default 75)

import sys
import time
import asyncio

from bleak import BleakScanner
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

IRK_BYTES = bytes.fromhex("2dbfa199fa42d060551738470e010f2e")
APPLE = 0x004C
DUR = int(sys.argv[1]) if len(sys.argv) > 1 else 75
t0 = time.monotonic()

seen = {}           # full hex -> count
last_nearby = {"status": None, "flags": None}
# Known Apple Nearby-Info action codes (low nibble of status byte) — best-effort labels;
# we VERIFY against observed behaviour rather than trusting them blindly.
ACTION = {
    0x00: "unknown", 0x01: "idle?", 0x03: "idle", 0x05: "audio(locked)",
    0x07: "active/screen-on", 0x09: "video", 0x0A: "wrist+unlocked",
    0x0B: "recent-interaction", 0x0D: "driving", 0x0E: "call",
}


def is_watch(a):
    try:
        return bool(resolve_private_address(get_cipher_for_irk(IRK_BYTES), a))
    except Exception:
        return False


def parse_nearby(data: bytes):
    # data = full Apple manuf payload, e.g. 10 05 <status> <flags> <auth...>
    if len(data) < 4 or data[0] != 0x10:
        return None
    status, flags = data[2], data[3]
    auth = data[4:].hex()
    return status, flags, auth


def cb(device, adv):
    if not is_watch(device.address):
        return
    md = adv.manufacturer_data.get(APPLE)
    if not md:
        return
    hx = md.hex()
    seen[hx] = seen.get(hx, 0) + 1
    p = parse_nearby(md)
    if not p:
        return
    status, flags, auth = p
    if status != last_nearby["status"] or flags != last_nearby["flags"]:
        action = status & 0x0F
        sflags = (status & 0xF0) >> 4
        label = ACTION.get(action, f"code 0x{action:x}")
        print(f"  [{time.monotonic()-t0:5.1f}s] STATUS CHANGE  "
              f"status=0x{status:02x}(action={label},flags=0x{sflags:x})  "
              f"dataflags=0x{flags:02x}  auth={auth}", flush=True)
        last_nearby["status"] = status
        last_nearby["flags"] = flags


async def main():
    assert is_watch("4B:7F:44:E3:37:88"), "self-test failed"
    print("resolver self-test: PASS")
    print("Interact with the Watch on cue; we log every status/flags change.\n")
    s = BleakScanner(detection_callback=cb, scanning_mode="active")
    await s.start()
    cues = [
        (3,  ">>> hold still, screen OFF, on wrist"),
        (18, ">>> RAISE WRIST / tap to wake the screen"),
        (33, ">>> LOCK the watch (cover the screen / press side)"),
        (48, ">>> open an app / start interacting"),
        (63, ">>> take it OFF your wrist"),
    ]
    ci = 0
    while time.monotonic() - t0 < DUR:
        await asyncio.sleep(0.5)
        el = time.monotonic() - t0
        if ci < len(cues) and el >= cues[ci][0]:
            print(f"\n{cues[ci][1]}", flush=True)
            ci += 1
    await s.stop()
    print("\n=== distinct full payloads seen (count) ===")
    for hx, n in sorted(seen.items(), key=lambda x: -x[1]):
        print(f"  {n:4d}x  {hx}")
    print("\nInterpretation: bytes that changed WITH your interactions = usable state;\n"
          "the trailing bytes that change every time regardless = rotating auth (ignore).")


if __name__ == "__main__":
    asyncio.run(main())
