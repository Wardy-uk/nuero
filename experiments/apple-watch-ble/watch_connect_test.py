#!/usr/bin/env python3
# EMPIRICAL connection test — can we actually connect to the Watch (unpaired) and
# read any GATT data? No assumptions; just try it and report what happens.
#
# Steps:
#   1. Scan, resolve the Watch's current RPA via IRK.
#   2. Attempt a BLE GATT connection to that address.
#   3. If connected: enumerate all services/characteristics, try reading each readable
#      one, and print whatever comes back (battery, device info, etc.).
#   4. Report failures verbatim — no interpretation, just the truth.

import asyncio
import sys
import time

from bleak import BleakScanner, BleakClient
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

IRK_BYTES = bytes.fromhex("2dbfa199fa42d060551738470e010f2e")


def is_our_watch(addr: str) -> bool:
    try:
        return bool(resolve_private_address(get_cipher_for_irk(IRK_BYTES), addr))
    except Exception:
        return False


async def main():
    print("=== STEP 1: find the Watch's current address ===", flush=True)
    found = {"addr": None, "dev": None}

    def cb(device, adv):
        if found["addr"] is None and is_our_watch(device.address):
            found["addr"] = device.address
            found["dev"] = device
            print(f"  Watch at {device.address} rssi={adv.rssi}", flush=True)

    scanner = BleakScanner(detection_callback=cb, scanning_mode="active")
    await scanner.start()
    for _ in range(20):
        if found["addr"]:
            break
        await asyncio.sleep(0.5)
    await scanner.stop()

    if not found["addr"]:
        print("  Watch not found in 10s — bring it close + awake, retry.")
        return

    addr = found["addr"]
    print(f"\n=== STEP 2: attempt GATT connection to {addr} ===", flush=True)
    try:
        async with BleakClient(addr, timeout=20.0) as client:
            print(f"  CONNECTED = {client.is_connected}", flush=True)
            print("\n=== STEP 3: enumerate services / characteristics ===", flush=True)
            for svc in client.services:
                print(f"  service {svc.uuid}  ({svc.description})")
                for ch in svc.characteristics:
                    props = ",".join(ch.properties)
                    line = f"    char {ch.uuid} [{props}] {ch.description}"
                    if "read" in ch.properties:
                        try:
                            val = await client.read_gatt_char(ch.uuid)
                            line += f"  = {val.hex()}"
                            # decode common ones
                            if ch.uuid.startswith("00002a19"):  # battery level
                                line += f"  (battery {val[0]}%)"
                            elif ch.uuid.startswith("00002a29"):  # manufacturer
                                line += f"  ({val.decode(errors='replace')})"
                            elif ch.uuid.startswith("00002a24") or ch.uuid.startswith("00002a25") \
                                    or ch.uuid.startswith("00002a26") or ch.uuid.startswith("00002a28"):
                                line += f"  ({val.decode(errors='replace')})"
                        except Exception as e:
                            line += f"  (read failed: {e})"
                    print(line, flush=True)
            print("\nRESULT: ✅ connection + read worked (see above for available data).")
    except Exception as e:
        print(f"  CONNECT FAILED: {type(e).__name__}: {e}", flush=True)
        print("\nRESULT: ❌ could not connect/read unpaired. (Then passive presence is the path.)")


if __name__ == "__main__":
    asyncio.run(main())
