from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class SendResult:
    provider_message_id: str | None
    from_number: str
    to_number: str


class MessagingProvider(ABC):
    """Abstract base for all SMS providers.

    Contract:
    - send_message() delivers content to the AI agent's number.
    - After the agent replies, deliver_inbound() on the orchestrator is called
      (via webhook for RingCentral, or via scheduled task for Mock).
    - Both providers use the same internal flow so the orchestrator is provider-agnostic.
    """

    @abstractmethod
    async def send_message(self, run_id: str, content: str) -> SendResult:
        """Send an outbound SMS to the AI agent and return provider metadata."""
        ...

    @abstractmethod
    async def setup(self) -> None:
        """One-time setup (register webhooks, authenticate, etc.)."""
        ...

    @abstractmethod
    async def teardown(self) -> None:
        """Clean up resources (de-register webhooks, close sessions, etc.)."""
        ...
