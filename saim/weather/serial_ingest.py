#!/usr/bin/env python3
"""Validate receiver JSON from USB serial, journal it, and forward it to NEURO.

The outdoor station: ESP32-C3/BME280 -> ESP-NOW -> ESP32 receiver -> USB on pi5
-> this service. Every accepted record is still written to the journal exactly
as before ("Accepted {...}") -- that line is the operational evidence -- and is
then put in an on-disk SPOOL. A forwarder thread drains the spool to NEURO's
POST /api/weather/observations in batches.

Why a spool, not a direct POST per reading: NEURO restarts several times a day
on deploys and the Pi's network can drop. A reading is taken once and cannot be
re-taken, so it is written to disk BEFORE anything is sent, and removed only
when NEURO has said what happened to it (stored / duplicate / rejected). A
resend after a timeout is safe: NEURO folds a repeat of the same node + sequence
+ received_at as a duplicate.

Configuration (environment, /etc/saim-weather-ingest.env):
  SERIAL_DEVICE        /dev/serial/by-id/...           (required)
  SERIAL_BAUD          115200
  NEURO_WEATHER_URL    http://127.0.0.1:3001/api/weather/observations
                       empty = journal-only, exactly the old behaviour
  NEURO_API_TOKEN      NEURO's machine API token (X-NEURO-API-TOKEN)
  SPOOL_PATH           /var/lib/saim-weather/spool.db
  SPOOL_MAX_ROWS       200000  (~4.5 months at one a minute; oldest dropped, loudly)
  FORWARD_BATCH        200
  MQTT_HOST / MQTT_PORT / MQTT_TOPIC   unchanged, optional
"""
import json
import logging
import os
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SERIAL_DEVICE = os.environ.get("SERIAL_DEVICE", "")
SERIAL_BAUD = int(os.environ.get("SERIAL_BAUD", "115200"))
MQTT_HOST = os.environ.get("MQTT_HOST", "")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_TOPIC = os.environ.get("MQTT_TOPIC", "saim/weather/outdoor")
NEURO_WEATHER_URL = os.environ.get("NEURO_WEATHER_URL", "").strip()
NEURO_API_TOKEN = os.environ.get("NEURO_API_TOKEN", "").strip()
SPOOL_PATH = os.environ.get("SPOOL_PATH", "/var/lib/saim-weather/spool.db")
SPOOL_MAX_ROWS = int(os.environ.get("SPOOL_MAX_ROWS", "200000"))
FORWARD_BATCH = int(os.environ.get("FORWARD_BATCH", "200"))
SOURCE = "saim-weather-ingest@" + socket.gethostname()

BACKOFF_MIN_S = 5
BACKOFF_MAX_S = 300
HTTP_TIMEOUT_S = 15

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def valid(record):
    required = ("schema", "node_id", "sequence", "temperature_c", "humidity_pct", "pressure_hpa", "rssi")
    if not isinstance(record, dict) or any(field not in record for field in required):
        return False
    if record["schema"] != "saim.weather.v1" or not isinstance(record["node_id"], str):
        return False
    try:
        float(record["temperature_c"]); float(record["humidity_pct"]); float(record["pressure_hpa"])
        int(record["sequence"])
        if record["rssi"] is not None:
            int(record["rssi"])
    except (TypeError, ValueError):
        return False
    return -80 <= float(record["temperature_c"]) <= 80 and 0 <= float(record["humidity_pct"]) <= 100 and 800 <= float(record["pressure_hpa"]) <= 1200


class Spool:
    """A durable FIFO of accepted payloads. Survives a service restart and a reboot."""

    def __init__(self, path, max_rows=SPOOL_MAX_ROWS):
        self.path = path
        self.max_rows = max_rows
        self.lock = threading.Lock()
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        with self._conn() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, queued_at REAL NOT NULL)")
            c.execute("CREATE TABLE IF NOT EXISTS dead (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, outcome TEXT, reason TEXT, dead_at REAL NOT NULL)")

    def _conn(self):
        return sqlite3.connect(self.path, timeout=30)

    def put(self, payload):
        with self.lock, self._conn() as c:
            c.execute("INSERT INTO queue (payload, queued_at) VALUES (?, ?)", (payload, time.time()))
            n = c.execute("SELECT COUNT(*) FROM queue").fetchone()[0]
            if n > self.max_rows:
                drop = n - self.max_rows
                c.execute("DELETE FROM queue WHERE id IN (SELECT id FROM queue ORDER BY id LIMIT ?)", (drop,))
                logging.error("Spool full (%d rows): dropped the %d oldest unsent readings", self.max_rows, drop)

    def peek(self, n):
        with self.lock, self._conn() as c:
            return c.execute("SELECT id, payload FROM queue ORDER BY id LIMIT ?", (n,)).fetchall()

    def done(self, ids):
        if not ids:
            return
        with self.lock, self._conn() as c:
            c.executemany("DELETE FROM queue WHERE id = ?", [(i,) for i in ids])

    def bury(self, rows):
        """Move rows NEURO will never accept out of the queue, keeping them for a human."""
        if not rows:
            return
        with self.lock, self._conn() as c:
            for (i, payload, outcome, reason) in rows:
                c.execute("INSERT OR REPLACE INTO dead (id, payload, outcome, reason, dead_at) VALUES (?, ?, ?, ?, ?)", (i, payload, outcome, reason, time.time()))
                c.execute("DELETE FROM queue WHERE id = ?", (i,))

    def bump(self, ids):
        if not ids:
            return
        with self.lock, self._conn() as c:
            c.executemany("UPDATE queue SET attempts = attempts + 1 WHERE id = ?", [(i,) for i in ids])

    def size(self):
        with self.lock, self._conn() as c:
            return c.execute("SELECT COUNT(*) FROM queue").fetchone()[0]


class PostError(Exception):
    def __init__(self, message, permanent=False):
        super().__init__(message)
        self.permanent = permanent


def http_post(url, token, body):
    """POST JSON; return the parsed body. Raises PostError on anything not a usable 2xx."""
    data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "X-NEURO-API-TOKEN": token,
        "X-Neuro-Machine-Client": "saim-weather-ingest",
    })
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")[:300]
        # 4xx is a configuration problem (bad token, refused route): resending the
        # same thing will not help, but neither will dropping readings -- keep them
        # and back off so the journal says why, loudly.
        raise PostError(f"HTTP {e.code}: {text}", permanent=400 <= e.code < 500)
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
        raise PostError(f"unreachable: {e}")
    except json.JSONDecodeError:
        raise PostError("NEURO answered with something that is not JSON")


def forward_once(spool, post, batch=FORWARD_BATCH, source=SOURCE):
    """Send one batch. Returns (sent, ok). Rows leave the spool only on an answer."""
    rows = spool.peek(batch)
    if not rows:
        return 0, True
    ids = [r[0] for r in rows]
    try:
        body = post({"observations": [json.loads(p) for (_, p) in rows], "source": source})
    except PostError as e:
        spool.bump(ids)
        level = logging.error if e.permanent else logging.warning
        level("Forward to NEURO failed (%d queued): %s", spool.size(), e)
        return 0, False
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list) or len(results) != len(rows):
        spool.bump(ids)
        logging.warning("NEURO answered without one outcome per reading -- keeping all %d", len(rows))
        return 0, False
    done, dead = [], []
    for (i, payload), r in zip(rows, results):
        outcome = r.get("outcome") if isinstance(r, dict) else None
        if outcome in ("stored", "duplicate"):
            done.append(i)
        elif outcome in ("rejected", "conflict"):
            dead.append((i, payload, outcome, r.get("reason")))
            logging.warning("NEURO %s a reading (%s): %s", outcome, r.get("reason"), payload[:200])
        else:
            spool.bump([i])
    spool.done(done)
    spool.bury(dead)
    return len(done) + len(dead), True


def forwarder(spool, wake, stop):
    backoff = BACKOFF_MIN_S
    post = lambda body: http_post(NEURO_WEATHER_URL, NEURO_API_TOKEN, body)
    while not stop.is_set():
        sent, ok = forward_once(spool, post)
        if not ok:
            stop.wait(backoff)
            backoff = min(BACKOFF_MAX_S, backoff * 2)
            continue
        backoff = BACKOFF_MIN_S
        if sent:
            continue  # more may be waiting (a backlog after an outage)
        wake.wait(30)
        wake.clear()


def main():
    if not SERIAL_DEVICE:
        sys.exit("SERIAL_DEVICE must be set to /dev/serial/by-id/... in /etc/saim-weather-ingest.env")
    import serial

    mqtt = None
    if MQTT_HOST:
        import paho.mqtt.client as mqtt_client
        mqtt = mqtt_client.Client()
        mqtt.connect(MQTT_HOST, MQTT_PORT, 30)
        mqtt.loop_start()
        logging.info("MQTT enabled: %s", MQTT_TOPIC)

    spool = None
    wake = threading.Event()
    stop = threading.Event()
    if NEURO_WEATHER_URL:
        if not NEURO_API_TOKEN:
            sys.exit("NEURO_WEATHER_URL is set but NEURO_API_TOKEN is not")
        spool = Spool(SPOOL_PATH)
        threading.Thread(target=forwarder, args=(spool, wake, stop), daemon=True, name="forwarder").start()
        logging.info("Forwarding to NEURO at %s (spool %s, %d queued)", NEURO_WEATHER_URL, SPOOL_PATH, spool.size())
    else:
        logging.info("NEURO_WEATHER_URL not set: journal-only")

    logging.info("Listening on %s at %s baud", SERIAL_DEVICE, SERIAL_BAUD)
    with serial.Serial(SERIAL_DEVICE, SERIAL_BAUD, timeout=5) as port:
        # CP2102-based ESP32 boards often wire DTR/RTS to reset/boot circuitry.
        # Release both lines so opening the Pi service cannot hold the receiver reset.
        port.dtr = False
        port.rts = False
        while True:
            try:
                raw = port.readline().decode("utf-8", errors="replace").strip()
                if not raw:
                    continue
                record = json.loads(raw)
                if not valid(record):
                    logging.warning("Rejected invalid telemetry: %r", raw[:300])
                    continue
                record["received_at"] = datetime.now(timezone.utc).isoformat()
                payload = json.dumps(record, separators=(",", ":"))
                logging.info("Accepted %s", payload)
                if spool is not None:
                    try:
                        spool.put(payload)
                        wake.set()
                    except sqlite3.Error as e:
                        logging.error("Could not spool reading for NEURO (journal still has it): %s", e)
                if mqtt:
                    mqtt.publish(f"{MQTT_TOPIC}/{record['node_id']}", payload, qos=1, retain=False)
            except json.JSONDecodeError:
                logging.debug("Ignoring non-JSON serial line")
            except serial.SerialException as exc:
                logging.exception("Serial error: %s", exc)
                raise


if __name__ == "__main__":
    main()
