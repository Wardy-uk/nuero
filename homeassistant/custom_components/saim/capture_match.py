"""Which spoken sentences are captures. PURE — no Home Assistant, no network.

Split out so the judgement pins without a running Home Assistant, exactly as
`pi-health.assess()` and `context-state` are split from their readers. The
rules here are the product; the HTTP around them is plumbing.

WARNING  ANCHORED PREFIXES ONLY, AND NEVER AN INFERENCE FROM PROSE. "That
  sounded like a task" is how a thought spoken out loud silently becomes a
  todo — `feature-tracker`'s explicit-prefix rule, in a place where the input
  is already a lossy transcript.

WARNING  A PHRASE WITH NO BODY IS NOT A CAPTURE. "Remember" on its own, or a
  trailing "add a todo" with nothing after it, returns None rather than
  capturing an empty string — an empty task is worse than no task, because it
  occupies a line in the list Nick uses to find what he owes and says nothing.
"""

from __future__ import annotations

import re

# Longest and most specific first: "add a todo X" must not be read by a looser
# sibling as "add X to my list".
_TODO_PATTERNS = [
    re.compile(
        r"^(?:please\s+)?add\s+(?:a\s+)?(?:new\s+)?(?:todo|to-do|to do|task)\s+(?:to\s+)?(.+)$",
        re.I,
    ),
    re.compile(r"^(?:please\s+)?(?:new|create\s+a)\s+(?:todo|to-do|task)\s+(.+)$", re.I),
    re.compile(r"^(?:please\s+)?put\s+(.+?)\s+on\s+my\s+(?:to-?\s?do\s+)?list$", re.I),
    re.compile(r"^(?:please\s+)?add\s+(.+?)\s+to\s+my\s+(?:to-?\s?do\s+)?list$", re.I),
]

_NOTE_PATTERNS = [
    re.compile(r"^(?:please\s+)?remember\s+(?:that\s+)?(.+)$", re.I),
    re.compile(r"^(?:please\s+)?take\s+a\s+note\s+(?:that\s+)?(.+)$", re.I),
    re.compile(r"^(?:please\s+)?(?:make\s+a\s+note|note)\s+(?:that\s+)?(.+)$", re.I),
]

# WARNING  AN OPTIONAL GROUP BACKTRACKS, and that is not a theoretical worry —
#   "remember that" matched, skipped its own optional `that`, and captured the
#   word "that" as the note. The regex is behaving correctly; the body simply
#   has to be checked for being nothing but filler. Caught by a test rather
#   than by reading it.
_FILLER_BODIES = {"that", "this", "it", "to", "the", "a", "and"}


def match_capture(text: str) -> tuple[str, str] | None:
    """Return ('todo'|'note', body) for a capture phrase, else None."""
    if not isinstance(text, str):
        return None
    cleaned = text.strip().rstrip(".!?").strip()
    if not cleaned:
        return None

    for pattern in _TODO_PATTERNS:
        match = pattern.match(cleaned)
        if match:
            body = _body(match)
            if body:
                return ("todo", body)

    for pattern in _NOTE_PATTERNS:
        match = pattern.match(cleaned)
        if match:
            body = _body(match)
            if body:
                return ("note", body)

    return None


def _body(match: "re.Match[str]") -> str | None:
    """The captured body, or None when there is nothing real in it."""
    body = match.group(1).strip()
    if not body:
        return None
    if body.lower() in _FILLER_BODIES:
        return None
    return body
