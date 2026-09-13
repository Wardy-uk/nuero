"""Config flow for SARA.

Deliberately minimal: where NEURO is, how to authenticate, and how long to
wait. `async_set_agent` requires a ConfigEntry, so a YAML-only integration is
not possible — this is the smallest flow that produces one.

WARNING  THE TOKEN IS NEVER SHOWN BACK. The flow stores it and the options
  flow re-asks rather than pre-filling, for the same reason `notion-sync`
  reports `credentialSource` and never the credential: this repo is public and
  a token echoed into a form is a token in a screenshot.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback

from .const import (
    CONF_BASE_URL,
    CONF_TIMEOUT,
    CONF_TOKEN,
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT,
    DOMAIN,
)


class SaraConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for SARA."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask where NEURO is."""
        # One brain, so one entry. A second would put two agents on one
        # pipeline with no way to tell which answered.
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title="SARA", data=user_input)

        schema = vol.Schema(
            {
                vol.Required(CONF_BASE_URL, default=DEFAULT_BASE_URL): str,
                vol.Required(CONF_TOKEN): str,
                vol.Optional(CONF_TIMEOUT, default=DEFAULT_TIMEOUT): int,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema)

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> OptionsFlow:
        return SaraOptionsFlow()


class SaraOptionsFlow(OptionsFlow):
    """Change the timeout without re-entering the token."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = self.config_entry.options.get(
            CONF_TIMEOUT, self.config_entry.data.get(CONF_TIMEOUT, DEFAULT_TIMEOUT)
        )
        schema = vol.Schema({vol.Optional(CONF_TIMEOUT, default=current): int})
        return self.async_show_form(step_id="init", data_schema=schema)
