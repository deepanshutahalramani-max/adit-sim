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
import string
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
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

# ── Data classes ──────────────────────────────────────────────────────────────
@dataclass
class Turn:
    role: str
    message: str
    latency_ms: int = 0

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

# ── Pydantic request/response models ──────────────────────────────────────────
class SimRequest(BaseModel):
    scenario_id: str
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    openai_key: str = ""
    use_judge: bool = True
    reuse_phone: Optional[str] = None

class ParallelSimRequest(BaseModel):
    scenario_ids: list[str]
    repeats: int = 1
    max_parallel: int = 5
    api_base: str = "https://frontdeskchatagent.adit.com"
    bearer_token: str
    agent_phone: str = DEFAULT_AGENT_PHONE
    openai_key: str = ""
    use_judge: bool = True

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

def smart_patient_reply(agent_msg, persona, history, goal, oai_key, patient_phone=""):
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
        system_prompt = f"""You are a real person texting a dental office AI receptionist via SMS.

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
                    "You are a QA evaluator for a dental front-desk AI SMS agent called Siriyaa.\n"
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
) -> SimResult:
    config = SCENARIOS.get(scenario_id)
    if not config:
        raise ValueError(f"Unknown scenario: {scenario_id}")
    persona = PERSONAS[config["persona_idx"]]
    patient_phone = reuse_phone or _phone()
    turns: list[Turn] = []
    chat_id: Optional[str] = None
    t_start = time.time()
    passed = False
    failure_reason = ""
    outcome_type = "incomplete"
    current_msg = config["opener"]

    for turn_num in range(MAX_TURNS):
        t_turn = time.time()
        try:
            resp = _call_agent(api_base, token, current_msg, patient_phone, agent_phone, chat_id)
        except httpx.HTTPStatusError as e:
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
                    current_msg, should_end = smart_patient_reply(last_agent, persona, turns, config["goal"], oai_key, patient_phone)
                    if should_end:
                        passed = True
                        outcome_type = "task_created" if any(kw in last_agent.lower() for kw in TASK_CREATED_KWS) else "booking_confirmed"
                        break
                    continue
                except Exception:
                    pass
            continue

        turns.append(Turn("patient", current_msg))
        turns.append(Turn("agent", agent_msg, latency_ms))
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
            current_msg, should_end = smart_patient_reply(agent_msg, persona, turns, config["goal"], oai_key, patient_phone)
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
    if not failure_reason and not passed:
        failure_reason = judge_reason

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
    )

def _result_to_dict(r: SimResult) -> dict:
    d = asdict(r)
    d["turns"] = [{"role": t["role"], "message": t["message"], "latency_ms": t["latency_ms"]} for t in d["turns"]]
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
    try:
        result = _run_simulation_sync(
            req.scenario_id, req.api_base, req.bearer_token,
            req.agent_phone, req.openai_key, req.use_judge, req.reuse_phone,
        )
        return _result_to_dict(result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/simulate/parallel")
def simulate_parallel(req: ParallelSimRequest):
    tasks = [(sid, i) for sid in req.scenario_ids for i in range(req.repeats)]
    results = []
    with ThreadPoolExecutor(max_workers=min(req.max_parallel, MAX_PARALLEL)) as ex:
        futures = [
            ex.submit(
                _run_simulation_sync,
                sid, req.api_base, req.bearer_token,
                req.agent_phone, req.openai_key, req.use_judge,
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
    phone = _phone()
    chain = {}
    for scenario_id in ["new-patient-cleaning", "reschedule", "cancel"]:
        result = _run_simulation_sync(
            scenario_id, req.api_base, req.bearer_token,
            req.agent_phone, req.openai_key, reuse_phone=phone,
        )
        chain[scenario_id] = _result_to_dict(result)
    return chain

@app.post("/api/debug/analyze")
async def debug_analyze(
    screenshot: UploadFile = File(...),
    system_prompt: str = Form(""),
    extra_context: str = Form(""),
    openai_key: str = Form(...),
):
    if not openai_key:
        raise HTTPException(status_code=400, detail="OpenAI API key required")
    image_bytes = await screenshot.read()
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        b64 = base64.b64encode(image_bytes).decode()
        prompt_block = f"\n\nSYSTEM PROMPT (full Retell agent prompt):\n```\n{system_prompt}\n```" if system_prompt.strip() else ""
        context_block = f"\n\nADDITIONAL CONTEXT FROM TESTER: {extra_context}" if extra_context.strip() else ""

        analysis_prompt = f"""You are a senior QA engineer debugging Siriyaa, an AI dental front-desk SMS receptionist.

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
    if not req.openai_key:
        raise HTTPException(status_code=400, detail="OpenAI API key required")
    try:
        from openai import OpenAI
        client = OpenAI(api_key=req.openai_key)
        prompt_block = f"\n\nSYSTEM PROMPT (full Retell agent prompt):\n```\n{req.system_prompt}\n```" if req.system_prompt.strip() else ""
        context_block = f"\n\nADDITIONAL CONTEXT FROM TESTER: {req.extra_context}" if req.extra_context.strip() else ""

        analysis_prompt = f"""You are a senior QA engineer debugging Siriyaa, an AI dental front-desk SMS receptionist.

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
    if not req.openai_key:
        raise HTTPException(status_code=400, detail="OpenAI key required")
    try:
        from openai import OpenAI
        client = OpenAI(api_key=req.openai_key)
        prompt_ctx = f"\n\nSystem Prompt:\n```\n{req.system_prompt}\n```" if req.system_prompt.strip() else ""
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": (
                    "You are a QA evaluator for Siriyaa, an AI dental front desk agent.\n"
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
    if not req.openai_key:
        raise HTTPException(status_code=400, detail="OpenAI key required")
    try:
        from openai import OpenAI
        client = OpenAI(api_key=req.openai_key)
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
