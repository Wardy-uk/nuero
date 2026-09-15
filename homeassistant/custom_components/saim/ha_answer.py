"""Does Home Assistant's own answer stand, or does the sentence go to NEURO?

PURE — strings in, a boolean out. No Home Assistant, no network, so the rule
that decides what reaches the brain pins without a running house.

THE PRINCIPLE: HOME ASSISTANT IS AUTHORITATIVE ABOUT THE HOUSE, AND NOTHING
ELSE. Lights, heating, sockets, sensors, timers — local, instant, free, and
working with the internet down. It is not authoritative about Nick's diary,
his tasks, his week or his body, and an answer it gives about one of those is
a guess made by sentence-matching.

⚠ BOTH REFUSALS BELOW WERE MEASURED ON THE LIVE HOUSE, 13 Sep 2026, not
  reasoned about in advance — and the first cut of this rule got both wrong.

  1. "what is on my calendar today" → Home Assistant answered `action_done`
     with **"September 13th, 2026"**. It matched its own date intent on the
     word "today" and gave a confident, fluent answer to a different question,
     and NEURO never saw the sentence. A wrong answer delivered confidently is
     worse than no answer, because there is nothing about it to notice.

  2. "what is the living room temperature" → `no_valid_targets`, spoken as
     **"Sorry, I couldn't understand that"** — while a living-room climate
     entity exists and is readable. The first version of this rule deliberately
     kept that error, on the argument that "no valid targets" is a precise
     local fact and a model would blur it. The live wording shows it is not
     precise at all: it is the generic no-match line, so keeping it buys the
     user nothing and costs them the answer.
"""

from __future__ import annotations

# Home Assistant intents that are not about the house. They are the ones that
# hijack a question meant for the brain, because they match on a bare date or
# time word appearing anywhere in the sentence.
#
# ⚠ A DENY LIST, NOT AN ALLOW LIST, deliberately. An allow list of house
#   intents would have to be extended every time Home Assistant adds a device
#   capability, and the failure mode of forgetting is that working device
#   control silently starts going to a language model — slow, costly and
#   broken offline. Forgetting to deny a new trivia intent merely restores
#   today's behaviour.
NOT_THE_HOUSE = frozenset(
    {
        "HassGetCurrentDate",
        "HassGetCurrentTime",
    }
)

# Error codes that mean Home Assistant did not really answer.
_FALL_THROUGH_CODES = frozenset({"no_intent_match", "no_valid_targets"})


# Entity domains Home Assistant is NOT the authority on in this house.
#
# ⚠⚠ MEASURED, 13 Sep 2026. Asked "is anyone else home" Home Assistant answered
#   **"No"**, matching exactly one entity: `person.nick`. Helen and Isaac were
#   both in.
#
#   That is not a bug in Home Assistant, it is the shape of this house: HA holds
#   ONE `person` entity, and the household truth lives in
#   `binary_sensor.household_others_home`, built from Life360 (for WHO) and the
#   router's associated-client list (for WHETHER anyone is indoors). The router
#   is there precisely because the phone reports home ~90m out over Wi-Fi
#   positioning, which makes the GPS geofence useless at home.
#
#   So when HA answers about people it is answering from the weakest source in
#   the building, and NEURO — which reads that sensor — is the one that knows.
#   Lights, radiators and sockets stay HA's, instantly and offline.
PEOPLE_DOMAINS = frozenset({"person", "device_tracker"})


def _all_targets_are_people(targets) -> bool:
    """True when every entity the answer was about is a person or a tracker.

    ⚠ ALL, not ANY. A question that touched a light as well as a person is
      still partly about the house, and HA's answer about the light is worth
      more than a language model's guess. Only a PURELY presence answer is
      handed on.

    ⚠ NO TARGETS MEANS THIS RULE SAYS NOTHING. An answer we cannot inspect is
      decided by the rules above, not silently handed on by this one.
    """
    ids = [str(t) for t in (targets or []) if t]
    if not ids:
        return False
    return all(i.split(".")[0].lower() in PEOPLE_DOMAINS for i in ids)


def ha_answer_stands(
    response_type: str | None,
    error_code: str | None = None,
    intent_type: str | None = None,
    targets=None,
) -> bool:
    """True when Home Assistant's answer should be used as-is.

    ⚠ An unreadable response FALLS THROUGH to NEURO rather than being accepted.
      Accepting something we could not inspect is how a confidently wrong
      answer gets spoken; asking the brain costs a round trip and says
      something honest either way.
    """
    if not response_type:
        return False

    if str(response_type).lower() == "error":
        code = str(error_code or "").lower()
        # An error we do not recognise IS Home Assistant's own answer about its
        # own devices ("that device is not supported", and so on) and is more
        # useful than a guess.
        return code not in _FALL_THROUGH_CODES

    # A real answer, but only if it was about the house.
    if intent_type and str(intent_type) in NOT_THE_HOUSE:
        return False

    # ⚠ …and only if it was about the house's DEVICES rather than its people.
    if _all_targets_are_people(targets):
        return False

    return True
