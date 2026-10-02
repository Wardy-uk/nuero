#!/usr/bin/env python3
"""SAiM's natural voice for Home Assistant — a Wyoming TTS server that speaks
through NEURO.

Nick, 2 Oct 2026: the house voice was "so unnatural that it was annoying". The
living-room satellite spoke through Piper (`en_US-lessac-medium`) while NEURO
already had a natural voice (`POST /api/tts/speak`, OpenRouter
`gpt-audio-mini`, voice `coral`) that only the phone used. This is the bridge:
Home Assistant's voice pipeline points its TTS at this server, and this server
asks NEURO for the audio.

⚠ IT FALLS BACK TO PIPER, never to silence. If NEURO is slow, down or answers
with anything that is not audio, the same text is handed to the local Piper
server and its audio relayed instead — a reply in the old voice beats a room
that says nothing after it was asked something.

Config (env, from /etc/saim-voice.env):
  NEURO_BASE_URL   e.g. http://127.0.0.1:3001
  NEURO_API_TOKEN  machine token (preferred) — or NEURO_PIN
  PIPER_URI        fallback, default tcp://127.0.0.1:10200
  LISTEN_URI       default tcp://0.0.0.0:10201
  NEURO_TIMEOUT_S  default 10
"""

import asyncio
import io
import json
import logging
import os
import urllib.request
import wave
from functools import partial

from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.client import AsyncClient
from wyoming.event import Event
from wyoming.info import Attribution, Describe, Info, TtsProgram, TtsVoice
from wyoming.server import AsyncEventHandler, AsyncServer
from wyoming.tts import Synthesize

LOG = logging.getLogger("saim-voice")

NEURO = os.environ.get("NEURO_BASE_URL", "http://127.0.0.1:3001").rstrip("/")
TOKEN = os.environ.get("NEURO_API_TOKEN", "").strip()
PIN = os.environ.get("NEURO_PIN", "").strip()
PIPER_URI = os.environ.get("PIPER_URI", "tcp://127.0.0.1:10200")
LISTEN_URI = os.environ.get("LISTEN_URI", "tcp://0.0.0.0:10201")
TIMEOUT = float(os.environ.get("NEURO_TIMEOUT_S", "10"))
CHUNK_FRAMES = 1024


def neuro_wav(text: str) -> bytes:
    """NEURO's natural voice as WAV bytes, or raise."""
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["X-NEURO-API-TOKEN"] = TOKEN
    elif PIN:
        headers["X-NEURO-PIN"] = PIN
    req = urllib.request.Request(f"{NEURO}/api/tts/speak", method="POST", headers=headers,
                                 data=json.dumps({"text": text}).encode())
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        if "audio" not in (r.headers.get("Content-Type") or ""):
            raise RuntimeError(f"NEURO answered {r.headers.get('Content-Type')}, not audio")
        return r.read()


class Handler(AsyncEventHandler):
    def __init__(self, info_event: Event, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.info_event = info_event

    async def handle_event(self, event: Event) -> bool:
        if Describe.is_type(event.type):
            await self.write_event(self.info_event)
            return True
        if not Synthesize.is_type(event.type):
            return True

        text = (Synthesize.from_event(event).text or "").strip()
        if not text:
            await self.write_event(AudioStart(rate=24000, width=2, channels=1).event())
            await self.write_event(AudioStop().event())
            return True

        try:
            data = await asyncio.get_running_loop().run_in_executor(None, neuro_wav, text)
            with wave.open(io.BytesIO(data), "rb") as w:
                rate, width, channels = w.getframerate(), w.getsampwidth(), w.getnchannels()
                await self.write_event(AudioStart(rate=rate, width=width, channels=channels).event())
                while True:
                    frames = w.readframes(CHUNK_FRAMES)
                    if not frames:
                        break
                    await self.write_event(AudioChunk(audio=frames, rate=rate, width=width, channels=channels).event())
            await self.write_event(AudioStop().event())
            LOG.info("spoke %d chars in the natural voice", len(text))
        except Exception as e:  # noqa: BLE001 — any failure falls back, by design
            LOG.warning("natural voice failed (%s) — falling back to Piper", e)
            await self.relay_piper(event)
        return True

    async def relay_piper(self, event: Event) -> None:
        """Hand the same Synthesize to Piper and pass its audio straight through."""
        try:
            async with AsyncClient.from_uri(PIPER_URI) as piper:
                await piper.write_event(event)
                while True:
                    e = await asyncio.wait_for(piper.read_event(), timeout=30)
                    if e is None:
                        break
                    await self.write_event(e)
                    if AudioStop.is_type(e.type):
                        break
        except Exception as e:  # noqa: BLE001
            LOG.error("Piper fallback failed too: %s", e)
            await self.write_event(AudioStart(rate=24000, width=2, channels=1).event())
            await self.write_event(AudioStop().event())


def info() -> Info:
    attr = Attribution(name="NEURO", url="https://github.com/Wardy-uk/nuero")
    voice = TtsVoice(name="saim", description="SAiM (NEURO coral, Piper fallback)", attribution=attr,
                     installed=True, version=None, languages=["en-GB", "en"])
    return Info(tts=[TtsProgram(name="saim-voice", description="SAiM's natural voice via NEURO",
                                attribution=attr, installed=True, voices=[voice], version="1.0")])


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    LOG.info("listening on %s → %s (fallback %s)", LISTEN_URI, NEURO, PIPER_URI)
    server = AsyncServer.from_uri(LISTEN_URI)
    await server.run(partial(Handler, info().event()))


if __name__ == "__main__":
    asyncio.run(main())
