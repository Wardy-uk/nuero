#!/usr/bin/env python3
# Watch presence detector — verify build (no Home Assistant, no pairing).
#
# Passively scans BLE, resolves every advert against the Watch IRK, and runs a simple
# present/away state machine. Also DUMPS the full advertisement payload for our Watch
# (manufacturer data, service data/UUIDs, TX power) so we can see what's mineable
# without ever pairing/connecting.
#
# Present/away tuning comes from the walk-away capture:
#   - PRESENT while seen within PRESENT_WINDOW seconds
#   - AWAY (lock) once not seen for AWAY_TIMEOUT seconds
# RSSI is logged but NOT used as the lock trigger (a wall barely dents it; the real
# "gone" signal is detections stopping).
#
# Run:  sudo ./venv/bin/python watch_presence.py [seconds]   (default 120; 0 = forever)

import asyncio
import sys
import time

from bleak import BleakScanner
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

IRK_HEX = "2dbfa199fa42d060551738470e010f2e"  # true byte-reverse of BlueZ on-disk key
IRK_BYTES = bytes.fromhex(IRK_HEX)

PRESENT_WINDOW = 15.0   # seen within this many seconds => present
AWAY_TIMEOUT = 25.0     # not seen for this long => away (lock)

APPLE_COMPANY_ID = 0x004C

state = {
    "last_seen": 0.0,
    "last_rssi": None,
    "hits": 0,
    "status": "unknown",   # present | away | unknown
    "addr": None,
    "dumped": False,
}


def is_our_watch(address: str) -> bool:
    # Fresh cipher per call — get_cipher_for_irk returns a stateful object that
    # silently returns False if reused.
    try:
        return bool(resolve_private_address(get_cipher_for_irk(IRK_BYTES), address))
    except Exception:
        return False


def dump_advert(device, adv):
    """One-time dump of everything in our Watch's advertisement (no pairing needed)."""
    print("  ── WATCH ADVERTISEMENT CONTENTS ──")
    print(f"     address      : {device.address}")
    print(f"     name         : {adv.local_name!r}")
    print(f"     rssi         : {adv.rssi} dBm")
    print(f"     tx_power     : {adv.tx_power}")
    print(f"     service_uuids: {adv.service_uuids or '(none)'}")
    if adv.service_data:
        for u, d in adv.service_data.items():
            print(f"     service_data : {u} = {d.hex()}")
    else:
        print("     service_data : (none)")
    if adv.manufacturer_data:
        for cid, d in adv.manufacturer_data.items():
            who = "Apple/Continuity" if cid == APPLE_COMPANY_ID else f"company 0x{cid:04x}"
            print(f"     manuf_data   : {who} = {d.hex()}")
            if cid == APPLE_COMPANY_ID and d:
                # First byte is the Continuity message type (0x10 nearby-info,
                # 0x0c handoff, 0x05 airdrop, etc.) — informational only.
                print(f"                    (continuity type=0x{d[0]:02x}, {len(d)} bytes)")
    else:
        print("     manuf_data   : (none)")
    print("  ──────────────────────────────────")


def on_detect(device, adv):
    if not is_our_watch(device.address):
        return
    now = time.monotonic()
    state["hits"] += 1
    state["last_seen"] = now
    state["last_rssi"] = adv.rssi
    state["addr"] = device.address
    if not state["dumped"]:
        dump_advert(device, adv)
        state["dumped"] = True


async def main():
    duration = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    assert is_our_watch("4B:7F:44:E3:37:88"), "resolver self-test failed"
    print("resolver self-test: PASS")
    print(f"PRESENT if seen <{PRESENT_WINDOW:.0f}s ago; AWAY (lock) after {AWAY_TIMEOUT:.0f}s unseen.")
    print("Watch its status change as you move around / leave the room.\n", flush=True)

    scanner = BleakScanner(detection_callback=on_detect, scanning_mode="active")
    await scanner.start()
    t0 = time.monotonic()
    try:
        while duration == 0 or time.monotonic() - t0 < duration:
            await asyncio.sleep(2.0)
            now = time.monotonic()
            age = (now - state["last_seen"]) if state["last_seen"] else 9999
            new = "present" if age < PRESENT_WINDOW else ("away" if age >= AWAY_TIMEOUT else state["status"])
            if new != state["status"] and new in ("present", "away"):
                arrow = "🟢 PRESENT" if new == "present" else "🔴 AWAY  (SARA would lock)"
                print(f"  >>> STATE CHANGE -> {arrow}   (after {age:.0f}s unseen)" if new == "away"
                      else f"  >>> STATE CHANGE -> {arrow}", flush=True)
                state["status"] = new
            t = int(now - t0)
            rssi = state["last_rssi"]
            print(f"    [{t:>3}s] status={state['status']:<7} last_seen={age:5.1f}s rssi={rssi} hits={state['hits']}",
                  flush=True)
    finally:
        await scanner.stop()
    print(f"\nDONE — {state['hits']} detections in {duration}s, final status={state['status']}")


if __name__ == "__main__":
    asyncio.run(main())
