#!/usr/bin/env python3
r"""
SARA Watch-presence REPORTER (Windows / ARM64) — headless sensor, no lock of its own.

This is the laptop twin of the Pi's watch-presence-service.py. It does ONE thing:
passively detect the Apple Watch over BLE (via its IRK) and write a small presence.json
that the SARA backend reads (GET /api/presence). SARA — not this script — owns the lock
decision. Keeping the sensor and the decision separate is the charter seam: the same
SARA lock logic runs on the Pi and the laptop, fed by whichever reporter is local.

Engine reused from watch_lock.py (proven on this ARM64 box: IRK self-test PASS, ~23
adverts/25s). DETECTION-based present/away, NOT RSSI: on Windows a wall barely dents the
Watch's RSSI (see watch-irk-RESULTS.md), so the reliable "gone" signal is adverts
STOPPING, not getting weaker.

Detection rule (config.json, shared with watch_lock.py):
  - present : the Watch's resolvable address was seen within present_window_s (default 15s)
  - away    : not seen for away_timeout_s (default 25s) -- but ONLY once we've been present
              at least once. Before the first sighting we stay "unknown" (SARA ignores
              "unknown" and uses its fallback), so starting this with the Watch off-wrist
              can never blind-lock you.

presence.json (atomic write) matches the schema SARA's presence.js expects:
  status, away, present, rssi, last_seen_s, hits, updated, source.

Run:  windows-watch-lock\venv\Scripts\python.exe watch-presence-reporter.py
Env:  WATCH_STATUS_FILE (where to write; default presence.json next to this script)
      WATCH_PRESENT_WINDOW_S, WATCH_AWAY_TIMEOUT_S, WATCH_TICK_S (override config/timings)
"""

import asyncio
import ctypes
import hmac
import json
import os
import sys
import time
from collections import deque
from ctypes import wintypes
from datetime import datetime, timezone

from bleak import BleakScanner
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# --- paths -----------------------------------------------------------------------
APP_DIR = os.path.dirname(
    os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__)
)
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
STATUS_FILE = os.environ.get("WATCH_STATUS_FILE", os.path.join(APP_DIR, "presence.json"))

DEFAULTS = {
    "irk_hex": "2dbfa199fa42d060551738470e010f2e",
    "selftest_rpa": "4B:7F:44:E3:37:88",
    "present_window_s": 15,
    "away_timeout_s": 25,
    "scan_mode": "active",
    # Keyboard/mouse fusion: any global input within this many seconds = definitely
    # present, which VETOES the Watch. So a sparse-advert gap can never read as "away"
    # while you're actually using the machine. "away" needs BOTH the Watch silent AND
    # no input for this long.
    "input_grace_s": 5,
    # RSSI-window presence (the real "are you physically near?" signal). At laptop range
    # the Watch is HEARD even when you've left the building, so on/off detection is useless
    # — but its SIGNAL STRENGTH drops when you walk off. Single samples are noisy, so we
    # take a rolling majority: you count as "near" if at least `rssi_needed` of the last
    # `rssi_window` 1s samples were a fresh advert STRONGER than `rssi_near` dBm. Measured
    # bands on this machine: settled at desk -47..-67; genuinely away -83..-95.
    "rssi_near": -78,      # dBm: stronger than this = a "near" sample
    "rssi_window": 8,      # how many 1s samples in the rolling window
    "rssi_needed": 2,      # how many of those must be "near" to count as present (lenient)
}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update({k: v for k, v in json.load(f).items() if k in DEFAULTS})
    except Exception:
        pass  # config optional; defaults are the proven values
    # env overrides win (handy for tuning without editing the shared config.json)
    cfg["present_window_s"] = float(os.environ.get("WATCH_PRESENT_WINDOW_S", cfg["present_window_s"]))
    cfg["away_timeout_s"] = float(os.environ.get("WATCH_AWAY_TIMEOUT_S", cfg["away_timeout_s"]))
    cfg["scan_mode"] = os.environ.get("WATCH_SCAN_MODE", cfg["scan_mode"])  # "active" | "passive"
    cfg["input_grace_s"] = float(os.environ.get("WATCH_INPUT_GRACE_S", cfg["input_grace_s"]))
    cfg["rssi_near"] = float(os.environ.get("WATCH_RSSI_NEAR", cfg["rssi_near"]))
    cfg["rssi_window"] = int(os.environ.get("WATCH_RSSI_WINDOW", cfg["rssi_window"]))
    cfg["rssi_needed"] = int(os.environ.get("WATCH_RSSI_NEEDED", cfg["rssi_needed"]))
    return cfg


# --- system-wide input idle (keyboard/mouse fusion) ------------------------------
# GetLastInputInfo reports the tick of the last keyboard/mouse event ACROSS the whole
# session — regardless of which app has focus — so it sees you typing in VS Code, a
# browser, anywhere. That is exactly the "I'm clearly at my desk" signal.
class _LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def get_idle_s():
    """Seconds since the last global keyboard/mouse input, or None if unreadable."""
    try:
        lii = _LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(_LASTINPUTINFO)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
            return None
        # GetLastInputInfo's dwTime is 32-bit GetTickCount-based; use the 32-bit tick to
        # match (both wrap together, so the subtraction stays correct across the wrap).
        millis = (ctypes.windll.kernel32.GetTickCount() - lii.dwTime) & 0xFFFFFFFF
        return millis / 1000.0
    except Exception:
        return None


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + msg, flush=True)


# --- IRK resolution (inlined; bluetooth_data_tools has no Windows-ARM64 wheel) ----
_RPA_PADDING = b"\x00" * 13


def get_cipher_for_irk(irk: bytes) -> Cipher:
    return Cipher(algorithms.AES(irk), modes.ECB())


def resolve_private_address(cipher: Cipher, address: str) -> bool:
    rpa = bytes.fromhex(address.replace(":", ""))
    if len(rpa) != 6 or rpa[0] & 0xC0 != 0x40:  # not a resolvable private address
        return False
    enc = cipher.encryptor()
    ct = enc.update(_RPA_PADDING + rpa[:3]) + enc.finalize()
    return hmac.compare_digest(ct[13:], rpa[3:])


# --- presence engine -------------------------------------------------------------
class Reporter:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.cipher = get_cipher_for_irk(bytes.fromhex(cfg["irk_hex"]))
        self.last_seen = 0.0
        self.last_rssi = None
        self.hits = 0
        self.status = "unknown"          # unknown | present | away
        self.been_present = False        # gate: never report "away" before first sighting
        self.last_idle = None            # seconds since last global keyboard/mouse input
        # Rolling window of per-tick "near" flags (a fresh advert stronger than rssi_near).
        self.rssi_window = deque(maxlen=int(cfg["rssi_window"]))
        self.near_count = 0              # how many of the window are "near" right now
        self.max_gap = 0.0               # diag: largest gap between adverts (s)
        self.rssi_min = None
        self.rssi_max = None

    def is_our_watch(self, address: str) -> bool:
        try:
            return resolve_private_address(self.cipher, address)
        except Exception:
            return False

    def on_detect(self, device, adv):
        if not self.is_our_watch(device.address):
            return
        now = time.monotonic()
        if self.last_seen and self.been_present:
            gap = now - self.last_seen
            if gap > self.max_gap:
                self.max_gap = gap
        self.hits += 1
        self.last_seen = now
        self.last_rssi = adv.rssi
        if adv.rssi is not None:
            self.rssi_min = adv.rssi if self.rssi_min is None else min(self.rssi_min, adv.rssi)
            self.rssi_max = adv.rssi if self.rssi_max is None else max(self.rssi_max, adv.rssi)

    def decide(self):
        now = time.monotonic()
        age = (now - self.last_seen) if self.last_seen else None
        idle = get_idle_s()
        self.last_idle = idle

        # This tick's RSSI sample: a "near" sample is a FRESH advert (heard within ~2s)
        # whose strength beats the threshold. No fresh advert, or a weak one, counts as
        # "far" — so both "out of range" and "across the room" push toward away.
        fresh = age is not None and age <= 2.0
        near_sample = bool(fresh and self.last_rssi is not None and self.last_rssi > self.cfg["rssi_near"])
        self.rssi_window.append(near_sample)
        self.near_count = sum(self.rssi_window)
        window_full = len(self.rssi_window) == self.rssi_window.maxlen

        watch_near = self.near_count >= self.cfg["rssi_needed"]
        # Recent keyboard/mouse input = you're clearly here. Either the Watch being near OR
        # recent input makes you present, so reading at your desk (input idle, Watch near)
        # never locks, and working (input fresh) never locks even if the Watch reads weak.
        input_present = idle is not None and idle < self.cfg["input_grace_s"]

        if watch_near or input_present:
            self.status = "present"
            self.been_present = True
        elif self.been_present and window_full \
                and not watch_near \
                and (idle is None or idle >= self.cfg["input_grace_s"]):
            # "away" needs BOTH: the Watch's rolling signal has gone weak/absent AND no
            # input for the grace period. (Window must be full first, so we never decide on
            # partial data; before the first present we stay "unknown" and never lock.)
            self.status = "away"
        # else: hold current status
        return age

    def write_status(self, age):
        payload = {
            "status": self.status,
            "away": self.status == "away",
            "present": self.status == "present",
            "rssi": self.last_rssi,
            "last_seen_s": round(age, 1) if age is not None else None,
            "idle_s": round(self.last_idle, 1) if self.last_idle is not None else None,
            "near_count": self.near_count,
            "near_window": self.rssi_window.maxlen,
            "hits": self.hits,
            "updated": datetime.now(timezone.utc).isoformat(),
            "source": "watch-rssi+input",
        }
        tmp = STATUS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, STATUS_FILE)  # atomic — SARA never reads a half-written file


async def main():
    cfg = load_config()
    rep = Reporter(cfg)
    ok = rep.is_our_watch(cfg["selftest_rpa"])
    log(f"IRK self-test: {'PASS' if ok else 'FAIL (check irk_hex/selftest_rpa)'}")
    log(f"near>{cfg['rssi_near']:.0f}dBm needing {cfg['rssi_needed']}/{cfg['rssi_window']} samples, "
        f"input_grace={cfg['input_grace_s']:.0f}s, mode={cfg['scan_mode']}, file={STATUS_FILE}")

    tick_s = float(os.environ.get("WATCH_TICK_S", "2.0"))
    verbose = os.environ.get("WATCH_VERBOSE", "") not in ("", "0", "false")
    scanner = BleakScanner(detection_callback=rep.on_detect, scanning_mode=cfg["scan_mode"])
    await scanner.start()
    log("BLE scanner started" + (" [VERBOSE baseline]" if verbose else ""))
    last_written = None
    ticks = 0
    try:
        while True:
            await asyncio.sleep(tick_s)
            ticks += 1
            age = rep.decide()
            if verbose:
                log(f"tick {ticks:3d} status={rep.status:7s} near={rep.near_count}/{rep.rssi_window.maxlen} "
                    f"age={('%.1f' % age) if age is not None else '  -'}s "
                    f"idle={('%.1f' % rep.last_idle) if rep.last_idle is not None else '  -'}s "
                    f"rssi={rep.last_rssi}")
            # Write on every transition, and otherwise heartbeat ~every 6s so SARA's
            # freshness check (WATCH_STALE_MS, default 30s) always sees a live file.
            if rep.status != last_written or ticks % 3 == 0:
                rep.write_status(age)
                if rep.status != last_written:
                    log(f"-> {rep.status} (hits={rep.hits}, rssi={rep.last_rssi}, "
                        f"last_seen_s={round(age,1) if age is not None else None})")
                    last_written = rep.status
    finally:
        await scanner.stop()
        log("BLE scanner stopped")


if __name__ == "__main__":
    asyncio.run(main())
