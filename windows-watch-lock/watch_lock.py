#!/usr/bin/env python3
"""
Watch Lock — lock Windows when your Apple Watch leaves, wake it when it returns.

Engine lifted from nuero/watch_presence.py:
  - Scans BLE and resolves every rotating advert address against the Watch IRK.
  - present/away state machine. The reliable "gone" signal is detections STOPPING,
    not RSSI (a wall barely dents RSSI — proven in watch-irk-RESULTS.md).

On the state transitions it:
  - LOCKS the workstation when the Watch leaves      -> user32.LockWorkStation()
  - WAKES the display when the Watch returns          -> tiny mouse nudge, so Windows
    Hello's camera powers up and logs you in hands-free.

Windows Hello still performs the actual authentication — we never store or replay a
credential, so there is no new login-secret to steal. We only supply the *wake* you
currently do by hand.

Runs as a system-tray app. Right-click for status / pause auto-lock / lock-now / quit.
Config lives in config.json next to this file (auto-created on first run).
"""

import asyncio
import ctypes
import json
import os
import sys
import threading
import time
from ctypes import wintypes

import hmac

from bleak import BleakScanner
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

import pystray
from PIL import Image, ImageDraw


# --- IRK address resolution ------------------------------------------------------
# Inlined from bluetooth_data_tools (its newer versions ship no Windows-ARM64 wheel).
# Standard BLE Resolvable Private Address check: ah(IRK, prand) == hash.
_RPA_PADDING = b"\x00" * 13


def get_cipher_for_irk(irk: bytes) -> Cipher:
    return Cipher(algorithms.AES(irk), modes.ECB())


def resolve_private_address(cipher: Cipher, address: str) -> bool:
    rpa = bytes.fromhex(address.replace(":", ""))
    if len(rpa) != 6 or rpa[0] & 0xC0 != 0x40:   # not a resolvable private address
        return False
    enc = cipher.encryptor()
    ct = enc.update(_RPA_PADDING + rpa[:3]) + enc.finalize()
    return hmac.compare_digest(ct[13:], rpa[3:])


# --- paths (work both as .py and as a PyInstaller .exe) --------------------------
APP_DIR = os.path.dirname(
    os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__)
)
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
LOG_PATH = os.path.join(APP_DIR, "watch_lock.log")

DEFAULTS = {
    # IRK + a known live RPA, copied verbatim from watch_presence.py (self-test passes).
    "irk_hex": "2dbfa199fa42d060551738470e010f2e",
    "selftest_rpa": "4B:7F:44:E3:37:88",
    "present_window_s": 15,   # seen within this many seconds => present
    "away_timeout_s": 25,     # not seen for this long => away (lock)
    "scan_mode": "active",    # "active" or "passive"
    "auto_lock": True,        # lock the workstation when the Watch leaves
    "wake_on_return": True,   # nudge the display when the Watch returns (Hello unlock)
}


def log(msg: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:
            log(f"config read error, using defaults: {e}")
    else:
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(DEFAULTS, f, indent=2)
        except Exception:
            pass
    return cfg


# --- Windows actions -------------------------------------------------------------
user32 = ctypes.windll.user32

user32.OpenInputDesktop.restype = ctypes.c_void_p
user32.OpenInputDesktop.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
user32.CloseDesktop.argtypes = (ctypes.c_void_p,)
user32.mouse_event.argtypes = (
    wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
)

MOUSEEVENTF_MOVE = 0x0001
DESKTOP_READOBJECTS = 0x0001


def lock_workstation() -> None:
    user32.LockWorkStation()


def is_locked() -> bool:
    """True when the secure/Winlogon desktop is active (i.e. the session is locked).

    A user-session process cannot OpenInputDesktop the secure desktop, so a NULL
    handle reliably means 'locked'. Avoids tracking our own flag, so it also handles
    locks the user triggered manually (Win+L)."""
    hdesk = user32.OpenInputDesktop(0, False, DESKTOP_READOBJECTS)
    if not hdesk:
        return True
    user32.CloseDesktop(hdesk)
    return False


def wake_display() -> None:
    """Net-zero mouse jiggle. Wakes the monitor from display-off so Windows Hello's
    camera scans you in. (Can't cross into a deep-sleep/Modern-Standby state — that's
    a power-state wall, not a code one; see README.)"""
    user32.mouse_event(MOUSEEVENTF_MOVE, 1, 0, 0, None)
    time.sleep(0.04)
    user32.mouse_event(MOUSEEVENTF_MOVE, 0xFFFFFFFF, 0, 0, None)  # 0xFFFFFFFF = -1 relative


# --- presence engine (from watch_presence.py) ------------------------------------
class Presence:
    def __init__(self, cfg: dict, on_status):
        self.cfg = cfg
        self.on_status = on_status          # callback(new_status, prev_status)
        self.irk = bytes.fromhex(cfg["irk_hex"])
        self.cipher = get_cipher_for_irk(self.irk)
        self.last_seen = 0.0
        self.last_rssi = None
        self.hits = 0
        self.status = "unknown"             # present | away | unknown
        self._stop = threading.Event()

    def is_our_watch(self, address: str) -> bool:
        # Cipher is reusable here: resolve_private_address takes a fresh encryptor each call.
        try:
            return resolve_private_address(self.cipher, address)
        except Exception:
            return False

    def on_detect(self, device, adv):
        if not self.is_our_watch(device.address):
            return
        self.hits += 1
        self.last_seen = time.monotonic()
        self.last_rssi = adv.rssi

    def _tick(self):
        now = time.monotonic()
        age = (now - self.last_seen) if self.last_seen else 9999
        new = self.status
        if age < self.cfg["present_window_s"]:
            new = "present"
        elif age >= self.cfg["away_timeout_s"]:
            new = "away"
        if new != self.status and new in ("present", "away"):
            prev, self.status = self.status, new
            self.on_status(new, prev)

    async def run(self):
        if not self.is_our_watch(self.cfg["selftest_rpa"]):
            log("WARNING: IRK self-test FAILED — check irk_hex / selftest_rpa in config.json")
        else:
            log("IRK self-test: PASS")
        scanner = BleakScanner(detection_callback=self.on_detect, scanning_mode=self.cfg["scan_mode"])
        await scanner.start()
        log(f"BLE scanner started (mode={self.cfg['scan_mode']})")
        try:
            while not self._stop.is_set():
                await asyncio.sleep(2.0)
                self._tick()
        finally:
            await scanner.stop()
            log("BLE scanner stopped")

    def stop(self):
        self._stop.set()


# --- tray app --------------------------------------------------------------------
class TrayApp:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.auto_lock = bool(cfg["auto_lock"])
        self.status = "unknown"
        self.presence = Presence(cfg, self.handle_status)
        self.icon = pystray.Icon("watch_lock", self._image(), "Watch Lock — starting…", self._menu())

    # ---- visuals ----
    def _image(self):
        color = {"present": (40, 180, 80), "away": (210, 60, 60)}.get(self.status, (150, 150, 150))
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse((8, 8, 56, 56), fill=color)
        return img

    def _menu(self):
        return pystray.Menu(
            pystray.MenuItem(lambda i: f"Status: {self.status}", None, enabled=False),
            pystray.MenuItem(
                lambda i: f"Watch: {'seen' if self.presence.hits else 'not seen yet'}"
                          f"  rssi={self.presence.last_rssi}", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Auto-lock when away", self._toggle_auto, checked=lambda i: self.auto_lock),
            pystray.MenuItem("Lock now", lambda i: lock_workstation()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self._quit),
        )

    def _refresh(self):
        try:
            self.icon.icon = self._image()
            self.icon.title = f"Watch Lock — {self.status}"
            self.icon.update_menu()
        except Exception:
            pass

    # ---- state handling (called from the BLE worker thread) ----
    def handle_status(self, new, prev):
        self.status = new
        log(f"state {prev} -> {new}  (hits={self.presence.hits}, rssi={self.presence.last_rssi})")
        if new == "away" and prev == "present" and self.auto_lock:
            log("Watch left -> locking workstation")
            lock_workstation()
        elif new == "present" and prev in ("away", "unknown"):
            if self.cfg["wake_on_return"] and is_locked():
                log("Watch returned while locked -> waking display for Windows Hello")
                wake_display()
        self._refresh()

    # ---- menu actions ----
    def _toggle_auto(self, icon, item):
        self.auto_lock = not self.auto_lock
        log(f"auto-lock {'ON' if self.auto_lock else 'OFF'}")

    def _quit(self, *_):
        log("quitting")
        self.presence.stop()
        self.icon.stop()

    # ---- run ----
    def _worker(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self.presence.run())
        except Exception as e:
            log(f"worker error: {e}")

    def run(self):
        threading.Thread(target=self._worker, daemon=True).start()
        self.icon.run()  # blocks the main thread until _quit()


def main():
    cfg = load_config()
    log("Watch Lock starting")
    TrayApp(cfg).run()


if __name__ == "__main__":
    main()
