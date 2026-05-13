from enum import Enum
from typing import Optional

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(str, Enum):
    production = "production"
    staging = "staging"
    mock = "mock"


class MessagingProviderType(str, Enum):
    mock = "mock"
    ringcentral = "ringcentral"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    TARGET_ENVIRONMENT: Environment
    MESSAGING_PROVIDER: MessagingProviderType
    DATABASE_URL: Optional[str] = None

    # Railway Postgres plugin injects these individually
    PGHOST: Optional[str] = None
    PGPORT: str = "5432"
    PGDATABASE: str = "railway"
    PGUSER: str = "postgres"
    PGPASSWORD: Optional[str] = None

    ANTHROPIC_API_KEY: Optional[str] = None

    RINGCENTRAL_CLIENT_ID: Optional[str] = None
    RINGCENTRAL_CLIENT_SECRET: Optional[str] = None
    RINGCENTRAL_JWT: Optional[str] = None
    RINGCENTRAL_SERVER_URL: str = "https://platform.ringcentral.com"
    RINGCENTRAL_FROM_NUMBER: Optional[str] = None
    TARGET_AGENT_NUMBER: Optional[str] = None
    PUBLIC_WEBHOOK_URL: Optional[str] = None

    @model_validator(mode="after")
    def resolve_database_url(self) -> "Settings":
        needs_pg = (
            not self.DATABASE_URL
            or "localhost" in self.DATABASE_URL
            or "127.0.0.1" in self.DATABASE_URL
        )
        if needs_pg and self.PGHOST:
            pwd = self.PGPASSWORD or ""
            self.DATABASE_URL = (
                f"postgresql+asyncpg://{self.PGUSER}:{pwd}"
                f"@{self.PGHOST}:{self.PGPORT}/{self.PGDATABASE}"
            )
        if not self.DATABASE_URL:
            raise ValueError(
                "No database configured. Set DATABASE_URL or PGHOST/PGPASSWORD."
            )
        return self

    @model_validator(mode="after")
    def validate_ringcentral_deps(self) -> "Settings":
        if self.MESSAGING_PROVIDER == MessagingProviderType.ringcentral:
            required = [
                "RINGCENTRAL_CLIENT_ID",
                "RINGCENTRAL_CLIENT_SECRET",
                "RINGCENTRAL_JWT",
                "RINGCENTRAL_FROM_NUMBER",
                "TARGET_AGENT_NUMBER",
                "PUBLIC_WEBHOOK_URL",
            ]
            missing = [f for f in required if not getattr(self, f)]
            if missing:
                raise ValueError(
                    f"MESSAGING_PROVIDER=ringcentral requires these env vars: {', '.join(missing)}"
                )
        return self

    @property
    def has_anthropic(self) -> bool:
        return bool(self.ANTHROPIC_API_KEY)


def load_settings() -> Settings:
    try:
        return Settings()
    except Exception as e:
        raise SystemExit(
            f"\n[ADIT-SIM] Configuration error: {e}\n"
            "Set TARGET_ENVIRONMENT=mock|staging|production to start.\n"
        ) from e


settings = load_settings()
