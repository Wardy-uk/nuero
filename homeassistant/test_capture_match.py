"""What counts as a spoken capture.

Runs under plain python3 with no Home Assistant:

    python3 homeassistant/test_capture_match.py

Most of what follows is a REFUSAL. Deciding that a sentence is a todo is easy;
declining to decide it is the part that keeps a thought spoken out loud off the
list Nick uses to find what he owes.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "custom_components", "sara"))

from capture_match import match_capture  # noqa: E402


class TodoPhrases(unittest.TestCase):
    def test_the_plain_forms(self):
        for said in [
            "add a todo buy cat food",
            "add todo buy cat food",
            "add a task buy cat food",
            "new task buy cat food",
            "create a todo buy cat food",
            "please add a todo buy cat food",
            "Add a to-do buy cat food.",
        ]:
            self.assertEqual(match_capture(said), ("todo", "buy cat food"), said)

    def test_the_trailing_forms(self):
        for said in [
            "put buy cat food on my list",
            "add buy cat food to my list",
            "put buy cat food on my todo list",
            "add buy cat food to my to-do list",
        ]:
            self.assertEqual(match_capture(said), ("todo", "buy cat food"), said)


class NotePhrases(unittest.TestCase):
    def test_the_plain_forms(self):
        for said in [
            "remember the bins go out on Tuesday",
            "remember that the bins go out on Tuesday",
            "note that the bins go out on Tuesday",
            "make a note the bins go out on Tuesday",
            "take a note that the bins go out on Tuesday",
        ]:
            self.assertEqual(
                match_capture(said), ("note", "the bins go out on Tuesday"), said
            )


class Refusals(unittest.TestCase):
    def test_ordinary_speech_is_never_a_capture(self):
        # The expensive direction. Every one of these is a question or a
        # command, and capturing it would both lose the answer and put junk on
        # the list.
        for said in [
            "what is on my calendar today",
            "turn the living room lights on",
            "how did I sleep last night",
            "is it going to rain this afternoon",
            "what did I finish this week",
            "tell me about the risk assessment",
            "set the heating to nineteen degrees",
            "who am I meeting tomorrow",
        ]:
            self.assertIsNone(match_capture(said), said)

    def test_a_phrase_with_no_body_is_not_a_capture(self):
        # An empty task occupies a line and says nothing.
        for said in ["remember", "remember that", "add a todo", "note", "make a note", "new task"]:
            self.assertIsNone(match_capture(said), said)

    def test_nothing_at_all(self):
        for said in ["", "   ", ".", None, 42, [], "..."]:
            self.assertIsNone(match_capture(said), repr(said))

    def test_remember_to_do_a_device_thing_is_still_a_note(self):
        # This is the ordering rule stated as a test. Home Assistant is asked
        # FIRST, so a bare "turn the lights off" is a light; by the time a
        # sentence reaches here it did not match a device intent, and
        # "remember to turn the lights off" is a thing to keep, not to do now.
        self.assertEqual(
            match_capture("remember to turn the lights off"),
            ("note", "to turn the lights off"),
        )


class Robustness(unittest.TestCase):
    def test_case_and_trailing_punctuation_do_not_matter(self):
        # A transcript arrives capitalised and sometimes punctuated.
        self.assertEqual(match_capture("REMEMBER THAT Helen is away"), ("note", "Helen is away"))
        self.assertEqual(match_capture("Add a todo call the vet?"), ("todo", "call the vet"))

    def test_a_todo_wins_over_a_note_when_both_could_match(self):
        # "note" is a looser word than "task"; the todo list is the more
        # specific request and is checked first.
        self.assertEqual(
            match_capture("add a task note the meter reading"),
            ("todo", "note the meter reading"),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
