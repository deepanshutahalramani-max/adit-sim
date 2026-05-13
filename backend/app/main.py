"""FastAPI application entry point.

Startup sequence:
  1. Validate config (raises SystemExit if TARGET_ENVIRONMENT not set).
  2. Initialise DB engine and create tables.
  3. Seed scenarios from YAML files.
  4. Initialise messaging provider.
  5. Recover any runs that were left in an active state (mark as failed).
  6. Mount static frontend (built React bundle) if dist/ exists.
"""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlmodel import select

from .config import settings
from .db.models import Run, ACTIVE_STATUSES
from .db.session import create_tables, get_session, init_db
from .api import runs as runs_router, scenarios as scenarios_router, webhooks as webhooks_router
from .api.runs import set_provider

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger(__name__)


async def _load_scenarios():
    """Upsert seed scenarios from YAML files into the DB."""
    import yaml
    from datetime import datetime
    from .db.models import Scenario

    scenarios_dir = Path(__file__).parent / "scenarios"
    if not scenarios_dir.exists():
        logger.warning("No scenarios/ directory found")
        return

    for yaml_path in sorted(scenarios_dir.glob("*.yaml")):
        with open(yaml_path) as f:
            data = yaml.safe_load(f)

        async with get_session() as session:
            existing = await session.get(Scenario, data["id"])
            if existing:
                for k, v in data.items():
                    setattr(existing, k, v)
                existing.updated_at = datetime.utcnow()
                session.add(existing)
            else:
                session.add(Scenario(**data))
            await session.commit()
            logger.info("Loaded scenario: %s", data["id"])


async def _recover_orphaned_runs():
    """On startup, mark any runs stuck in active state as failed."""
    async with get_session() as session:
        result = await session.exec(
            select(Run).where(Run.status.in_([s.value for s in ACTIVE_STATUSES]))
        )
        orphaned = result.all()
        for run in orphaned:
            run.status = "failed"
            run.error = "Server restarted while run was active"
            session.add(run)
        if orphaned:
            await session.commit()
            logger.warning("Recovered %d orphaned run(s)", len(orphaned))


def _build_provider():
    from .config import MessagingProviderType

    if settings.MESSAGING_PROVIDER == MessagingProviderType.mock:
        from .messaging.mock import MockProvider
        # Reply lookup is resolved async inside MockProvider via the injected coroutine.
        return MockProvider(_async_get_reply)
    else:
        from .messaging.ringcentral import RingCentralProvider
        return RingCentralProvider()


async def _async_get_reply(run_id: str, outbound_idx: int) -> str | None:
    from .db.models import Run, Scenario
    async with get_session() as session:
        run = await session.get(Run, run_id)
        if not run:
            return None
        scenario = await session.get(Scenario, run.scenario_id)
        if not scenario:
            return None
        turns = scenario.mock_turns or []
        if outbound_idx < len(turns):
            return turns[outbound_idx].get("agent_replies")
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting ADIT Sim — environment=%s provider=%s",
                settings.TARGET_ENVIRONMENT, settings.MESSAGING_PROVIDER)

    init_db(settings.DATABASE_URL)
    await create_tables()
    await _load_scenarios()
    await _recover_orphaned_runs()

    provider = _build_provider()
    await provider.setup()
    set_provider(provider)

    yield

    await provider.teardown()
    logger.info("ADIT Sim shut down")


app = FastAPI(
    title="ADIT Simulation Platform",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scenarios_router.router)
app.include_router(runs_router.router)
app.include_router(webhooks_router.router)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "environment": settings.TARGET_ENVIRONMENT,
        "provider": settings.MESSAGING_PROVIDER,
        "anthropic_available": settings.has_anthropic,
    }


# Serve built React frontend — check both local layout and container layout (/frontend/dist)
_dist = Path(__file__).parent.parent.parent / "frontend" / "dist"
if not _dist.exists():
    _dist = Path("/frontend/dist")
if _dist.exists():
    from fastapi.responses import FileResponse

    app.mount("/assets", StaticFiles(directory=str(_dist / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        index = _dist / "index.html"
        return FileResponse(str(index))
