from datetime import datetime
from enum import Enum
from typing import Any, Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


class RunStatus(str, Enum):
    pending = "pending"
    running = "running"
    awaiting_reply = "awaiting_reply"
    completing = "completing"
    completed = "completed"
    failed = "failed"
    timeout = "timeout"


TERMINAL_STATUSES = {RunStatus.completed, RunStatus.failed, RunStatus.timeout}
ACTIVE_STATUSES = {RunStatus.pending, RunStatus.running, RunStatus.awaiting_reply, RunStatus.completing}


class Scenario(SQLModel, table=True):
    __tablename__ = "scenarios"

    id: str = Field(primary_key=True)
    name: str
    description: str
    persona_description: str
    persona_traits: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    opening_message: str
    expected_outcomes: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    end_conditions: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # scripted turns for full-mock mode (no API key)
    mock_turns: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Run(SQLModel, table=True):
    __tablename__ = "runs"

    id: str = Field(primary_key=True)
    scenario_id: str = Field(foreign_key="scenarios.id", index=True)
    provider: str
    status: str = Field(default=RunStatus.pending)
    phone_number: Optional[str] = None
    error: Optional[str] = None
    started_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None


class Turn(SQLModel, table=True):
    __tablename__ = "turns"

    id: str = Field(primary_key=True)
    run_id: str = Field(foreign_key="runs.id", index=True)
    direction: str  # outbound | inbound
    content: str
    turn_index: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    provider_message_id: Optional[str] = None


class EvalResult(SQLModel, table=True):
    __tablename__ = "eval_results"

    id: str = Field(primary_key=True)
    run_id: str = Field(foreign_key="runs.id", index=True)
    evaluator_type: str  # deterministic | llm_judge
    passed: Optional[bool] = None
    score: Optional[float] = None
    details: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)
