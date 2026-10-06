# Outdoor weather station → NEURO

ESP32-C3 + BME280 → ESP-NOW → ESP32 receiver → USB on **pi5** → `saim-weather-ingest`
→ `POST /api/weather/observations` → NEURO's `weather_observations` table → the **Weather**
screen (NEURO sidebar, LIFE group).

`serial_ingest.py` is the source of truth for `/opt/saim-weather/serial_ingest.py` on pi5.
It keeps the existing behaviour (validate, journal `Accepted {...}`, optional MQTT) and adds
forwarding through a durable SQLite spool at `/var/lib/saim-weather/spool.db`:

- a reading is spooled **before** it is sent, and leaves the spool only when NEURO answers
  with an outcome for it (`stored` / `duplicate` → done; `rejected` / `conflict` → moved to
  the spool's `dead` table and logged);
- NEURO down, network down, or a 4xx (bad token) → nothing is lost; it backs off 5 s → 5 min
  and drains the backlog when NEURO is back;
- a resend is safe: NEURO folds the same node + sequence + `received_at` as a duplicate, and
  a transmitter reboot (sequence back to 1) opens a new `boot` instead of colliding.

With `NEURO_WEATHER_URL` empty it is exactly the old journal-only service.

## Install / upgrade on pi5

```bash
# from a checkout of this repo on pi5 (/mnt/data/nuero)
sudo install -m 0755 saim/weather/serial_ingest.py /opt/saim-weather/serial_ingest.py
sudo install -m 0644 saim/weather/saim-weather-ingest.service /etc/systemd/system/saim-weather-ingest.service
# add the three NEURO_* / SPOOL_PATH lines from saim-weather-ingest.env.example to the env file:
sudo nano /etc/saim-weather-ingest.env      # NEURO_API_TOKEN = the value in backend/.env
sudo chmod 0640 /etc/saim-weather-ingest.env
sudo systemctl daemon-reload && sudo systemctl restart saim-weather-ingest
journalctl -u saim-weather-ingest -f        # expect "Forwarding to NEURO at …" then Accepted lines
```

The NEURO backend must be deployed first (it creates the tables at startup).

## Tests

```bash
python3 -m unittest saim/weather/test_serial_ingest.py
```
