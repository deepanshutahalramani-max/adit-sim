"""
Real Phone mode — Twilio-driven REAL calls and SMS to the practice number.
============================================================================
Unlike the API simulation mode (which calls ADIT's forward-to-agent directly
and therefore never appears in the ADIT app), this mode exercises the TRUE
patient path: a real phone number calls/texts the practice number, ADIT
receives a genuine inbound event, registers the conversation in the app,
and engages the AI agent.

The SMS Agent engages in three ways (per product behaviour):
  1. missed_call      — call the practice, cancel while ringing → AI sends follow-up SMS
  2. incomplete_call  — call the practice, AI answers, hang up mid-call → AI sends follow-up SMS
  3. inbound_sms      — text the practice directly (only engages if no chat in last 24h)
Plus the voice channel:
  4. inbound_call     — call the practice, AI Front Desk answers, full VOICE
                        conversation (Twilio speech-to-text → LLM patient → TTS)

Configuration (Railway env vars):
  TWILIO_ACCOUNT_SID   — Twilio account SID
  TWILIO_AUTH_TOKEN    — Twilio auth token
  TWILIO_NUMBERS       — comma-separated E.164 numbers owned in Twilio,
                         rotated to dodge the 24-hour inbound-SMS cooldown
  PUBLIC_BASE_URL      — public URL of this app (webhook callbacks),
                         default https://adit-sim-production-1b80.up.railway.app
  PRACTICE_NUMBER_BETA — default practice number for BETA (+18324768799)
  PRACTICE_NUMBER_PROD — default practice number for PROD (unset until known)
"""
from __future__ import annotations

import os
import random
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Optional
from xml.sax.saxutils import escape as xml_escape

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()

# ── Configuration ─────────────────────────────────────────────────────────────
# Secrets come from Railway env vars only (GitHub push protection rejects them in code).
TWILIO_SID    = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN  = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_NUMBERS = [n.strip() for n in os.environ.get(
    "TWILIO_NUMBERS",
    "+18326886475,+18327725892,+18392743350,+19314652485",
).split(",") if n.strip()]
PUBLIC_BASE   = os.environ.get("PUBLIC_BASE_URL", "https://adit-sim-production-1b80.up.railway.app").rstrip("/")
PRACTICE_NUMBERS = {
    "beta": os.environ.get("PRACTICE_NUMBER_BETA", "+18324768799"),
    "prod": os.environ.get("PRACTICE_NUMBER_PROD", ""),
}
_TW_BASE = "https://api.twilio.com/2010-04-01"

MAX_SMS_TURNS     = 16    # safety cap on auto-replies per session
INCOMPLETE_HOLD_S = 12    # seconds of silence before hanging up an incomplete call
MISSED_CANCEL_S   = 4     # seconds of ringing before cancelling a missed call
COOLDOWN_S        = 24 * 3600
FOLLOWUP_SMS_TIMEOUT_S = 4 * 60   # fail if AI never texts back after a call trigger
CONVO_IDLE_TIMEOUT_S   = 6 * 60   # fail if mid-conversation goes silent this long


def _twilio_configured() -> bool:
    return bool(TWILIO_SID and TWILIO_TOKEN and TWILIO_NUMBERS)


def _require_twilio() -> None:
    if not _twilio_configured():
        raise HTTPException(
            status_code=503,
            detail="Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_NUMBERS in Railway.",
        )


def _tw_post(path: str, data: dict, timeout: int = 20) -> dict:
    r = httpx.post(f"{_TW_BASE}/Accounts/{TWILIO_SID}{path}", data=data,
                   auth=(TWILIO_SID, TWILIO_TOKEN), timeout=timeout)
    r.raise_for_status()
    return r.json()


def _tw_get(path: str, params: dict | None = None, timeout: int = 15) -> dict:
    r = httpx.get(f"{_TW_BASE}/Accounts/{TWILIO_SID}{path}", params=params or {},
                  auth=(TWILIO_SID, TWILIO_TOKEN), timeout=timeout)
    r.raise_for_status()
    return r.json()


def _tw_send_sms(from_number: str, to_number: str, body: str) -> dict:
    return _tw_post("/Messages.json", {
        "From": from_number, "To": to_number, "Body": body,
        "StatusCallback": f"{PUBLIC_BASE}/api/twilio/sms-status",
    })


# ── Session registry ──────────────────────────────────────────────────────────

@dataclass
class RealTurn:
    role: str               # "patient" | "agent" | "system"
    message: str
    channel: str = "sms"    # "sms" | "voice"
    ts: float = field(default_factory=time.time)


@dataclass
class RealSession:
    session_id: str
    trigger_type: str            # missed_call | incomplete_call | inbound_sms | inbound_call
    patient_number: str          # our Twilio number acting as the patient
    practice_number: str
    scenario_id: str
    goal: str
    persona_idx: int
    scenario_label: str = ""
    status: str = "starting"     # starting | calling | waiting_for_sms | in_conversation | completed | failed
    outcome: str = ""            # booking_confirmed | task_created | incomplete | error
    call_sid: str = ""
    call_status: str = ""        # Twilio call status as observed
    turns: list = field(default_factory=list)
    events: list = field(default_factory=list)   # timeline of system events
    score: int = 0               # LLM judge score (0-100), filled on completion
    judge_reason: str = ""
    suite_id: str = ""           # set when launched as part of a suite run
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def log(self, msg: str) -> None:
        self.events.append({"ts": time.time(), "msg": msg})
        self.updated_at = time.time()


REAL_SESSIONS: dict[str, RealSession] = {}
_SESSIONS_LOCK = threading.Lock()

# 24h cooldown tracker: (patient_number, practice_number) → last conversation ts
_COOLDOWNS: dict[tuple[str, str], float] = {}


def _cooldown_remaining(patient: str, practice: str) -> int:
    last = _COOLDOWNS.get((patient, practice), 0)
    rem = int(COOLDOWN_S - (time.time() - last))
    return max(0, rem)


def _mark_cooldown(patient: str, practice: str) -> None:
    _COOLDOWNS[(patient, practice)] = time.time()


def _pick_patient_number(practice: str, requested: str = "") -> str:
    """Pick the Twilio number with no recent conversation against this practice."""
    if requested:
        return requested
    best, best_rem = None, None
    for n in TWILIO_NUMBERS:
        rem = _cooldown_remaining(n, practice)
        if rem == 0:
            return n
        if best_rem is None or rem < best_rem:
            best, best_rem = n, rem
    return best or (TWILIO_NUMBERS[0] if TWILIO_NUMBERS else "")


def _active_session_for(patient_number: str) -> Optional[RealSession]:
    """Most recent non-terminal session bound to this Twilio number."""
    candidates = [
        s for s in REAL_SESSIONS.values()
        if s.patient_number == patient_number and s.status not in ("completed", "failed")
    ]
    return max(candidates, key=lambda s: s.created_at) if candidates else None


def _session_dict(s: RealSession) -> dict:
    d = asdict(s)
    d["cooldown_remaining_s"] = _cooldown_remaining(s.patient_number, s.practice_number)
    return d


# ── Lazy access to the main app's simulation brain (avoids circular import) ──

def _sim():
    import server
    return server


def _resolve_scenario(scenario_id: str) -> dict:
    srv = _sim()
    cfg = srv.SCENARIOS.get(scenario_id)
    if not cfg:
        raise HTTPException(status_code=400, detail=f"Unknown scenario: {scenario_id}")
    return cfg


def _patient_reply(session: RealSession, agent_msg: str) -> tuple[str, bool]:
    """Generate the next patient message via the same brain as API simulations."""
    srv = _sim()
    persona = srv.PERSONAS[session.persona_idx % len(srv.PERSONAS)]
    history = [srv.Turn(t.role, t.message) for t in session.turns if t.role in ("patient", "agent")]
    oai_key = srv._resolve_openai_key("")
    return srv.smart_patient_reply(
        agent_msg, persona, history, session.goal, oai_key,
        patient_phone=session.patient_number,
    )


def _judge_session(session: RealSession) -> None:
    """Score the finished conversation with the same LLM judge as API simulations."""
    try:
        srv = _sim()
        turns = [srv.Turn(t.role, t.message) for t in session.turns if t.role in ("patient", "agent")]
        if not turns:
            return
        oai_key = srv._resolve_openai_key("")
        score, reason = srv._llm_judge(session.scenario_label or session.scenario_id, turns, oai_key)
        session.score, session.judge_reason = score, reason
        session.log(f"Judge score: {score}")
    except Exception as exc:
        session.log(f"Judge failed: {exc}")


def _finish(session: RealSession, status: str, outcome: str, note: str = "") -> None:
    """Terminal-state transition: mark cooldown and kick off async judging."""
    session.status, session.outcome = status, outcome
    if note:
        session.log(note)
    _mark_cooldown(session.patient_number, session.practice_number)
    threading.Thread(target=_judge_session, args=(session,), daemon=True).start()


def _check_completion(session: RealSession, agent_msg: str) -> bool:
    """Detect terminal success in the agent's message; mark the session if found."""
    srv = _sim()
    low = agent_msg.lower()
    if any(kw in low for kw in srv.BOOKING_CONFIRMED_KWS):
        _finish(session, "completed", "booking_confirmed", "Goal reached: booking_confirmed")
    elif any(kw in low for kw in srv.TASK_CREATED_KWS):
        _finish(session, "completed", "task_created", "Goal reached: task_created")
    else:
        return False
    return True


# ── Watchdog: timeout detection (no follow-up SMS / dead conversation) ───────

def _watchdog_loop() -> None:
    while True:
        time.sleep(20)
        now = time.time()
        for s in list(REAL_SESSIONS.values()):
            try:
                if s.status == "waiting_for_sms" and now - s.updated_at > FOLLOWUP_SMS_TIMEOUT_S:
                    _finish(s, "failed", "error",
                            f"No AI follow-up SMS within {FOLLOWUP_SMS_TIMEOUT_S // 60} min of the "
                            f"{s.trigger_type.replace('_', ' ')} — agent did not engage")
                elif s.status == "in_conversation" and now - s.updated_at > CONVO_IDLE_TIMEOUT_S:
                    _finish(s, "failed", "incomplete",
                            f"Conversation went silent for {CONVO_IDLE_TIMEOUT_S // 60} min — timing out")
            except Exception:
                pass


_watchdog_started = False


def _ensure_watchdog() -> None:
    global _watchdog_started
    if not _watchdog_started:
        _watchdog_started = True
        threading.Thread(target=_watchdog_loop, daemon=True).start()


# ── Call orchestration (background threads) ───────────────────────────────────

def _run_missed_call(session: RealSession) -> None:
    """Place a call and cancel it while still ringing → missed call at the practice."""
    try:
        call = _tw_post("/Calls.json", {
            "From": session.patient_number,
            "To": session.practice_number,
            # TwiML only matters if the call is somehow answered before we cancel
            "Twiml": "<Response><Pause length='2'/><Hangup/></Response>",
            "StatusCallback": f"{PUBLIC_BASE}/api/twilio/call-status?session_id={session.session_id}",
            "StatusCallbackEvent": "initiated ringing answered completed",
        })
        session.call_sid = call.get("sid", "")
        session.status = "calling"
        session.log(f"Call placed (sid={session.call_sid}), cancelling after ~{MISSED_CANCEL_S}s of ringing")

        deadline = time.time() + 30
        rang = False
        while time.time() < deadline:
            time.sleep(1)
            st = _tw_get(f"/Calls/{session.call_sid}.json").get("status", "")
            session.call_status = st
            if st == "ringing" and not rang:
                rang = True
                time.sleep(MISSED_CANCEL_S)
                _tw_post(f"/Calls/{session.call_sid}.json", {"Status": "canceled"})
                session.log("Cancelled while ringing → missed call created")
                break
            if st == "in-progress":
                # AI answered before we could cancel — hang up immediately (very short incomplete call)
                _tw_post(f"/Calls/{session.call_sid}.json", {"Status": "completed"})
                session.log("Agent answered before cancel — hung up immediately (registered as incomplete call)")
                break
            if st in ("completed", "busy", "failed", "no-answer", "canceled"):
                session.log(f"Call ended with status: {st}")
                break

        session.status = "waiting_for_sms"
        session.log("Waiting for the AI follow-up SMS…")
    except Exception as exc:
        session.status, session.error = "failed", f"Missed-call error: {exc}"
        session.log(session.error)


def _run_incomplete_call(session: RealSession) -> None:
    """Place a call, let the AI answer, stay silent, hang up mid-call → incomplete call."""
    try:
        call = _tw_post("/Calls.json", {
            "From": session.patient_number,
            "To": session.practice_number,
            "Twiml": f"<Response><Pause length='{INCOMPLETE_HOLD_S}'/><Hangup/></Response>",
            "StatusCallback": f"{PUBLIC_BASE}/api/twilio/call-status?session_id={session.session_id}",
            "StatusCallbackEvent": "initiated ringing answered completed",
        })
        session.call_sid = call.get("sid", "")
        session.status = "calling"
        session.log(f"Call placed (sid={session.call_sid}); will hold {INCOMPLETE_HOLD_S}s after answer then hang up")

        deadline = time.time() + 90
        while time.time() < deadline:
            time.sleep(2)
            st = _tw_get(f"/Calls/{session.call_sid}.json").get("status", "")
            session.call_status = st
            if st in ("completed", "busy", "failed", "no-answer", "canceled"):
                session.log(f"Call finished: {st} → incomplete call registered")
                break

        session.status = "waiting_for_sms"
        session.log("Waiting for the AI follow-up SMS…")
    except Exception as exc:
        session.status, session.error = "failed", f"Incomplete-call error: {exc}"
        session.log(session.error)


def _run_inbound_call(session: RealSession) -> None:
    """Place a call and hold a full voice conversation via Gather/Say webhooks."""
    try:
        twiml_url = f"{PUBLIC_BASE}/api/twilio/voice-answer?session_id={session.session_id}"
        call = _tw_post("/Calls.json", {
            "From": session.patient_number,
            "To": session.practice_number,
            "Url": twiml_url,
            "StatusCallback": f"{PUBLIC_BASE}/api/twilio/call-status?session_id={session.session_id}",
            "StatusCallbackEvent": "initiated ringing answered completed",
            "Timeout": "30",
        })
        session.call_sid = call.get("sid", "")
        session.status = "calling"
        session.log(f"Voice call placed (sid={session.call_sid}) — conversation driven by webhooks")
    except Exception as exc:
        session.status, session.error = "failed", f"Inbound-call error: {exc}"
        session.log(session.error)


# ── API: config / trigger / sessions ─────────────────────────────────────────

@router.get("/api/real/config")
def real_config():
    """Expose Real Phone mode configuration state (no secrets)."""
    return {
        "configured": _twilio_configured(),
        "patient_numbers": [
            {"number": n,
             "cooldowns": {env: _cooldown_remaining(n, p) for env, p in PRACTICE_NUMBERS.items() if p}}
            for n in TWILIO_NUMBERS
        ],
        "practice_numbers": {k: v for k, v in PRACTICE_NUMBERS.items() if v},
        "webhook_base": PUBLIC_BASE,
        "trigger_types": ["missed_call", "incomplete_call", "inbound_sms", "inbound_call"],
    }


class RealTriggerRequest(BaseModel):
    trigger_type: str                     # missed_call | incomplete_call | inbound_sms | inbound_call
    practice_number: str = ""             # E.164; default resolved from env param
    env: str = "beta"                     # beta | prod — used when practice_number empty
    scenario_id: str = "new-patient-cleaning"
    patient_number: str = ""              # optional explicit Twilio number
    opener: str = ""                      # optional custom first SMS (inbound_sms only)


def _start_session(trigger_type: str, practice: str, scenario_id: str,
                   patient_number: str = "", opener: str = "", suite_id: str = "") -> RealSession:
    """Create and launch a real-phone session. Shared by the trigger endpoint and the suite runner."""
    _ensure_watchdog()
    cfg = _resolve_scenario(scenario_id)
    patient = _pick_patient_number(practice, patient_number)
    if not patient:
        raise HTTPException(status_code=503, detail="No Twilio patient numbers available.")

    session = RealSession(
        session_id=uuid.uuid4().hex[:12],
        trigger_type=trigger_type,
        patient_number=patient,
        practice_number=practice,
        scenario_id=scenario_id,
        goal=cfg["goal"],
        persona_idx=cfg.get("persona_idx", 0),
        scenario_label=cfg.get("label", scenario_id),
        suite_id=suite_id,
    )
    with _SESSIONS_LOCK:
        REAL_SESSIONS[session.session_id] = session

    if trigger_type == "inbound_sms":
        cooldown = _cooldown_remaining(patient, practice)
        if cooldown > 0:
            session.log(f"WARNING: {patient} is in 24h cooldown with {practice} "
                        f"for another {cooldown}s — AI may not reply")
        msg = opener or cfg["opener"]
        try:
            _tw_send_sms(patient, practice, msg)
            session.turns.append(RealTurn("patient", msg, "sms"))
            session.status = "in_conversation"
            session.log(f"Opener SMS sent from {patient}")
        except Exception as exc:
            session.status, session.error = "failed", f"SMS send error: {exc}"
            session.log(session.error)
    elif trigger_type == "missed_call":
        threading.Thread(target=_run_missed_call, args=(session,), daemon=True).start()
    elif trigger_type == "incomplete_call":
        threading.Thread(target=_run_incomplete_call, args=(session,), daemon=True).start()
    elif trigger_type == "inbound_call":
        threading.Thread(target=_run_inbound_call, args=(session,), daemon=True).start()

    return session


@router.post("/api/real/trigger")
def real_trigger(req: RealTriggerRequest):
    _require_twilio()
    if req.trigger_type not in ("missed_call", "incomplete_call", "inbound_sms", "inbound_call"):
        raise HTTPException(status_code=400, detail=f"Unknown trigger_type: {req.trigger_type}")

    practice = (req.practice_number or PRACTICE_NUMBERS.get(req.env, "")).strip()
    if not practice:
        raise HTTPException(status_code=400, detail=f"No practice number configured for env '{req.env}'.")

    patient_preview = _pick_patient_number(practice, req.patient_number)
    cooldown = _cooldown_remaining(patient_preview, practice) if req.trigger_type == "inbound_sms" else 0
    session = _start_session(req.trigger_type, practice, req.scenario_id,
                             req.patient_number, req.opener)
    return {"session": _session_dict(session), "cooldown_warning_s": cooldown}


# ── Suite runner: full scenario regression over the REAL phone path ──────────

@dataclass
class SuiteRun:
    suite_id: str
    scenario_ids: list
    trigger_type: str
    practice_number: str
    env: str
    status: str = "running"        # running | completed
    current_idx: int = 0
    session_ids: list = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    finished_at: float = 0.0


SUITES: dict[str, SuiteRun] = {}
SESSION_TERMINAL_TIMEOUT_S = 12 * 60   # hard cap per scenario in a suite


def _run_suite(suite: SuiteRun) -> None:
    for idx, sid in enumerate(suite.scenario_ids):
        suite.current_idx = idx
        try:
            session = _start_session(suite.trigger_type, suite.practice_number, sid,
                                     suite_id=suite.suite_id)
        except Exception:
            continue
        suite.session_ids.append(session.session_id)
        deadline = time.time() + SESSION_TERMINAL_TIMEOUT_S
        while time.time() < deadline:
            time.sleep(5)
            if session.status in ("completed", "failed"):
                break
        else:
            if session.status not in ("completed", "failed"):
                _finish(session, "failed", "incomplete", "Suite watchdog: scenario hard timeout")
        time.sleep(10)  # brief gap between real conversations
    suite.status = "completed"
    suite.finished_at = time.time()


class SuiteRequest(BaseModel):
    scenario_ids: list[str] = []
    trigger_type: str = "incomplete_call"   # call triggers dodge the 24h inbound-SMS cooldown
    env: str = "beta"
    practice_number: str = ""


@router.post("/api/real/run-suite")
def real_run_suite(req: SuiteRequest):
    _require_twilio()
    practice = (req.practice_number or PRACTICE_NUMBERS.get(req.env, "")).strip()
    if not practice:
        raise HTTPException(status_code=400, detail=f"No practice number configured for env '{req.env}'.")
    srv = _sim()
    ids = req.scenario_ids or list(srv.SCENARIOS.keys())
    bad = [i for i in ids if i not in srv.SCENARIOS]
    if bad:
        raise HTTPException(status_code=400, detail=f"Unknown scenarios: {bad}")

    suite = SuiteRun(
        suite_id=uuid.uuid4().hex[:10],
        scenario_ids=ids,
        trigger_type=req.trigger_type,
        practice_number=practice,
        env=req.env,
    )
    SUITES[suite.suite_id] = suite
    threading.Thread(target=_run_suite, args=(suite,), daemon=True).start()
    return asdict(suite)


@router.get("/api/real/suites")
def real_suites():
    out = []
    for s in sorted(SUITES.values(), key=lambda x: x.started_at, reverse=True)[:10]:
        d = asdict(s)
        sessions = [REAL_SESSIONS.get(i) for i in s.session_ids]
        sessions = [x for x in sessions if x]
        d["passed"] = sum(1 for x in sessions if x.status == "completed" and x.outcome in ("booking_confirmed", "task_created"))
        d["failed"] = sum(1 for x in sessions if x.status == "failed")
        d["total"] = len(s.scenario_ids)
        out.append(d)
    return {"suites": out}


@router.get("/api/real/sessions")
def real_sessions():
    with _SESSIONS_LOCK:
        items = sorted(REAL_SESSIONS.values(), key=lambda s: s.created_at, reverse=True)
        return {"sessions": [_session_dict(s) for s in items[:50]]}


@router.get("/api/real/session/{session_id}")
def real_session(session_id: str):
    s = REAL_SESSIONS.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_dict(s)


@router.post("/api/real/session/{session_id}/stop")
def real_session_stop(session_id: str):
    s = REAL_SESSIONS.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    if s.call_sid and s.status == "calling":
        try:
            _tw_post(f"/Calls/{s.call_sid}.json", {"Status": "completed"})
        except Exception:
            pass
    s.status = "completed" if s.outcome else "failed"
    if not s.outcome:
        s.outcome = "incomplete"
    s.log("Stopped by user")
    return _session_dict(s)


@router.post("/api/real/setup")
def real_setup():
    """One-time: point every Twilio number's SMS webhook at this app."""
    _require_twilio()
    results = []
    nums = _tw_get("/IncomingPhoneNumbers.json", {"PageSize": 50}).get("incoming_phone_numbers", [])
    for n in nums:
        if n.get("phone_number") in TWILIO_NUMBERS:
            _tw_post(f"/IncomingPhoneNumbers/{n['sid']}.json", {
                "SmsUrl": f"{PUBLIC_BASE}/api/twilio/sms",
                "SmsMethod": "POST",
            })
            results.append({"number": n["phone_number"], "sms_webhook": f"{PUBLIC_BASE}/api/twilio/sms"})
    return {"configured": results}


# ── Twilio webhooks ───────────────────────────────────────────────────────────

def _twiml(content: str) -> Response:
    return Response(content=f'<?xml version="1.0" encoding="UTF-8"?><Response>{content}</Response>',
                    media_type="application/xml")


@router.post("/api/twilio/sms")
async def twilio_sms_webhook(request: Request):
    """Inbound SMS to one of our Twilio numbers — the AI agent (via ADIT) is texting us."""
    form = await request.form()
    to_number   = str(form.get("To", ""))
    from_number = str(form.get("From", ""))
    body        = str(form.get("Body", "")).strip()

    session = _active_session_for(to_number)
    if not session:
        return _twiml("")  # no active session — log nothing, never auto-reply

    session.turns.append(RealTurn("agent", body, "sms"))
    session.log(f"SMS received from {from_number}")
    if session.status in ("waiting_for_sms", "calling"):
        session.status = "in_conversation"

    if _check_completion(session, body):
        # Send a final courteous close so the agent can end_chat cleanly
        try:
            _tw_send_sms(session.patient_number, session.practice_number, "Great, thanks!")
            session.turns.append(RealTurn("patient", "Great, thanks!", "sms"))
        except Exception:
            pass
        return _twiml("")

    n_patient_turns = sum(1 for t in session.turns if t.role == "patient")
    if n_patient_turns >= MAX_SMS_TURNS:
        _finish(session, "completed", "incomplete", f"Max turns ({MAX_SMS_TURNS}) reached — stopping auto-replies")
        return _twiml("")

    try:
        reply, should_end = _patient_reply(session, body)
        # Human-like typing delay. Replying within ~2s creates a race in ADIT's
        # SMS pipeline: our answer can arrive while the agent's own message is
        # still in flight, and ADIT silently drops it (observed live — the SMS
        # is carrier-delivered but never forwarded into the Retell chat).
        time.sleep(random.uniform(8, 12))
        _tw_send_sms(session.patient_number, session.practice_number, reply)
        session.turns.append(RealTurn("patient", reply, "sms"))
        if should_end:
            _finish(session, "completed", session.outcome or "booking_confirmed",
                    "Patient brain signalled goal reached")
    except Exception as exc:
        session.log(f"Reply generation/send failed: {exc}")

    return _twiml("")


@router.post("/api/twilio/sms-status")
async def twilio_sms_status(request: Request):
    return _twiml("")


@router.post("/api/twilio/call-status")
async def twilio_call_status(request: Request, session_id: str = ""):
    form = await request.form()
    status = str(form.get("CallStatus", ""))
    s = REAL_SESSIONS.get(session_id)
    if s:
        s.call_status = status
        s.log(f"Call status: {status}")
        if s.trigger_type == "inbound_call" and status in ("completed", "failed", "busy", "no-answer"):
            if s.status not in ("completed", "failed"):
                agent_text = " ".join(t.message.lower() for t in s.turns if t.role == "agent")
                srv = _sim()
                if any(kw in agent_text for kw in srv.BOOKING_CONFIRMED_KWS):
                    outcome = "booking_confirmed"
                elif any(kw in agent_text for kw in srv.TASK_CREATED_KWS):
                    outcome = "task_created"
                else:
                    outcome = "incomplete"
                _finish(s, "completed", s.outcome or outcome, "Voice call ended")
    return _twiml("")


# ── Voice conversation loop (inbound_call) ───────────────────────────────────

def _gather(session_id: str, say: str = "") -> str:
    say_xml = f'<Say voice="Polly.Joanna">{xml_escape(say)}</Say>' if say else ""
    return (
        f"{say_xml}"
        f'<Gather input="speech" action="{PUBLIC_BASE}/api/twilio/voice-turn?session_id={session_id}" '
        f'method="POST" speechTimeout="auto" timeout="12" actionOnEmptyResult="true" language="en-US"/>'
        # If gather never fires (dead air), end politely
        f"<Hangup/>"
    )


@router.post("/api/twilio/voice-answer")
async def twilio_voice_answer(request: Request, session_id: str = ""):
    """Call connected — the AI Front Desk speaks first; listen for its greeting."""
    s = REAL_SESSIONS.get(session_id)
    if not s:
        return _twiml("<Hangup/>")
    s.status = "in_conversation"
    s.log("Call answered — listening for AI greeting")
    return _twiml(_gather(session_id))


@router.post("/api/twilio/voice-turn")
async def twilio_voice_turn(request: Request, session_id: str = ""):
    """One conversation turn: SpeechResult = what the AI Front Desk just said."""
    s = REAL_SESSIONS.get(session_id)
    if not s:
        return _twiml("<Hangup/>")

    form = await request.form()
    agent_speech = str(form.get("SpeechResult", "")).strip()

    if agent_speech:
        s.turns.append(RealTurn("agent", agent_speech, "voice"))
        s.log("Agent turn captured")

        if _check_completion(s, agent_speech):
            return _twiml('<Say voice="Polly.Joanna">Great, thank you so much. Bye!</Say><Hangup/>')

        try:
            reply, should_end = _patient_reply(s, agent_speech)
        except Exception as exc:
            s.log(f"Patient reply failed: {exc}")
            return _twiml("<Hangup/>")

        s.turns.append(RealTurn("patient", reply, "voice"))
        n_patient_turns = sum(1 for t in s.turns if t.role == "patient")
        if should_end or n_patient_turns >= MAX_SMS_TURNS:
            _finish(s, "completed", s.outcome or "booking_confirmed", "Voice goal reached")
            return _twiml(f'<Say voice="Polly.Joanna">{xml_escape(reply)}</Say><Hangup/>')
        return _twiml(_gather(session_id, say=reply))

    # Empty gather (agent still talking or silence) — keep listening
    return _twiml(_gather(session_id))
