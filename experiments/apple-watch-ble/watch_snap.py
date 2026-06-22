#!/usr/bin/env python3
# Short snapshot of the Watch's Nearby-Info status/flags bytes. Run once per
# interaction state; compare output between runs to see which bytes track what.
import sys, time, asyncio
from bleak import BleakScanner
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

IRK = bytes.fromhex("2dbfa199fa42d060551738470e010f2e")
APPLE = 0x004C
DUR = int(sys.argv[1]) if len(sys.argv) > 1 else 12
nearby = {}   # (status,flags) -> count
other = {}

def is_watch(a):
    try: return bool(resolve_private_address(get_cipher_for_irk(IRK), a))
    except Exception: return False

def cb(d, adv):
    if not is_watch(d.address): return
    md = adv.manufacturer_data.get(APPLE)
    if not md: return
    # walk concatenated TLVs: <type><len><payload>...
    i = 0
    while i + 1 < len(md):
        t, ln = md[i], md[i+1]
        payload = md[i+2:i+2+ln]
        if t == 0x10 and len(payload) >= 2:
            key = (payload[0], payload[1])
            nearby[key] = nearby.get(key, 0) + 1
        i += 2 + ln

async def main():
    s = BleakScanner(detection_callback=cb, scanning_mode="active")
    await s.start(); await asyncio.sleep(DUR); await s.stop()
    if not nearby:
        print("  (no Nearby-Info captured — wake/raise watch and retry)"); return
    print("  Nearby-Info status/flags seen (count):")
    for (st, fl), n in sorted(nearby.items(), key=lambda x:-x[1]):
        act = st & 0x0F
        print(f"    status=0x{st:02x} (action_nibble=0x{act:x})  flags=0x{fl:02x}   x{n}")

asyncio.run(main())
