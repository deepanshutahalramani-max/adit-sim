from fastapi import APIRouter, Depends
from sqlmodel import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Scenario
from ..db.session import get_db

router = APIRouter(prefix="/api/scenarios", tags=["scenarios"])


@router.get("")
async def list_scenarios(session: AsyncSession = Depends(get_db)):
    result = await session.exec(select(Scenario).order_by(Scenario.name))
    scenarios = result.all()
    return [
        {
            "id": s.id,
            "name": s.name,
            "description": s.description,
            "persona_description": s.persona_description,
            "persona_traits": s.persona_traits,
            "opening_message": s.opening_message,
            "expected_outcomes": s.expected_outcomes,
            "end_conditions": s.end_conditions,
            "mock_turn_count": len(s.mock_turns or []),
        }
        for s in scenarios
    ]


@router.get("/{scenario_id}")
async def get_scenario(scenario_id: str, session: AsyncSession = Depends(get_db)):
    scenario = await session.get(Scenario, scenario_id)
    if not scenario:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Scenario not found")
    return {
        "id": scenario.id,
        "name": scenario.name,
        "description": scenario.description,
        "persona_description": scenario.persona_description,
        "persona_traits": scenario.persona_traits,
        "opening_message": scenario.opening_message,
        "expected_outcomes": scenario.expected_outcomes,
        "end_conditions": scenario.end_conditions,
        "mock_turn_count": len(scenario.mock_turns or []),
    }
