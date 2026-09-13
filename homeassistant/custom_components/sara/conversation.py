"""The SARA conversation entity.

Three things can happen to a sentence, in this order, and the order is the
design:

  1. HOME ASSISTANT ANSWERS IT. Lights, heating, sockets, timers. Local,
     instant, free, and works with the internet down.
  2. IT IS A CAPTURE. Deterministic prefixes only ("remember that…", "add a
     todo…"). Straight to NEURO's capture routes, ~100ms, and the reply states
     what NEURO actually said rather than what we hope it did.
  3. ANYTHING ELSE GOES TO NEURO'S BRAIN — the full chat, with tools and RAG.

WARNING  CAPTURE IS MATCHED ON ANCHORED PREFIXES AND NOTHING ELSE. Guessing
  "that sounded like a task" from prose is how a thought spoken out loud lands
  on the todo list; `feature-tracker`'s rule about explicit prefixes, in a
  place where the input is a transcript and therefore already lossy.

WARNING  ORDER MATTERS THE OTHER WAY TOO: capture is checked AFTER Home
  Assistant, so "remember to turn the lights off" stays a captured note rather
  than being hijacked, while "turn the lights off" is still a light.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import aiohttp
from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .capture_match import match_capture
from .ha_answer import ha_answer_stands
from .const import (
    CONF_BASE_URL,
    CONF_TIMEOUT,
    CONF_TOKEN,
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT,
)

_LOGGER = logging.getLogger(__name__)


def _targets_of(response: Any) -> list[str]:
    """The entity ids an answer was about, so the rule can see WHAT it answered.

    ⚠ Read defensively. These are populated on a successful query and absent on
      an error, and a shape we cannot read must leave the decision to the other
      rules rather than being treated as "no targets, therefore fine".
    """
    out: list[str] = []
    for attr in ("success_results", "failed_results"):
        for item in getattr(response, attr, None) or []:
            ident = getattr(item, "id", None)
            if isinstance(ident, str) and ident:
                out.append(ident)
    return out


def _value(item: Any) -> str | None:
    """A StrEnum, a str or None, as a plain string — so the pure rule stays pure."""
    if item is None:
        return None
    return getattr(item, "value", None) or str(item)

async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up the SARA conversation entity."""
    async_add_entities([SaraConversationEntity(entry)])


class SaraConversationEntity(conversation.ConversationEntity):
    """NEURO's brain, wearing Home Assistant's conversation interface."""

    _attr_has_entity_name = True
    _attr_name = "SARA"

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = entry.entry_id

    @property
    def supported_languages(self) -> list[str]:
        return ["en", "en-GB", "en-US"]

    # ── Config ───────────────────────────────────────────────────────────

    def _opt(self, key: str, default: Any) -> Any:
        """Options win over data, so a changed timeout needs no re-entry."""
        return self._entry.options.get(key, self._entry.data.get(key, default))

    @property
    def _base_url(self) -> str:
        return str(self._opt(CONF_BASE_URL, DEFAULT_BASE_URL)).rstrip("/")

    @property
    def _timeout(self) -> int:
        try:
            value = int(self._opt(CONF_TIMEOUT, DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            return DEFAULT_TIMEOUT
        # A zero or negative timeout would abort every call instantly and read
        # exactly like NEURO being down.
        return value if value > 0 else DEFAULT_TIMEOUT

    # ── The pipeline ─────────────────────────────────────────────────────

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        """Answer a sentence."""
        ha_result = await self._try_home_assistant(user_input)
        if ha_result is not None:
            return ha_result

        capture = match_capture(user_input.text or "")
        if capture is not None:
            kind, body = capture
            return await self._capture(user_input, kind, body)

        return await self._ask_neuro(user_input)

    async def _try_home_assistant(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult | None:
        """Let Home Assistant answer if it can. None means it could not.

        WARNING  WHAT COUNTS AS AN ANSWER IS `ha_answer.ha_answer_stands`, which
          is pure and tested against live fixtures — both of its fall-through
          cases were found by asking the real house, not by reasoning. Keeping
          the rule out of here is what lets it be checked at all.
        """
        try:
            result = await conversation.async_converse(
                hass=self.hass,
                text=user_input.text,
                conversation_id=user_input.conversation_id,
                context=user_input.context,
                language=user_input.language,
                agent_id=conversation.HOME_ASSISTANT_AGENT,
                device_id=user_input.device_id,
            )
        except Exception:  # noqa: BLE001 - HA's agent must never take SARA down
            _LOGGER.exception("Home Assistant's own agent raised; falling through to NEURO")
            return None

        response = result.response
        # `intent` is None on an error response, so it is read defensively —
        # an unreadable field must fall through rather than be trusted.
        matched = getattr(getattr(response, "intent", None), "intent_type", None)
        targets = _targets_of(response)
        if ha_answer_stands(
            _value(response.response_type),
            _value(response.error_code),
            _value(matched),
            targets,
        ):
            return result

        _LOGGER.debug(
            "Home Assistant did not answer %r (type=%s code=%s intent=%s targets=%s); asking NEURO",
            user_input.text,
            _value(response.response_type),
            _value(response.error_code),
            _value(matched),
            targets,
        )
        return None

    # ── Capture ──────────────────────────────────────────────────────────

    async def _capture(
        self, user_input: conversation.ConversationInput, kind: str, body: str
    ) -> conversation.ConversationResult:
        """Send a capture and say what NEURO actually reported."""
        if kind == "todo":
            path, payload = "/api/capture/todo", {"text": body}
        else:
            path, payload = "/api/capture/note", {"title": "Voice capture", "content": body}

        ok, data, problem = await self._post(path, payload)
        if not ok:
            # WARNING  The words in the box are the last copy of the thought,
            # and there is no box here — so the reply repeats it back. A
            # capture that failed silently is exactly what capture exists to
            # prevent.
            return self._say(
                user_input,
                f"I could not save that — {problem}. What you said was: {body}",
            )

        # `success` is NEURO's own acknowledgement. A 200 carrying anything
        # else is not one (`neuroCapture`'s rule).
        if not (isinstance(data, dict) and data.get("success")):
            return self._say(
                user_input,
                f"NEURO answered but did not confirm that saved. What you said was: {body}",
            )

        if kind == "todo":
            return self._say(user_input, "Added to your list.")
        return self._say(user_input, "Noted.")

    # ── The brain ────────────────────────────────────────────────────────

    async def _ask_neuro(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        """Forward the sentence to NEURO's chat and speak the answer."""
        started = time.monotonic()
        ok, data, problem = await self._post(
            "/api/chat/sync",
            {
                "message": user_input.text,
                # The conversation id travels, so NEURO keeps context per
                # conversation rather than treating every sentence as new.
                "conversationId": user_input.conversation_id or "ha-assist",
            },
        )
        elapsed = time.monotonic() - started

        if not ok:
            _LOGGER.warning("SARA could not answer after %.1fs: %s", elapsed, problem)
            return self._say(user_input, f"I couldn't reach my brain — {problem}.")

        message = None
        if isinstance(data, dict):
            message = data.get("message")
        if not isinstance(message, str) or not message.strip():
            _LOGGER.warning("NEURO answered in %.1fs with no message field", elapsed)
            return self._say(user_input, "NEURO answered, but with nothing I can say out loud.")

        # Logged so the latency can be MEASURED from real use rather than
        # guessed at — the timeout above was set from two samples.
        _LOGGER.debug("SARA answered in %.1fs", elapsed)
        return self._say(user_input, message.strip())

    # ── Plumbing ─────────────────────────────────────────────────────────

    async def _post(
        self, path: str, payload: dict[str, Any]
    ) -> tuple[bool, Any, str | None]:
        """POST to NEURO. Returns (ok, parsed body, human reason for failure).

        WARNING  Each failure is told apart, because they license different
          next actions: waiting, rephrasing, or going and fixing something.
        """
        token = self._opt(CONF_TOKEN, None)
        if not token:
            return False, None, "no NEURO token is configured"

        url = f"{self._base_url}{path}"
        session = async_get_clientsession(self.hass)
        try:
            async with session.post(
                url,
                json=payload,
                headers={"x-neuro-api-token": str(token)},
                timeout=aiohttp.ClientTimeout(total=self._timeout),
            ) as response:
                status = response.status
                try:
                    body = await response.json(content_type=None)
                except Exception:  # noqa: BLE001
                    body = await response.text()

                if status == 200:
                    return True, body, None
                if status in (401, 403):
                    return False, body, "NEURO refused my credentials"
                return False, body, f"NEURO answered with status {status}"
        except asyncio.TimeoutError:
            return False, None, f"it took longer than {self._timeout} seconds"
        except aiohttp.ClientError as err:
            # The exception text can carry the URL and is fine for a log, but
            # a spoken sentence naming a host and port helps nobody.
            _LOGGER.warning("SARA could not reach NEURO at %s: %s", url, err)
            return False, None, "I couldn't connect to it"

    def _say(
        self, user_input: conversation.ConversationInput, text: str
    ) -> conversation.ConversationResult:
        """Wrap plain speech as a conversation result.

        WARNING  Deliberately ordinary speech rather than `async_set_error`,
          even for an outage: an error response is handled differently by
          different pipelines and can end up spoken as nothing at all, and
          silence is the one answer a failure must never give.
        """
        response = intent.IntentResponse(language=user_input.language or "en")
        response.async_set_speech(text)
        return conversation.ConversationResult(
            response=response,
            conversation_id=user_input.conversation_id,
        )
