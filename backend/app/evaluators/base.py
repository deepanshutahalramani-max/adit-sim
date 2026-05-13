from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class EvalOutput:
    passed: bool
    score: float | None
    details: dict[str, Any] = field(default_factory=dict)


class BaseEvaluator(ABC):
    evaluator_type: str = "base"

    @abstractmethod
    async def evaluate(
        self,
        scenario: Any,
        conversation_history: list[dict],
    ) -> EvalOutput:
        ...
