#!/usr/bin/env python3
# NEURO environment-logger service — downloads Nick's Blue Maestro Disc Maxi from
# the Pi, whenever the logger is home, and posts the readings to NEURO.
#
# Why the Pi and not the phone: the Maxi advertises no service UUID, and iOS will
# not deliver an unfiltered scan to a backgrounded app. The Pi is always on and
# always listening, so the logger syncs itself when the pack comes through the
# door — no app to open.
#
# Protocol: Blue Maestro "Device API Documentation" v2.0 — the Maxi's v41-43
# protocol, NOT the old Tempo Disc one. Mirrors NeuroKit/BlueMaestro.swift in the
# iOS repo; the two decoders must agree, and both are pinned against the real
# advert captured on this Pi (27 Sep 2026).
#
# ⚠ THE LOG HAS NO TIMESTAMPS. Records are timed backwards from an ANCHOR: the
# moment the newest record was written. The phone can only guess it (mid-interval,
# ±interval/2). This service WATCHES the advert's record count, so when it ticks
# over it knows the anchor to within a second or two — which is the whole reason
# the timing on the Pi beats the phone's. If no tick has been seen since startup,
# it falls back to the phone's guess and says so in `timingErrorSeconds`.
#
# ⚠ THE CURSOR IS NEURO'S, NOT THIS FILE'S. "How far through the log have we got"
# lives on the server (GET /api/environment/sensors/:id), so the phone's manual
# sync and this service can never both download — and double-time — the same
# records.
#
# Run (service):  ./venv/bin/python environment-logger-service.py
# Dry run:        ./venv/bin/python environment-logger-service.py --dry-run [--records N]
#                 (downloads, saves the raw dump, prints a decode, posts NOTHING)
# Env:            NEURO_URL (default http://localhost:3001), NEURO_API_TOKEN,
#                 BM_SENSOR (MAC suffix to pin one logger; default: first Maxi heard),
#                 BM_SYNC_MINUTES (default 30), BM_DUMP_DIR

import argparse
import asyncio
import json
import os
import re
import struct
import sys
import time
import urllib.request
from datetime import datetime, timezone

from bleak import BleakClient, BleakScanner

COMPANY_ID = 0x0133
UART_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"   # "RX" — device's side
UART_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # "TX"
MODELS = {41: ("Disc Maxi (temperature)", 2), 42: ("Disc Maxi 3-in-1", 4), 43: ("Disc Maxi 4-in-1", 8)}
CAPACITY = 25_000
# Crystal drift: a cheap 32 kHz crystal is ~20 ppm. Over a 90-day back-log that is
# ~2.6 minutes, so a record's timing error grows with its age and is reported so.
DRIFT_PPM = 20e-6

NEURO_URL = os.environ.get("NEURO_URL", "http://localhost:3001").rstrip("/")
API_TOKEN = os.environ.get("NEURO_API_TOKEN", "").strip()
PIN_SENSOR = os.environ.get("BM_SENSOR", "").strip().upper().replace(":", "")
SYNC_MINUTES = float(os.environ.get("BM_SYNC_MINUTES", "30"))
DUMP_DIR = os.environ.get("BM_DUMP_DIR", os.path.expanduser("~/environment-logger"))


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


# ── Pure decoding ────────────────────────────────────────────────────────────

def parse_advert(payload: bytes):
    """Decode manufacturer data WITHOUT the company id (BlueZ strips it)."""
    if len(payload) < 17 or payload[0] not in MODELS:
        return None
    version = payload[0]
    name, size = MODELS[version]
    need = {41: 17, 42: 19, 43: 23}[version]
    if len(payload) < need:
        return None
    interval_ds, count = struct.unpack_from("<II", payload, 2)
    temp = struct.unpack_from("<h", payload, 15)[0] / 100
    rh = struct.unpack_from("<h", payload, 17)[0] / 100 if version >= 42 else None
    pa = struct.unpack_from("<i", payload, 19)[0] / 100 if version == 43 else None
    return {
        "version": version, "model": name, "recordSize": size,
        "battery": payload[1],
        "intervalSeconds": max(1, interval_ds // 10),   # ⚠ deciseconds on the wire
        "logCount": count,
        "sensorId": payload[10:14][::-1].hex().upper(),  # MAC suffix, stored reversed
        "locked": bool(payload[14] & 0x01),
        "airplane": bool(payload[14] & 0x40),
        "tempC": temp, "humidityPct": rh, "pressureHpa": pa,
    }


def decode_records(data: bytes, size: int):
    out = []
    for o in range(0, len(data) - size + 1, size):
        t = struct.unpack_from("<h", data, o)[0] / 100
        rh = struct.unpack_from("<h", data, o + 2)[0] / 100 if size >= 4 else None
        pa = struct.unpack_from("<i", data, o + 4)[0] / 100 if size >= 8 else None
        out.append({"tempC": t, "humidityPct": rh, "pressureHpa": pa})
    return out


# ⚠ THE DUMP CARRIES A TRAILER THE DOCUMENTATION DOES NOT MENTION. Captured off
# the real logger (27 Sep 2026): the records are followed by ASCII
#     ,,<count>|<deviceNowMs>|<newestAtMs>|0|0|0|..
# <deviceNowMs> is the logger's own millisecond clock at the moment of the reply
# (it advanced ~1000/s across three captures) and <newestAtMs> is that clock's
# reading when the newest record was written (fixed across them). Their
# difference is the AGE of the newest record — which is the anchor the docs say
# the device never sends. So timing needs no guess and no advert-watching.
TRAILER_RE = re.compile(rb",,(\d+)\|(\d+)\|(\d+)\|((?:\d+\|)*)\.\.$")


def parse_dump(buf: bytes, size: int):
    """(record bytes, trailer) for a complete dump, else None.

    The trailer must start exactly where <count> records end — a `,,` anywhere
    else is data (0x2C2C is a perfectly good humidity)."""
    m = TRAILER_RE.search(buf)
    if not m:
        return None
    count = int(m.group(1))
    if m.start() != count * size:
        return None
    return buf[:m.start()], {
        "count": count,
        "deviceNowMs": int(m.group(2)),
        "newestAtMs": int(m.group(3)),
        "extra": [int(x) for x in m.group(4).split(b"|") if x],
    }


def dump_state(buf: bytes, size: int, expected: int) -> str:
    """'complete' | 'incomplete' | 'refused' | 'receiving'."""
    if len(buf) < 64 and buf.startswith(b"ERR"):
        return "refused"
    if buf.endswith(b"~~"):
        return "incomplete"
    if buf.endswith(b"..") and parse_dump(buf, size):
        return "complete"
    return "receiving"


def records_to_fetch(adv, cursor, now):
    """Same rules as BlueMaestroPlan.recordsToFetch."""
    if not cursor or cursor.get("intervalSeconds") != adv["intervalSeconds"]:
        return adv["logCount"]
    if adv["logCount"] < cursor["logCount"]:
        return adv["logCount"]              # cleared (setlog~ clears too)
    if adv["logCount"] >= CAPACITY:
        synced = cursor.get("syncedAt") or now
        return min(CAPACITY, max(0, int((now - synced) / adv["intervalSeconds"])))
    return adv["logCount"] - cursor["logCount"]


def time_records(records, interval, anchor, anchor_error):
    """Oldest first; the last record was written at `anchor`."""
    n = len(records)
    out = []
    for i, r in enumerate(records):
        age = (n - 1 - i) * interval
        out.append({
            "t": int(round(anchor - age)),
            **r,
            "timingErrorSeconds": int(round(anchor_error + age * DRIFT_PPM)),
        })
    return out


# ── NEURO ────────────────────────────────────────────────────────────────────

def neuro(method, path, body=None):
    req = urllib.request.Request(NEURO_URL + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if API_TOKEN:
        req.add_header("X-Neuro-Api-Token", API_TOKEN)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


# ── The radio ────────────────────────────────────────────────────────────────

class Watcher:
    """Listens to adverts; remembers when the record count last ticked."""

    def __init__(self):
        self.device = None
        self.adv = None
        self.seen_at = 0.0
        self.tick_at = None      # when logCount last INCREASED, as observed
        self.tick_count = None

    def on_advert(self, device, ad):
        payload = ad.manufacturer_data.get(COMPANY_ID)
        if payload is None:
            return
        adv = parse_advert(bytes(payload))
        if not adv or (PIN_SENSOR and not PIN_SENSOR.startswith(adv["sensorId"]) and adv["sensorId"] != PIN_SENSOR):
            return
        now = time.time()
        if self.adv and adv["sensorId"] == self.adv["sensorId"] and adv["logCount"] > self.adv["logCount"]:
            self.tick_at, self.tick_count = now, adv["logCount"]
            log(f"record {adv['logCount']} written — anchor pinned")
        self.device, self.adv, self.seen_at = device, adv, now

    def anchor(self, now):
        """(anchor, error seconds) for the newest record held right now."""
        adv = self.adv
        if self.tick_at and self.tick_count == adv["logCount"]:
            # Adverts arrive ~1/s; the tick was seen within a couple of them.
            return self.tick_at, 3
        return now - adv["intervalSeconds"] / 2, adv["intervalSeconds"] // 2


async def download(device, adv, wanted, idle_s=6.0, limit_s=600):
    size = adv["recordSize"]
    buf = bytearray()
    last = time.time()

    def on_data(_, data: bytearray):
        nonlocal last
        buf.extend(data)
        last = time.time()

    def keep(name):
        os.makedirs(DUMP_DIR, exist_ok=True)
        with open(os.path.join(DUMP_DIR, name), "wb") as f:
            f.write(bytes(buf))

    command = "logall" if wanted >= adv["logCount"] else f"log~{wanted}"
    async with BleakClient(device, timeout=30) as client:
        await client.start_notify(UART_NOTIFY, on_data)
        await client.write_gatt_char(UART_WRITE, command.encode(), response=True)
        log(f"sent {command!r}, expecting {wanted} records ({wanted * size} bytes)")
        started = time.time()
        while True:
            await asyncio.sleep(0.25)
            state = dump_state(bytes(buf), size, wanted)
            if state == "complete":
                break
            if state in ("incomplete", "refused"):
                keep("failed-dump.bin")
                raise RuntimeError(f"logger said {state}: {bytes(buf[:40])!r}")
            if time.time() - last > idle_s:
                keep("failed-dump.bin")
                raise RuntimeError(f"logger went quiet after {len(buf)} bytes (kept as failed-dump.bin)")
            if time.time() - started > limit_s:
                raise RuntimeError("download took too long")
    # The moment the reply finished arriving, which is when <deviceNowMs> was true.
    return bytes(buf), last


async def sync_once(w: Watcher, scanner, dry_run=False, force_records=None):
    adv = w.adv
    now = time.time()
    cursor = None
    if not dry_run:
        cursor = neuro("GET", f"/api/environment/sensors/{adv['sensorId']}").get("cursor")
    wanted = force_records or records_to_fetch(adv, cursor, now)
    if wanted <= 0:
        return 0
    count_at_start = adv["logCount"]

    await scanner.stop()     # BlueZ is happier connecting with the scan off
    try:
        raw, arrived_at = await download(w.device, adv, wanted)
    finally:
        await scanner.start()

    os.makedirs(DUMP_DIR, exist_ok=True)
    with open(os.path.join(DUMP_DIR, "last-dump.bin"), "wb") as f:
        f.write(raw)
    body_bytes, trailer = parse_dump(raw, adv["recordSize"])
    # ⚠ NEWEST FIRST on the wire (record 0 matched the live advert to 0.01 °C),
    # the opposite of what the documentation's formula implies. Reversed here so
    # everything downstream is oldest-first.
    records = decode_records(body_bytes, adv["recordSize"])[::-1]
    age_s = (trailer["deviceNowMs"] - trailer["newestAtMs"]) / 1000
    if 0 <= age_s <= adv["intervalSeconds"] * 2:
        anchor, anchor_err = arrived_at - age_s, 2
    else:
        # A trailer that does not make sense is not trusted over a guess.
        anchor, anchor_err = w.anchor(now)
        log(f"trailer age {age_s:.0f}s is implausible — falling back to the advert anchor")
    readings = time_records(records, adv["intervalSeconds"], anchor, anchor_err)

    if dry_run:
        log(f"got {len(records)} records, {len(raw)} bytes; raw dump in {DUMP_DIR}/last-dump.bin")
        for r in readings[:3] + [None] + readings[-3:]:
            if r is None:
                print("   …")
                continue
            print("  ", datetime.fromtimestamp(r["t"]).strftime("%Y-%m-%d %H:%M"),
                  f"{r['tempC']:6.2f} °C  {r['humidityPct']:6.2f} %RH  {r['pressureHpa']:8.2f} hPa  ±{r['timingErrorSeconds']}s")
        print(f"   live now: {adv['tempC']:.2f} °C {adv['humidityPct']:.2f} %RH {adv['pressureHpa']:.2f} hPa"
              " — the LAST (newest) record should be close to this")
        log(f"trailer {trailer}; newest record written {datetime.fromtimestamp(anchor).strftime('%H:%M:%S')}")
        return len(records)

    body = {"sensorId": adv["sensorId"], "model": adv["model"], "intervalSeconds": adv["intervalSeconds"],
            "source": "pi"}
    for i in range(0, len(readings), 1000):
        chunk = readings[i:i + 1000]
        last_chunk = i + 1000 >= len(readings)
        # The cursor moves only with the LAST chunk, so a failure part-way leaves
        # it where it was and the next pass re-fetches the lot (the server folds
        # the part already stored on (sensor, t) — the anchor is the same).
        payload = {**body, "readings": chunk}
        if last_chunk:
            payload["cursor"] = {"logCount": count_at_start, "intervalSeconds": adv["intervalSeconds"]}
        receipt = neuro("POST", "/api/environment/readings", payload)
        log(f"posted {len(chunk)}: stored {receipt.get('stored')}, duplicate {receipt.get('duplicate')}")
    return len(readings)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--records", type=int, help="dry run: how many newest records (default: all)")
    ap.add_argument("--after-tick", action="store_true",
                    help="dry run: wait until a new record is written, to check the trailer anchor against it")
    args = ap.parse_args()

    w = Watcher()
    scanner = BleakScanner(detection_callback=w.on_advert)
    await scanner.start()
    log("listening for a Disc Maxi" + (f" ({PIN_SENSOR})" if PIN_SENSOR else ""))

    if args.dry_run:
        for _ in range(60):
            if w.adv:
                break
            await asyncio.sleep(0.5)
        if not w.adv:
            raise SystemExit("no Disc Maxi heard in 30 s")
        a = w.adv
        log(f"{a['model']} {a['sensorId']}: {a['logCount']} records every {a['intervalSeconds']} s, battery {a['battery']}%")
        if args.after_tick:
            deadline = time.time() + a["intervalSeconds"] + 120
            while not w.tick_at and time.time() < deadline:
                await asyncio.sleep(1)
            if not w.tick_at:
                raise SystemExit("no new record was written while watching")
            log(f"tick observed at {datetime.fromtimestamp(w.tick_at).strftime('%H:%M:%S')}")
        await sync_once(w, scanner, dry_run=True, force_records=args.records or a["logCount"])
        await scanner.stop()
        return

    last_sync = 0.0
    while True:
        await asyncio.sleep(5)
        # Heard recently = home. Throttled, because every connection is paid for
        # out of the logger's coin cell.
        if not w.adv or time.time() - w.seen_at > 30 or time.time() - last_sync < SYNC_MINUTES * 60:
            continue
        if w.adv["airplane"]:
            continue
        try:
            n = await sync_once(w, scanner)
            last_sync = time.time()
            if n:
                log(f"synced {n} readings")
        except Exception as e:  # keep listening; try again next window
            last_sync = time.time() - SYNC_MINUTES * 60 + 120   # retry in ~2 min
            log(f"sync failed: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
