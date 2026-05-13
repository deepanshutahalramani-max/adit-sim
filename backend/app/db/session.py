from contextlib import asynccontextmanager
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

_engine = None
_session_factory: async_sessionmaker | None = None


def init_db(database_url: str) -> None:
    global _engine, _session_factory
    url = (
        database_url
        .replace("postgresql://", "postgresql+asyncpg://")
        .replace("postgres://", "postgresql+asyncpg://")
    )
    # Railway's hosted Postgres requires SSL; local/internal doesn't
    connect_args: dict = {}
    if "railway.app" in url or "railway.internal" in url:
        import ssl as _ssl
        ctx = _ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE
        connect_args["ssl"] = ctx
    _engine = create_async_engine(url, echo=False, pool_pre_ping=True, connect_args=connect_args)
    _session_factory = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)


async def create_tables() -> None:
    assert _engine is not None, "DB not initialised — call init_db() first"
    import asyncio
    for attempt in range(10):
        try:
            async with _engine.begin() as conn:
                await conn.run_sync(SQLModel.metadata.create_all)
            return
        except Exception as e:
            if attempt == 9:
                raise
            wait = 2 ** attempt
            import logging
            logging.getLogger(__name__).warning(
                "DB not ready (attempt %d/10): %s — retrying in %ds", attempt + 1, e, wait
            )
            await asyncio.sleep(wait)


@asynccontextmanager
async def get_session() -> AsyncGenerator[AsyncSession, None]:
    assert _session_factory is not None, "DB not initialised — call init_db() first"
    async with _session_factory() as session:
        yield session


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency."""
    assert _session_factory is not None
    async with _session_factory() as session:
        yield session
