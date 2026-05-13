"""Persona response generator.

When ANTHROPIC_API_KEY is set: calls claude-opus-4-7 to generate a dynamic persona reply.
When not set (pure mock mode): uses scripted mock_turns from the scenario YAML.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any

from ..config import settings
from .prompts import PERSONA_SYSTEM

logger = logging.getLogger(__name__)


@dataclass
class PersonaReply:
    message: str
    is_complete: bool
    internal_note: str = ""


class PersonaGenerator:
    def __init__(self) -> None:
        self._client = None
        if settings.has_anthropic:
            import anthropic
            self._client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)

    async def generate(
        self,
        scenario: Any,
        conversation_history: list[dict],
        mock_turn_index: int = 0,
    ) -> PersonaReply:
        if self._client is None:
            return self._scripted_reply(scenario, mock_turn_index)
        return await self._llm_reply(scenario, conversation_history)

    def _scripted_reply(self, scenario: Any, turn_index: int) -> PersonaReply:
        """Fallback used when no API key is available."""
        turns = scenario.mock_turns or []
        if turn_index >= len(turns):
            return PersonaReply(
                message="Thank you, goodbye.",
                is_complete=True,
                internal_note="scripted: ran out of turns",
            )
        turn = turns[turn_index]
        # persona_says is what the patient says at this point in the script
        is_last = turn_index >= len(turns) - 1
        return PersonaReply(
            message=turn.get("persona_says", ""),
            is_complete=turn.get("is_complete", is_last),
            internal_note="scripted",
        )

    async def _llm_reply(self, scenario: Any, history: list[dict]) -> PersonaReply:
        system_prompt = PERSONA_SYSTEM.format(
            persona_description=scenario.persona_description,
            traits=", ".join(scenario.persona_traits or []),
            scenario_goal=scenario.description,
        )

        messages = []
        for turn in history:
            role = "assistant" if turn["direction"] == "outbound" else "user"
            messages.append({"role": role, "content": turn["content"]})

        # Prompt the LLM to generate the next patient turn
        messages.append({
            "role": "user",
            "content": (
                "[SYSTEM: The AI agent just sent the above message. "
                "Respond as the patient in JSON format as instructed.]"
            ),
        })

        response = await self._client.messages.create(
            model="claude-opus-4-7",
            max_tokens=512,
            system=system_prompt,
            messages=messages,
        )

        raw = response.content[0].text.strip()
        try:
            data = json.loads(raw)
            return PersonaReply(
                message=data["message"],
                is_complete=bool(data.get("is_complete", False)),
                internal_note=data.get("internal_note", ""),
            )
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning("Failed to parse persona LLM response: %s — raw: %s", e, raw[:200])
            # Graceful fallback: treat raw text as message, don't end conversation
            return PersonaReply(message=raw[:500], is_complete=False)
