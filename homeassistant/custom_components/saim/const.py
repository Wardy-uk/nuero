"""Constants for the SAiM conversation agent."""

DOMAIN = "saim"

CONF_BASE_URL = "base_url"
CONF_TOKEN = "token"
CONF_TIMEOUT = "timeout"

DEFAULT_BASE_URL = "http://127.0.0.1:3001"

# Measured on the live Pi, 13 Sep 2026: two consecutive /api/chat/sync calls
# took 4.3s and 35.0s. A voice assistant that gives up at ten seconds would
# therefore fail on a normal question roughly half the time, and fail SILENTLY
# from the listener's point of view.
#
# WARNING  This is a ceiling, not a target. It is deliberately generous because
#   the alternative is cutting off an answer that was on its way; the honest
#   thing to do about a slow brain is to SAY it was slow, which the agent does.
DEFAULT_TIMEOUT = 45
