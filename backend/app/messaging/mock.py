"""Mock provider — deterministic, instant, zero external deps.

Simulates the full async webhook flow:
  send_message() → records outbound → schedules a coroutine that sleeps briefly,
  then calls deliver_inbound_message() exactly as the real webhook handler would.

The scripted agent reply is resolved via an injected async callable keyed by
(run_id, outbound_turn_index).
"""

import asyncio
import uuid
from typing import Awaitable, Callable, Optional

from .base import MessagingProvider, SendResult

MOCK_FROM_NUMBER = "+15550000001"
MOCK_AGENT_NUMBER = "+15550000002"
MOCK_REPLY_DELAY = 0.8  # seconds

# Async fn: (run_id, outbound_idx) -> reply str | None
ReplyFn = Callable[[str, int], Awaitable[Optional[str]]]


class MockProvider(MessagingProvider):
    def __init__(self, get_reply_fn: ReplyFn) -> None:
        self._get_reply: ReplyFn = get_reply_fn
        self._outbound_count: dict[str, int] = {}

    async def setup(self) -> None:
        pass

    async def teardown(self) -> None:
        self._outbound_count.clear()

    async def send_message(self, run_id: str, content: str) -> SendResult:
        idx = self._outbound_count.get(run_id, 0)
        self._outbound_count[run_id] = idx + 1

        msg_id = f"mock-{uuid.uuid4().hex[:8]}"

        # Schedule the fake reply — same flow as a real webhook arriving later.
        asyncio.create_task(self._deliver_reply(run_id, idx))

        return SendResult(
            provider_message_id=msg_id,
            from_number=MOCK_FROM_NUMBER,
            to_number=MOCK_AGENT_NUMBER,
        )

    async def _deliver_reply(self, run_id: str, outbound_idx: int) -> None:
        await asyncio.sleep(MOCK_REPLY_DELAY)
        reply = await self._get_reply(run_id, outbound_idx)
        if reply is None:
            return

        from ..orchestrator.single_run import deliver_inbound_message
        await deliver_inbound_message(
            run_id=run_id,
            content=reply,
            provider_message_id=f"mock-in-{uuid.uuid4().hex[:8]}",
        )

    def reset_run(self, run_id: str) -> None:
        self._outbound_count.pop(run_id, None)
