#!/usr/bin/env python3
# Watch-presence POC — detect the Apple Watch directly by BLE, no Home Assistant.
#
# We already own the Watch's IRK. Apple Watches broadcast a rotating Resolvable
# Private Address (RPA); the IRK lets us recognise it. This continuously active-scans
# BLE, resolves every advert against the IRK, and reports when OUR watch is seen + its
# RSSI (signal strength → rough distance). That's everything SARA's auto-lock needs:
# "seen recently & close = present; not seen for N s = walked away".
#
# Uses HA's own proven resolver (bluetooth_data_tools) so the IRK math is byte-for-byte
# what already validated our key, and bleak for per-advertisement RSSI.
#
# Run:  python3 watch_presence_poc.py [seconds]   (default 45)

import asyncio
import sys
import time

from bleak import BleakScanner
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

# IRK = TRUE byte-reverse of the BlueZ on-disk key (2E0F...BF2D). Verified: this exact
# value resolves the Watch via bluetooth_data_tools. (An earlier hand-reversed string
# 2dbf...010e0f transposed the last 4 bytes and silently never matched — the bug.)
IRK_HEX = "2dbfa199fa42d060551738470e010f2e"
KNOWN_GOOD_ADDR = "4B:7F:44:E3:37:88"  # an RPA we previously confirmed resolves

IRK_BYTES = bytes.fromhex(IRK_HEX)

state = {"last_seen": 0.0, "last_rssi": None, "hits": 0, "first_seen": None}


def is_our_watch(address: str) -> bool:
    # NOTE: get_cipher_for_irk returns a stateful cipher that must NOT be reused across
    # calls — a reused cipher silently returns False. Build a fresh one every resolve.
    try:
        return bool(resolve_private_address(get_cipher_for_irk(IRK_BYTES), address))
    except Exception:
        return False


def on_detect(device, adv):
    if is_our_watch(device.address):
        now = time.monotonic()
        state["hits"] += 1
        state["last_seen"] = now
        state["last_rssi"] = adv.rssi
        if state["first_seen"] is None:
            state["first_seen"] = now
        print(f"  ⌚ WATCH  addr={device.address}  rssi={adv.rssi} dBm  (hit #{state['hits']})",
              flush=True)


async def main():
    duration = int(sys.argv[1]) if len(sys.argv) > 1 else 45

    # Self-test: prove our resolver matches the known-good address before trusting it.
    ok = is_our_watch(KNOWN_GOOD_ADDR)
    print(f"resolver self-test on {KNOWN_GOOD_ADDR}: {'PASS' if ok else 'FAIL'}", flush=True)
    print(f"active-scanning {duration}s — move the Watch near/far to see RSSI change…\n", flush=True)

    scanner = BleakScanner(detection_callback=on_detect, scanning_mode="active")
    await scanner.start()
    t0 = time.monotonic()
    try:
        # Print a heartbeat each second with seconds-since-last-seen.
        while time.monotonic() - t0 < duration:
            await asyncio.sleep(1.0)
            if state["last_seen"]:
                age = time.monotonic() - state["last_seen"]
                tag = "PRESENT" if age < 10 else "stale"
                print(f"    [{int(time.monotonic()-t0):>2}s] last_seen={age:4.1f}s ago "
                      f"rssi={state['last_rssi']} [{tag}]", flush=True)
    finally:
        await scanner.stop()

    print("\n=== SUMMARY ===")
    if state["hits"]:
        span = state["last_seen"] - state["first_seen"]
        print(f"  Watch detected {state['hits']}× over {span:.0f}s. Last RSSI {state['last_rssi']} dBm.")
        print(f"  Avg detection interval ≈ {span/max(1,state['hits']-1):.1f}s "
              f"(fine for presence/auto-lock).")
        print("  RESULT: ✅ direct BLE presence works — no Home Assistant needed.")
    else:
        print("  RESULT: ❌ Watch not detected. Wake it / bring it closer / check it's unbonded from the Pi.")


if __name__ == "__main__":
    asyncio.run(main())
