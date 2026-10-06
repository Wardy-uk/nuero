"""Spool + forwarder tests. Run: python3 -m unittest saim/weather/test_serial_ingest.py

No serial port, no network: `forward_once` takes the POST as a function.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import serial_ingest as si  # noqa: E402


def rec(seq):
    return json.dumps({"schema": "saim.weather.v1", "node_id": "outdoor-1", "sequence": seq,
                       "temperature_c": 23.4, "humidity_pct": 54.4, "pressure_hpa": 999.9,
                       "battery_mv": None, "rssi": -55, "received_at": "2026-10-06T18:55:14.732690+00:00"})


class SpoolTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "spool.db")
        self.spool = si.Spool(self.path)

    def answer(self, *outcomes):
        def post(body):
            self.sent = body
            return {"ok": True, "results": [{"outcome": o, "reason": "x" if o in ("rejected", "conflict") else None} for o in outcomes]}
        return post

    def test_survives_a_restart(self):
        self.spool.put(rec(1)); self.spool.put(rec(2))
        self.assertEqual(si.Spool(self.path).size(), 2)

    def test_stored_and_duplicate_leave_the_spool(self):
        self.spool.put(rec(1)); self.spool.put(rec(2))
        sent, ok = si.forward_once(self.spool, self.answer("stored", "duplicate"))
        self.assertEqual((sent, ok), (2, True))
        self.assertEqual(self.spool.size(), 0)
        self.assertEqual(self.sent["observations"][0]["sequence"], 1)
        self.assertTrue(self.sent["source"].startswith("saim-weather-ingest@"))

    def test_unreachable_neuro_loses_nothing(self):
        self.spool.put(rec(1))
        def down(body):
            raise si.PostError("unreachable: refused")
        self.assertEqual(si.forward_once(self.spool, down), (0, False))
        self.assertEqual(self.spool.size(), 1)
        # ... and it goes through once NEURO is back.
        self.assertEqual(si.forward_once(self.spool, self.answer("stored")), (1, True))
        self.assertEqual(self.spool.size(), 0)

    def test_a_4xx_keeps_the_readings(self):
        self.spool.put(rec(1))
        def refused(body):
            raise si.PostError("HTTP 401: bad token", permanent=True)
        si.forward_once(self.spool, refused)
        self.assertEqual(self.spool.size(), 1)

    def test_rejected_and_conflict_are_buried_not_retried_forever(self):
        self.spool.put(rec(1)); self.spool.put(rec(2)); self.spool.put(rec(3))
        si.forward_once(self.spool, self.answer("stored", "rejected", "conflict"))
        self.assertEqual(self.spool.size(), 0)
        with self.spool._conn() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM dead").fetchone()[0], 2)

    def test_an_answer_without_one_outcome_per_reading_keeps_everything(self):
        self.spool.put(rec(1)); self.spool.put(rec(2))
        self.assertEqual(si.forward_once(self.spool, lambda b: {"ok": True, "results": []}), (0, False))
        self.assertEqual(self.spool.size(), 2)

    def test_fifo_and_batching(self):
        for s in range(1, 6):
            self.spool.put(rec(s))
        si.forward_once(self.spool, self.answer("stored", "stored"), batch=2)
        self.assertEqual([o["sequence"] for o in self.sent["observations"]], [1, 2])
        self.assertEqual(self.spool.size(), 3)

    def test_a_full_spool_drops_the_oldest(self):
        small = si.Spool(os.path.join(self.dir, "small.db"), max_rows=3)
        for s in range(1, 6):
            small.put(rec(s))
        self.assertEqual(small.size(), 3)
        self.assertEqual(json.loads(small.peek(1)[0][1])["sequence"], 3)

    def test_validator_unchanged(self):
        self.assertTrue(si.valid(json.loads(rec(1))))
        bad = json.loads(rec(1)); bad["humidity_pct"] = 140
        self.assertFalse(si.valid(bad))


if __name__ == "__main__":
    unittest.main()
