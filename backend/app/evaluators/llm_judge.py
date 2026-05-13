"""LLM Judge evaluator — uses claude-opus-4-7 to score conversation quality.

Skipped automatically when ANTHROPIC_API_KEY is not set; caller receives
a special EvalOutput with passed=None and details["skipped"]=True.
"""

import json
import logging
from typing import Any

from .base import BaseEvaluator, EvalOutput
from ..config import settings
from ..personas.prompts import JUDGE_SYSTEM

logger = logging.getLogger(__name__)


def _format_transcript(history: list[dict]) -> str:
    lines = []
    for turn in history:
        role = "PATIENT" if turn["direction"] == "outbound" else "AGENT"
        lines.append(f"{role}: {turn['content']}")
    return "\n".join(lines)


class LLMJudgeEvaluator(BaseEvaluator):
    evaluator_type = "llm_judge"

    def __init__(self) -> None:
        self._client = None
        if settings.has_anthropic:
            import anthropic
            self._client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)

    async def evaluate(
        self,
        scenario: Any,
        conversation_history: list[dict],
    ) -> EvalOutput:
        if self._client is None:
            return EvalOutput(
                passed=None,
                score=None,
                details={"skipped": True, "reason": "ANTHROPIC_API_KEY not set"},
            )

        transcript = _format_transcript(conversation_history)
        user_prompt = (
            f"Scenario goal: {scenario.description}\n\n"
            f"Conversation transcript:\n{transcript}\n\n"
            "Evaluate the AGENT's performance per the rubric and respond in JSON."
        )

        try:
            response = await self._client.messages.create(
                model="claude-opus-4-7",
                max_tokens=1024,
                system=JUDGE_SYSTEM,
                messages=[{"role": "user", "content": user_prompt}],
            )
            raw = response.content[0].text.strip()
            data = json.loads(raw)

            scores: dict[str, int] = data.get("scores", {})
            overall = data.get("overall_score", sum(scores.values()) / max(len(scores), 1))
            passed = bool(data.get("passed", overall >= 3.0))

            return EvalOutput(
                passed=passed,
                score=float(overall),
                details={
                    "scores": scores,
                    "rationale": data.get("rationale", ""),
                    "critical_failure": data.get("critical_failure"),
                    "skipped": False,
                },
            )
        except Exception as e:
            logger.error("LLM judge failed: %s", e)
            return EvalOutput(
                passed=None,
                score=None,
                details={"skipped": True, "reason": f"LLM error: {e}"},
            )
