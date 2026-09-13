"""When Home Assistant's answer stands, and when the sentence goes to NEURO.

    python3 homeassistant/test_ha_answer.py

Both fall-through cases are live fixtures: the exact response_type/error_code
Home Assistant produced on Nick's own house on 13 Sep 2026.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "custom_components", "sara"))

from ha_answer import NOT_THE_HOUSE, ha_answer_stands  # noqa: E402


class TheHouse(unittest.TestCase):
    def test_a_device_action_stands(self):
        # The whole reason HA is asked first: local, instant, free, offline.
        self.assertTrue(ha_answer_stands("action_done", None, "HassTurnOn"))
        self.assertTrue(ha_answer_stands("action_done", None, "HassLightSet"))
        self.assertTrue(ha_answer_stands("action_done", None, "HassClimateSetTemperature"))

    def test_a_sensor_read_stands(self):
        self.assertTrue(ha_answer_stands("query_answer", None, "HassGetState"))

    def test_an_unrecognised_house_error_stands(self):
        # "That device does not support that" is a precise local fact and beats
        # anything a language model would say about it.
        self.assertTrue(ha_answer_stands("error", "failed_to_handle", "HassTurnOn"))
        self.assertTrue(ha_answer_stands("error", "unknown", "HassTurnOn"))


class FallsThroughToNeuro(unittest.TestCase):
    def test_no_intent_match(self):
        self.assertFalse(ha_answer_stands("error", "no_intent_match", None))

    def test_no_valid_targets(self):
        # LIVE FIXTURE: "what is the living room temperature" answered
        # no_valid_targets, spoken as the generic "Sorry, I couldn't understand
        # that", while a living-room climate entity exists.
        self.assertFalse(ha_answer_stands("error", "no_valid_targets", "HassGetState"))

    def test_the_date_intent_never_shadows_a_real_question(self):
        # LIVE FIXTURE: "what is on my calendar today" answered action_done
        # with "September 13th, 2026".
        self.assertFalse(ha_answer_stands("action_done", None, "HassGetCurrentDate"))
        self.assertFalse(ha_answer_stands("action_done", None, "HassGetCurrentTime"))

    def test_an_unreadable_response_falls_through(self):
        # Never accept what could not be inspected.
        for bad in [None, "", 0]:
            self.assertFalse(ha_answer_stands(bad), repr(bad))


class TheShapeOfTheRule(unittest.TestCase):
    def test_case_does_not_decide_anything(self):
        self.assertFalse(ha_answer_stands("ERROR", "NO_INTENT_MATCH", None))
        self.assertFalse(ha_answer_stands("Error", "No_Valid_Targets", None))

    def test_a_missing_intent_type_does_not_block_a_real_answer(self):
        # Older/simpler responses carry no intent object. That is not evidence
        # the answer was trivia, so it stands.
        self.assertTrue(ha_answer_stands("action_done", None, None))

    def test_it_is_a_deny_list_and_stays_small(self):
        # An allow list would have to grow with every new HA device capability,
        # and forgetting would send working device control to a language model.
        self.assertEqual(NOT_THE_HOUSE, frozenset({"HassGetCurrentDate", "HassGetCurrentTime"}))
        self.assertTrue(ha_answer_stands("action_done", None, "HassSomeBrandNewDeviceIntent"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
