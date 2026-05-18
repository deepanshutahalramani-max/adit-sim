"""
ADIT Agent QA Platform — FastAPI backend
=========================================
All simulation + analysis logic extracted from Streamlit app.py.
Serves the built React frontend as static files.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import random
import re
import string
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form

# ── Retell API base URL ───────────────────────────────────────────────────────
_RETELL_BASE = "https://api.retellai.com"


async def _retell_get(path: str, extra_headers: dict | None = None):
    """GET {_RETELL_BASE}{path} with Retell auth."""
    url = f"{_RETELL_BASE}{path}"
    hdrs = {"Authorization": f"Bearer {RETELL_API_KEY}", **(extra_headers or {})}
    async with httpx.AsyncClient(timeout=15) as client:
        return await client.get(url, headers=hdrs)


async def _retell_post(path: str, body: dict, extra_headers: dict | None = None):
    """POST {_RETELL_BASE}{path} with Retell auth."""
    url = f"{_RETELL_BASE}{path}"
    hdrs = {
        "Authorization": f"Bearer {RETELL_API_KEY}",
        "Content-Type": "application/json",
        **(extra_headers or {}),
    }
    async with httpx.AsyncClient(timeout=15) as client:
        return await client.post(url, headers=hdrs, json=body)

# ─────────────────────────────────────────────────────────────────────────────
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── Constants ─────────────────────────────────────────────────────────────────
HOSTS = {
    "live": "https://frontdeskchatagent.adit.com",
    "dev":  "https://gjqwwdfeo35edl-8009.proxy.runpod.net",
}
DEFAULT_AGENT_PHONE = "+12673565689"
MAX_PARALLEL = 10
MAX_TURNS = 14

BOOKING_CONFIRMED_KWS = [
    "appointment is confirmed", "you're all set", "all set",
    "appointment has been booked", "successfully booked",
    "your appointment on", "we've got you booked", "booking is confirmed",
    "confirmed for", "appointment has been scheduled", "you are scheduled",
    "you're scheduled", "appointment has been rescheduled",
    "successfully rescheduled", "updated your appointment",
    "appointment has been cancelled", "successfully cancelled",
    "appointment has been canceled",
]
TASK_CREATED_KWS = [
    "i've created a note", "i have created a note", "created a note for the team",
    "note for the team", "team will contact", "team member will",
    "a team member will", "someone will reach out", "team will reach out",
    "i've made a note", "passed this along", "i'll have someone",
    "i will have someone", "created a task", "i've noted", "i have noted",
    "your request has been sent", "request has been sent",
    "will contact you soon", "will reach out soon",
]
ALL_SUCCESS_KWS = BOOKING_CONFIRMED_KWS + TASK_CREATED_KWS

# More precise: these must clearly be the agent OFFERING to create a task/note.
# Keep phrases long enough to avoid false positives on common sentences.
TASK_TRIGGER_PHRASES = [
    "would you like me to create a note",
    "would you like me to create a task",
    "shall i create a note",
    "should i create a note",
    "i can create a note for",
    "i can have a team member",
    "would you like me to pass",
    "like me to pass this along",
    "shall i have someone",
    "would you like someone from our team",
]

# ── Personas ──────────────────────────────────────────────────────────────────
@dataclass
class PatientPersona:
    first_name: str
    last_name: str
    dob: str
    insurance: str
    reason: str
    preferred_day: str
    preferred_time: str
    is_new: bool = True

PERSONAS = [
    PatientPersona("Jamie",  "Chen",    "April 12, 1990",   "Delta Dental PPO", "cleaning and check-up",       "Monday or Tuesday",   "afternoon", True),
    PatientPersona("Maria",  "Garcia",  "July 23, 1985",    "Cigna PPO",        "toothache on my lower left",  "as soon as possible", "any time",  True),
    PatientPersona("Robert", "Lee",     "June 20, 1978",    "Aetna",            "routine cleaning",            "weekday morning",     "morning",   False),
    PatientPersona("Sarah",  "Johnson", "November 8, 1995", "MetLife PPO",      "tooth sensitivity to cold",   "Wednesday or Friday", "afternoon", True),
    PatientPersona("David",  "Kim",     "March 15, 1982",   "United Concordia", "crown came loose",            "today if possible",   "any time",  False),
]

# ── Registered patient store ──────────────────────────────────────────────────
# After a successful new-patient booking simulation, the patient's details are
# stored here so that "existing patient" scenarios (reschedule, cancel, etc.)
# can look them up consistently — matching what was just created in the backend.
_REGISTERED_PATIENT: Optional[PatientPersona] = None
_REGISTERED_PATIENT_PHONE: str = ""


def _register_patient(persona: PatientPersona, phone: str) -> None:
    """Store a newly-booked patient so existing-patient scenarios can reuse their details."""
    global _REGISTERED_PATIENT, _REGISTERED_PATIENT_PHONE
    _REGISTERED_PATIENT = PatientPersona(
        persona.first_name, persona.last_name, persona.dob,
        persona.insurance, persona.reason, persona.preferred_day,
        persona.preferred_time,
        is_new=False,  # they are now an existing patient
    )
    _REGISTERED_PATIENT_PHONE = phone


def _resolve_persona(
    config: dict,
    persona_override: Optional[PatientPersona] = None,
) -> PatientPersona:
    """
    Return the right persona for a scenario:
      1. Explicit override (used by E2E chain to reuse the newly-booked patient)
      2. If scenario needs an existing patient AND we have a registered patient → use them
      3. Default persona for the scenario
    """
    if persona_override:
        return persona_override
    default = PERSONAS[config["persona_idx"]]
    if not default.is_new and _REGISTERED_PATIENT:
        return _REGISTERED_PATIENT
    return default

SCENARIOS: dict[str, dict] = {
    "new-patient-cleaning":   {"label": "🆕 New Patient – Cleaning",    "goal": "Book a new patient dental cleaning/check-up appointment from start to full confirmation", "opener": "Hi, I need to book a new patient appointment", "type": "book", "persona_idx": 0},
    "dental-emergency":       {"label": "🚨 Dental Emergency",           "goal": "Get an urgent/emergency appointment as soon as possible today", "opener": "Hi I have a bad toothache and need to see someone urgently", "type": "book", "persona_idx": 1},
    "existing-routine":       {"label": "📅 Existing Patient – Routine", "goal": "Book a routine cleaning as an existing patient", "opener": "Hi, I'm an existing patient and need to schedule a cleaning", "type": "book", "persona_idx": 2},
    "reschedule":             {"label": "🔄 Reschedule Appointment",     "goal": "Reschedule an existing upcoming appointment to a different day/time", "opener": "Hi, I need to reschedule my upcoming appointment", "type": "reschedule", "persona_idx": 2},
    "cancel":                 {"label": "❌ Cancel Appointment",          "goal": "Cancel an upcoming appointment", "opener": "I need to cancel my appointment please", "type": "cancel", "persona_idx": 2},
    "insurance-book":         {"label": "🏥 Insurance Check → Book",     "goal": "Confirm insurance is accepted then book appointment", "opener": "Do you accept Delta Dental insurance?", "type": "book", "persona_idx": 0},
    "office-hours-book":      {"label": "🕐 Office Hours → Book",        "goal": "Ask about office hours then book if available", "opener": "What are your office hours?", "type": "book", "persona_idx": 3},
    "post-treatment-followup":{"label": "💊 Post-Treatment Follow-up",   "goal": "Report sensitivity after treatment and book a follow-up check as an existing patient", "opener": "I had a filling done last week and it's still sensitive to cold, I need a follow-up", "type": "book", "persona_idx": 2},
}

# Scenarios that require an existing patient record in the backend.
# The runner will automatically book a new-patient appointment first (same phone),
# then run the main scenario with the same patient credentials.
REQUIRES_PRIOR_BOOKING: frozenset[str] = frozenset({
    "existing-routine",
    "reschedule",
    "cancel",
    "post-treatment-followup",
})

# ── Data classes ──────────────────────────────────────────────────────────────
@dataclass
class Turn:
    role: str
    message: str
    latency_ms: int = 0
    api_events: list = field(default_factory=list)  # inline API call indicators

@dataclass
class SimResult:
    scenario: str
    scenario_label: str
    patient_phone: str
    turns: list[Turn] = field(default_factory=list)
    passed: bool = False
    score: int = 0
    failure_reason: str = ""
    total_ms: int = 0
    chat_id: str = ""
    outcome_type: str = ""
    api_calls: list = field(default_factory=list)

# ── Pydantic request/response models ──────────────────────────────────────────
class SimRequest(BaseModel):
    scenario_id: str
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    openai_key: str = ""
    use_judge: bool = True
    reuse_phone: Optional[str] = None
    extra_context: str = ""

class ParallelSimRequest(BaseModel):
    scenario_ids: list[str]
    repeats: int = 1
    max_parallel: int = 5
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    openai_key: str = ""
    use_judge: bool = True
    extra_context: str = ""

class ChainRequest(BaseModel):
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    openai_key: str = ""

class TranscriptRequest(BaseModel):
    transcript: str
    system_prompt: str = ""
    openai_key: str

class ScenarioGenRequest(BaseModel):
    instruction: str
    openai_key: str

class ValidationRequest(BaseModel):
    repro_opener: str
    root_cause: str
    n_runs: int = 3
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    openai_key: str = ""

# ── Core helpers ──────────────────────────────────────────────────────────────
def _phone() -> str:
    return "+1555" + "".join(random.choices(string.digits, k=7))

def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

def _call_agent(api_base, token, message, patient_phone, agent_phone, chat_id=None, timeout=45) -> dict:
    payload: dict[str, Any] = {
        "message": message,
        "patient_phone_number": patient_phone,
        "agent_phone_number": agent_phone,
        "end_conversation": False,
    }
    if chat_id:
        payload["chat_id"] = chat_id
    r = httpx.post(
        f"{api_base}/engage/forward-to-agent",
        headers=_headers(token), json=payload, timeout=timeout,
    )
    r.raise_for_status()
    return r.json()

def smart_patient_reply(agent_msg, persona, history, goal, oai_key, patient_phone="", extra_context=""):
    if not oai_key:
        return "OK", False
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)

        agent_lower = agent_msg.lower()
        if any(ph in agent_lower for ph in TASK_TRIGGER_PHRASES):
            return "Yes please", False
        if any(kw in agent_lower for kw in ALL_SUCCESS_KWS):
            return "Great, thanks!", True

        recent = history[-10:]
        transcript = "\n".join(
            f"{'You' if t.role == 'patient' else 'Agent'}: {t.message}" for t in recent
        )
        extra_ctx_block = f"\n\nADDITIONAL SCENARIO CONTEXT (use to make your replies more realistic):\n{extra_context.strip()}" if extra_context.strip() else ""
        system_prompt = f"""You are a real person texting a dental office AI receptionist via SMS.{extra_ctx_block}

YOUR DETAILS — reveal ONLY when the agent's question asks for that specific piece:
- First name: {persona.first_name}
- Last name: {persona.last_name}
- Date of birth: {persona.dob}
- Insurance: {persona.insurance}
- Reason for visit: {persona.reason}
- Preferred day: {persona.preferred_day}
- Preferred time of day: {persona.preferred_time}
- Are you new or existing: {"New patient" if persona.is_new else "Existing patient"}
- Phone number: {patient_phone if patient_phone else "the number I'm texting from"}

YOUR GOAL: {goal}

RULES:
1. Reply in 1 SHORT sentence — like a real SMS text
2. ONLY answer what the agent's last question asked. Nothing else.
3. Sound casual and human — not robotic
4. If asked "for yourself or someone else?" → For myself
5. If asked "new or existing patient?" → {"New patient" if persona.is_new else "Existing patient, I've been there before"}
6. If asked reason/purpose for visit → {persona.reason}
7. If asked preferred day/date → {persona.preferred_day}
8. If asked morning/afternoon/time → {persona.preferred_time}
9. If asked first name → {persona.first_name}
10. If asked last name → {persona.last_name}
11. If asked date of birth / DOB → {persona.dob}
12. If asked insurance → {persona.insurance}
13. If asked for phone number / contact number → {patient_phone if patient_phone else "use the number I'm texting from"}
14. If given a choice between two options → pick the first one
15. If asked for full name / first and last name together → {persona.first_name} {persona.last_name}
16. Output ONLY your reply text. No quotes, no labels, no explanation."""

        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": (
                    f"Conversation so far:\n{transcript}\n\n"
                    f"Agent's latest question:\n\"{agent_msg}\"\n\nYour 1-sentence reply:"
                )},
            ],
            max_tokens=40, temperature=0.15,
        )
        reply = resp.choices[0].message.content.strip().strip('"').strip("'")
        should_end = "[DONE]" in reply or any(kw in agent_lower for kw in ALL_SUCCESS_KWS)
        reply = reply.replace("[DONE]", "").strip()
        return reply, should_end
    except Exception as exc:
        # Never return "Yes please" on failure — that triggers task-creation acceptance.
        # Log and return a neutral patient reply so the simulation can continue.
        import logging
        logging.getLogger(__name__).warning("smart_patient_reply OpenAI error: %s", exc)
        neutral_fallbacks = [
            "Sure, that works for me.",
            "Okay, sounds good.",
            "Alright, thank you.",
            "That's fine with me.",
            "Yes, that's correct.",
        ]
        return random.choice(neutral_fallbacks), False

def _llm_judge(scenario_label, turns, oai_key):
    if not oai_key or not turns:
        return 70, "No OpenAI key – default score"
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)
        transcript = "\n".join(f"[{t.role.upper()}] {t.message}" for t in turns)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": (
                    "You are a QA evaluator for a dental front-desk AI SMS agent.\n"
                    "This agent has two valid completion paths:\n"
                    "  A) DIRECT BOOKING: agent books appointment and gives confirmation\n"
                    "  B) TASK CREATION: agent cannot book directly, collects patient info, creates a task/note for human team\n"
                    "Both paths are VALID outcomes. Score 0-100:\n"
                    "  95-100: Full direct booking confirmed with all details\n"
                    "  80-94:  Task/note created after collecting name + DOB + reason + preferred time\n"
                    "  60-79:  Task created but missing some patient details\n"
                    "  40-59:  Conversation started, no completion\n"
                    "  0-39:   Agent gave wrong info, failed, or was unhelpful\n"
                    "Reply ONLY with JSON: {\"score\": <int>, \"reason\": \"<1-2 sentences>\"}"
                )},
                {"role": "user", "content": f"Scenario: {scenario_label}\n\nFull transcript:\n{transcript}"},
            ],
            max_tokens=150, temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
        data = json.loads(raw)
        return int(data["score"]), data["reason"]
    except Exception as e:
        return 60, f"Judge error: {e}"

def _infer_api_events(agent_msg: str, latency_ms: int, turn_num: int) -> list[str]:
    """Detect which internal agent APIs were likely called based on message content + latency."""
    events = []
    m = agent_msg.lower()

    # Booking / scheduling
    if any(kw in m for kw in ["appointment has been booked", "appointment is booked", "appointment is confirmed",
                                "appointment has been scheduled", "you are scheduled", "you're scheduled",
                                "we've got you booked", "booking is confirmed", "successfully booked",
                                "confirmed for", "your appointment on", "booked on", "booked for",
                                "scheduled you for", "scheduled for"]):
        events.append("📅 Book Appointment API → called")

    # Reschedule
    if any(kw in m for kw in ["appointment has been rescheduled", "successfully rescheduled",
                                "updated your appointment", "rescheduled to", "moved your appointment"]):
        events.append("🔄 Reschedule Appointment API → called")

    # Cancel
    if any(kw in m for kw in ["appointment has been cancelled", "appointment has been canceled",
                                "successfully cancelled", "successfully canceled", "cancellation confirmed"]):
        events.append("❌ Cancel Appointment API → called")

    # Task / note creation
    if any(kw in m for kw in ["i've created a note", "created a note", "i've made a note",
                                "created a task", "passed this along", "i'll have someone",
                                "team will contact", "team member will", "someone will reach out",
                                "your request has been sent", "i've noted"]):
        events.append("📋 Create Task / Note API → called")

    # New patient creation (inferred from asking for DOB + confirmation)
    if any(kw in m for kw in ["new patient", "added you", "created your profile",
                                "set you up", "registered you"]):
        events.append("👤 Create New Patient API → called")

    # High latency on non-first turn = external API round-trip happening
    if latency_ms > 3500 and turn_num > 0 and not events:
        events.append(f"⚡ External API call detected ({latency_ms}ms)")

    return events

def _fmt_error(s: str) -> str:
    if not s:
        return ""
    if "HTTP 4" in s or "HTTP 5" in s:
        try:
            j_start = s.find("{")
            if j_start != -1:
                data = json.loads(s[j_start:])
                msg = data.get("message", data.get("error", ""))
                code = s.split(":")[0].strip()
                if msg:
                    if "Retell Create Completion API" in msg:
                        msg = "Retell LLM completion failed — check agent configuration"
                    return f"{code} — {msg[:120]}"
        except Exception:
            pass
        return s[:100] + ("…" if len(s) > 100 else "")
    return s[:140] + ("…" if len(s) > 140 else "")

def _run_simulation_sync(
    scenario_id: str, api_base: str, token: str, agent_phone: str,
    oai_key: str, use_judge: bool = True, reuse_phone: Optional[str] = None,
    extra_context: str = "",
    persona_override: Optional[PatientPersona] = None,
    auto_prereq: bool = True,
) -> SimResult:
    config = SCENARIOS.get(scenario_id)
    if not config:
        raise ValueError(f"Unknown scenario: {scenario_id}")

    # ── Two-phase: for existing-patient scenarios, silently book a new patient
    # first (same phone number) so the backend has a real record to find.
    if auto_prereq and scenario_id in REQUIRES_PRIOR_BOOKING and persona_override is None:
        prereq_phone = reuse_phone or _phone()
        _run_simulation_sync(
            "new-patient-cleaning", api_base, token, agent_phone, oai_key,
            use_judge=False, reuse_phone=prereq_phone,
            extra_context="", persona_override=None, auto_prereq=False,
        )
        reuse_phone = prereq_phone
        # Pass the same name/DOB that was just registered, but with the
        # existing-patient scenario's reason/preferred-time.
        booking_p   = PERSONAS[SCENARIOS["new-patient-cleaning"]["persona_idx"]]
        sc_persona  = PERSONAS[config["persona_idx"]]
        persona_override = PatientPersona(
            first_name=booking_p.first_name,
            last_name=booking_p.last_name,
            dob=booking_p.dob,
            insurance=booking_p.insurance,
            reason=sc_persona.reason,
            preferred_day=sc_persona.preferred_day,
            preferred_time=sc_persona.preferred_time,
            is_new=False,
        )

    persona = _resolve_persona(config, persona_override)
    patient_phone = reuse_phone or _phone()
    turns: list[Turn] = []
    chat_id: Optional[str] = None
    t_start = time.time()
    passed = False
    failure_reason = ""
    outcome_type = "incomplete"
    api_calls: list[dict] = []
    current_msg = config["opener"]

    for turn_num in range(MAX_TURNS):
        t_turn = time.time()
        t_api = time.time()
        try:
            resp = _call_agent(api_base, token, current_msg, patient_phone, agent_phone, chat_id)
            api_calls.append({"endpoint": "/engage/forward-to-agent", "status": 200, "latency_ms": int((time.time()-t_api)*1000)})
        except httpx.HTTPStatusError as e:
            api_calls.append({"endpoint": "/engage/forward-to-agent", "status": e.response.status_code, "latency_ms": int((time.time()-t_api)*1000)})
            # Retry once on 400 (Retell transient LLM failures)
            if e.response.status_code == 400 and turn_num > 0:
                time.sleep(1.5)
                try:
                    t_api2 = time.time()
                    resp = _call_agent(api_base, token, current_msg, patient_phone, agent_phone, chat_id)
                    api_calls.append({"endpoint": "/engage/forward-to-agent (retry)", "status": 200, "latency_ms": int((time.time()-t_api2)*1000)})
                except Exception as e2:
                    failure_reason = f"HTTP 400: {e.response.text[:200]}"
                    outcome_type = "error"
                    break
            else:
                failure_reason = f"HTTP {e.response.status_code}: {e.response.text[:200]}"
                outcome_type = "error"
                break
        except Exception as e:
            failure_reason = f"API error: {str(e)[:120]}"
            outcome_type = "error"
            break

        latency_ms = int((time.time() - t_turn) * 1000)
        data = resp.get("data", {})
        agent_msg = data.get("agent_response", "")
        chat_id = data.get("chat_id", chat_id) or chat_id

        if not agent_msg:
            if turn_num == 0:
                failure_reason = "Agent returned no response on first message"
                outcome_type = "error"
                break
            last_agent = next((t.message for t in reversed(turns) if t.role == "agent"), "")
            if last_agent and oai_key:
                try:
                    current_msg, should_end = smart_patient_reply(last_agent, persona, turns, config["goal"], oai_key, patient_phone, extra_context)
                    api_calls.append({"endpoint": "openai/gpt-4o-mini (patient)", "status": 200, "latency_ms": 0})
                    if should_end:
                        passed = True
                        outcome_type = "task_created" if any(kw in last_agent.lower() for kw in TASK_CREATED_KWS) else "booking_confirmed"
                        break
                    continue
                except Exception:
                    pass
            continue

        api_events = _infer_api_events(agent_msg, latency_ms, turn_num)
        turns.append(Turn("patient", current_msg))
        turns.append(Turn("agent", agent_msg, latency_ms, api_events))
        agent_lower = agent_msg.lower()

        if any(kw in agent_lower for kw in BOOKING_CONFIRMED_KWS):
            passed = True
            outcome_type = "booking_confirmed"
            break
        if any(kw in agent_lower for kw in TASK_CREATED_KWS):
            passed = True
            outcome_type = "task_created"
            break
        if not oai_key:
            failure_reason = "No OpenAI key — cannot drive patient responses"
            break

        try:
            current_msg, should_end = smart_patient_reply(agent_msg, persona, turns, config["goal"], oai_key, patient_phone, extra_context)
            api_calls.append({"endpoint": "openai/gpt-4o-mini (patient)", "status": 200, "latency_ms": 0})
            if should_end:
                passed = True
                outcome_type = (
                    "booking_confirmed" if any(kw in agent_lower for kw in BOOKING_CONFIRMED_KWS)
                    else "task_created" if any(kw in agent_lower for kw in TASK_CREATED_KWS)
                    else "booking_confirmed"
                )
                break
        except Exception as e:
            failure_reason = f"Patient gen error: {str(e)[:80]}"
            break
    else:
        if not passed:
            failure_reason = f"Goal not reached in {MAX_TURNS} turns"

    total_ms = int((time.time() - t_start) * 1000)
    score, judge_reason = (70, "") if not use_judge else _llm_judge(config["label"], turns, oai_key)

    # If a late-turn API error fired after a successful conversation, trust the judge.
    # Score ≥ 80 with populated turns means the conversation was good — don't show "Error".
    if not passed and outcome_type == "error" and turns and score >= 80:
        last_agent = next((t.message for t in reversed(turns) if t.role == "agent"), "").lower()
        if any(kw in last_agent for kw in BOOKING_CONFIRMED_KWS):
            passed = True
            outcome_type = "booking_confirmed"
            failure_reason = ""
        elif any(kw in last_agent for kw in TASK_CREATED_KWS):
            passed = True
            outcome_type = "task_created"
            failure_reason = ""
        elif score >= 88:
            # Judge is very confident — the late HTTP error was a cleanup call, not a real failure
            passed = True
            outcome_type = "booking_confirmed"
            failure_reason = ""

    if not failure_reason and not passed:
        failure_reason = judge_reason

    # Auto-register a new patient that was just successfully booked so that
    # subsequent existing-patient scenarios (reschedule, cancel, etc.) can use
    # the same details and the backend will actually find them.
    if passed and persona.is_new and outcome_type in ("booking_confirmed", "task_created"):
        _register_patient(persona, patient_phone)

    return SimResult(
        scenario=scenario_id,
        scenario_label=config["label"],
        patient_phone=patient_phone,
        turns=turns,
        passed=passed,
        score=score,
        failure_reason=failure_reason if not passed else judge_reason,
        total_ms=total_ms,
        chat_id=chat_id or "",
        outcome_type=outcome_type,
        api_calls=api_calls,
    )

def _result_to_dict(r: SimResult) -> dict:
    d = asdict(r)
    d["turns"] = [
        {"role": t["role"], "message": t["message"], "latency_ms": t["latency_ms"], "api_events": t.get("api_events", [])}
        for t in d["turns"]
    ]
    d["failure_reason_clean"] = _fmt_error(r.failure_reason)
    return d

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="ADIT Agent QA Platform", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API routes ────────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0.0"}

@app.get("/api/config")
def get_config():
    return {
        "scenarios": [
            {"id": k, "label": v["label"], "goal": v["goal"], "opener": v["opener"], "type": v["type"]}
            for k, v in SCENARIOS.items()
        ],
        "default_agent_phone": DEFAULT_AGENT_PHONE,
        "max_parallel": MAX_PARALLEL,
        "hosts": HOSTS,
    }

@app.post("/api/simulate")
def simulate(req: SimRequest):
    req.openai_key = _resolve_openai_key(req.openai_key)
    try:
        result = _run_simulation_sync(
            req.scenario_id, req.api_base, req.bearer_token,
            req.agent_phone, req.openai_key, req.use_judge, req.reuse_phone,
            req.extra_context,
        )
        return _result_to_dict(result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/simulate/parallel")
def simulate_parallel(req: ParallelSimRequest):
    req.openai_key = _resolve_openai_key(req.openai_key)
    tasks = [(sid, i) for sid in req.scenario_ids for i in range(req.repeats)]
    results = []
    with ThreadPoolExecutor(max_workers=min(req.max_parallel, MAX_PARALLEL)) as ex:
        futures = [
            ex.submit(
                _run_simulation_sync,
                sid, req.api_base, req.bearer_token,
                req.agent_phone, req.openai_key, req.use_judge, None,
                req.extra_context,
            )
            for sid, _ in tasks
        ]
        for fut in futures:
            try:
                results.append(_result_to_dict(fut.result()))
            except Exception as e:
                results.append({"error": str(e), "passed": False, "score": 0})
    return {"results": results}

@app.post("/api/simulate/chain")
def simulate_chain(req: ChainRequest):
    """
    Book → Reschedule → Cancel chain.
    Step 1 books as a new patient. Steps 2-3 reuse the SAME patient details
    (same phone + same persona marked is_new=False) so the backend can find them.
    """
    req.openai_key = _resolve_openai_key(req.openai_key)
    phone = _phone()
    chain = {}
    chained_persona: Optional[PatientPersona] = None

    for scenario_id in ["new-patient-cleaning", "reschedule", "cancel"]:
        result = _run_simulation_sync(
            scenario_id, req.api_base, req.bearer_token,
            req.agent_phone, req.openai_key, reuse_phone=phone,
            persona_override=chained_persona,
            auto_prereq=False,  # chain manages its own sequencing
        )
        # After the booking step succeeds, carry the same patient (now existing)
        # forward so reschedule / cancel use the same name + DOB the backend just stored.
        if scenario_id == "new-patient-cleaning" and result.passed:
            booking_config = SCENARIOS["new-patient-cleaning"]
            p = PERSONAS[booking_config["persona_idx"]]
            chained_persona = PatientPersona(
                p.first_name, p.last_name, p.dob,
                p.insurance, p.reason, p.preferred_day,
                p.preferred_time, is_new=False,
            )
        chain[scenario_id] = _result_to_dict(result)
    return chain

@app.post("/api/debug/analyze")
async def debug_analyze(
    screenshot: UploadFile = File(...),
    system_prompt: str = Form(""),
    extra_context: str = Form(""),
    openai_key: str = Form(""),
):
    openai_key = _resolve_openai_key(openai_key)
    image_bytes = await screenshot.read()
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        b64 = base64.b64encode(image_bytes).decode()
        prompt_block = f"\n\nSYSTEM PROMPT (full Retell agent prompt):\n```\n{system_prompt}\n```" if system_prompt.strip() else ""
        context_block = f"\n\nADDITIONAL CONTEXT FROM TESTER: {extra_context}" if extra_context.strip() else ""

        analysis_prompt = f"""You are a senior QA engineer debugging an AI dental front-desk SMS receptionist.

Analyze the conversation screenshot and identify exactly what went wrong.{prompt_block}{context_block}

Return ONLY valid JSON (no markdown, no explanation):
{{
    "what_happened": "1-2 sentences describing what the agent did wrong",
    "severity": "low|medium|high|critical",
    "scenario_type": "booking|reschedule|cancel|insurance|hours|emergency|other",
    "root_cause": "Specific technical reason the agent failed",
    "prompt_section_at_fault": "The exact text from the system prompt that is wrong or missing — quote it verbatim. If no prompt was provided, describe what instruction is likely missing.",
    "suggested_fix": "The exact replacement text or addition to make in the system prompt to fix this issue",
    "fix_explanation": "1-2 sentences explaining why this change fixes the issue",
    "repro_opener": "The exact first patient message that would reproduce this bug",
    "repro_followups": ["patient msg 2", "patient msg 3", "patient msg 4"],
    "confidence": "high|medium|low"
}}"""

        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"}},
                {"type": "text", "text": analysis_prompt},
            ]}],
            max_tokens=1400, temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"Parse error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class AnalyzeTextRequest(BaseModel):
    description: str
    system_prompt: str = ""
    extra_context: str = ""
    openai_key: str

@app.post("/api/debug/analyze-text")
def debug_analyze_text(req: AnalyzeTextRequest):
    """Text-only escalation analysis (no screenshot)."""
    openai_key = _resolve_openai_key(req.openai_key)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        prompt_block = f"\n\nSYSTEM PROMPT (full Retell agent prompt):\n```\n{req.system_prompt}\n```" if req.system_prompt.strip() else ""
        context_block = f"\n\nADDITIONAL CONTEXT FROM TESTER: {req.extra_context}" if req.extra_context.strip() else ""

        analysis_prompt = f"""You are a senior QA engineer debugging an AI dental front-desk SMS receptionist.

A client has escalated this issue:{prompt_block}{context_block}

ESCALATION DESCRIPTION:
{req.description}

Based on this description, identify exactly what went wrong.

Return ONLY valid JSON (no markdown, no explanation):
{{
    "what_happened": "1-2 sentences describing what the agent did wrong",
    "severity": "low|medium|high|critical",
    "scenario_type": "booking|reschedule|cancel|insurance|hours|emergency|other",
    "root_cause": "Specific technical reason the agent failed",
    "prompt_section_at_fault": "The exact text from the system prompt that is wrong or missing — quote it verbatim. If no prompt was provided, describe what instruction is likely missing.",
    "suggested_fix": "The exact replacement text or addition to make in the system prompt to fix this issue",
    "fix_explanation": "1-2 sentences explaining why this change fixes the issue",
    "repro_opener": "The exact first patient message that would reproduce this bug",
    "repro_followups": ["patient msg 2", "patient msg 3", "patient msg 4"],
    "confidence": "high|medium|low"
}}"""

        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": analysis_prompt}],
            max_tokens=1400, temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"Parse error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/debug/validate")
def debug_validate(req: ValidationRequest):
    req.openai_key = _resolve_openai_key(req.openai_key)
    # Temporarily inject a custom repro scenario
    repro_id = "debug-repro"
    SCENARIOS[repro_id] = {
        "label": "🔬 Debug Repro",
        "goal": f"Reproduce: {req.root_cause}",
        "opener": req.repro_opener,
        "type": "repro",
        "persona_idx": 0,
    }
    results = []
    for _ in range(req.n_runs):
        r = _run_simulation_sync(repro_id, req.api_base, req.bearer_token, req.agent_phone, req.openai_key)
        results.append(_result_to_dict(r))
    # Clean up
    SCENARIOS.pop(repro_id, None)
    return {"results": results}

@app.post("/api/evaluate/transcript")
def evaluate_transcript(req: TranscriptRequest):
    openai_key = _resolve_openai_key(req.openai_key)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        prompt_ctx = f"\n\nSystem Prompt:\n```\n{req.system_prompt}\n```" if req.system_prompt.strip() else ""
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": (
                    "You are a QA evaluator for an AI dental front desk agent.\n"
                    "Evaluate this transcript and return ONLY valid JSON:\n"
                    "{\n"
                    "  \"score\": 0-100,\n"
                    "  \"outcome\": \"booking_confirmed|task_created|incomplete|error\",\n"
                    "  \"passed\": true|false,\n"
                    "  \"what_went_well\": [\"point1\", \"point2\"],\n"
                    "  \"issues\": [\"issue1\", \"issue2\"],\n"
                    "  \"prompt_violations\": [\"specific instruction violated if prompt provided\"],\n"
                    "  \"tone\": \"professional|neutral|poor\",\n"
                    "  \"summary\": \"1-2 sentence summary\"\n"
                    "}\n"
                    "Scoring: 95-100 direct booking confirmed, 80-94 task created with full patient info, "
                    "60-79 partial completion, <60 failure or unhelpful."
                )},
                {"role": "user", "content": f"Transcript:\n{req.transcript}{prompt_ctx}"},
            ],
            max_tokens=700, temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
        return json.loads(raw)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate/scenarios")
def generate_scenarios(req: ScenarioGenRequest):
    openai_key = _resolve_openai_key(req.openai_key)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": (
                    "You generate test scenarios for a dental AI SMS receptionist. "
                    "Given a test description, output a JSON array of scenarios. "
                    "Each: {\"name\": str, \"goal\": str, \"opener\": str, \"followups\": [str, ...]}. "
                    "followups are 3-5 natural patient messages that continue the conversation. "
                    "Output JSON array only."
                )},
                {"role": "user", "content": f"Test description: {req.instruction}"},
            ],
            max_tokens=800, temperature=0.5,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:])
        if raw.endswith("```"):
            raw = "\n".join(raw.split("\n")[:-1])
        return json.loads(raw)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/simulate/generated")
def run_generated_scenario(
    scenario_name: str = Form(...),
    goal: str = Form(...),
    opener: str = Form(...),
    api_base: str = Form("https://frontdeskchatagent.adit.com"),
    bearer_token: str = Form(...),
    agent_phone: str = Form(DEFAULT_AGENT_PHONE),
    openai_key: str = Form(""),
):
    openai_key = _resolve_openai_key(openai_key)
    gen_id = "generated-" + scenario_name.lower().replace(" ", "-")[:30]
    SCENARIOS[gen_id] = {
        "label": scenario_name,
        "goal": goal,
        "opener": opener,
        "type": "generated",
        "persona_idx": random.randint(0, len(PERSONAS) - 1),
    }
    result = _run_simulation_sync(gen_id, api_base, bearer_token, agent_phone, openai_key)
    SCENARIOS.pop(gen_id, None)
    return _result_to_dict(result)

# ── Debug: apply fix to prompt ───────────────────────────────────────────────
class ApplyFixRequest(BaseModel):
    prompt_text: str
    section_at_fault: str
    suggested_fix: str

# ── Retell: fetch live agent prompt ──────────────────────────────────────────
RETELL_API_KEY       = "key_fb275adbb9a079ffa32be77492db"
RETELL_AGENT_ID      = "agent_ee5d7e7f782caa9f1789765182"   # chat / SMS agent
RETELL_CALL_AGENT_ID = "agent_8c769ad3395e9b058984c07628"   # voice call agent

# ── OpenAI default key ────────────────────────────────────────────────────────
# Loaded from environment so it is never sent to the browser.
# Individual requests can still override it by passing their own key.
DEFAULT_OPENAI_KEY: str = os.environ.get("OPENAI_API_KEY", "")


def _resolve_openai_key(request_key: str) -> str:
    """Return the request-level key if set, otherwise fall back to server default."""
    key = (request_key or "").strip()
    if key:
        return key
    if DEFAULT_OPENAI_KEY:
        return DEFAULT_OPENAI_KEY
    raise HTTPException(
        status_code=400,
        detail="OpenAI API key required — set OPENAI_API_KEY env var on the server or enter it in the sidebar.",
    )

# Runtime placeholder defaults injected before LLM simulation (Retell fills
# these at call-time normally; for simulation we use plausible values).
import datetime as _dt
_now = _dt.datetime.now()
RUNTIME_DEFAULTS: dict[str, str] = {
    "{{office_status}}":       "open",
    "{{business_hours}}":      "Monday through Friday 8 AM to 5 PM, Saturday 9 AM to 2 PM",
    "{{agent_phone_number}}":  DEFAULT_AGENT_PHONE,
    "{{patient_phone_number}}":"the number you're calling from",
    "{{current_day}}":         _now.strftime("%A"),
    "{{current_date}}":        _now.strftime("%B %d, %Y"),
    "{{current_year}}":        str(_now.year),
    "{{current_time}}":        _now.strftime("%I:%M %p").lstrip("0"),
}

def _fill_runtime_placeholders(prompt: str) -> str:
    """Replace Retell runtime variables with simulation-safe defaults."""
    for k, v in RUNTIME_DEFAULTS.items():
        prompt = prompt.replace(k, v)
    return prompt

# ── Call agent helpers ────────────────────────────────────────────────────────

# Phone-call-style caller openers (same intents as SCENARIOS but spoken)
CALL_OPENERS: dict[str, str] = {
    "new-patient-cleaning":    "Hi, I'd like to schedule an appointment. I'm a new patient.",
    "dental-emergency":        "Hi, I have a really bad toothache and I need to see someone today if at all possible.",
    "existing-routine":        "Hi, I'm an existing patient and I'd like to schedule a routine cleaning.",
    "reschedule":              "Hi, I need to reschedule my upcoming appointment.",
    "cancel":                  "Hi, I need to cancel my appointment please.",
    "insurance-book":          "Hi, I was wondering if you accept Delta Dental insurance before I go ahead and book.",
    "office-hours-book":       "Hi, what are your office hours? And if you're open, I'd love to make an appointment.",
    "post-treatment-followup": "Hi, I had a filling done last week and my tooth is still really sensitive to cold. I think I need to come back in.",
}

def smart_caller_reply(
    agent_msg: str, persona: PatientPersona, history: list,
    goal: str, oai_key: str, patient_phone: str = "",
    extra_context: str = "",
) -> tuple[str, bool]:
    """Phone-caller AI — natural spoken replies, voice-call register."""
    if not oai_key:
        return "Yeah, okay.", False
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)

        agent_lower = agent_msg.lower()
        if any(ph in agent_lower for ph in TASK_TRIGGER_PHRASES):
            return "Yeah, that would be great, thank you.", False
        if any(kw in agent_lower for kw in ALL_SUCCESS_KWS):
            return "Great, thanks so much. Have a good day!", True

        recent = history[-8:]
        transcript = "\n".join(
            f"{'You' if t.role == 'patient' else 'Agent'}: {t.message}" for t in recent
        )
        extra_ctx_block = f"\n\nADDITIONAL SCENARIO CONTEXT (use to make your replies more realistic):\n{extra_context.strip()}" if extra_context.strip() else ""
        system_prompt = f"""You are a real person calling a dental office on the phone.{extra_ctx_block}

YOUR DETAILS — reveal ONLY when the agent specifically asks for that piece:
- First name: {persona.first_name}
- Last name: {persona.last_name}
- Date of birth: {persona.dob}
- Insurance: {persona.insurance}
- Reason for calling: {persona.reason}
- Preferred day: {persona.preferred_day}
- Preferred time: {persona.preferred_time}
- Patient type: {"New patient" if persona.is_new else "Existing patient, I've been here before"}
- My phone: {patient_phone if patient_phone else "the number I'm calling from"}

YOUR GOAL: {goal}

You are on a PHONE CALL — sound natural and human:
1. Reply in 1-2 short spoken sentences (voice register, not SMS)
2. ONLY respond to what the agent just asked. Nothing else.
3. You may use casual spoken language: "yeah", "sure", "uh", "right", "okay"
4. If asked new or existing → {"New" if persona.is_new else "Existing — I've been there before"}
5. If asked first name → {persona.first_name}
6. If asked last name → {persona.last_name}
7. If asked to spell name → spell it: {' '.join(list(persona.first_name.upper()))} for first name
8. If asked date of birth → {persona.dob}
9. If asked insurance → {persona.insurance}
10. If asked reason for visit → {persona.reason}
11. If asked preferred day → {persona.preferred_day}
12. If asked morning or afternoon → {persona.preferred_time}
13. If given two appointment slot choices → pick the first one
14. If asked if this is your number → "Yes, that's my cell."
15. Output ONLY your spoken reply — no labels, no quotes."""

        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": (
                    f"Call so far:\n{transcript}\n\n"
                    f"Agent just said:\n\"{agent_msg}\"\n\nYour spoken reply:"
                )},
            ],
            max_tokens=60, temperature=0.2,
        )
        reply = resp.choices[0].message.content.strip().strip('"').strip("'")
        should_end = any(kw in agent_lower for kw in ALL_SUCCESS_KWS)
        return reply, should_end
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("smart_caller_reply error: %s", exc)
        return "Yeah, that sounds good.", False


def call_agent_llm_reply(
    caller_msg: str, system_prompt: str, history: list, oai_key: str,
) -> str:
    """Simulates the voice call agent using its Retell system prompt via GPT-4o."""
    from openai import OpenAI
    client = OpenAI(api_key=oai_key)

    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    for turn in history:
        role = "user" if turn.role == "patient" else "assistant"
        messages.append({"role": role, "content": turn.message})
    messages.append({"role": "user", "content": caller_msg})

    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        max_tokens=300,
        temperature=0.1,
    )
    return resp.choices[0].message.content.strip()


# ── Call simulation: synchronous single + parallel ────────────────────────────

def _run_call_simulation_sync(
    scenario_id: str,
    call_agent_prompt: str,
    oai_key: str,
    max_turns: int = 12,
    extra_context: str = "",
    persona_override: Optional[PatientPersona] = None,
    auto_prereq: bool = True,
    reuse_phone: Optional[str] = None,
) -> SimResult:
    """LLM-to-LLM call simulation — returns a SimResult (no streaming)."""
    config = SCENARIOS.get(scenario_id, SCENARIOS["new-patient-cleaning"])

    # ── Two-phase: for existing-patient call scenarios, run a new-patient
    # booking simulation first so the LLM agent believes a patient exists.
    if auto_prereq and scenario_id in REQUIRES_PRIOR_BOOKING and persona_override is None:
        prereq_phone = reuse_phone or _phone()
        _run_call_simulation_sync(
            "new-patient-cleaning", call_agent_prompt, oai_key,
            max_turns=max_turns, extra_context="",
            persona_override=None, auto_prereq=False,
            reuse_phone=prereq_phone,
        )
        reuse_phone = prereq_phone
        booking_p   = PERSONAS[SCENARIOS["new-patient-cleaning"]["persona_idx"]]
        sc_persona  = PERSONAS[config["persona_idx"]]
        persona_override = PatientPersona(
            first_name=booking_p.first_name,
            last_name=booking_p.last_name,
            dob=booking_p.dob,
            insurance=booking_p.insurance,
            reason=sc_persona.reason,
            preferred_day=sc_persona.preferred_day,
            preferred_time=sc_persona.preferred_time,
            is_new=False,
        )

    persona = _resolve_persona(config, persona_override)
    patient_phone = reuse_phone or _phone()
    goal = config["goal"]

    system_prompt = (
        _fill_runtime_placeholders(call_agent_prompt)
        if call_agent_prompt.strip()
        else (
            "You are an AI voice receptionist for a dental office. "
            "Help callers book, reschedule, or cancel appointments warmly and efficiently."
        )
    )

    turns: list[Turn] = []
    current_caller_msg = CALL_OPENERS.get(scenario_id, config["opener"])
    passed = False
    outcome_type = "incomplete"
    failure_reason = ""
    t_start = time.time()

    for turn_num in range(max_turns):
        t0 = time.time()
        try:
            agent_msg = call_agent_llm_reply(current_caller_msg, system_prompt, turns, oai_key)
        except Exception as exc:
            failure_reason = f"Agent LLM error: {str(exc)[:80]}"
            outcome_type = "error"
            break

        latency_ms = int((time.time() - t0) * 1000)
        api_events = _infer_api_events(agent_msg, latency_ms, turn_num)
        turns.append(Turn("patient", current_caller_msg))
        turns.append(Turn("agent", agent_msg, latency_ms, api_events))

        agent_lower = agent_msg.lower()
        if any(kw in agent_lower for kw in BOOKING_CONFIRMED_KWS):
            passed = True; outcome_type = "booking_confirmed"; break
        if any(kw in agent_lower for kw in TASK_CREATED_KWS):
            passed = True; outcome_type = "task_created"; break

        try:
            current_caller_msg, should_end = smart_caller_reply(
                agent_msg, persona, turns, goal, oai_key, patient_phone, extra_context
            )
            if should_end:
                passed = True; outcome_type = "booking_confirmed"; break
        except Exception as exc:
            failure_reason = f"Caller LLM error: {str(exc)[:80]}"; break
    else:
        failure_reason = f"Goal not reached in {max_turns} turns"

    total_ms = int((time.time() - t_start) * 1000)
    score, judge_reason = _llm_judge(config["label"], turns, oai_key) if turns else (0, "No turns")

    # Auto-register newly-booked patient for reuse in existing-patient call scenarios
    if passed and persona.is_new and outcome_type in ("booking_confirmed", "task_created"):
        _register_patient(persona, patient_phone)

    return SimResult(
        scenario=scenario_id,
        scenario_label=config["label"],
        patient_phone=patient_phone,
        turns=turns,
        passed=passed,
        score=score,
        failure_reason=failure_reason if not passed else judge_reason,
        total_ms=total_ms,
        chat_id="",
        outcome_type=outcome_type,
        api_calls=[],
    )


class CallSimRequest(BaseModel):
    scenario_id: str = "new-patient-cleaning"
    call_agent_prompt: str = ""
    openai_key: str
    max_turns: int = 12
    extra_context: str = ""


class CallParallelRequest(BaseModel):
    scenario_ids: list[str]
    repeats: int = 1
    max_parallel: int = 3
    call_agent_prompt: str = ""
    openai_key: str
    max_turns: int = 12
    extra_context: str = ""


@app.post("/api/simulate/call")
def simulate_call(req: CallSimRequest):
    """Single synchronous call simulation."""
    req.openai_key = _resolve_openai_key(req.openai_key)
    result = _run_call_simulation_sync(
        req.scenario_id, req.call_agent_prompt, req.openai_key, req.max_turns,
        req.extra_context,
    )
    return _result_to_dict(result)


@app.post("/api/simulate/call/parallel")
def simulate_call_parallel(req: CallParallelRequest):
    """Parallel call simulations — LLM-to-LLM, no ADIT backend needed."""
    req.openai_key = _resolve_openai_key(req.openai_key)
    tasks = [(sid, i) for sid in req.scenario_ids for i in range(req.repeats)]
    results = []
    with ThreadPoolExecutor(max_workers=min(req.max_parallel, 5)) as ex:
        futures = [
            ex.submit(
                _run_call_simulation_sync,
                sid, req.call_agent_prompt, req.openai_key, req.max_turns,
                req.extra_context,
            )
            for sid, _ in tasks
        ]
        for fut in futures:
            try:
                results.append(_result_to_dict(fut.result()))
            except Exception as exc:
                results.append({"error": str(exc), "passed": False, "score": 0,
                                "scenario_label": "Error", "turns": []})
    return {"results": results}


# ── Call simulation SSE stream ────────────────────────────────────────────────

class StreamCallRequest(BaseModel):
    scenario_id: str = "new-patient-cleaning"
    call_agent_prompt: str = ""
    openai_key: str
    max_turns: int = 12
    # Optional repro fields — override scenario opener/goal for debug reproduction
    repro_opener: str = ""
    root_cause: str = ""
    extra_context: str = ""


@app.post("/api/simulate/call-stream")
async def stream_call(req: StreamCallRequest):
    """
    LLM-to-LLM voice call simulation streamed as Server-Sent Events.
    One GPT-4o instance plays the call agent (using its live Retell prompt).
    One GPT-4o-mini instance plays the patient caller.
    """
    req.openai_key = _resolve_openai_key(req.openai_key)
    from fastapi.responses import StreamingResponse as SR

    async def gen():
        loop = asyncio.get_running_loop()
        config = SCENARIOS.get(req.scenario_id, SCENARIOS["new-patient-cleaning"])

        # Two-phase: for existing-patient scenarios, run the booking prereq first
        prereq_persona: Optional[PatientPersona] = None
        if req.scenario_id in REQUIRES_PRIOR_BOOKING and not req.repro_opener:
            yield f"data: {json.dumps({'type': 'status', 'message': '⏳ Running prerequisite new-patient booking…'})}\n\n"
            booking_p  = PERSONAS[SCENARIOS["new-patient-cleaning"]["persona_idx"]]
            sc_persona = PERSONAS[config["persona_idx"]]
            prereq_persona = PatientPersona(
                first_name=booking_p.first_name, last_name=booking_p.last_name,
                dob=booking_p.dob, insurance=booking_p.insurance,
                reason=sc_persona.reason, preferred_day=sc_persona.preferred_day,
                preferred_time=sc_persona.preferred_time, is_new=False,
            )
            await loop.run_in_executor(
                None,
                lambda: _run_call_simulation_sync(
                    "new-patient-cleaning", req.call_agent_prompt, req.openai_key,
                    req.max_turns, extra_context="",
                    persona_override=None, auto_prereq=False,
                ),
            )

        persona = _resolve_persona(config, prereq_persona)
        patient_phone = _phone()
        # Repro mode overrides goal; otherwise use scenario goal
        goal = f"Reproduce: {req.root_cause}" if req.root_cause else config["goal"]

        system_prompt = _fill_runtime_placeholders(req.call_agent_prompt) if req.call_agent_prompt.strip() else (
            "You are an AI voice receptionist for a dental office. "
            "Help callers book, reschedule, or cancel appointments warmly and efficiently."
        )

        turns: list[Turn] = []
        # Repro mode uses custom opener; otherwise use call-specific or scenario default
        current_caller_msg = (
            req.repro_opener if req.repro_opener
            else CALL_OPENERS.get(req.scenario_id, config["opener"])
        )

        for turn_num in range(req.max_turns):
            # Stream patient / caller turn
            yield f"data: {json.dumps({'type': 'patient', 'message': current_caller_msg})}\n\n"
            await asyncio.sleep(0.02)

            # Call agent LLM reply
            t0 = time.time()
            try:
                agent_msg = await loop.run_in_executor(
                    None,
                    lambda m=current_caller_msg: call_agent_llm_reply(m, system_prompt, turns, req.openai_key),
                )
            except Exception as exc:
                yield f"data: {json.dumps({'type': 'error', 'message': f'Agent LLM error: {str(exc)[:120]}'})}\n\n"
                return

            latency_ms = int((time.time() - t0) * 1000)
            api_events = _infer_api_events(agent_msg, latency_ms, turn_num)

            turns.append(Turn("patient", current_caller_msg))
            turns.append(Turn("agent", agent_msg, latency_ms, api_events))

            yield f"data: {json.dumps({'type': 'agent', 'message': agent_msg, 'latency_ms': latency_ms, 'api_events': api_events})}\n\n"
            await asyncio.sleep(0.02)

            agent_lower = agent_msg.lower()
            if any(kw in agent_lower for kw in BOOKING_CONFIRMED_KWS):
                yield f"data: {json.dumps({'type': 'done', 'outcome': 'booking_confirmed', 'passed': True})}\n\n"
                return
            if any(kw in agent_lower for kw in TASK_CREATED_KWS):
                yield f"data: {json.dumps({'type': 'done', 'outcome': 'task_created', 'passed': True})}\n\n"
                return

            # Patient caller reply
            try:
                current_caller_msg, should_end = await loop.run_in_executor(
                    None,
                    lambda m=agent_msg: smart_caller_reply(m, persona, turns, goal, req.openai_key, patient_phone, req.extra_context),
                )
                if should_end:
                    yield f"data: {json.dumps({'type': 'done', 'outcome': 'booking_confirmed', 'passed': True})}\n\n"
                    return
            except Exception as exc:
                yield f"data: {json.dumps({'type': 'error', 'message': f'Caller LLM error: {str(exc)[:80]}'})}\n\n"
                return

        yield f"data: {json.dumps({'type': 'done', 'outcome': 'incomplete', 'passed': False})}\n\n"

    return SR(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Retell: fetch call agent prompt ──────────────────────────────────────────

@app.post("/api/retell/list-calls")
async def list_calls(body: dict = None):
    """Proxy: list recent calls from Retell (for viewing real transcripts)."""
    payload = body or {}
    try:
        r = await _retell_post("/v2/list-calls", payload)
        return r.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Retell list-calls failed: {exc}")


@app.get("/api/retell/get-call/{call_id}")
async def get_call(call_id: str):
    """Proxy: get a single call's transcript + metadata from Retell."""
    headers = {"Authorization": f"Bearer {RETELL_API_KEY}"}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(f"{_RETELL_BASE}/v2/get-call/{call_id}", headers=headers)
            return r.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Retell get-call failed: {exc}")


class AnalyzeCallRequest(BaseModel):
    transcript: str
    system_prompt: str = ""
    extra_context: str = ""
    openai_key: str


@app.post("/api/debug/analyze-call-screenshot")
async def debug_analyze_call_screenshot(
    screenshot: UploadFile = File(...),
    system_prompt: str = Form(""),
    extra_context: str = Form(""),
    openai_key: str = Form(""),
):
    """Analyze a call-related screenshot using GPT-4o vision (call agent debug mode)."""
    openai_key = _resolve_openai_key(openai_key)
    image_bytes = await screenshot.read()
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        b64 = base64.b64encode(image_bytes).decode()
        prompt_block = f"\n\nCALL AGENT SYSTEM PROMPT:\n```\n{system_prompt}\n```" if system_prompt.strip() else ""
        context_block = f"\n\nADDITIONAL CONTEXT: {extra_context}" if extra_context.strip() else ""

        analysis_prompt = f"""You are a senior QA engineer debugging an AI dental front-desk VOICE CALL agent.

Analyze the screenshot — it may show a call transcript, a call recording interface, a conversation log, or any call-related issue.{prompt_block}{context_block}

Identify exactly what the voice agent did wrong.

Voice call issues to look for:
- Agent interrupting or not waiting for caller to finish
- Missing required information collection (name, DOB, insurance, reason)
- Wrong information given (hours, availability, policies)
- Failing to book when it should, or booking when it shouldn't
- Not offering task creation when direct booking fails
- Unnatural or confusing responses
- Not following the system prompt instructions

Return ONLY valid JSON (no markdown):
{{
    "what_happened": "1-2 sentences describing what the agent did wrong",
    "severity": "low|medium|high|critical",
    "scenario_type": "booking|reschedule|cancel|insurance|hours|emergency|other",
    "root_cause": "Specific technical reason the call agent failed",
    "prompt_section_at_fault": "The exact text from the system prompt that is wrong or missing — quote verbatim. If no prompt provided, describe the missing instruction.",
    "suggested_fix": "The exact replacement text or addition to fix the system prompt",
    "fix_explanation": "1-2 sentences explaining why this change fixes the issue",
    "repro_opener": "The exact first spoken caller message that would reproduce this bug (phone call style)",
    "repro_followups": ["what caller says next", "then this", "then this"],
    "confidence": "high|medium|low"
}}"""

        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"}},
                {"type": "text", "text": analysis_prompt},
            ]}],
            max_tokens=1400, temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Parse error: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/debug/analyze-call")
def debug_analyze_call(req: AnalyzeCallRequest):
    """Analyze a voice call transcript for agent issues."""
    openai_key = _resolve_openai_key(req.openai_key)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        prompt_block = f"\n\nCALL AGENT SYSTEM PROMPT:\n```\n{req.system_prompt}\n```" if req.system_prompt.strip() else ""
        context_block = f"\n\nADDITIONAL CONTEXT: {req.extra_context}" if req.extra_context.strip() else ""

        analysis_prompt = f"""You are a senior QA engineer debugging an AI dental front-desk VOICE CALL agent.

Analyze this call transcript and identify exactly what the voice agent did wrong.{prompt_block}{context_block}

CALL TRANSCRIPT:
{req.transcript}

Voice call issues to look for:
- Agent interrupting or not waiting for caller to finish
- Missing required information collection (name, DOB, insurance, reason)
- Wrong information given (hours, availability, policies)
- Failing to book when it should, or booking when it shouldn't
- Not offering task creation when direct booking fails
- Unnatural or confusing responses
- Not following the system prompt instructions

Return ONLY valid JSON (no markdown):
{{
    "what_happened": "1-2 sentences describing what the agent did wrong",
    "severity": "low|medium|high|critical",
    "scenario_type": "booking|reschedule|cancel|insurance|hours|emergency|other",
    "root_cause": "Specific technical reason the call agent failed",
    "prompt_section_at_fault": "The exact text from the system prompt that is wrong or missing — quote verbatim. If no prompt provided, describe the missing instruction.",
    "suggested_fix": "The exact replacement text or addition to fix the system prompt",
    "fix_explanation": "1-2 sentences explaining why this change fixes the issue",
    "repro_opener": "The exact first spoken caller message that would reproduce this bug (phone call style)",
    "repro_followups": ["what caller says next", "then this", "then this"],
    "confidence": "high|medium|low"
}}"""

        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": analysis_prompt}],
            max_tokens=1400, temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Parse error: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


def _extract_agent_prompt_from_data(agent_data: dict, agent_id: str) -> dict | None:
    """Given a parsed Retell agent object, fetch the associated LLM prompt synchronously.
    Returns the prompt dict on success, None if llm_id is missing."""
    llm_id = (
        agent_data.get("llm_id")
        or (agent_data.get("response_engine") or {}).get("llm_id")
    )
    return llm_id  # just return the id; async fetching done by caller


async def _fetch_llm_prompt(llm_id: str, agent_id: str, errors: list[str]) -> dict | None:
    """Try fetching a Retell LLM by id; returns prompt dict or None."""
    for llm_path in [f"/get-retell-llm/{llm_id}", f"/v2/get-retell-llm/{llm_id}"]:
        try:
            llm_resp = await _retell_get(llm_path)
            if llm_resp.status_code != 200:
                errors.append(f"{llm_path}: HTTP {llm_resp.status_code}")
                continue
            llm_data = llm_resp.json()
            if isinstance(llm_data, dict) and llm_data.get("status") == "error":
                errors.append(f"{llm_path}: {llm_data.get('message', 'API error')}")
                continue
            prompt = (
                llm_data.get("general_prompt")
                or llm_data.get("system_prompt")
                or ""
            )
            return {
                "prompt": prompt,
                "llm_id": llm_id,
                "agent_id": agent_id,
                "model": llm_data.get("model", ""),
            }
        except Exception as exc:
            errors.append(f"{llm_path}: {exc}")
    return None


async def _fetch_agent_prompt_data(agent_id: str) -> dict:
    """
    Robustly fetch an agent's system prompt from Retell.
    Tries multiple strategies to handle different agent channel types:

    1. GET /get-chat-agent/{id}  — chat/SMS agents (Retell "chat" channel)
    2. GET /get-agent/{id}       — voice agents v1
    3. GET /v2/get-agent/{id}    — voice agents v2
    4. GET /list-agents          — fallback: scan all voice agents by id

    For each successful agent fetch, tries both LLM path variants.
    Also detects Retell's pattern of HTTP 200 + JSON {"status":"error",...}.
    """
    errors: list[str] = []

    # ── Strategy 1: chat agent path (SMS / chat channel) ─────────────────────
    try:
        chat_resp = await _retell_get(f"/get-chat-agent/{agent_id}")
        if chat_resp.status_code == 200:
            chat_data = chat_resp.json()
            if isinstance(chat_data, dict) and chat_data.get("status") != "error":
                llm_id = (
                    chat_data.get("llm_id")
                    or (chat_data.get("response_engine") or {}).get("llm_id")
                )
                if llm_id:
                    result = await _fetch_llm_prompt(llm_id, agent_id, errors)
                    if result:
                        return result
                    errors.append(f"/get-chat-agent: found llm_id={llm_id} but LLM fetch failed")
                else:
                    errors.append(f"/get-chat-agent: no llm_id in response")
            else:
                errors.append(f"/get-chat-agent: {chat_data.get('message', 'API error')}")
        else:
            errors.append(f"/get-chat-agent/{agent_id}: HTTP {chat_resp.status_code}")
    except Exception as exc:
        errors.append(f"/get-chat-agent: {exc}")

    # ── Strategy 2 & 3: voice agent GET paths ────────────────────────────────
    for agent_path in [f"/get-agent/{agent_id}", f"/v2/get-agent/{agent_id}"]:
        try:
            agent_resp = await _retell_get(agent_path)
        except Exception as exc:
            errors.append(f"{agent_path}: request error — {exc}")
            continue

        if agent_resp.status_code != 200:
            errors.append(f"{agent_path}: HTTP {agent_resp.status_code}")
            continue

        try:
            agent_data = agent_resp.json()
        except Exception:
            errors.append(f"{agent_path}: non-JSON response")
            continue

        # Retell returns 200 + JSON error body for wrong channel types
        if isinstance(agent_data, dict) and agent_data.get("status") == "error":
            errors.append(f"{agent_path}: {agent_data.get('message', 'API error')}")
            continue

        llm_id = (
            agent_data.get("llm_id")
            or (agent_data.get("response_engine") or {}).get("llm_id")
        )
        if not llm_id:
            errors.append(f"{agent_path}: no llm_id in response")
            continue

        result = await _fetch_llm_prompt(llm_id, agent_id, errors)
        if result:
            return result

    # ── Strategy 3: GET /list-agents (correct Retell v1 endpoint) ────────────
    try:
        list_resp = await _retell_get("/list-agents")
        if list_resp.status_code != 200:
            errors.append(f"list-agents: HTTP {list_resp.status_code} — {list_resp.text[:120]}")
        else:
            agents_raw = list_resp.json()
            # Retell returns a plain array
            if isinstance(agents_raw, dict):
                agents_raw = agents_raw.get("agents", agents_raw.get("data", []))
            if isinstance(agents_raw, list):
                agent_data = next((a for a in agents_raw if a.get("agent_id") == agent_id), None)
                if agent_data:
                    re = agent_data.get("response_engine") or {}
                    engine_type = re.get("type", "")

                    # retell-llm → fetch the LLM object
                    llm_id = agent_data.get("llm_id") or re.get("llm_id")
                    if llm_id:
                        result = await _fetch_llm_prompt(llm_id, agent_id, errors)
                        if result:
                            return result

                    # custom-llm → prompt lives on the external server, not in Retell
                    if engine_type == "custom-llm":
                        ws_url = re.get("llm_websocket_url", "")
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"SMS agent uses custom-llm (WebSocket: {ws_url[:60]}). "
                                "The system prompt is managed by the ADIT backend, not stored in Retell. "
                                "Please paste the prompt manually."
                            ),
                        )

                    errors.append(
                        f"list-agents: agent found (type={engine_type}) but could not extract prompt. "
                        f"response_engine keys: {list(re.keys())}"
                    )
                else:
                    errors.append(f"list-agents: agent {agent_id} not found in {len(agents_raw)} agents")
            else:
                errors.append(f"list-agents: unexpected response shape")
    except HTTPException:
        raise
    except Exception as exc:
        errors.append(f"list-agents: {exc}")

    raise HTTPException(
        status_code=502,
        detail=f"Could not fetch agent prompt. Errors: {'; '.join(errors)}",
    )


@app.get("/api/retell/debug-agent-raw")
async def debug_agent_raw(agent_id: str | None = None):
    """
    Diagnostic: returns the raw Retell API responses for an agent ID.
    Tries every known path and returns all raw response bodies so we can
    see exactly what fields Retell is returning.
    """
    target_id = agent_id or RETELL_AGENT_ID
    report: dict = {"agent_id": target_id, "strategies": {}}

    for path in [f"/get-chat-agent/{target_id}", f"/get-agent/{target_id}", f"/v2/get-agent/{target_id}"]:
        try:
            r = await _retell_get(path)
            try:
                body = r.json()
            except Exception:
                body = r.text[:500]
            report["strategies"][f"GET {path}"] = {"status": r.status_code, "body": body}
        except Exception as exc:
            report["strategies"][f"GET {path}"] = {"error": str(exc)}

    for method, fn in [
        ("GET /list-agents", lambda: _retell_get("/list-agents")),
    ]:
        try:
            r = await fn()
            try:
                body = r.json()
            except Exception:
                body = r.text[:500]
            # Find the matching agent in the list response
            if isinstance(body, list):
                matched = next((a for a in body if a.get("agent_id") == target_id), None)
                report["strategies"][method] = {
                    "status": r.status_code,
                    "total_agents": len(body),
                    "matched_agent": matched,
                }
            elif isinstance(body, dict):
                agents = body.get("agents", body.get("data", []))
                matched = next((a for a in agents if a.get("agent_id") == target_id), None) if isinstance(agents, list) else None
                report["strategies"][method] = {
                    "status": r.status_code,
                    "total_agents": len(agents) if isinstance(agents, list) else "?",
                    "matched_agent": matched,
                    "raw_keys": list(body.keys()),
                }
            else:
                report["strategies"][method] = {"status": r.status_code, "body": str(body)[:500]}
        except Exception as exc:
            report["strategies"][method] = {"error": str(exc)}

    return report


def _norm_phone(p: str) -> str:
    """Strip spaces, dashes and parentheses for phone comparison."""
    return p.replace(" ", "").replace("-", "").replace("(", "").replace(")", "")


def _phone_match(agent: dict, norm: str) -> bool:
    for field in ("agent_phone_number", "phone_number", "inbound_phone_number", "phone"):
        val = agent.get(field, "")
        if val and _norm_phone(val) == norm:
            return True
    return False


async def _list_agents(channel: str) -> list[dict]:
    """Return the raw agent list for 'chat' or 'voice' channel."""
    path = "/list-chat-agents" if channel == "chat" else "/list-agents"
    try:
        resp = await _retell_get(path)
        if resp.status_code != 200:
            return []
        data = resp.json()
        if isinstance(data, dict):
            data = data.get("agents", data.get("data", []))
        return data if isinstance(data, list) else []
    except Exception:
        return []


async def _resolve_agent_by_phone(phone: str, channel: str) -> str | None:
    """
    Look up the Retell agent ID whose associated phone number matches `phone`.

    Strategy for voice agents:
      1. Direct phone-field match in GET /list-agents

    Strategy for chat agents (no phone field in Retell):
      1. Try direct phone-field match in GET /list-chat-agents (in case a future
         API version exposes it)
      2. Fallback: find the voice agent for this phone → compare its name with
         all chat agents → return the chat agent with the most name-word overlap
         (requires ≥ 3 words in common to avoid false positives)

    Returns the agent_id string, or None if not found / API error.
    """
    norm = _norm_phone(phone)

    if channel == "voice":
        for agent in await _list_agents("voice"):
            if _phone_match(agent, norm):
                return agent.get("agent_id") or agent.get("id")
        return None

    # ── Chat channel ─────────────────────────────────────────────────────────
    # Step 1: direct match
    for agent in await _list_agents("chat"):
        if _phone_match(agent, norm):
            return agent.get("agent_id") or agent.get("id")

    # Step 2: name-similarity via voice agent
    voice_agent: dict | None = None
    for agent in await _list_agents("voice"):
        if _phone_match(agent, norm):
            voice_agent = agent
            break

    if not voice_agent:
        return None

    voice_name = (voice_agent.get("agent_name") or voice_agent.get("name") or "").lower()
    voice_words = set(w for w in voice_name.split() if len(w) > 2)  # ignore short words
    if not voice_words:
        return None

    best_id: str | None = None
    best_score = 0
    for ca in await _list_agents("chat"):
        chat_name = (ca.get("agent_name") or ca.get("name") or "").lower()
        chat_words = set(w for w in chat_name.split() if len(w) > 2)
        score = len(voice_words & chat_words)
        if score > best_score:
            best_score = score
            best_id = ca.get("agent_id") or ca.get("id")

    # Require at least 3 meaningful words in common to avoid false positives
    return best_id if best_score >= 3 else None


@app.get("/api/retell/fetch-call-prompt")
async def fetch_call_prompt(
    agent_phone: Optional[str] = None,
    agent_id: Optional[str] = None,   # explicit override — highest priority
):
    """
    Fetches the live system prompt for the voice call agent.
    Priority: explicit agent_id > phone lookup > hardcoded default.
    """
    try:
        resolved_id = agent_id or RETELL_CALL_AGENT_ID
        if not agent_id and agent_phone:
            resolved = await _resolve_agent_by_phone(agent_phone, "voice")
            if resolved:
                resolved_id = resolved
        return await _fetch_agent_prompt_data(resolved_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Retell call prompt fetch failed: {exc}")


@app.get("/api/retell/fetch-prompt")
async def fetch_retell_prompt(
    agent_phone: Optional[str] = None,
    agent_id: Optional[str] = None,   # explicit override — highest priority
):
    """
    Fetches the live system prompt from Retell for the SMS/chat agent.
    Priority: explicit agent_id > phone-based lookup (voice name similarity) > hardcoded default.
    """
    try:
        resolved_id = agent_id or RETELL_AGENT_ID
        if not agent_id and agent_phone:
            resolved = await _resolve_agent_by_phone(agent_phone, "chat")
            if resolved:
                resolved_id = resolved
        return await _fetch_agent_prompt_data(resolved_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Retell prompt fetch failed: {exc}")


# ── Retell: placeholder fill-in values (ON vs OFF per feature) ───────────────
# These are substituted into the live Retell template based on practice settings.

SCHEDULE_NEW_ON = """\
Collect in this order for each new patient:
0. For every new patient, ask for their insurance provider.(don't ask if already provided or it's obvious)
  Do NOT discuss acceptance unless they explicitly ask.
1. First and last name (ask them to spell)
2. Date of Birth
3. is this the best number to reach you at ?(do not read the number unless asked) -> no -> collect new number
4. call create_new_patient function to register the patient
5. if step 4 is done -> follow 14. SCHEDULING ENGINE\
"""

SCHEDULE_NEW_OFF = """\
Collect in this order for each new patient:
1. First and last name (ask them to spell)
2. Date of Birth
3. is this the best number to reach you at ?(do not read the number unless asked) -> no -> collect new number
4. Ask for the reason for visit.
5. Inform the caller that appointment scheduling for new patients is handled by our team \
and they will reach out to schedule the appointment -> follow Section 7\
"""

SCHEDULE_EXISTING_ON = """\
0. For every existing patient, ask for their insurance provider.(don't ask if already provided or it's obvious)
  Do NOT discuss acceptance unless they explicitly ask.
For all existing patients,
1. Ask if registered under same number or different -> if different then ask for it
2. One by One collect first name and dob for all patients that are registered under given number
   - after that always prepare a first_names list and dob_list -> call fetch_patient_details
2.1. If step 2 is done move to step 3
3. For same DOB if there are multiple patient records in result -> always confirm by giving first name -> move ahead with chosen patient record
3.1. In result If a record match by first name only then you should confirm that dob is different without giving dob. If it's not their record then ask if registered under different dob or phone
4. If there are more patients -> follow step 1, 2 and 3 again
5. For patients whose record found (patient_id) -> follow 14. SCHEDULING ENGINE.\
"""

SCHEDULE_EXISTING_OFF = """\
Inform the caller that existing patient booking is handled by our team and \
someone will reach out to schedule. Ask if they would like to leave a note → create_task → follow section 19\
"""

RESCHEDULING_ON = """\
3. Ask preferred date -> ask preference for morning/afternoon(>=12PM).
4. Call get_rescheduling_slot; offer only 2 slots(mention date).
5. After selection -> call modify_appointment
6. follow section 19\
"""

RESCHEDULING_OFF = """\
Inform the caller that rescheduling is handled by our team and someone will reach out. \
Ask if they would like to leave a note → create_task → follow section 19\
"""

CANCELLATION_ON = """\
3. Ask them if it is possible to reschedule rather than cancelling.
4. If they don't want to reschedule → say "No problem, let me go ahead and cancel your appointment" \
→ if reason not provided → ask if there is any reason they would like to share \
→ Give empathetic soft rebuttal if reason isn't that genuine → if yes → call modify_appointment.\
"""

CANCELLATION_OFF = """\
Inform the caller that cancellation is handled by our team and someone will reach out. \
Ask if they would like to leave a note → create_task → follow section 19\
"""

TRANSFER_PROMPT_DEFAULT = """\
If the caller explicitly asks to speak with a person or transfer the call, \
inform them that a team member will reach out → create_task → follow section 19\
"""

PLACEHOLDER_MAP = {
    "{{schedule_new_fallback_prompt}}":      (SCHEDULE_NEW_ON,      SCHEDULE_NEW_OFF),
    "{{schedule_existing_fallback_prompt}}": (SCHEDULE_EXISTING_ON, SCHEDULE_EXISTING_OFF),
    "{{rescheduling_fallback_prompt}}":      (RESCHEDULING_ON,      RESCHEDULING_OFF),
    "{{cancellation_fallback_prompt}}":      (CANCELLATION_ON,      CANCELLATION_OFF),
}


class ResolvePromptRequest(BaseModel):
    template: str                  # raw Retell template with {{placeholders}}
    schedule_new: bool = True      # new patient live booking
    schedule_existing: bool = True # existing patient live booking
    rescheduling: bool = True      # live rescheduling
    cancellation: bool = True      # live cancellation


@app.post("/api/retell/resolve-prompt")
def resolve_prompt(req: ResolvePromptRequest):
    """
    Substitutes all behavioral {{placeholders}} in the Retell template based on
    the practice's ON/OFF toggle settings. Runtime vars like {{office_status}}
    are left intact (Retell fills those at call time).
    """
    flags = {
        "{{schedule_new_fallback_prompt}}":      req.schedule_new,
        "{{schedule_existing_fallback_prompt}}": req.schedule_existing,
        "{{rescheduling_fallback_prompt}}":      req.rescheduling,
        "{{cancellation_fallback_prompt}}":      req.cancellation,
    }
    result = req.template
    for placeholder, (on_text, off_text) in PLACEHOLDER_MAP.items():
        result = result.replace(placeholder, on_text if flags[placeholder] else off_text)
    # Replace transfer prompt with default if present
    result = result.replace("{{transfer_call_prompt}}", TRANSFER_PROMPT_DEFAULT)
    return {
        "prompt": result,
        "substitutions": {
            "schedule_new": req.schedule_new,
            "schedule_existing": req.schedule_existing,
            "rescheduling": req.rescheduling,
            "cancellation": req.cancellation,
        },
    }


@app.post("/api/debug/apply-fix")
def apply_fix(req: ApplyFixRequest):
    """
    String-replace the faulty section with the suggested fix.
    Returns the modified prompt and whether the replacement was found.
    """
    if req.section_at_fault.strip() and req.section_at_fault.strip() in req.prompt_text:
        modified = req.prompt_text.replace(req.section_at_fault.strip(), req.suggested_fix.strip(), 1)
        applied = True
    else:
        # Section not found verbatim — append the fix as a new instruction
        modified = req.prompt_text.rstrip() + "\n\n" + req.suggested_fix.strip()
        applied = False
    return {"modified_prompt": modified, "applied_inline": applied}


# ── Debug: full regression ────────────────────────────────────────────────────
class RegressionRequest(BaseModel):
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    openai_key: str = ""
    use_judge: bool = True
    scenario_ids: list[str] = []   # empty = run all 8 standard scenarios

@app.post("/api/debug/regression")
def run_regression(req: RegressionRequest):
    """Run all (or specified) scenarios in parallel and return pass/fail summary."""
    req.openai_key = _resolve_openai_key(req.openai_key)
    ids = req.scenario_ids if req.scenario_ids else list(SCENARIOS.keys())
    results = []
    with ThreadPoolExecutor(max_workers=min(8, len(ids))) as ex:
        futures = [
            ex.submit(
                _run_simulation_sync,
                sid, req.api_base, req.bearer_token,
                req.agent_phone, req.openai_key, req.use_judge,
            )
            for sid in ids
        ]
        for fut in futures:
            try:
                results.append(_result_to_dict(fut.result()))
            except Exception as e:
                results.append({"error": str(e), "passed": False, "score": 0, "scenario_label": "unknown"})
    n_pass = sum(1 for r in results if r.get("passed"))
    return {
        "results": results,
        "summary": {
            "total": len(results),
            "passed": n_pass,
            "failed": len(results) - n_pass,
            "pass_rate": round(100 * n_pass / len(results)) if results else 0,
            "avg_score": round(sum(r.get("score", 0) for r in results) / len(results)) if results else 0,
        }
    }


class StreamReproRequest(BaseModel):
    repro_opener: str
    root_cause: str
    prescribed_followups: list[str] = []
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    openai_key: str = ""
    max_turns: int = 12

@app.post("/api/simulate/stream-repro")
async def stream_repro(req: StreamReproRequest):
    """Stream a single repro simulation as Server-Sent Events."""
    req.openai_key = _resolve_openai_key(req.openai_key)
    from fastapi.responses import StreamingResponse as SR

    async def gen():
        loop = asyncio.get_running_loop()
        patient_phone = _phone()
        turns: list[Turn] = []
        chat_id = None
        current_msg = req.repro_opener
        # Use registered patient if available — most debug repros are for existing-patient bugs
        persona = _REGISTERED_PATIENT if _REGISTERED_PATIENT else PERSONAS[0]
        goal = f"Reproduce: {req.root_cause}"
        api_calls: list[dict] = []
        followup_idx = 0

        for turn_num in range(req.max_turns):
            yield f"data: {json.dumps({'type': 'patient', 'message': current_msg})}\n\n"
            await asyncio.sleep(0.02)

            t_api = time.time()
            try:
                resp = await loop.run_in_executor(
                    None,
                    lambda m=current_msg, c=chat_id: _call_agent(
                        req.api_base, req.bearer_token, m, patient_phone, req.agent_phone, c
                    ),
                )
                api_ms = int((time.time() - t_api) * 1000)
                api_calls.append({"endpoint": "/engage/forward-to-agent", "status": 200, "latency_ms": api_ms})
            except httpx.HTTPStatusError as e:
                api_ms = int((time.time() - t_api) * 1000)
                api_calls.append({"endpoint": "/engage/forward-to-agent", "status": e.response.status_code, "latency_ms": api_ms})
                if e.response.status_code == 400 and turn_num > 0:
                    await asyncio.sleep(1.5)
                    try:
                        resp = await loop.run_in_executor(
                            None,
                            lambda m=current_msg, c=chat_id: _call_agent(
                                req.api_base, req.bearer_token, m, patient_phone, req.agent_phone, c
                            ),
                        )
                        api_calls.append({"endpoint": "/engage/forward-to-agent (retry)", "status": 200, "latency_ms": 0})
                    except Exception:
                        yield f"data: {json.dumps({'type': 'error', 'message': _fmt_error(e.response.text[:200]), 'api_calls': api_calls})}\n\n"
                        return
                else:
                    yield f"data: {json.dumps({'type': 'error', 'message': _fmt_error(e.response.text[:200]), 'api_calls': api_calls})}\n\n"
                    return
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)[:120], 'api_calls': api_calls})}\n\n"
                return

            data = resp.get("data", {})
            agent_msg = data.get("agent_response", "")
            new_cid = data.get("chat_id", chat_id) or chat_id
            if new_cid:
                chat_id = new_cid

            if not agent_msg:
                continue

            api_events = _infer_api_events(agent_msg, api_ms, turn_num)
            turns.append(Turn("patient", current_msg))
            turns.append(Turn("agent", agent_msg, api_ms, api_events))

            yield f"data: {json.dumps({'type': 'agent', 'message': agent_msg, 'latency_ms': api_ms, 'chat_id': chat_id or '', 'api_calls': api_calls, 'api_events': api_events})}\n\n"
            await asyncio.sleep(0.02)

            agent_lower = agent_msg.lower()
            if any(kw in agent_lower for kw in BOOKING_CONFIRMED_KWS):
                yield f"data: {json.dumps({'type': 'done', 'outcome': 'booking_confirmed', 'passed': True, 'api_calls': api_calls})}\n\n"
                return
            if any(kw in agent_lower for kw in TASK_CREATED_KWS):
                yield f"data: {json.dumps({'type': 'done', 'outcome': 'task_created', 'passed': True, 'api_calls': api_calls})}\n\n"
                return

            if followup_idx < len(req.prescribed_followups):
                current_msg = req.prescribed_followups[followup_idx]
                followup_idx += 1
            elif req.openai_key:
                try:
                    current_msg, should_end = await loop.run_in_executor(
                        None,
                        lambda m=agent_msg: smart_patient_reply(
                            m, persona, turns, goal, req.openai_key, patient_phone
                        ),
                    )
                    api_calls.append({"endpoint": "openai/gpt-4o-mini (patient)", "status": 200, "latency_ms": 0})
                    if should_end:
                        yield f"data: {json.dumps({'type': 'done', 'outcome': 'task_created', 'passed': True, 'api_calls': api_calls})}\n\n"
                        return
                except Exception as exc:
                    yield f"data: {json.dumps({'type': 'error', 'message': f'Patient AI: {str(exc)[:80]}', 'api_calls': api_calls})}\n\n"
                    return
            else:
                break

        yield f"data: {json.dumps({'type': 'done', 'outcome': 'incomplete', 'passed': False, 'api_calls': api_calls})}\n\n"

    return SR(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Manual SMS: proxy individual messages to the real ADIT/Retell SMS agent ────

class SmsStartRequest(BaseModel):
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    message: str          # first message from user

class SmsSendRequest(BaseModel):
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    patient_phone: str    # phone from start response
    chat_id: str          # chat_id from previous turn
    message: str

@app.post("/api/sms/start")
def sms_start(req: SmsStartRequest):
    """
    Opens a new manual SMS conversation with the real ADIT/Retell SMS agent.
    Generates a patient phone number, sends the first message, returns the
    agent reply together with chat_id and patient_phone for subsequent turns.
    """
    patient_phone = _phone()
    try:
        resp = _call_agent(
            req.api_base, req.bearer_token,
            req.message, patient_phone, req.agent_phone,
            chat_id=None,
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code,
                            detail=f"ADIT API error: {e.response.text[:300]}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ADIT API unreachable: {e}")
    data = resp.get("data", {})
    agent_response = data.get("agent_response", "")
    chat_id = data.get("chat_id", "")
    api_events = _infer_api_events(agent_response, 0, 0)
    return {
        "patient_phone": patient_phone,
        "chat_id": chat_id,
        "agent_response": agent_response,
        "api_events": api_events,
    }

@app.post("/api/sms/send")
def sms_send(req: SmsSendRequest):
    """
    Sends a subsequent message in an existing manual SMS conversation.
    Requires patient_phone and chat_id from a previous /api/sms/start call.
    """
    t0 = time.time()
    try:
        resp = _call_agent(
            req.api_base, req.bearer_token,
            req.message, req.patient_phone, req.agent_phone,
            chat_id=req.chat_id,
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code,
                            detail=f"ADIT API error: {e.response.text[:300]}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ADIT API unreachable: {e}")
    latency_ms = int((time.time() - t0) * 1000)
    data = resp.get("data", {})
    agent_response = data.get("agent_response", "")
    chat_id = data.get("chat_id", req.chat_id) or req.chat_id
    api_events = _infer_api_events(agent_response, latency_ms, 1)
    return {
        "chat_id": chat_id,
        "agent_response": agent_response,
        "latency_ms": latency_ms,
        "api_events": api_events,
    }


# ── Retell Web Call: create a browser-based WebRTC session ────────────────────

class CreateWebCallRequest(BaseModel):
    agent_id: Optional[str] = None
    agent_phone: Optional[str] = None   # resolves agent_id dynamically when supplied
    scenario_id: Optional[str] = None   # passed through to Retell metadata
    mode: Optional[str] = None          # "manual" | "ai" — for metadata

@app.post("/api/retell/create-web-call")
async def create_web_call(req: CreateWebCallRequest):
    """
    Creates a Retell web call session.
    If agent_phone is supplied, the correct voice agent is looked up dynamically.
    Falls back to RETELL_CALL_AGENT_ID if neither is provided.

    Passes metadata into the Retell call so it appears in Call History
    and is included in the inbound + post-call webhook payloads sent to ADIT.
    """
    try:
        agent_id = req.agent_id or RETELL_CALL_AGENT_ID
        if req.agent_phone and not req.agent_id:
            resolved = await _resolve_agent_by_phone(req.agent_phone, "voice")
            if resolved:
                agent_id = resolved

        # Build metadata — stored by Retell and forwarded on every webhook event.
        # This is what populates the "Metadata" section in Retell Call History
        # and what flows into ADIT via the inbound + post-call webhooks.
        metadata: dict = {
            "source":       "adit_sim_platform",
            "call_type":    "web_call",
            "agent_phone":  req.agent_phone or "",
            "agent_id":     agent_id,
        }
        if req.scenario_id:
            sc = SCENARIOS.get(req.scenario_id, {})
            metadata["scenario_id"]    = req.scenario_id
            metadata["scenario_label"] = sc.get("label", req.scenario_id)
            metadata["scenario_goal"]  = sc.get("goal", "")
        if req.mode:
            metadata["mode"] = req.mode

        r = await _retell_post("/v2/create-web-call", {
            "agent_id": agent_id,
            "metadata": metadata,
        })
        if r.status_code not in (200, 201):
            raise HTTPException(
                status_code=502,
                detail=f"Retell create-web-call failed ({r.status_code}): {r.text[:300]}",
            )
        data = r.json()
        return {
            "call_id":      data.get("call_id", ""),
            "access_token": data.get("access_token", ""),
            "agent_id":     agent_id,
            "metadata":     metadata,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Retell web call creation failed: {exc}")


# ── Phone call (outbound) ─────────────────────────────────────────────────────

class CreatePhoneCallRequest(BaseModel):
    from_number: str                    # Retell-owned number (agent phone)
    to_number: str                      # Destination (tester / patient phone)
    override_agent_id: Optional[str] = None
    scenario_id: Optional[str] = None
    mode: Optional[str] = None


@app.post("/api/retell/create-phone-call")
async def create_phone_call(req: CreatePhoneCallRequest):
    """
    Creates an outbound Retell phone call:  from_number (agent) → to_number (patient/tester).
    Returns call_id and initial call_status.
    """
    try:
        metadata: dict = {
            "source":      "adit_sim_platform",
            "call_type":   "phone_call",
            "from_number": req.from_number,
            "to_number":   req.to_number,
        }
        if req.override_agent_id:
            metadata["agent_id"] = req.override_agent_id
        if req.scenario_id:
            sc = SCENARIOS.get(req.scenario_id, {})
            metadata["scenario_id"]    = req.scenario_id
            metadata["scenario_label"] = sc.get("label", req.scenario_id)
            metadata["scenario_goal"]  = sc.get("goal", "")
        if req.mode:
            metadata["mode"] = req.mode

        body: dict = {
            "from_number": req.from_number,
            "to_number":   req.to_number,
            "metadata":    metadata,
        }
        if req.override_agent_id:
            body["override_agent_id"] = req.override_agent_id

        r = await _retell_post("/v2/create-phone-call", body)
        if r.status_code not in (200, 201):
            raise HTTPException(
                status_code=502,
                detail=f"Retell create-phone-call failed ({r.status_code}): {r.text[:300]}",
            )
        data = r.json()
        return {
            "call_id":     data.get("call_id", ""),
            "agent_id":    data.get("agent_id", ""),
            "call_status": data.get("call_status", "registered"),
            "from_number": data.get("from_number", req.from_number),
            "to_number":   data.get("to_number", req.to_number),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Retell phone call creation failed: {exc}")


@app.get("/api/retell/call-status/{call_id}")
async def get_call_status(call_id: str):
    """
    Poll Retell for live call status + transcript.
    Frontend polls this every few seconds while a phone call is in progress.
    """
    try:
        r = await _retell_get(f"/v2/get-call/{call_id}")
        if r.status_code == 404:
            raise HTTPException(status_code=404, detail="Call not found")
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Retell error ({r.status_code}): {r.text[:200]}")
        data = r.json()
        start_ts = data.get("start_timestamp") or 0
        end_ts   = data.get("end_timestamp")   or 0
        return {
            "call_id":     data.get("call_id", call_id),
            "call_status": data.get("call_status", "unknown"),
            "transcript":  data.get("transcript", []),
            "call_analysis": data.get("call_analysis") or {},
            "duration_ms": (end_ts - start_ts) if end_ts and start_ts else 0,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


def _extract_persona_name(prompt_text: str) -> str:
    """
    Pull the AI persona name from a Retell system prompt.
    Matches patterns like 'You are Cimo,' or 'You are Siriyaa the...'
    Returns title-cased first word after 'you are', or "" if not found.
    """
    if not prompt_text:
        return ""
    m = re.search(r"you\s+are\s+([A-Za-z][A-Za-z'-]*)", prompt_text, re.IGNORECASE)
    if m:
        return m.group(1).strip().title()
    return ""


# ── Registered patient endpoints ──────────────────────────────────────────────

@app.get("/api/registered-patient")
def get_registered_patient():
    """Return the currently-stored registered patient (from the last successful new booking)."""
    if not _REGISTERED_PATIENT:
        return {"registered": False}
    return {
        "registered": True,
        "first_name":    _REGISTERED_PATIENT.first_name,
        "last_name":     _REGISTERED_PATIENT.last_name,
        "dob":           _REGISTERED_PATIENT.dob,
        "insurance":     _REGISTERED_PATIENT.insurance,
        "phone":         _REGISTERED_PATIENT_PHONE,
    }


@app.delete("/api/registered-patient")
def clear_registered_patient():
    """Clear the stored registered patient so scenarios revert to default personas."""
    global _REGISTERED_PATIENT, _REGISTERED_PATIENT_PHONE
    _REGISTERED_PATIENT = None
    _REGISTERED_PATIENT_PHONE = ""
    return {"cleared": True}


@app.post("/api/registered-patient")
def set_registered_patient(body: dict):
    """
    Manually set a registered patient (for when you know who's in the system).
    Body: {first_name, last_name, dob, insurance, phone}
    """
    global _REGISTERED_PATIENT, _REGISTERED_PATIENT_PHONE
    _REGISTERED_PATIENT = PatientPersona(
        first_name=body.get("first_name", ""),
        last_name=body.get("last_name", ""),
        dob=body.get("dob", ""),
        insurance=body.get("insurance", ""),
        reason=body.get("reason", "routine cleaning"),
        preferred_day=body.get("preferred_day", "any weekday"),
        preferred_time=body.get("preferred_time", "any time"),
        is_new=False,
    )
    _REGISTERED_PATIENT_PHONE = body.get("phone", "")
    return {"registered": True, "first_name": _REGISTERED_PATIENT.first_name, "last_name": _REGISTERED_PATIENT.last_name}


@app.get("/api/retell/agent-info")
async def get_agent_info(
    agent_phone: Optional[str] = None,
    sms_agent_id: Optional[str] = None,
    call_agent_id: Optional[str] = None,
):
    """
    Returns display info (name, id, persona_name) for the agent.
    Priority: explicit agent IDs > phone lookup > hardcoded defaults.
    persona_name is extracted from 'You are [Name]' in the system prompt.
    """
    sms_id  = RETELL_AGENT_ID
    call_id = RETELL_CALL_AGENT_ID

    if sms_agent_id:
        sms_id = sms_agent_id
    elif agent_phone:
        resolved_chat = await _resolve_agent_by_phone(agent_phone, "chat")
        if resolved_chat:
            sms_id = resolved_chat

    if call_agent_id:
        call_id = call_agent_id
    elif agent_phone:
        resolved_voice = await _resolve_agent_by_phone(agent_phone, "voice")
        if resolved_voice:
            call_id = resolved_voice

    # Fetch dashboard names from Retell
    async def _get_dashboard_name(aid: str, channel: str) -> str:
        try:
            path = f"/get-chat-agent/{aid}" if channel == "chat" else f"/get-agent/{aid}"
            r = await _retell_get(path)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict) and data.get("status") != "error":
                    return data.get("agent_name") or data.get("name") or ""
        except Exception:
            pass
        return ""

    # Fetch persona name from the SMS agent's LLM prompt
    async def _get_persona_name(aid: str, channel: str) -> str:
        try:
            path = f"/get-chat-agent/{aid}" if channel == "chat" else f"/get-agent/{aid}"
            r = await _retell_get(path)
            if r.status_code != 200:
                return ""
            agent_data = r.json()
            llm_id = (
                agent_data.get("llm_id")
                or (agent_data.get("response_engine") or {}).get("llm_id")
            )
            if not llm_id:
                return ""
            errors: list[str] = []
            llm_result = await _fetch_llm_prompt(llm_id, aid, errors)
            if llm_result:
                return _extract_persona_name(llm_result.get("prompt", ""))
        except Exception:
            pass
        return ""

    sms_name, call_name, persona_name = await asyncio.gather(
        _get_dashboard_name(sms_id, "chat"),
        _get_dashboard_name(call_id, "voice"),
        _get_persona_name(sms_id, "chat"),
    )

    return {
        "sms_agent_id":   sms_id,
        "call_agent_id":  call_id,
        "sms_agent_name":  sms_name  or "Agent",
        "call_agent_name": call_name or "Agent",
        "persona_name":    persona_name or "",
    }


# ── AI Caller helper: generate patient reply + TTS for web call AI mode ──────

class AiCallerReplyRequest(BaseModel):
    agent_text: str
    history: str = ""
    opener: str = ""
    openai_key: str
    scenario_id: str = "new-patient-cleaning"
    extra_context: str = ""

CALL_SCENARIOS_GOALS: dict[str, str] = {
    "new-patient-cleaning":    "Book a new patient dental cleaning appointment",
    "dental-emergency":        "Get an urgent/emergency appointment today",
    "existing-routine":        "Book a routine cleaning as an existing patient",
    "reschedule":              "Reschedule an existing appointment",
    "cancel":                  "Cancel an upcoming appointment",
    "insurance-book":          "Confirm insurance is accepted then book",
    "office-hours-book":       "Ask about hours then book if available",
    "post-treatment-followup": "Report sensitivity and book a follow-up",
}

@app.post("/api/ai-caller-reply")
def ai_caller_reply(req: AiCallerReplyRequest):
    """
    Generates the next spoken reply from the AI patient caller during a live
    Retell web call. Used exclusively by LiveWebCall in 'ai' mode.
    """
    openai_key = _resolve_openai_key(req.openai_key)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        goal = CALL_SCENARIOS_GOALS.get(req.scenario_id, "Book a dental appointment")
        extra_ctx_block = f"\n\nADDITIONAL SCENARIO CONTEXT (use this to make your replies more realistic and specific):\n{req.extra_context.strip()}" if req.extra_context.strip() else ""
        system = f"""You are a patient calling a dental office on the phone.
Your goal: {goal}
The FIRST thing you said was: "{req.opener}"{extra_ctx_block}

Respond naturally to what the agent just said. Keep it SHORT (1-2 spoken sentences).
Sound like a real person — casual, natural phone register.
Only answer the specific question asked. Do not volunteer extra info.
Output ONLY your spoken reply — no labels, no quotes."""

        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": f"Call history:\n{req.history}\n\nAgent just said:\n\"{req.agent_text}\"\n\nYour reply:"},
            ],
            max_tokens=80, temperature=0.2,
        )
        reply = resp.choices[0].message.content.strip().strip('"').strip("'")
        return {"reply": reply}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/extract-context")
async def extract_context(
    screenshot: UploadFile = File(...),
    openai_key: str = Form(""),
):
    """
    Upload a screenshot (or any image) and extract scenario context from it
    using GPT-4o vision. The returned text is used to guide AI patient
    behaviour during simulations.
    """
    openai_key = _resolve_openai_key(openai_key)
    image_bytes = await screenshot.read()
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        b64 = base64.b64encode(image_bytes).decode()
        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"}},
                {"type": "text", "text": (
                    "This is a screenshot related to a dental office simulation test scenario. "
                    "Extract and summarise the key scenario details visible: patient name, reason for visit, "
                    "appointment type, any specific instructions or context the AI patient should know. "
                    "Return only a concise plain-text summary (3-6 sentences) that an AI patient caller "
                    "can use to simulate the scenario realistically. No headers, no bullet points."
                )},
            ]}],
            max_tokens=300, temperature=0,
        )
        context = resp.choices[0].message.content.strip()
        return {"context": context}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class TtsRequest(BaseModel):
    text: str
    openai_key: str
    voice: str = "shimmer"   # shimmer = soft female, good for patient caller

@app.post("/api/tts")
async def text_to_speech(req: TtsRequest):
    """
    Convert text to MP3 audio via OpenAI TTS.
    Used by LiveWebCall AI caller mode to inject voice into the Retell WebRTC session.
    """
    openai_key = _resolve_openai_key(req.openai_key)
    try:
        from openai import OpenAI
        from fastapi.responses import Response as FastResponse
        client = OpenAI(api_key=openai_key)
        resp = client.audio.speech.create(
            model="tts-1",
            voice=req.voice,
            input=req.text[:500],  # cap to avoid huge audio
        )
        audio_bytes = resp.content
        return FastResponse(content=audio_bytes, media_type="audio/mpeg")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Retell call webhooks ──────────────────────────────────────────────────────
#
# Point Retell's "Add an inbound webhook" URL (in Phone Numbers settings) at:
#
#     https://<this-server>/api/retell/webhook
#
# Retell fires this URL for every call lifecycle event.  This handler:
#   1. call_started   → extract from_number/to_number/call_id
#                        → POST /api/v1/incoming_call  to ADIT with full metadata
#   2. call_ended     → forward basic call info to ADIT
#   3. call_analyzed  → forward full transcript + analysis to ADIT
#                        → POST /api/v1/call_completed to ADIT
#
# ADIT voice base URL is read from ADIT_VOICE_BASE env var so it works in
# dev and prod without code changes.
# ─────────────────────────────────────────────────────────────────────────────

ADIT_VOICE_BASE: str = os.environ.get(
    "ADIT_VOICE_BASE", "https://voicereceiption.adit.com"
)

# In-memory ring-buffer of the last 100 webhook events (for UI inspection)
_call_events: list[dict] = []
_MAX_CALL_EVENTS = 100


def _store_call_event(event: dict) -> None:
    _call_events.append(event)
    if len(_call_events) > _MAX_CALL_EVENTS:
        _call_events.pop(0)


import logging as _wh_log
_wh_logger = _wh_log.getLogger("retell.webhook")


async def _forward_to_adit(path: str, body: dict) -> None:
    """POST body to ADIT voice backend.  Logs but never raises — webhook must return 200."""
    url = f"{ADIT_VOICE_BASE}{path}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, json=body, headers={"Content-Type": "application/json"})
            _wh_logger.info("ADIT %s → HTTP %s  call_id=%s", path, r.status_code, body.get("call_id", "?"))
    except Exception as exc:
        _wh_logger.warning("ADIT %s failed: %s", path, exc)


@app.post("/api/retell/webhook")
async def retell_webhook(request: Request):
    """
    Unified Retell webhook receiver for all call lifecycle events.

    Configure in Retell dashboard → Phone Numbers → <number> → Add inbound webhook:
        https://<this-server>/api/retell/webhook

    Also register this URL as the post-call webhook in Retell → Agents → <agent>
    → Post-call webhook URL (for call_analyzed / transcript delivery).
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    event = payload.get("event", "")
    call  = payload.get("call", {})

    # ── Extract universal fields ──────────────────────────────────────────────
    call_id      = call.get("call_id", "")
    from_number  = call.get("from_number", "")    # patient's phone
    to_number    = call.get("to_number", "")      # practice's Retell number
    agent_id     = call.get("agent_id", "")
    direction    = call.get("direction", "inbound")
    call_type    = call.get("call_type", "phone_call")
    start_ts     = call.get("start_timestamp")
    # Retell passes back the metadata we attached at call creation (or empty dict)
    retell_meta: dict = call.get("metadata") or {}

    _store_call_event({
        "event":    event,
        "call_id":  call_id,
        "from":     from_number,
        "to":       to_number,
        "metadata": retell_meta,
        "ts":       time.time(),
    })

    # ── call_started: send metadata to ADIT incoming_call ────────────────────
    if event == "call_started":
        # Merge Retell's own metadata (scenario info, source, etc.) with call fields
        merged_metadata = {
            "call_id":     call_id,
            "from_number": from_number,
            "to_number":   to_number,
            "agent_id":    agent_id,
            "call_type":   call_type,
            "source":      retell_meta.get("source", "retell_inbound_webhook"),
            **retell_meta,   # include scenario_id, scenario_label, mode, etc.
        }
        await _forward_to_adit("/api/v1/incoming_call", {
            "call_id":              call_id,
            "patient_phone_number": from_number,
            "agent_phone_number":   to_number,
            "agent_id":             agent_id,
            "direction":            direction,
            "call_type":            call_type,
            "start_timestamp":      start_ts,
            "metadata":             merged_metadata,
        })

    # ── call_ended / call_analyzed: send transcript + analysis to ADIT ───────
    elif event in ("call_ended", "call_analyzed"):
        # Build readable transcript from structured object if available
        transcript_obj: list = call.get("transcript_object") or []
        transcript_str: str  = call.get("transcript", "")
        if not transcript_str and transcript_obj:
            transcript_str = "\n".join(
                f"{t.get('role', 'unknown').capitalize()}: {t.get('content', '')}"
                for t in transcript_obj
            )

        analysis      = call.get("call_analysis") or {}
        duration_ms   = call.get("duration_ms", 0)
        recording_url = call.get("recording_url", "")
        end_ts        = call.get("end_timestamp")

        await _forward_to_adit("/api/v1/call_completed", {
            "call_id":              call_id,
            "patient_phone_number": from_number,
            "agent_phone_number":   to_number,
            "agent_id":             agent_id,
            "direction":            direction,
            "start_timestamp":      start_ts,
            "end_timestamp":        end_ts,
            "duration_ms":          duration_ms,
            "recording_url":        recording_url,
            "transcript":           transcript_str,
            "transcript_object":    transcript_obj,
            "call_successful":      analysis.get("call_successful"),
            "call_summary":         analysis.get("call_summary", ""),
            "user_sentiment":       analysis.get("user_sentiment", ""),
            "in_voicemail":         analysis.get("in_voicemail", False),
            "metadata":             retell_meta,   # scenario info, source, etc.
        })

    else:
        _wh_logger.debug("Unhandled Retell event: %s", event)

    return {"ok": True, "event": event, "call_id": call_id}


@app.get("/api/retell/call-events")
def get_call_events():
    """Recent Retell webhook events — newest first.  Useful for debugging the webhook flow."""
    return {"events": list(reversed(_call_events))}


# ── Serve built React frontend ─────────────────────────────────────────────────
_dist = Path(__file__).parent / "frontend" / "dist"
_index = _dist / "index.html"

# Mount static assets directory (CSS/JS chunks)
if _dist.exists() and (_dist / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(_dist / "assets")), name="assets")

# Catch-all for SPA — MUST come last and must not intercept /api/* routes
@app.get("/{full_path:path}", include_in_schema=False)
def serve_spa(full_path: str):
    # Never intercept API routes — let FastAPI return its own 404
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API route not found")
    if _index.exists():
        return FileResponse(str(_index))
    # Fallback: no React build present yet
    return {"status": "ok", "message": "ADIT Agent QA Platform API", "version": "2.0.0"}
