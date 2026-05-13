"""LLM judge rubric definitions.

Each rubric maps a dimension name → description used in the judge prompt.
The prompt template lives in personas/prompts.py — this module
exists so future milestones can register additional rubrics without
modifying the judge itself.
"""

from dataclasses import dataclass


@dataclass
class RubricDimension:
    name: str
    description: str
    weight: float = 1.0  # reserved for v1 weighted scoring


DEFAULT_RUBRIC: list[RubricDimension] = [
    RubricDimension(
        "clarity",
        "Messages are clear, well-structured, and unambiguous.",
    ),
    RubricDimension(
        "empathy",
        "Agent acknowledges the patient's emotional state appropriately.",
    ),
    RubricDimension(
        "task_completion",
        "Agent accomplishes what the patient actually needed.",
    ),
    RubricDimension(
        "hallucination_risk",
        "Agent does NOT invent information it could not know (5=no hallucinations).",
        weight=1.5,
    ),
    RubricDimension(
        "scheduling_accuracy",
        "Times, dates, and booking details are handled correctly.",
    ),
]

RUBRIC_BY_NAME = {r.name: r for r in DEFAULT_RUBRIC}
