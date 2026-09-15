"""SAiM — NEURO's brain as Home Assistant's conversation agent (13 Sep 2026).

WHY THIS EXISTS, measured rather than assumed.

`intent_script` + `rest_command` was the obvious way to let a voice satellite
ask NEURO a question, and it CANNOT WORK on HA 2026.5.4. Proven with a probe
intent that reported which variables its speech template could actually see:

    neuro_response=False  action_response=False  _response=False  results=False

The same `rest_command` called directly as a service returns the answer
perfectly (`service_response.content.message == "Pong."`, status 200), so the
bridge was never the problem — the response simply does not reach a speech
template. Every "ask SAiM" therefore answered *"Nothing came back from the
bridge to NEURO."*, and every voice capture answered *"I cannot say whether
that saved"* even on a save that worked.

WARNING  THE OLD FAILURE NAMED THE WRONG CAUSE, which is why it survived. It
  sent you to check a bridge that was healthy. A catch-all message that blames
  the wrong component is worse than no message at all.

So the agent moves into Python, where a response can actually be read.

WARNING  HOME ASSISTANT ANSWERS FIRST, ALWAYS. Device control stays local,
  instant and deterministic — "turn the living room lights on" must never take
  a round trip to a cloud model, must never cost money, and must still work
  when the internet is down. Only a sentence HA reports as NO_INTENT_MATCH is
  forwarded to NEURO. That is `event-parser`'s regex-first rule, one layer up.

WARNING  IT NEVER INVENTS AN ANSWER. A timeout, an unreachable backend and a
  refusal each say which one happened, in words, and are never rendered as
  "I didn't understand" — those license opposite next actions (wait and retry
  versus rephrase the question).
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

PLATFORMS: list[Platform] = [Platform.CONVERSATION]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up SAiM from a config entry."""
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload when options change, so a new timeout takes effect immediately."""
    await hass.config_entries.async_reload(entry.entry_id)
