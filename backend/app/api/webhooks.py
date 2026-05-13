"""RingCentral inbound SMS webhook handler.

RingCentral sends a POST with a validation token on first subscription,
and subsequent POSTs contain inbound message events. We match the inbound
message to an active run by the from-number (TARGET_AGENT_NUMBER) and deliver
it to the orchestrator's queue.
"""

import json
import logging
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from sqlmodel import select

from ..config import settings
from ..db.models import Run, ACTIVE_STATUSES
from ..db.session import get_session
from ..orchestrator.single_run import deliver_inbound_message

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


@router.post("/ringcentral")
async def ringcentral_inbound(request: Request, background_tasks: BackgroundTasks):
    # RingCentral sends a validation token on initial subscription
    validation_token = request.headers.get("Validation-Token")
    if validation_token:
        return Response(
            content="",
            status_code=200,
            headers={"Validation-Token": validation_token},
        )

    try:
        body: dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    logger.debug("RingCentral webhook payload: %s", json.dumps(body)[:500])

    # Extract SMS body from RingCentral event structure
    body_data = body.get("body", {})
    changes = body_data.get("changes", [])

    for change in changes:
        if change.get("type") != "Message":
            continue

        # Fetch message details — in a real integration you'd call the RC API.
        # Here we extract from the notification body directly if present.
        msg_body = change.get("messageBody", "")
        from_number = change.get("from", "")
        msg_id = str(change.get("id", ""))

        if not msg_body:
            continue

        # Find the active run that matches TARGET_AGENT_NUMBER as the sender
        if settings.TARGET_AGENT_NUMBER and from_number:
            from_clean = from_number.replace("-", "").replace(" ", "")
            target_clean = settings.TARGET_AGENT_NUMBER.replace("-", "").replace(" ", "")
            if from_clean != target_clean:
                logger.debug("Ignoring SMS from %s (not agent number)", from_number)
                continue

        # Find active run
        async with get_session() as session:
            result = await session.exec(
                select(Run).where(Run.status.in_([s.value for s in ACTIVE_STATUSES]))
            )
            run = result.first()

        if not run:
            logger.warning("Inbound SMS received but no active run found")
            continue

        background_tasks.add_task(
            deliver_inbound_message,
            run_id=run.id,
            content=msg_body,
            provider_message_id=msg_id,
        )
        logger.info("Dispatched inbound SMS to run=%s", run.id)

    return {"ok": True}
