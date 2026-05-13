"""Deterministic evaluator — keyword + pattern matching, zero API calls.

Inspects the inbound (agent) turns to infer what actually happened, then
compares against the scenario's expected_outcomes dict.

Supported outcome keys:
  booked          bool  — appointment was confirmed
  cancelled       bool  — appointment was cancelled
  rescheduled     bool  — appointment was rescheduled
  task_created    bool  — agent created a follow-up task
  patient_type    str   — new | existing  (detected from agent asking / confirming)
  call_type       str   — scheduling | rescheduling | cancellation | billing | insurance | other
  tags_include    list  — every tag in this list must appear in agent messages
"""

import re
from typing import Any

from .base import BaseEvaluator, EvalOutput


# --------------------------------------------------------------------------- #
# Keyword maps                                                                 #
# --------------------------------------------------------------------------- #

_BOOKED_PATTERNS = re.compile(
    r"\b(booked|scheduled|confirmed your appointment|appointment is set|see you on|"
    r"you('re| are) all set|appointment has been)\b",
    re.I,
)
_CANCELLED_PATTERNS = re.compile(
    r"\b(cancelled|canceled|removed your appointment|appointment has been cancel)\b",
    re.I,
)
_RESCHEDULED_PATTERNS = re.compile(
    r"\b(rescheduled|moved your appointment|new appointment|changed your appointment)\b",
    re.I,
)
_TASK_PATTERNS = re.compile(
    r"\b(follow.?up|someone will (contact|reach out|call)|created a (task|ticket|note)|"
    r"I'?ll have|our team will)\b",
    re.I,
)
_NEW_PATIENT_PATTERNS = re.compile(
    r"\b(new patient|first (visit|appointment|time)|welcome to our practice)\b",
    re.I,
)
_EXISTING_PATIENT_PATTERNS = re.compile(
    r"\b(existing patient|welcome back|see you (again|in our records)|found your (record|account))\b",
    re.I,
)
_CALL_TYPE_PATTERNS: dict[str, re.Pattern] = {
    "scheduling": re.compile(r"\b(schedul|book|new appointment)\b", re.I),
    "rescheduling": re.compile(r"\b(reschedul|move your appointment|change.*appointment)\b", re.I),
    "cancellation": re.compile(r"\b(cancel|remov.*appointment)\b", re.I),
    "billing": re.compile(r"\b(bill|invoice|charge|payment|balance)\b", re.I),
    "insurance": re.compile(r"\b(insurance|coverage|plan|deductible|copay)\b", re.I),
}


def _agent_text(history: list[dict]) -> str:
    return " ".join(t["content"] for t in history if t["direction"] == "inbound")


def _detect(pattern: re.Pattern, text: str) -> bool:
    return bool(pattern.search(text))


def _detect_call_type(text: str) -> str:
    for call_type, pattern in _CALL_TYPE_PATTERNS.items():
        if _detect(pattern, text):
            return call_type
    return "other"


def _detect_patient_type(text: str) -> str | None:
    if _detect(_NEW_PATIENT_PATTERNS, text):
        return "new"
    if _detect(_EXISTING_PATIENT_PATTERNS, text):
        return "existing"
    return None


class DeterministicEvaluator(BaseEvaluator):
    evaluator_type = "deterministic"

    async def evaluate(
        self,
        scenario: Any,
        conversation_history: list[dict],
    ) -> EvalOutput:
        agent_text = _agent_text(conversation_history)
        expected: dict[str, Any] = scenario.expected_outcomes or {}

        checks: dict[str, dict[str, Any]] = {}
        all_passed = True

        def _check(key: str, detected: Any, expected_val: Any) -> None:
            nonlocal all_passed
            match = detected == expected_val
            if not match:
                all_passed = False
            checks[key] = {"expected": expected_val, "detected": detected, "pass": match}

        # Boolean outcome checks
        if "booked" in expected:
            _check("booked", _detect(_BOOKED_PATTERNS, agent_text), expected["booked"])

        if "cancelled" in expected:
            _check("cancelled", _detect(_CANCELLED_PATTERNS, agent_text), expected["cancelled"])

        if "rescheduled" in expected:
            _check("rescheduled", _detect(_RESCHEDULED_PATTERNS, agent_text), expected["rescheduled"])

        if "task_created" in expected:
            _check("task_created", _detect(_TASK_PATTERNS, agent_text), expected["task_created"])

        # String outcome checks
        if "patient_type" in expected:
            _check("patient_type", _detect_patient_type(agent_text), expected["patient_type"])

        if "call_type" in expected:
            _check("call_type", _detect_call_type(agent_text), expected["call_type"])

        # Tags subset check
        if "tags_include" in expected:
            tags_expected: list[str] = expected["tags_include"]
            tags_found = [tag for tag in tags_expected if tag.lower() in agent_text.lower()]
            tags_missing = [tag for tag in tags_expected if tag not in tags_found]
            match = len(tags_missing) == 0
            if not match:
                all_passed = False
            checks["tags_include"] = {
                "expected": tags_expected,
                "found": tags_found,
                "missing": tags_missing,
                "pass": match,
            }

        return EvalOutput(
            passed=all_passed,
            score=None,
            details={"checks": checks, "turn_count": len(conversation_history)},
        )
