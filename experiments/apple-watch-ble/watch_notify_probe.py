#!/usr/bin/env python3
# Probe the Watch's notify characteristics — connect (unpaired), subscribe to every
# notify/indicate characteristic, and log raw payloads for N seconds. Purely
# observational: we want to SEE what (if anything) streams without Apple pairing crypto.

import asyncio
import sys
import time

from bleak import BleakScanner, BleakClient
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

IRK_BYTES = bytes.fromhex("2dbfa199fa42d060551738470e010f2e")
DUR = int(sys.argv[1]) if len(sys.argv) > 1 else 60

t0 = time.monotonic()
counts = {}


def is_watch(a):
    try:
        return bool(resolve_private_address(get_cipher_for_irk(IRK_BYTES), a))
    except Exception:
        return False


def make_handler(uuid):
    def h(_char, data: bytearray):
        counts[uuid] = counts.get(uuid, 0) + 1
        print(f"  [{time.monotonic()-t0:5.1f}s] NOTIFY {uuid[:8]}  ({len(data)}B)  {bytes(data).hex()}",
              flush=True)
    return h


async def main():
    print("=== find Watch ===", flush=True)
    found = {}
    def cb(d, a):
        if "addr" not in found and is_watch(d.address):
            found["addr"] = d.address
            print(f"  Watch {d.address} rssi={a.rssi}", flush=True)
    s = BleakScanner(detection_callback=cb, scanning_mode="active")
    await s.start()
    for _ in range(20):
        if found:
            break
        await asyncio.sleep(0.5)
    await s.stop()
    if not found:
        print("  not found"); return

    print(f"=== connect {found['addr']} ===", flush=True)
    async with BleakClient(found["addr"], timeout=20.0) as c:
        print(f"  connected={c.is_connected}", flush=True)
        subbed = []
        for svc in c.services:
            for ch in svc.characteristics:
                if "notify" in ch.properties or "indicate" in ch.properties:
                    try:
                        await c.start_notify(ch.uuid, make_handler(ch.uuid))
                        subbed.append(ch.uuid)
                        print(f"  subscribed: {ch.uuid} [{','.join(ch.properties)}]", flush=True)
                    except Exception as e:
                        print(f"  sub FAILED {ch.uuid}: {e}", flush=True)
        if not subbed:
            print("  no notify chars to subscribe")
            return
        print(f"\n=== listening {DUR}s (move/tap the Watch to trigger activity) ===", flush=True)
        await asyncio.sleep(DUR)
        print("\n=== notification counts ===")
        for u in subbed:
            print(f"  {u}: {counts.get(u,0)}")
        print("RESULT: see counts above — non-zero means that channel streams data unpaired.")


if __name__ == "__main__":
    asyncio.run(main())
