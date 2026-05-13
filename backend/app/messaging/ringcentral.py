"""RingCentral SMS provider — JWT auth, real outbound SMS.

Inbound messages arrive via webhook (POST /api/webhooks/ringcentral).
The webhook handler calls deliver_inbound_message() to resume the orchestrator.
"""

import asyncio
import logging

from .base import MessagingProvider, SendResult
from ..config import settings

logger = logging.getLogger(__name__)


class RingCentralProvider(MessagingProvider):
    def __init__(self) -> None:
        self._sdk = None
        self._platform = None

    async def setup(self) -> None:
        try:
            from ringcentral import SDK
        except ImportError as e:
            raise RuntimeError("ringcentral package not installed") from e

        self._sdk = SDK(
            settings.RINGCENTRAL_CLIENT_ID,
            settings.RINGCENTRAL_CLIENT_SECRET,
            settings.RINGCENTRAL_SERVER_URL,
        )
        self._platform = self._sdk.platform()
        # JWT login runs synchronously in the SDK — wrap in executor
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: self._platform.login(jwt=settings.RINGCENTRAL_JWT),
        )
        logger.info("RingCentral platform authenticated")

        # Register inbound webhook
        if settings.PUBLIC_WEBHOOK_URL:
            await self._register_webhook()

    async def teardown(self) -> None:
        if self._platform:
            loop = asyncio.get_event_loop()
            try:
                await loop.run_in_executor(None, self._platform.logout)
            except Exception:
                pass

    async def send_message(self, run_id: str, content: str) -> SendResult:
        assert self._platform is not None, "RingCentralProvider not set up"

        loop = asyncio.get_event_loop()

        def _send():
            return self._platform.post(
                "/restapi/v1.0/account/~/extension/~/sms",
                {
                    "from": {"phoneNumber": settings.RINGCENTRAL_FROM_NUMBER},
                    "to": [{"phoneNumber": settings.TARGET_AGENT_NUMBER}],
                    "text": content,
                },
            )

        response = await loop.run_in_executor(None, _send)
        body = response.json_dict()
        msg_id = str(body.get("id", ""))
        logger.info("Sent SMS for run=%s msg_id=%s", run_id, msg_id)

        return SendResult(
            provider_message_id=msg_id,
            from_number=settings.RINGCENTRAL_FROM_NUMBER,
            to_number=settings.TARGET_AGENT_NUMBER,
        )

    async def _register_webhook(self) -> None:
        loop = asyncio.get_event_loop()
        webhook_url = f"{settings.PUBLIC_WEBHOOK_URL}/api/webhooks/ringcentral"

        def _register():
            return self._platform.post(
                "/restapi/v1.0/subscription",
                {
                    "eventFilters": ["/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"],
                    "deliveryMode": {
                        "transportType": "WebHook",
                        "address": webhook_url,
                    },
                },
            )

        try:
            await loop.run_in_executor(None, _register)
            logger.info("RingCentral webhook registered at %s", webhook_url)
        except Exception as e:
            logger.warning("Failed to register RingCentral webhook: %s", e)
