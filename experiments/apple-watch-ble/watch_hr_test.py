#!/usr/bin/env python3
# Test whether the Watch exposes a standard BLE Heart Rate Service during a workout.
# Connect (unpaired), enumerate ALL services, and if 0x180D / 0x2A37 exists, subscribe
# to live HR notifications. Also re-dumps the full service list to catch any
# workout-only services. Purely observational.

import asyncio, sys, time
from bleak import BleakScanner, BleakClient
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

IRK = bytes.fromhex("2dbfa199fa42d060551738470e010f2e")
HR_SVC = "0000180d-0000-1000-8000-00805f9b34fb"
HR_CHAR = "00002a37-0000-1000-8000-00805f9b34fb"
DUR = int(sys.argv[1]) if len(sys.argv) > 1 else 30
t0 = time.monotonic()

def is_watch(a):
    try: return bool(resolve_private_address(get_cipher_for_irk(IRK), a))
    except Exception: return False

def hr_handler(_c, data: bytearray):
    # HR Measurement: byte0 flags; if bit0=0 -> 8-bit bpm in byte1, else 16-bit LE.
    flags = data[0]
    bpm = data[1] if not (flags & 0x01) else int.from_bytes(data[1:3], "little")
    print(f"  [{time.monotonic()-t0:5.1f}s] ❤️  HR = {bpm} bpm   raw={bytes(data).hex()}", flush=True)

async def main():
    print("=== find Watch ===", flush=True)
    found = {}
    def cb(d, a):
        if "addr" not in found and is_watch(d.address):
            found["addr"] = d.address; print(f"  {d.address} rssi={a.rssi}", flush=True)
    s = BleakScanner(detection_callback=cb, scanning_mode="active")
    await s.start()
    for _ in range(20):
        if found: break
        await asyncio.sleep(0.5)
    await s.stop()
    if not found: print("  not found"); return

    print(f"=== connect {found['addr']} ===", flush=True)
    try:
        async with BleakClient(found["addr"], timeout=20.0) as c:
            print(f"  connected={c.is_connected}\n=== services ===", flush=True)
            has_hr = False
            for svc in c.services:
                mark = "  <-- HEART RATE!" if svc.uuid.lower()==HR_SVC else ""
                print(f"  {svc.uuid}  ({svc.description}){mark}", flush=True)
                if svc.uuid.lower()==HR_SVC: has_hr = True
            if not has_hr:
                print("\nRESULT: ❌ no 0x180D Heart Rate Service exposed (even during workout).")
                return
            print("\n=== HR service present — subscribing to live measurements ===", flush=True)
            await c.start_notify(HR_CHAR, hr_handler)
            await asyncio.sleep(DUR)
            await c.stop_notify(HR_CHAR)
            print("\nRESULT: ✅ Heart Rate readable — see bpm above.")
    except Exception as e:
        print(f"  FAILED: {type(e).__name__}: {e}")
        print("\nRESULT: ❌ connect/subscribe failed.")

asyncio.run(main())
