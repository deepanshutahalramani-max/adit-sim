"""
Real Phone mode v2 — Twilio-driven REAL calls and SMS to the practice number.
==============================================================================
Everything runs over the true patient path: a real phone number calls/texts
the practice line, ADIT registers the conversation in the app, injects all
dynamic variables, and engages the AI agent — exactly like a real patient.

Trigger model (how the SMS Agent engages):
  1. missed_call      — call practice, cancel while ringing → AI sends follow-up SMS
  2. incomplete_call  — call practice, AI answers, hang up mid-call → AI follow-up SMS
  3. inbound_sms      — text the practice directly (24h cooldown per number applies)
  4. inbound_call     — AI Front Desk answers; full voice conversation (STT ↔ LLM ↔ TTS)

Identity model:
  Each Twilio number carries ONE stable patient identity (name/DOB/insurance)
  so ADIT accumulates consistent patient records per number. Existing-patient
  scenarios (reschedule/cancel/routine) auto-book first with that identity.

Engineering metrics per session:
  - first_sms_latency_s : call-end → first AI SMS (trigger engagement speed)
  - reply latencies     : patient msg → agent reply, per turn (avg + list)
  - failure taxonomy    : no_followup_sms | reply_timeout | judge_fail | error

Config (Railway env vars override; numbers/practices have safe defaults):
  TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBERS
  PUBLIC_BASE_URL, PRACTICE_NUMBER_BETA, PRACTICE_NUMBER_PROD
"""
from __future__ import annotations

import json
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
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

router = APIRouter()

# ── Configuration ─────────────────────────────────────────────────────────────
TWILIO_SID    = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN  = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_NUMBERS = [n.strip() for n in os.environ.get(
    "TWILIO_NUMBERS",
    "+18326886475,+18327725892,+18392743350,+19314652485",
).split(",") if n.strip()]
PUBLIC_BASE   = os.environ.get("PUBLIC_BASE_URL", "https://adit-sim-production-1b80.up.railway.app").rstrip("/")
PRACTICE_NUMBERS = {
    "beta": os.environ.get("PRACTICE_NUMBER_BETA", "+18324768799"),
    "prod": os.environ.get("PRACTICE_NUMBER_PROD", "+14025031303"),
}
_TW_BASE = "https://api.twilio.com/2010-04-01"

MAX_SMS_TURNS          = 16        # safety cap on auto-replies per session
INCOMPLETE_HOLD_S      = 12        # silence before hanging up an incomplete call
MISSED_CANCEL_S        = 4         # ringing seconds before cancelling a missed call
COOLDOWN_S             = 24 * 3600
REPLY_TIMEOUT_S        = 90        # agent must reply within 90s mid-conversation
FOLLOWUP_SMS_TIMEOUT_S = 180       # AI follow-up SMS must arrive within 3 min of a call
REPLY_DELAY_RANGE      = (8, 12)   # human-like typing delay (avoids ADIT in-flight race)

# Stable identity per Twilio number — ADIT builds one consistent patient record per number.
NUMBER_IDENTITIES: dict[str, dict] = {
    TWILIO_NUMBERS[0] if len(TWILIO_NUMBERS) > 0 else "+10000000001":
        {"first": "Jamie", "last": "Chen", "dob": "April 12, 1990", "insurance": "Delta Dental PPO"},
    TWILIO_NUMBERS[1] if len(TWILIO_NUMBERS) > 1 else "+10000000002":
        {"first": "Maria", "last": "Garcia", "dob": "July 23, 1985", "insurance": "Cigna PPO"},
    TWILIO_NUMBERS[2] if len(TWILIO_NUMBERS) > 2 else "+10000000003":
        {"first": "Robert", "last": "Lee", "dob": "June 20, 1978", "insurance": "Aetna"},
    TWILIO_NUMBERS[3] if len(TWILIO_NUMBERS) > 3 else "+10000000004":
        {"first": "Sarah", "last": "Johnson", "dob": "November 8, 1995", "insurance": "MetLife PPO"},
    # RingCentral company number — used for PROD SMS conversations (A2P-exempt path)
    os.environ.get("RINGCENTRAL_NUMBER", "+18324464448"):
        {"first": "David", "last": "Kim", "dob": "March 15, 1982", "insurance": "United Concordia"},
}

# ── RingCentral SMS provider ──────────────────────────────────────────────────
# PROD practice carrier blocks SMS from unregistered Twilio numbers (A2P 30034).
# The company RingCentral number delivers fine, so PROD SMS conversations run
# through RingCentral; Twilio keeps all calls + BETA SMS.
RC_BASE = "https://platform.ringcentral.com"
RC_CLIENT_ID     = os.environ.get("RINGCENTRAL_CLIENT_ID", "1RFSaNL0hNmddoL1qwjL0s")
RC_CLIENT_SECRET = os.environ.get("RINGCENTRAL_CLIENT_SECRET", "")
RC_JWT           = os.environ.get("RINGCENTRAL_JWT", "")
RC_NUMBER        = os.environ.get("RINGCENTRAL_NUMBER", "+18324464448")

_rc_token: dict = {"access": "", "exp": 0.0}
_rc_lock = threading.Lock()


def _rc_configured() -> bool:
    return bool(RC_CLIENT_ID and RC_CLIENT_SECRET and RC_JWT)


def _rc_access_token() -> str:
    with _rc_lock:
        if _rc_token["access"] and time.time() < _rc_token["exp"] - 60:
            return _rc_token["access"]
        r = httpx.post(
            f"{RC_BASE}/restapi/oauth/token",
            auth=(RC_CLIENT_ID, RC_CLIENT_SECRET),
            data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": RC_JWT},
            timeout=20,
        )
        r.raise_for_status()
        d = r.json()
        _rc_token["access"] = d["access_token"]
        _rc_token["exp"] = time.time() + int(d.get("expires_in", 3600))
        return _rc_token["access"]


def _rc_send_sms(to_number: str, body: str) -> None:
    tok = _rc_access_token()
    r = httpx.post(
        f"{RC_BASE}/restapi/v1.0/account/~/extension/~/sms",
        headers={"Authorization": f"Bearer {tok}"},
        json={"from": {"phoneNumber": RC_NUMBER},
              "to": [{"phoneNumber": to_number}],
              "text": body},
        timeout=20,
    )
    r.raise_for_status()


def _send_patient_sms(session: "RealSession", body: str) -> None:
    """Send an SMS as the session's patient, via the right provider for its number."""
    if session.patient_number == RC_NUMBER:
        _rc_send_sms(session.practice_number, body)
    else:
        _tw_send_sms(session.patient_number, session.practice_number, body)


# Persistent-ish state (survives within a deploy; Railway FS is ephemeral across deploys)
_STATE_FILE = "/tmp/real_phone_state.json"


def _twilio_configured() -> bool:
    return bool(TWILIO_SID and TWILIO_TOKEN and TWILIO_NUMBERS)


def _require_twilio() -> None:
    if not _twilio_configured():
        raise HTTPException(
            status_code=503,
            detail="Twilio not configured — set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Railway.",
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
    })


# ── Session model ─────────────────────────────────────────────────────────────

@dataclass
class RealTurn:
    role: str               # "patient" | "agent"
    message: str
    channel: str = "sms"    # "sms" | "voice"
    ts: float = field(default_factory=time.time)
    latency_s: float = 0.0  # for agent turns: seconds since the previous patient turn


@dataclass
class RealSession:
    session_id: str
    trigger_type: str            # missed_call | incomplete_call | inbound_sms | inbound_call
    patient_number: str
    practice_number: str
    env: str
    scenario_id: str
    goal: str
    persona_idx: int
    scenario_label: str = ""
    mode: str = "auto"           # auto (AI drives patient) | manual (human drives patient)
    patient_name: str = ""       # identity used (from NUMBER_IDENTITIES)
    status: str = "starting"     # starting | calling | waiting_for_sms | in_conversation | completed | failed
    outcome: str = ""            # booking_confirmed | task_created | incomplete | error
    failure_type: str = ""       # no_followup_sms | reply_timeout | error | max_turns | ""
    call_sid: str = ""
    call_status: str = ""
    call_ended_at: float = 0.0
    recording_sid: str = ""
    recording_duration_s: int = 0
    turns: list = field(default_factory=list)
    events: list = field(default_factory=list)
    score: int = 0
    judge_reason: str = ""
    suite_id: str = ""
    first_sms_latency_s: float = 0.0   # call end → first AI SMS
    awaiting_reply_since: float = 0.0  # set when patient sends; cleared on agent reply
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def log(self, msg: str) -> None:
        self.events.append({"ts": time.time(), "msg": msg})
        self.updated_at = time.time()

    def avg_reply_latency_s(self) -> float:
        ls = [t.latency_s for t in self.turns if t.role == "agent" and t.latency_s > 0]
        return round(sum(ls) / len(ls), 1) if ls else 0.0


REAL_SESSIONS: dict[str, RealSession] = {}
_SESSIONS_LOCK = threading.Lock()
_COOLDOWNS: dict[str, float] = {}        # "patient|practice" → last conversation ts
_BOOKED: dict[str, float] = {}           # "patient|practice" → ts of successful booking

_SESSIONS_FILE = "/tmp/real_sessions.json"


def _save_sessions() -> None:
    """Persist finished sessions so QA history survives app restarts."""
    try:
        terminal = [asdict(s) for s in REAL_SESSIONS.values()
                    if s.status in ("completed", "failed")]
        terminal.sort(key=lambda d: d["created_at"], reverse=True)
        with open(_SESSIONS_FILE, "w") as f:
            json.dump(terminal[:200], f)
    except Exception:
        pass


def _load_sessions() -> None:
    try:
        with open(_SESSIONS_FILE) as f:
            items = json.load(f)
        for d in items:
            turns = [RealTurn(**t) for t in d.pop("turns", [])]
            d.pop("avg_reply_latency_s", None)
            d.pop("cooldown_remaining_s", None)
            d.pop("recording_url", None)
            s = RealSession(**{k: v for k, v in d.items() if k != "turns"})
            s.turns = turns
            REAL_SESSIONS[s.session_id] = s
    except Exception:
        pass


_load_sessions()


def _load_state() -> None:
    try:
        with open(_STATE_FILE) as f:
            d = json.load(f)
        _COOLDOWNS.update(d.get("cooldowns", {}))
        _BOOKED.update(d.get("booked", {}))
    except Exception:
        pass


def _save_state() -> None:
    try:
        with open(_STATE_FILE, "w") as f:
            json.dump({"cooldowns": _COOLDOWNS, "booked": _BOOKED}, f)
    except Exception:
        pass


_load_state()


def _key(patient: str, practice: str) -> str:
    return f"{patient}|{practice}"


def _cooldown_remaining(patient: str, practice: str) -> int:
    rem = int(COOLDOWN_S - (time.time() - _COOLDOWNS.get(_key(patient, practice), 0)))
    return max(0, rem)


def _mark_cooldown(patient: str, practice: str) -> None:
    _COOLDOWNS[_key(patient, practice)] = time.time()
    _save_state()


def _is_booked(patient: str, practice: str) -> bool:
    return _key(patient, practice) in _BOOKED


def _mark_booked(patient: str, practice: str) -> None:
    _BOOKED[_key(patient, practice)] = time.time()
    _save_state()


def _number_busy(patient: str) -> bool:
    return any(
        s.patient_number == patient and s.status not in ("completed", "failed")
        for s in REAL_SESSIONS.values()
    )


def _pick_patient_number(practice: str, requested: str = "",
                         needs_existing: bool = False, prefer_new: bool = False) -> str:
    """Pick the best Twilio number for this scenario.
    needs_existing → prefer numbers already booked at this practice.
    prefer_new     → prefer numbers NOT yet booked (clean new-patient record).
    Always avoid numbers currently running a session."""
    if requested:
        return requested
    candidates = [n for n in TWILIO_NUMBERS if not _number_busy(n)]
    if not candidates:
        return ""

    def rank(n: str) -> tuple:
        booked = _is_booked(n, practice)
        cooldown = _cooldown_remaining(n, practice)
        if needs_existing:
            return (0 if booked else 1, cooldown)
        if prefer_new:
            return (0 if not booked else 1, cooldown)
        return (cooldown,)

    return sorted(candidates, key=rank)[0]


def _active_session_for(patient_number: str) -> Optional[RealSession]:
    candidates = [
        s for s in REAL_SESSIONS.values()
        if s.patient_number == patient_number and s.status not in ("completed", "failed")
    ]
    return max(candidates, key=lambda s: s.created_at) if candidates else None


def _session_dict(s: RealSession) -> dict:
    d = asdict(s)
    d["cooldown_remaining_s"] = _cooldown_remaining(s.patient_number, s.practice_number)
    d["avg_reply_latency_s"] = s.avg_reply_latency_s()
    d["recording_url"] = f"/api/real/recording/{s.recording_sid}" if s.recording_sid else ""
    return d


# ── Simulation brain (lazy import from server.py — avoids circular import) ───

def _sim():
    import server
    return server


def _resolve_scenario(scenario_id: str) -> dict:
    srv = _sim()
    cfg = srv.SCENARIOS.get(scenario_id)
    if not cfg:
        raise HTTPException(status_code=400, detail=f"Unknown scenario: {scenario_id}")
    return cfg


def _persona_for(session: RealSession):
    """Scenario behaviour + the NUMBER's stable identity = consistent ADIT records."""
    srv = _sim()
    base = srv.PERSONAS[session.persona_idx % len(srv.PERSONAS)]
    ident = NUMBER_IDENTITIES.get(session.patient_number)
    if not ident:
        return base
    is_new = base.is_new and not _is_booked(session.patient_number, session.practice_number)
    return srv.PatientPersona(
        ident["first"], ident["last"], ident["dob"], ident["insurance"],
        base.reason, base.preferred_day, base.preferred_time, is_new,
    )


def _patient_reply(session: RealSession, agent_msg: str) -> tuple[str, bool]:
    srv = _sim()
    persona = _persona_for(session)
    history = [srv.Turn(t.role, t.message) for t in session.turns if t.role in ("patient", "agent")]
    oai_key = srv._resolve_openai_key("")
    return srv.smart_patient_reply(
        agent_msg, persona, history, session.goal, oai_key,
        patient_phone=session.patient_number,
    )


def _judge_session(session: RealSession) -> None:
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


def _finish(session: RealSession, status: str, outcome: str, note: str = "",
            failure_type: str = "") -> None:
    session.status, session.outcome = status, outcome
    if failure_type:
        session.failure_type = failure_type
    if note:
        session.log(note)
    _mark_cooldown(session.patient_number, session.practice_number)
    if status == "completed" and outcome == "booking_confirmed":
        _mark_booked(session.patient_number, session.practice_number)

    def _judge_and_save():
        _judge_session(session)
        _save_sessions()

    threading.Thread(target=_judge_and_save, daemon=True).start()


def _check_completion(session: RealSession, agent_msg: str) -> bool:
    srv = _sim()
    low = agent_msg.lower()
    if any(kw in low for kw in srv.BOOKING_CONFIRMED_KWS):
        _finish(session, "completed", "booking_confirmed", "Goal reached: booking confirmed")
    elif any(kw in low for kw in srv.TASK_CREATED_KWS):
        _finish(session, "completed", "task_created", "Goal reached: task created")
    else:
        return False
    return True


# ── Watchdog: 90s reply timeout / 3 min follow-up SMS timeout ────────────────

def _watchdog_loop() -> None:
    while True:
        time.sleep(10)
        now = time.time()
        for s in list(REAL_SESSIONS.values()):
            try:
                if s.status == "waiting_for_sms" and now - s.updated_at > FOLLOWUP_SMS_TIMEOUT_S:
                    _finish(s, "failed", "error",
                            f"No AI follow-up SMS within {FOLLOWUP_SMS_TIMEOUT_S}s of the "
                            f"{s.trigger_type.replace('_', ' ')} — agent did not engage",
                            failure_type="no_followup_sms")
                elif (s.status == "in_conversation" and s.mode == "auto"
                      and s.awaiting_reply_since
                      and now - s.awaiting_reply_since > REPLY_TIMEOUT_S):
                    _finish(s, "failed", "incomplete",
                            f"Agent did not reply within {REPLY_TIMEOUT_S}s — conversation ended",
                            failure_type="reply_timeout")
            except Exception:
                pass


_watchdog_started = False


def _ensure_watchdog() -> None:
    global _watchdog_started
    if not _watchdog_started:
        _watchdog_started = True
        threading.Thread(target=_watchdog_loop, daemon=True).start()
        threading.Thread(target=_rc_poll_loop, daemon=True).start()


# ── Call orchestration ────────────────────────────────────────────────────────

def _call_common(session: RealSession, extra: dict) -> dict:
    body = {
        "From": session.patient_number,
        "To": session.practice_number,
        "StatusCallback": f"{PUBLIC_BASE}/api/twilio/call-status?session_id={session.session_id}",
        # Twilio requires REPEATED StatusCallbackEvent params — a single
        # space-separated string is silently ignored (no callbacks at all).
        "StatusCallbackEvent": ["initiated", "ringing", "answered", "completed"],
        "Record": "true",
        "RecordingStatusCallback": f"{PUBLIC_BASE}/api/twilio/recording-status?session_id={session.session_id}",
    }
    body.update(extra)
    return _tw_post("/Calls.json", body)


def _run_missed_call(session: RealSession) -> None:
    try:
        call = _call_common(session, {
            "Twiml": "<Response><Pause length='2'/><Hangup/></Response>",
        })
        session.call_sid = call.get("sid", "")
        session.status = "calling"
        session.log(f"Call placed — cancelling after ~{MISSED_CANCEL_S}s of ringing (missed call)")

        deadline = time.time() + 30
        while time.time() < deadline:
            time.sleep(1)
            st = _tw_get(f"/Calls/{session.call_sid}.json").get("status", "")
            session.call_status = st
            if st == "ringing":
                time.sleep(MISSED_CANCEL_S)
                _tw_post(f"/Calls/{session.call_sid}.json", {"Status": "canceled"})
                session.log("Cancelled while ringing → missed call created")
                break
            if st == "in-progress":
                _tw_post(f"/Calls/{session.call_sid}.json", {"Status": "completed"})
                session.log("Agent answered before cancel — hung up (registered as incomplete call)")
                break
            if st in ("completed", "busy", "failed", "no-answer", "canceled"):
                session.log(f"Call ended: {st}")
                break

        session.call_ended_at = time.time()
        session.status = "waiting_for_sms"
        session.log("Waiting for the AI follow-up SMS…")
    except Exception as exc:
        _finish(session, "failed", "error", f"Missed-call error: {exc}", failure_type="error")


def _run_incomplete_call(session: RealSession) -> None:
    try:
        call = _call_common(session, {
            "Twiml": f"<Response><Pause length='{INCOMPLETE_HOLD_S}'/><Hangup/></Response>",
        })
        session.call_sid = call.get("sid", "")
        session.status = "calling"
        session.log(f"Call placed — AI answers, {INCOMPLETE_HOLD_S}s silence, hang up (incomplete call)")

        deadline = time.time() + 90
        while time.time() < deadline:
            time.sleep(2)
            st = _tw_get(f"/Calls/{session.call_sid}.json").get("status", "")
            session.call_status = st
            if st in ("completed", "busy", "failed", "no-answer", "canceled"):
                session.log(f"Call finished: {st} → incomplete call registered")
                break

        session.call_ended_at = time.time()
        session.status = "waiting_for_sms"
        session.log("Waiting for the AI follow-up SMS…")
    except Exception as exc:
        _finish(session, "failed", "error", f"Incomplete-call error: {exc}", failure_type="error")


def _run_inbound_call(session: RealSession) -> None:
    try:
        call = _call_common(session, {
            "Url": f"{PUBLIC_BASE}/api/twilio/voice-answer?session_id={session.session_id}",
            "Timeout": "30",
        })
        session.call_sid = call.get("sid", "")
        session.status = "calling"
        session.log("Voice call placed — full conversation, recorded")
    except Exception as exc:
        _finish(session, "failed", "error", f"Inbound-call error: {exc}", failure_type="error")


# ── Session lifecycle ─────────────────────────────────────────────────────────

VALID_TRIGGERS = ("missed_call", "incomplete_call", "inbound_sms", "inbound_call")


def _start_session(trigger_type: str, practice: str, scenario_id: str, env: str,
                   patient_number: str = "", opener: str = "", suite_id: str = "",
                   mode: str = "auto", goal_override: str = "",
                   label_override: str = "") -> RealSession:
    _ensure_watchdog()
    cfg = _resolve_scenario(scenario_id)
    srv = _sim()
    base = srv.PERSONAS[cfg.get("persona_idx", 0)]
    needs_existing = not base.is_new

    # PROD SMS conversations must use the RingCentral number — the practice
    # carrier drops SMS from unregistered Twilio numbers (A2P error 30034).
    # Voice-only sessions (inbound_call) stay on Twilio numbers.
    is_prod = practice == PRACTICE_NUMBERS.get("prod", "")
    if is_prod and trigger_type != "inbound_call" and _rc_configured() and not patient_number:
        patient = RC_NUMBER
        if _number_busy(patient):
            raise HTTPException(status_code=503,
                                detail="The RingCentral number is busy with another PROD session — try again shortly.")
    else:
        patient = _pick_patient_number(practice, patient_number,
                                       needs_existing=needs_existing,
                                       prefer_new=base.is_new)
    if not patient:
        raise HTTPException(status_code=503, detail="All patient numbers are busy — try again shortly.")

    ident = NUMBER_IDENTITIES.get(patient, {})
    session = RealSession(
        session_id=uuid.uuid4().hex[:12],
        trigger_type=trigger_type,
        patient_number=patient,
        practice_number=practice,
        env=env,
        scenario_id=scenario_id,
        goal=goal_override or cfg["goal"],
        persona_idx=cfg.get("persona_idx", 0),
        scenario_label=label_override or cfg.get("label", scenario_id),
        patient_name=f"{ident.get('first', '')} {ident.get('last', '')}".strip(),
        suite_id=suite_id,
        mode=mode,
    )
    with _SESSIONS_LOCK:
        REAL_SESSIONS[session.session_id] = session

    if trigger_type == "inbound_sms":
        cooldown = _cooldown_remaining(patient, practice)
        if cooldown > 0:
            session.log(f"WARNING: number in 24h cooldown for another {cooldown}s — AI may not reply")
        msg = opener or cfg["opener"]
        try:
            _send_patient_sms(session, msg)
            session.turns.append(RealTurn("patient", msg, "sms"))
            session.status = "in_conversation"
            session.awaiting_reply_since = time.time()
            session.log(f"Opener SMS sent from {patient}")
        except Exception as exc:
            _finish(session, "failed", "error", f"SMS send error: {exc}", failure_type="error")
    elif trigger_type == "missed_call":
        threading.Thread(target=_run_missed_call, args=(session,), daemon=True).start()
    elif trigger_type == "incomplete_call":
        threading.Thread(target=_run_incomplete_call, args=(session,), daemon=True).start()
    elif trigger_type == "inbound_call":
        threading.Thread(target=_run_inbound_call, args=(session,), daemon=True).start()

    return session


# ── API: config / trigger / sessions ─────────────────────────────────────────

@router.get("/api/real/config")
def real_config():
    all_numbers = TWILIO_NUMBERS + ([RC_NUMBER] if _rc_configured() else [])
    return {
        "configured": _twilio_configured(),
        "ringcentral_configured": _rc_configured(),
        "patient_numbers": [
            {
                "number": n,
                "identity": NUMBER_IDENTITIES.get(n, {}),
                "provider": "ringcentral" if n == RC_NUMBER else "twilio",
                "busy": _number_busy(n),
                "cooldowns": {env: _cooldown_remaining(n, p) for env, p in PRACTICE_NUMBERS.items() if p},
                "booked": {env: _is_booked(n, p) for env, p in PRACTICE_NUMBERS.items() if p},
            }
            for n in all_numbers
        ],
        "practice_numbers": {k: v for k, v in PRACTICE_NUMBERS.items() if v},
        "webhook_base": PUBLIC_BASE,
        "trigger_types": list(VALID_TRIGGERS),
        "reply_timeout_s": REPLY_TIMEOUT_S,
        "followup_timeout_s": FOLLOWUP_SMS_TIMEOUT_S,
    }


class RealTriggerRequest(BaseModel):
    trigger_type: str
    practice_number: str = ""
    env: str = "beta"
    scenario_id: str = "new-patient-cleaning"
    patient_number: str = ""
    opener: str = ""


@router.post("/api/real/trigger")
def real_trigger(req: RealTriggerRequest):
    _require_twilio()
    if req.trigger_type not in VALID_TRIGGERS:
        raise HTTPException(status_code=400, detail=f"Unknown trigger_type: {req.trigger_type}")
    practice = (req.practice_number or PRACTICE_NUMBERS.get(req.env, "")).strip()
    if not practice:
        raise HTTPException(status_code=400, detail=f"No practice number configured for env '{req.env}'.")
    session = _start_session(req.trigger_type, practice, req.scenario_id, req.env,
                             req.patient_number, req.opener)
    return {"session": _session_dict(session)}


@router.get("/api/real/sessions")
def real_sessions():
    with _SESSIONS_LOCK:
        items = sorted(REAL_SESSIONS.values(), key=lambda s: s.created_at, reverse=True)
        return {"sessions": [_session_dict(s) for s in items[:80]]}


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
    _finish(s, "completed" if s.outcome else "failed", s.outcome or "incomplete", "Stopped by user")
    return _session_dict(s)


@router.post("/api/real/verify-callerid")
def verify_callerid():
    """One-time: register the RingCentral number as a Twilio verified caller ID
    so PROD missed/incomplete calls can originate from it (the AI then texts the
    RC number, where SMS delivery works). Twilio calls the RC number — answer it
    in the RingCentral app and enter the validation code returned here."""
    _require_twilio()
    try:
        r = _tw_post("/OutgoingCallerIds.json", {"PhoneNumber": RC_NUMBER})
        return {"validation_code": r.get("validation_code", ""),
                "note": f"Twilio is calling {RC_NUMBER} now — answer in the RingCentral app "
                        f"and key in the validation code."}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Verification start failed: {e.response.text[:200]}")


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


# ── Manual mode: a human drives the patient side through the platform ────────

class ManualStartRequest(BaseModel):
    env: str = "beta"
    practice_number: str = ""
    patient_number: str = ""
    message: str = ""
    trigger_type: str = "inbound_sms"   # inbound_sms | missed_call | incomplete_call


@router.post("/api/real/manual/start")
def manual_start(req: ManualStartRequest):
    _require_twilio()
    practice = (req.practice_number or PRACTICE_NUMBERS.get(req.env, "")).strip()
    if not practice:
        raise HTTPException(status_code=400, detail=f"No practice number for env '{req.env}'.")
    if req.trigger_type == "inbound_sms" and not req.message.strip():
        raise HTTPException(status_code=400, detail="Message required for inbound SMS.")
    session = _start_session(req.trigger_type, practice, "new-patient-cleaning", req.env,
                             req.patient_number, opener=req.message, mode="manual")
    return {"session": _session_dict(session)}


class ManualSendRequest(BaseModel):
    session_id: str
    message: str


@router.post("/api/real/manual/send")
def manual_send(req: ManualSendRequest):
    s = REAL_SESSIONS.get(req.session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    if s.mode != "manual":
        raise HTTPException(status_code=400, detail="Not a manual session")
    _send_patient_sms(s, req.message)
    s.turns.append(RealTurn("patient", req.message, "sms"))
    s.awaiting_reply_since = time.time()
    if s.status in ("waiting_for_sms", "starting"):
        s.status = "in_conversation"
    s.log("Manual message sent")
    return _session_dict(s)


@router.post("/api/real/manual/{session_id}/end")
def manual_end(session_id: str):
    s = REAL_SESSIONS.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    _finish(s, "completed", s.outcome or "incomplete", "Manual session ended by user")
    return _session_dict(s)


# ── Suite runner + Patient Journey ────────────────────────────────────────────

@dataclass
class SuiteRun:
    suite_id: str
    kind: str                      # "suite" | "journey" | "repro"
    scenario_ids: list
    trigger_type: str
    practice_number: str
    env: str
    status: str = "running"
    current_idx: int = 0
    session_ids: list = field(default_factory=list)
    pinned_number: str = ""        # journeys pin one number for identity continuity
    opener: str = ""               # repro override
    goal: str = ""                 # repro override
    label: str = ""                # repro override
    started_at: float = field(default_factory=time.time)
    finished_at: float = 0.0


SUITES: dict[str, SuiteRun] = {}
SESSION_TERMINAL_TIMEOUT_S = 12 * 60

# Scenarios that need the patient to already exist in ADIT
_NEEDS_BOOKING = {"existing-routine", "reschedule", "cancel", "post-treatment-followup"}


def _wait_terminal(session: RealSession) -> None:
    deadline = time.time() + SESSION_TERMINAL_TIMEOUT_S
    while time.time() < deadline:
        time.sleep(5)
        if session.status in ("completed", "failed"):
            return
    if session.status not in ("completed", "failed"):
        _finish(session, "failed", "incomplete", "Suite watchdog: scenario hard timeout",
                failure_type="error")


def _run_suite(suite: SuiteRun) -> None:
    for idx, sid in enumerate(suite.scenario_ids):
        suite.current_idx = idx
        pinned = suite.pinned_number

        # Existing-patient scenarios: make sure this number has a booking first
        if sid in _NEEDS_BOOKING:
            probe = pinned or _pick_patient_number(suite.practice_number, needs_existing=True)
            if probe and not _is_booked(probe, suite.practice_number):
                try:
                    prep = _start_session(suite.trigger_type, suite.practice_number,
                                          "new-patient-cleaning", suite.env,
                                          patient_number=probe, suite_id=suite.suite_id)
                    prep.log(f"Prior-booking step for '{sid}' — registering {prep.patient_name} first")
                    suite.session_ids.append(prep.session_id)
                    _wait_terminal(prep)
                    time.sleep(15)
                except Exception:
                    pass
            pinned = probe

        try:
            session = _start_session(suite.trigger_type, suite.practice_number, sid, suite.env,
                                     patient_number=pinned, suite_id=suite.suite_id,
                                     opener=suite.opener, goal_override=suite.goal,
                                     label_override=suite.label)
        except Exception:
            continue
        suite.session_ids.append(session.session_id)
        if suite.kind == "journey" and not suite.pinned_number:
            suite.pinned_number = session.patient_number
        _wait_terminal(session)
        time.sleep(15)  # gap between real conversations

    suite.status = "completed"
    suite.finished_at = time.time()


class SuiteRequest(BaseModel):
    scenario_ids: list[str] = []
    trigger_type: str = "incomplete_call"
    env: str = "beta"
    practice_number: str = ""
    kind: str = "suite"     # "suite" | "journey" (book→reschedule→cancel) | "repro" (custom opener/goal × repeat)
    opener: str = ""        # repro: custom first patient message
    goal: str = ""          # repro: custom patient goal (e.g. "Reproduce: <root cause>")
    label: str = ""         # repro: display label
    repeat: int = 1         # repro: how many runs


@router.post("/api/real/run-suite")
def real_run_suite(req: SuiteRequest):
    _require_twilio()
    practice = (req.practice_number or PRACTICE_NUMBERS.get(req.env, "")).strip()
    if not practice:
        raise HTTPException(status_code=400, detail=f"No practice number configured for env '{req.env}'.")
    srv = _sim()

    if req.kind == "journey":
        ids = ["new-patient-cleaning", "reschedule", "cancel"]
    elif req.kind == "repro":
        ids = ["new-patient-cleaning"] * max(1, min(req.repeat, 5))
    else:
        ids = req.scenario_ids or list(srv.SCENARIOS.keys())
        bad = [i for i in ids if i not in srv.SCENARIOS]
        if bad:
            raise HTTPException(status_code=400, detail=f"Unknown scenarios: {bad}")

    suite = SuiteRun(
        suite_id=uuid.uuid4().hex[:10],
        kind=req.kind,
        scenario_ids=ids,
        trigger_type=req.trigger_type,
        practice_number=practice,
        env=req.env,
        opener=req.opener if req.kind == "repro" else "",
        goal=req.goal if req.kind == "repro" else "",
        label=req.label if req.kind == "repro" else "",
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
        d["passed"] = sum(1 for x in sessions
                          if x.status == "completed" and x.outcome in ("booking_confirmed", "task_created"))
        d["failed"] = sum(1 for x in sessions if x.status == "failed")
        d["total"] = len(s.scenario_ids)
        out.append(d)
    return {"suites": out}


# ── Insights: engineering performance metrics ─────────────────────────────────

@router.get("/api/real/insights")
def real_insights():
    sessions = [s for s in REAL_SESSIONS.values() if s.status in ("completed", "failed")]
    if not sessions:
        return {"total": 0}

    def pct(vals: list, p: float) -> float:
        if not vals:
            return 0.0
        vals = sorted(vals)
        return round(vals[min(len(vals) - 1, int(len(vals) * p))], 1)

    by_trigger: dict[str, dict] = {}
    for t in VALID_TRIGGERS:
        ts = [s for s in sessions if s.trigger_type == t]
        if not ts:
            continue
        first_lat = [s.first_sms_latency_s for s in ts if s.first_sms_latency_s > 0]
        by_trigger[t] = {
            "total": len(ts),
            "passed": sum(1 for s in ts if s.outcome in ("booking_confirmed", "task_created")),
            "avg_first_sms_latency_s": round(sum(first_lat) / len(first_lat), 1) if first_lat else 0,
            "p95_first_sms_latency_s": pct(first_lat, 0.95),
        }

    reply_lats = [t.latency_s for s in sessions for t in s.turns
                  if t.role == "agent" and t.latency_s > 0]
    failures: dict[str, int] = {}
    for s in sessions:
        if s.status == "failed":
            failures[s.failure_type or "unknown"] = failures.get(s.failure_type or "unknown", 0) + 1

    by_scenario: dict[str, dict] = {}
    for s in sessions:
        b = by_scenario.setdefault(s.scenario_id, {"total": 0, "passed": 0, "avg_score": 0, "_scores": []})
        b["total"] += 1
        if s.outcome in ("booking_confirmed", "task_created"):
            b["passed"] += 1
        if s.score:
            b["_scores"].append(s.score)
    for b in by_scenario.values():
        b["avg_score"] = round(sum(b["_scores"]) / len(b["_scores"])) if b["_scores"] else 0
        del b["_scores"]

    passed = sum(1 for s in sessions if s.outcome in ("booking_confirmed", "task_created"))
    return {
        "total": len(sessions),
        "passed": passed,
        "failed": sum(1 for s in sessions if s.status == "failed"),
        "pass_rate": round(100 * passed / len(sessions)),
        "agent_reply_latency": {
            "avg_s": round(sum(reply_lats) / len(reply_lats), 1) if reply_lats else 0,
            "p95_s": pct(reply_lats, 0.95),
            "max_s": round(max(reply_lats), 1) if reply_lats else 0,
            "samples": len(reply_lats),
        },
        "by_trigger": by_trigger,
        "by_scenario": by_scenario,
        "failure_taxonomy": failures,
        "envs": {
            env: {
                "total": len([s for s in sessions if s.env == env]),
                "passed": len([s for s in sessions
                               if s.env == env and s.outcome in ("booking_confirmed", "task_created")]),
            }
            for env in ("beta", "prod") if any(s.env == env for s in sessions)
        },
    }


# ── Call recording playback (proxied with Twilio auth) ───────────────────────

@router.get("/api/real/recording/{recording_sid}")
def real_recording(recording_sid: str):
    _require_twilio()
    url = f"{_TW_BASE}/Accounts/{TWILIO_SID}/Recordings/{recording_sid}.mp3"
    r = httpx.get(url, auth=(TWILIO_SID, TWILIO_TOKEN), timeout=30, follow_redirects=True)
    if r.status_code != 200:
        raise HTTPException(status_code=404, detail="Recording not available yet")
    return Response(content=r.content, media_type="audio/mpeg",
                    headers={"Cache-Control": "max-age=3600"})


# ── Twilio webhooks ───────────────────────────────────────────────────────────

def _twiml(content: str) -> Response:
    return Response(content=f'<?xml version="1.0" encoding="UTF-8"?><Response>{content}</Response>',
                    media_type="application/xml")


def _handle_agent_message(session: RealSession, body: str, from_number: str) -> None:
    """Shared inbound-SMS conversation step — used by the Twilio webhook AND the
    RingCentral poller, so both providers behave identically."""
    now = time.time()
    latency = round(now - session.awaiting_reply_since, 1) if session.awaiting_reply_since else 0.0
    session.turns.append(RealTurn("agent", body, "sms", latency_s=latency))
    session.awaiting_reply_since = 0.0
    session.log(f"SMS received from {from_number}" + (f" ({latency}s)" if latency else ""))

    if session.status in ("waiting_for_sms", "calling"):
        if session.call_ended_at:
            session.first_sms_latency_s = round(now - session.call_ended_at, 1)
            session.log(f"AI engaged {session.first_sms_latency_s}s after call end")
        session.status = "in_conversation"

    if _check_completion(session, body):
        if session.mode == "auto":
            try:
                _send_patient_sms(session, "Great, thanks!")
                session.turns.append(RealTurn("patient", "Great, thanks!", "sms"))
            except Exception:
                pass
        return

    if session.mode == "manual":
        return   # human drives — just record the agent turn

    n_patient_turns = sum(1 for t in session.turns if t.role == "patient")
    if n_patient_turns >= MAX_SMS_TURNS:
        _finish(session, "completed", "incomplete",
                f"Max turns ({MAX_SMS_TURNS}) reached", failure_type="max_turns")
        return

    try:
        reply, should_end = _patient_reply(session, body)
        # Human-like typing delay — replying within ~2s races ADIT's in-flight
        # agent message and the answer gets silently dropped (observed live).
        time.sleep(random.uniform(*REPLY_DELAY_RANGE))
        _send_patient_sms(session, reply)
        session.turns.append(RealTurn("patient", reply, "sms"))
        session.awaiting_reply_since = time.time()
        if should_end:
            _finish(session, "completed", session.outcome or "booking_confirmed",
                    "Patient brain signalled goal reached")
    except Exception as exc:
        session.log(f"Reply generation/send failed: {exc}")


@router.post("/api/twilio/sms")
async def twilio_sms_webhook(request: Request):
    form = await request.form()
    to_number   = str(form.get("To", ""))
    from_number = str(form.get("From", ""))
    body        = str(form.get("Body", "")).strip()

    session = _active_session_for(to_number)
    if session:
        _handle_agent_message(session, body, from_number)
    return _twiml("")


# ── RingCentral inbound poller (RC has no webhook here — poll message-store) ──

_rc_seen_ids: set[str] = set()


def _rc_poll_loop() -> None:
    import datetime
    while True:
        time.sleep(4)
        try:
            if not _rc_configured():
                continue
            session = _active_session_for(RC_NUMBER)
            if not session:
                continue
            tok = _rc_access_token()
            date_from = datetime.datetime.utcfromtimestamp(session.created_at - 60).strftime(
                "%Y-%m-%dT%H:%M:%S.000Z")
            r = httpx.get(
                f"{RC_BASE}/restapi/v1.0/account/~/extension/~/message-store",
                params={"messageType": "SMS", "direction": "Inbound", "dateFrom": date_from},
                headers={"Authorization": f"Bearer {tok}"},
                timeout=15,
            )
            r.raise_for_status()
            records = sorted(r.json().get("records", []),
                             key=lambda m: m.get("creationTime", ""))
            for m in records:
                mid = str(m.get("id", ""))
                frm = (m.get("from") or {}).get("phoneNumber", "")
                if mid in _rc_seen_ids or frm != session.practice_number:
                    continue
                _rc_seen_ids.add(mid)
                _handle_agent_message(session, str(m.get("subject", "")).strip(), frm)
        except Exception:
            pass


@router.post("/api/twilio/call-status")
async def twilio_call_status(request: Request, session_id: str = ""):
    form = await request.form()
    status = str(form.get("CallStatus", ""))
    s = REAL_SESSIONS.get(session_id)
    if s:
        s.call_status = status
        s.log(f"Call status: {status}")
        if status in ("completed", "failed", "busy", "no-answer") and not s.call_ended_at:
            s.call_ended_at = time.time()
        if s.trigger_type == "inbound_call" and status in ("completed", "failed", "busy", "no-answer"):
            if s.status not in ("completed", "failed"):
                outcome = _derive_voice_outcome(s)
                _finish(s, "completed", s.outcome or outcome, f"Voice call ended — outcome: {outcome}")
    return _twiml("")


def _derive_voice_outcome(s: RealSession) -> str:
    """Classify a finished voice conversation from the full agent transcript."""
    srv = _sim()
    agent_text = " ".join(t.message.lower() for t in s.turns if t.role == "agent")
    if any(kw in agent_text for kw in srv.BOOKING_CONFIRMED_KWS):
        return "booking_confirmed"
    if any(kw in agent_text for kw in srv.TASK_CREATED_KWS):
        return "task_created"
    return "incomplete"


@router.post("/api/twilio/recording-status")
async def twilio_recording_status(request: Request, session_id: str = ""):
    form = await request.form()
    s = REAL_SESSIONS.get(session_id)
    if s:
        s.recording_sid = str(form.get("RecordingSid", "")) or s.recording_sid
        try:
            s.recording_duration_s = int(form.get("RecordingDuration", 0) or 0)
        except Exception:
            pass
        s.log(f"Recording ready ({s.recording_duration_s}s)")
        # The recording exists ⇒ the call has ended. If a voice session is still
        # open (e.g. a status callback was missed), finalize it from the transcript
        # instead of letting the watchdog mark a good conversation as failed.
        if s.trigger_type == "inbound_call" and s.status not in ("completed", "failed"):
            outcome = _derive_voice_outcome(s)
            _finish(s, "completed", s.outcome or outcome,
                    f"Call ended (recording ready) — outcome: {outcome}")
    return _twiml("")


@router.post("/api/twilio/sms-status")
async def twilio_sms_status(request: Request):
    return _twiml("")


# ── Voice conversation loop (inbound_call) ───────────────────────────────────

def _gather(session_id: str, say: str = "") -> str:
    # speechTimeout=3 (not "auto"): the AI Front Desk speaks long sentences with
    # natural pauses — "auto" chopped its speech mid-sentence and we replied to
    # fragments, talking over the agent (observed live). 3s of silence = real
    # end of the agent's turn. timeout=18 covers PBX forwarding + greeting delay.
    say_xml = f'<Say voice="Polly.Joanna">{xml_escape(say)}</Say>' if say else ""
    return (
        f"{say_xml}"
        f'<Gather input="speech" action="{PUBLIC_BASE}/api/twilio/voice-turn?session_id={session_id}" '
        f'method="POST" speechTimeout="3" timeout="18" actionOnEmptyResult="true" language="en-US"/>'
        f"<Hangup/>"
    )


@router.post("/api/twilio/voice-answer")
async def twilio_voice_answer(request: Request, session_id: str = ""):
    s = REAL_SESSIONS.get(session_id)
    if not s:
        return _twiml("<Hangup/>")
    s.status = "in_conversation"
    s.log("Call answered — listening for AI greeting")
    return _twiml(_gather(session_id))


@router.post("/api/twilio/voice-turn")
async def twilio_voice_turn(request: Request, session_id: str = ""):
    s = REAL_SESSIONS.get(session_id)
    if not s:
        return _twiml("<Hangup/>")

    form = await request.form()
    agent_speech = str(form.get("SpeechResult", "")).strip()
    n_patient_turns = sum(1 for t in s.turns if t.role == "patient")

    if agent_speech:
        s._empty_gathers = 0  # reset dead-air counter on real speech
        now = time.time()
        latency = round(now - s.awaiting_reply_since, 1) if s.awaiting_reply_since else 0.0
        s.turns.append(RealTurn("agent", agent_speech, "voice", latency_s=latency))
        s.awaiting_reply_since = 0.0
        s.log("Agent voice turn captured")

        # Completion only after a genuine exchange — keyword hits inside the
        # agent's greeting/questions caused premature hangups (observed live).
        if n_patient_turns >= 3 and _check_completion(s, agent_speech):
            return _twiml('<Say voice="Polly.Joanna">Great, thank you so much. Bye!</Say><Hangup/>')

        try:
            reply, should_end = _patient_reply(s, agent_speech)
        except Exception as exc:
            s.log(f"Patient reply failed: {exc}")
            return _twiml("<Hangup/>")

        s.turns.append(RealTurn("patient", reply, "voice"))
        s.awaiting_reply_since = time.time()
        if (should_end and n_patient_turns >= 3) or n_patient_turns + 1 >= MAX_SMS_TURNS:
            _finish(s, "completed", s.outcome or "booking_confirmed", "Voice goal reached")
            return _twiml(f'<Say voice="Polly.Joanna">{xml_escape(reply)}</Say><Hangup/>')
        return _twiml(_gather(session_id, say=reply))

    # Empty gather — agent silent or still connecting. Allow a few, then end
    # the call cleanly instead of looping forever on dead air.
    s._empty_gathers = getattr(s, "_empty_gathers", 0) + 1
    s.log(f"empty gather #{s._empty_gathers}")
    if s._empty_gathers >= 4:
        _finish(s, "failed", "incomplete", "Call dead air — 4 empty listens, hanging up",
                failure_type="error")
        return _twiml("<Hangup/>")
    return _twiml(_gather(session_id))
