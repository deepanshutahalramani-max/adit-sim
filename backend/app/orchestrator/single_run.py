"""Single-run orchestrator — drives one scenario's full lifecycle.

Flow:
  1. Mark run as running.
  2. Send opening message via provider (outbound turn 0).
  3. await reply from in-memory queue (populated by webhook handler or mock).
  4. Save inbound turn.
  5. Check end-conditions (is_complete signal, max_turns, timeout).
  6. Generate next persona reply (LLM or scripted).
  7. Send (goto 3).
  8. On terminal: run both evaluators, save EvalResult rows, update run status.

End-condition priority: is_complete > max_turns > timeout.

The queue registry is module-level so webhook.py can call deliver_inbound_message()
from a completely separate request context.
"""

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Optional

from sqlmodel import select

from ..config import settings
from ..db.models import EvalResult, Run, RunStatus, Scenario, Turn, TERMINAL_STATUSES
from ..db.session import get_session
from ..evaluators.deterministic import DeterministicEvaluator
from ..evaluators.llm_judge import LLMJudgeEvaluator
from ..messaging.base import MessagingProvider
from ..personas.generator import PersonaGenerator

logger = logging.getLogger(__name__)

# ── In-memory queue registry ──────────────────────────────────────────────── #
_run_queues: dict[str, asyncio.Queue] = {}


def _get_queue(run_id: str) -> asyncio.Queue:
    if run_id not in _run_queues:
        _run_queues[run_id] = asyncio.Queue(maxsize=50)
    return _run_queues[run_id]


def _drop_queue(run_id: str) -> None:
    _run_queues.pop(run_id, None)


async def deliver_inbound_message(
    run_id: str,
    content: str,
    provider_message_id: Optional[str] = None,
) -> None:
    """Entry point for webhook handler and mock provider."""
    if run_id not in _run_queues:
        logger.warning("deliver_inbound_message: no queue for run_id=%s (run may be complete)", run_id)
        return
    await _get_queue(run_id).put(
        {"content": content, "provider_message_id": provider_message_id}
    )


# ── Orchestrator ─────────────────────────────────────────────────────────── #

class RunOrchestrator:
    def __init__(self, run_id: str, provider: MessagingProvider) -> None:
        self.run_id = run_id
        self.provider = provider
        self._persona = PersonaGenerator()

    async def execute(self) -> None:
        queue = _get_queue(self.run_id)
        try:
            await self._run(queue)
        except Exception as e:
            logger.exception("Orchestrator unhandled error for run=%s", self.run_id)
            await self._mark_failed(f"Unhandled error: {e}")
        finally:
            _drop_queue(self.run_id)
            if hasattr(self.provider, "reset_run"):
                self.provider.reset_run(self.run_id)

    async def _run(self, queue: asyncio.Queue) -> None:
        async with get_session() as session:
            run = await session.get(Run, self.run_id)
            scenario = await session.get(Scenario, run.scenario_id)
            run.status = RunStatus.running
            session.add(run)
            await session.commit()

        max_turns: int = scenario.end_conditions.get("max_turns", 20)
        timeout_s: float = scenario.end_conditions.get("timeout_seconds", 600)
        mock_turns: list = scenario.mock_turns or []

        # Turn 0: opening message (persona says first)
        opening = scenario.opening_message
        await self._save_turn("outbound", opening, 0)
        await self._set_status(RunStatus.awaiting_reply)
        await self.provider.send_message(run_id=self.run_id, content=opening)

        outbound_count = 1  # counts persona (outbound) turns sent so far
        turn_index = 1      # global sequential index for turns

        while True:
            # ── Wait for agent reply ──────────────────────────────────────── #
            try:
                reply_data = await asyncio.wait_for(queue.get(), timeout=timeout_s)
            except asyncio.TimeoutError:
                await self._mark_timeout(f"Agent did not reply within {timeout_s}s")
                return

            content = reply_data["content"]
            pid = reply_data.get("provider_message_id")
            await self._save_turn("inbound", content, turn_index, pid)
            turn_index += 1

            # ── Check max-turns ───────────────────────────────────────────── #
            if outbound_count >= max_turns:
                logger.info("run=%s reached max_turns=%d, closing", self.run_id, max_turns)
                await self._finish()
                return

            # ── Generate next persona reply ───────────────────────────────── #
            history = await self._load_history()
            # mock_turn_index = number of persona turns already sent (0-based)
            persona_reply = await self._persona.generate(
                scenario=scenario,
                conversation_history=history,
                mock_turn_index=outbound_count,
            )

            if persona_reply.is_complete:
                logger.info("run=%s persona signalled is_complete", self.run_id)
                await self._finish()
                return

            # ── Send persona reply ────────────────────────────────────────── #
            await self._save_turn("outbound", persona_reply.message, turn_index)
            turn_index += 1
            outbound_count += 1
            await self._set_status(RunStatus.awaiting_reply)
            await self.provider.send_message(run_id=self.run_id, content=persona_reply.message)

    # ── Helpers ──────────────────────────────────────────────────────────── #

    async def _save_turn(
        self,
        direction: str,
        content: str,
        turn_index: int,
        provider_message_id: Optional[str] = None,
    ) -> None:
        async with get_session() as session:
            turn = Turn(
                id=str(uuid.uuid4()),
                run_id=self.run_id,
                direction=direction,
                content=content,
                turn_index=turn_index,
                provider_message_id=provider_message_id,
            )
            session.add(turn)
            await session.commit()

    async def _set_status(self, status: RunStatus) -> None:
        async with get_session() as session:
            run = await session.get(Run, self.run_id)
            run.status = status
            session.add(run)
            await session.commit()

    async def _load_history(self) -> list[dict]:
        async with get_session() as session:
            result = await session.exec(
                select(Turn)
                .where(Turn.run_id == self.run_id)
                .order_by(Turn.turn_index)
            )
            return [{"direction": t.direction, "content": t.content} for t in result.all()]

    async def _load_scenario(self) -> Scenario:
        async with get_session() as session:
            run = await session.get(Run, self.run_id)
            return await session.get(Scenario, run.scenario_id)

    async def _finish(self) -> None:
        await self._set_status(RunStatus.completing)
        scenario = await self._load_scenario()
        history = await self._load_history()

        det_result = await DeterministicEvaluator().evaluate(scenario, history)
        llm_result = await LLMJudgeEvaluator().evaluate(scenario, history)

        async with get_session() as session:
            session.add(EvalResult(
                id=str(uuid.uuid4()),
                run_id=self.run_id,
                evaluator_type="deterministic",
                passed=det_result.passed,
                score=det_result.score,
                details=det_result.details,
            ))
            if not llm_result.details.get("skipped"):
                session.add(EvalResult(
                    id=str(uuid.uuid4()),
                    run_id=self.run_id,
                    evaluator_type="llm_judge",
                    passed=llm_result.passed,
                    score=llm_result.score,
                    details=llm_result.details,
                ))

            run = await session.get(Run, self.run_id)
            # Overall pass: deterministic must pass; llm_judge only required if it ran
            llm_ok = llm_result.passed is None or llm_result.passed
            run.status = RunStatus.completed if (det_result.passed and llm_ok) else RunStatus.failed
            run.completed_at = datetime.utcnow()
            session.add(run)
            await session.commit()

        logger.info("run=%s finished status=%s", self.run_id, run.status)

    async def _mark_failed(self, error: str) -> None:
        async with get_session() as session:
            run = await session.get(Run, self.run_id)
            if run and run.status not in TERMINAL_STATUSES:
                run.status = RunStatus.failed
                run.error = error
                run.completed_at = datetime.utcnow()
                session.add(run)
                await session.commit()

    async def _mark_timeout(self, error: str) -> None:
        async with get_session() as session:
            run = await session.get(Run, self.run_id)
            if run:
                run.status = RunStatus.timeout
                run.error = error
                run.completed_at = datetime.utcnow()
                session.add(run)
                await session.commit()
        logger.warning("run=%s timed out: %s", self.run_id, error)
