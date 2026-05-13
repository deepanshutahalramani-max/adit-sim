import asyncio
import json
import uuid
from datetime import datetime, date
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from ..config import settings, MessagingProviderType
from ..db.models import EvalResult, Run, RunStatus, Scenario, Turn, ACTIVE_STATUSES, TERMINAL_STATUSES
from ..db.session import get_db, get_session
from ..orchestrator.single_run import RunOrchestrator

router = APIRouter(prefix="/api/runs", tags=["runs"])


# ── Provider singleton registry ──────────────────────────────────────────── #
_provider = None


def get_provider():
    return _provider


def set_provider(p):
    global _provider
    _provider = p


# ── Request / response helpers ───────────────────────────────────────────── #

class CreateRunRequest(BaseModel):
    scenario_id: str
    provider: str = "mock"  # mock | ringcentral


def _turn_to_dict(t: Turn) -> dict:
    return {
        "id": t.id,
        "direction": t.direction,
        "content": t.content,
        "turn_index": t.turn_index,
        "timestamp": t.timestamp.isoformat(),
        "provider_message_id": t.provider_message_id,
    }


def _eval_to_dict(e: EvalResult) -> dict:
    return {
        "id": e.id,
        "evaluator_type": e.evaluator_type,
        "passed": e.passed,
        "score": e.score,
        "details": e.details,
        "created_at": e.created_at.isoformat(),
    }


def _run_to_dict(run: Run, turns: list[Turn] = None, evals: list[EvalResult] = None) -> dict:
    d = {
        "id": run.id,
        "scenario_id": run.scenario_id,
        "provider": run.provider,
        "status": run.status,
        "error": run.error,
        "started_at": run.started_at.isoformat(),
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
    }
    if turns is not None:
        d["turns"] = [_turn_to_dict(t) for t in turns]
    if evals is not None:
        d["eval_results"] = [_eval_to_dict(e) for e in evals]
    return d


# ── Endpoints ────────────────────────────────────────────────────────────── #

@router.post("", status_code=201)
async def create_run(
    body: CreateRunRequest,
    session: AsyncSession = Depends(get_db),
):
    # Enforce single active run
    result = await session.exec(
        select(Run).where(Run.status.in_([s.value for s in ACTIVE_STATUSES]))
    )
    active = result.first()
    if active:
        raise HTTPException(
            status_code=409,
            detail=f"Run {active.id} is already active (status={active.status}). Wait for it to complete.",
        )

    scenario = await session.get(Scenario, body.scenario_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")

    provider_type = body.provider
    if provider_type == "ringcentral" and settings.MESSAGING_PROVIDER != MessagingProviderType.ringcentral:
        raise HTTPException(
            status_code=400,
            detail="MESSAGING_PROVIDER is not set to ringcentral in config",
        )

    run = Run(
        id=str(uuid.uuid4()),
        scenario_id=body.scenario_id,
        provider=provider_type,
        status=RunStatus.pending,
    )
    session.add(run)
    await session.commit()

    # Start orchestrator as background asyncio task
    provider = get_provider()
    orchestrator = RunOrchestrator(run_id=run.id, provider=provider)
    asyncio.create_task(orchestrator.execute())

    return _run_to_dict(run)


@router.get("")
async def list_runs(
    scenario_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    passed: Optional[bool] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_db),
):
    q = select(Run).order_by(Run.started_at.desc())

    if scenario_id:
        q = q.where(Run.scenario_id == scenario_id)
    if status:
        q = q.where(Run.status == status)
    if date_from:
        q = q.where(Run.started_at >= datetime.combine(date_from, datetime.min.time()))
    if date_to:
        q = q.where(Run.started_at <= datetime.combine(date_to, datetime.max.time()))

    result = await session.exec(q.offset(offset).limit(limit))
    runs = result.all()

    # Filter by pass/fail requires eval results
    if passed is not None:
        filtered = []
        for run in runs:
            evals_result = await session.exec(
                select(EvalResult).where(EvalResult.run_id == run.id)
            )
            evals = evals_result.all()
            det = next((e for e in evals if e.evaluator_type == "deterministic"), None)
            run_passed = det.passed if det else None
            if run_passed == passed:
                filtered.append(run)
        runs = filtered

    return [_run_to_dict(r) for r in runs]


@router.get("/{run_id}")
async def get_run(run_id: str, session: AsyncSession = Depends(get_db)):
    run = await session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    turns_result = await session.exec(
        select(Turn).where(Turn.run_id == run_id).order_by(Turn.turn_index)
    )
    evals_result = await session.exec(
        select(EvalResult).where(EvalResult.run_id == run_id)
    )
    return _run_to_dict(run, list(turns_result.all()), list(evals_result.all()))


@router.get("/{run_id}/stream")
async def stream_run(run_id: str):
    """SSE endpoint — sends a full run snapshot every second until terminal state."""

    async def event_gen():
        async with get_session() as session:
            run = await session.get(Run, run_id)
            if not run:
                yield {"event": "error", "data": json.dumps({"detail": "Run not found"})}
                return

        while True:
            async with get_session() as session:
                run = await session.get(Run, run_id)
                turns_result = await session.exec(
                    select(Turn).where(Turn.run_id == run_id).order_by(Turn.turn_index)
                )
                evals_result = await session.exec(
                    select(EvalResult).where(EvalResult.run_id == run_id)
                )
                snapshot = _run_to_dict(run, list(turns_result.all()), list(evals_result.all()))

            yield {"event": "update", "data": json.dumps(snapshot)}

            if run.status in [s.value for s in TERMINAL_STATUSES]:
                yield {"event": "complete", "data": json.dumps({"status": run.status})}
                return

            await asyncio.sleep(1)

    return EventSourceResponse(event_gen())
