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

import asyncio
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
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
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


def _normalize_number(num: str) -> str:
    """Normalize a destination number to E.164, raising a clear 400 if invalid —
    so a typo surfaces as a friendly message, not a raw Twilio 400."""
    import re
    raw = (num or "").strip()
    cleaned = re.sub(r"[^\d+]", "", raw)
    if not cleaned:
        raise HTTPException(status_code=400, detail="Enter a destination number to call / text.")
    if not cleaned.startswith("+"):
        digits = re.sub(r"\D", "", cleaned)
        if len(digits) == 10:            # bare US 10-digit → add +1
            cleaned = "+1" + digits
        elif len(digits) == 11 and digits.startswith("1"):
            cleaned = "+" + digits
        else:
            cleaned = "+" + digits
    digits = cleaned[1:]
    if not digits.isdigit():
        raise HTTPException(status_code=400, detail=f"'{raw}' isn't a valid phone number.")
    # US (+1) must be exactly 10 digits after the country code
    if digits.startswith("1") and len(digits) != 11:
        raise HTTPException(
            status_code=400,
            detail=f"'{raw}' isn't a valid US number. Use +1 followed by exactly 10 digits, "
                   f"e.g. +13215202959 (you entered {len(digits) - 1} digits after +1).")
    if not (11 <= len(digits) <= 15):
        raise HTTPException(status_code=400,
                            detail=f"'{raw}' isn't a valid E.164 number (needs 11–15 digits).")
    return cleaned

MAX_SMS_TURNS          = 16        # safety cap on auto-replies per session
INCOMPLETE_HOLD_S      = 12        # silence before hanging up an incomplete call
MISSED_CANCEL_S        = 1         # cancel ASAP after ringing starts (true missed call)
COOLDOWN_S             = 24 * 3600
REPLY_TIMEOUT_S        = 180       # agent must reply within this mid-conversation (3 min;
                                   # it pauses on EHR lookups). After this we nudge once,
                                   # then wait REPLY_TIMEOUT_S again before failing (~6 min total)
# AI follow-up SMS after a missed/incomplete call can take 6-7 minutes to arrive
# on the live practice path — give it 10 minutes before declaring no-engagement.
FOLLOWUP_SMS_TIMEOUT_S = 600
REPLY_DELAY_RANGE      = (8, 12)   # human-like typing delay (avoids ADIT in-flight race)

# When the agent says this, the practice's EHR isn't connected — the conversation
# can't actually book/reschedule/cancel, so it's NOT a meaningful pass/fail test.
EHR_NOT_CONNECTED_KWS = [
    "not near the system", "don't have access to the system",
    "do not have access to the system", "can't access the system",
    "cannot access the system", "not able to access the system",
    "no access to the system", "system is not available right now",
]

# Stable identity per Twilio number — ADIT builds one consistent patient record per number.
# Last name is the shared tag "QATest" so practice staff can instantly spot and bulk-delete
# QA test patients in the EHR (test-data hygiene). First name + DOB stay distinct per number.
QA_LAST_NAME = "QATest"
NUMBER_IDENTITIES: dict[str, dict] = {
    TWILIO_NUMBERS[0] if len(TWILIO_NUMBERS) > 0 else "+10000000001":
        {"first": "Jamie", "last": QA_LAST_NAME, "dob": "April 12, 1990", "insurance": "Delta Dental PPO"},
    TWILIO_NUMBERS[1] if len(TWILIO_NUMBERS) > 1 else "+10000000002":
        {"first": "Maria", "last": QA_LAST_NAME, "dob": "July 23, 1985", "insurance": "Cigna PPO"},
    TWILIO_NUMBERS[2] if len(TWILIO_NUMBERS) > 2 else "+10000000003":
        {"first": "Robert", "last": QA_LAST_NAME, "dob": "June 20, 1978", "insurance": "Aetna"},
    TWILIO_NUMBERS[3] if len(TWILIO_NUMBERS) > 3 else "+10000000004":
        {"first": "Sarah", "last": QA_LAST_NAME, "dob": "November 8, 1995", "insurance": "MetLife PPO"},
    # RingCentral company number — used for PROD SMS conversations (A2P-exempt path)
    os.environ.get("RINGCENTRAL_NUMBER", "+18324464448"):
        {"first": "David", "last": QA_LAST_NAME, "dob": "March 15, 1982", "insurance": "United Concordia"},
}

# Pool of first names for NEW-patient runs. A new-patient test must NOT reuse a
# name+DOB the EHR already has, or the agent recognizes them as an existing
# patient. We mint a fresh (first name, DOB) each run — last name stays QATest so
# test records remain easy to clean up.
_NEW_FIRST_NAMES = [
    "Olivia", "Liam", "Emma", "Noah", "Ava", "Ethan", "Sophia", "Mason", "Isabella",
    "Lucas", "Mia", "Logan", "Charlotte", "Jackson", "Amelia", "Aiden", "Harper",
    "Elijah", "Evelyn", "Grayson", "Abigail", "Carter", "Emily", "Owen", "Ella", "Wyatt",
]
_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"]


def _fresh_new_patient() -> tuple[str, str]:
    """A unique (first name, DOB) for a brand-new patient — huge combo space so
    the EHR never already has this person."""
    import random
    first = random.choice(_NEW_FIRST_NAMES)
    dob = f"{random.choice(_MONTH_NAMES)} {random.randint(1, 28)}, {random.randint(1960, 2003)}"
    return first, dob

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


def _supa_configured() -> bool:
    try:
        import supa
        return supa.configured()
    except Exception:
        return False


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
    def _do():
        r = httpx.post(
            f"{RC_BASE}/restapi/v1.0/account/~/extension/~/sms",
            headers={"Authorization": f"Bearer {tok}"},
            json={"from": {"phoneNumber": RC_NUMBER},
                  "to": [{"phoneNumber": to_number}],
                  "text": body},
            timeout=20,
        )
        r.raise_for_status()
    _timed("ringcentral", "sms", _do, cost=_COST["ringcentral.sms"], detail="PROD SMS")


def _send_patient_sms(session: "RealSession", body: str) -> None:
    """Send an SMS as the session's patient, via the right provider for its number."""
    if session.patient_number == RC_NUMBER:
        _rc_send_sms(session.practice_number, body)
    else:
        _tw_send_sms(session.patient_number, session.practice_number, body)


# ── API-call telemetry ────────────────────────────────────────────────────────
# We record only MEANINGFUL outbound calls (placing a call, sending SMS, the LLM
# judge, patient-reply generation, recording fetch) — NOT high-frequency noise
# like call-status polls or token refreshes. Each record carries latency, ok/err,
# an estimated cost, and the session it belongs to, so the dashboard can show
# real performance + spend per provider.
from collections import deque

API_CALLS: deque = deque(maxlen=5000)
_API_LOCK = threading.Lock()

# Rough unit costs (USD) for spend estimation — tune as needed.
_COST = {
    "twilio.call_minute": 0.014,
    "twilio.sms":         0.0079,
    "twilio.recording":   0.0005,
    "ringcentral.sms":    0.0,     # included in the RC plan
    "openai.judge":       0.0025,  # ~one gpt-4o-mini judge pass
    "openai.patient":     0.0008,  # ~one short reply
}


def _record_api(provider: str, operation: str, latency_ms: int, ok: bool,
                session_id: str = "", env: str = "", cost: float = 0.0,
                detail: str = "") -> None:
    rec = {
        "ts": time.time(), "provider": provider, "operation": operation,
        "latency_ms": int(latency_ms), "ok": bool(ok),
        "session_id": session_id, "env": env, "cost": round(cost, 5), "detail": detail[:120],
    }
    with _API_LOCK:
        API_CALLS.append(rec)
    try:
        import supa
        supa.record_api_call(rec)
    except Exception:
        pass


def _timed(provider: str, operation: str, fn, *, session_id="", env="", cost=0.0, **kw):
    """Run fn(), record one API-call telemetry row with its latency + ok/err."""
    t0 = time.time()
    ok = True
    try:
        return fn()
    except Exception:
        ok = False
        raise
    finally:
        _record_api(provider, operation, (time.time() - t0) * 1000, ok,
                    session_id=session_id, env=env, cost=cost, **kw)


# ── EHR / agent function-call tracking (from Retell tool-call logs) ──────────
# The Retell agent calls ADIT's EHR functions during the conversation. Retell
# logs each with name/args/result/successful. We pull these post-session so the
# dashboard can show the real EHR API flow + business success per function.
EHR_FUNCTIONS = {
    "create_new_patient", "fetch_patient_details", "get_available_slot",
    "get_rescheduling_slots", "book_appointment", "modify_appointment",
    "upcoming_appointments", "provider_list", "create_task",
}
EHR_CALLS: deque = deque(maxlen=5000)


def _business_ok(name: str, content: str, successful: bool) -> bool:
    """Retell marks the HTTP call successful even when the business result failed
    (e.g. book_appointment returns 'BOOKING FAILED'). Decode the real outcome."""
    if not successful:
        return False
    low = (content or "").lower()
    if "booking failed" in low or "failed." in low:
        return False
    if name == "book_appointment":
        return "booking failed" not in low
    return True


def _msg_ts_ms(m: dict) -> float:
    """Normalize a Retell message timestamp to milliseconds. Voice transcripts use
    `time_sec` (float seconds, relative to call start); other shapes may use
    `created_timestamp` (ms epoch). Returns 0 if neither is present."""
    if m.get("time_sec") is not None:
        return float(m.get("time_sec") or 0) * 1000.0
    return float(m.get("created_timestamp") or 0)


def _extract_ehr_calls(messages: list) -> list:
    """Turn Retell message_with_tool_calls into ordered EHR call records."""
    inv: dict[str, dict] = {}
    out: list = []
    for m in messages or []:
        role = m.get("role")
        if role == "tool_call_invocation" and m.get("name") in EHR_FUNCTIONS:
            inv[m.get("tool_call_id")] = {
                "name": m.get("name"),
                "ts": _msg_ts_ms(m),
                "args": m.get("arguments", ""),
            }
        elif role == "tool_call_result" and m.get("tool_call_id") in inv:
            i = inv.pop(m.get("tool_call_id"))
            content = m.get("content", "")
            ok = bool(m.get("successful", True))
            biz = _business_ok(i["name"], content, ok)
            lat = max(0, _msg_ts_ms(m) - i["ts"]) if i["ts"] else 0
            out.append({
                "name": i["name"], "ok": ok, "business_ok": biz,
                "latency_ms": int(lat), "result": content[:300],
                "args": i["args"], "msg_id": m.get("message_id", ""),
            })
    return out


def _diagnose_ehr(calls: list) -> list:
    """Inspect an EHR call sequence and explain WHY it failed — the QA platform's
    root-cause layer. Detects the param-mismatch / patient-type-flip failures."""
    import json as _json

    def parse(a):
        try:
            return _json.loads(a) if isinstance(a, str) else (a or {})
        except Exception:
            return {}

    issues: list = []
    last_slot_args = None          # most recent get_available_slot / get_rescheduling_slots params
    patient_existed = False
    booking_fails = 0

    for c in calls:
        name, a = c["name"], parse(c.get("args"))
        if name in ("get_available_slot", "get_rescheduling_slots"):
            last_slot_args = a
        elif name == "create_new_patient" and "already exists" in (c.get("result", "").lower()):
            patient_existed = True
        elif name == "book_appointment" and not c["business_ok"]:
            booking_fails += 1
            if last_slot_args:
                gs, bs = last_slot_args.get("service_name"), a.get("service_name")
                gt, bt = last_slot_args.get("patient_type"), a.get("patient_type")
                if gs and bs and gs != bs:
                    issues.append({
                        "severity": "high",
                        "title": "Service mismatch: slots fetched vs appointment booked",
                        "detail": f"get_available_slot used service '{gs}' but book_appointment used "
                                  f"'{bs}'. The held slot isn't valid for a different service, so the "
                                  f"booking is rejected as 'slot no longer available'.",
                    })
                if gt and bt and gt != bt:
                    issues.append({
                        "severity": "high",
                        "title": "Patient-type mismatch: slot lookup vs booking",
                        "detail": f"Availability was fetched for a '{gt}' patient but the appointment "
                                  f"was booked as '{bt}' — different patient types map to different "
                                  f"services/slots.",
                    })

    if patient_existed:
        issues.append({
            "severity": "medium",
            "title": "New patient already existed in the EHR",
            "detail": "create_new_patient returned an existing record, so the agent switched "
                      "new → existing. New vs existing patients have different services, which "
                      "invalidates slots fetched under the original (new-patient) service.",
        })
    if booking_fails >= 3:
        issues.append({
            "severity": "high",
            "title": f"book_appointment failed {booking_fails}× without re-checking availability",
            "detail": "The agent kept retrying against slots that were never valid for the chosen "
                      "service/type, instead of re-calling get_available_slot for the corrected service.",
        })

    # de-dup by title, keep first (highest-context) occurrence
    seen, out = set(), []
    for i in issues:
        if i["title"] not in seen:
            seen.add(i["title"])
            out.append(i)
    return out


_seen_ehr_msg_ids: set = set()
_seen_issue_keys: set = set()
EHR_ISSUES: deque = deque(maxlen=500)


def _ingest_ehr(calls: list, env: str, scenario_id: str = "", session_id: str = "") -> None:
    """Add new EHR call records to the global store, deduped by Retell message_id,
    so the per-session fetch and the background Retell sync never double-count.
    Also runs root-cause diagnostics on the (full) call sequence for this chat."""
    for c in calls:
        mid = c.get("msg_id") or f"{session_id}:{c['name']}:{c['latency_ms']}"
        if mid in _seen_ehr_msg_ids:
            continue
        _seen_ehr_msg_ids.add(mid)
        rec = {"ts": time.time(), "session_id": session_id, "env": env,
               "scenario_id": scenario_id,
               "name": c["name"], "ok": c["ok"], "business_ok": c["business_ok"],
               "latency_ms": c["latency_ms"], "result": c["result"]}
        EHR_CALLS.append(rec)
        try:
            import supa
            supa.record_ehr_call(rec)
        except Exception:
            pass

    # Diagnose the full sequence for this chat (deduped per chat+issue)
    for issue in _diagnose_ehr(calls):
        key = f"{session_id}:{issue['title']}"
        if key in _seen_issue_keys:
            continue
        _seen_issue_keys.add(key)
        EHR_ISSUES.append({"ts": time.time(), "session_id": session_id, "env": env,
                           "scenario_id": scenario_id, **issue})


def _ehr_sync_loop() -> None:
    """Continuously ingest EHR tool-calls from recent Retell chats in BOTH
    workspaces, so the dashboard reflects real agent activity regardless of
    whether a conversation went through a platform session (or finished after
    our turn cap). Deduped by message_id."""
    srv = _sim()
    workspaces = [
        ("prod", "https://frontdeskchatagent.adit.com"),
        ("beta", "https://betafrontdeskchatagent.adit.com"),
    ]
    while True:
        time.sleep(25)
        for env, api_base in workspaces:
            try:
                key = srv._resolve_retell_key(api_base)
                hdrs = {"Authorization": f"Bearer {key}"}
                r = httpx.get("https://api.retellai.com/list-chat", headers=hdrs, timeout=15)
                if r.status_code != 200:
                    continue
                # only chats from the last ~30 min (bounded work)
                cutoff = (time.time() - 1800) * 1000
                recent = [c for c in r.json() if c.get("start_timestamp", 0) >= cutoff]
                for c in sorted(recent, key=lambda x: x.get("start_timestamp", 0), reverse=True)[:15]:
                    full = httpx.get(f"https://api.retellai.com/get-chat/{c['chat_id']}",
                                     headers=hdrs, timeout=15)
                    if full.status_code != 200:
                        continue
                    calls = _extract_ehr_calls(full.json().get("message_with_tool_calls"))
                    _ingest_ehr(calls, env, session_id=c["chat_id"])
            except Exception:
                pass


def _fetch_ehr_calls(session: RealSession) -> None:
    """Find this session's Retell record and extract its EHR tool calls."""
    try:
        srv = _sim()
        api_base = ("https://betafrontdeskchatagent.adit.com" if session.env == "beta"
                    else "https://frontdeskchatagent.adit.com")
        key = srv._resolve_retell_key(api_base)
        digits = session.patient_number.lstrip("+")[-10:]
        hdrs = {"Authorization": f"Bearer {key}"}

        def _lookup():
            """One attempt to find this session's Retell record (the call/chat from
            this patient number, started around this session). Returns the record or None."""
            if session.trigger_type == "inbound_call":
                r = httpx.post("https://api.retellai.com/v2/list-calls", headers=hdrs,
                               json={"limit": 100, "sort_order": "descending"}, timeout=15)
                calls = r.json() if r.status_code == 200 else []
                for c in calls:
                    if digits in str(c.get("from_number", "")) and \
                       c.get("start_timestamp", 0) / 1000 >= session.created_at - 240:
                        return c
            else:
                r = httpx.get("https://api.retellai.com/list-chat", headers=hdrs, timeout=15)
                chats = sorted(r.json() if r.status_code == 200 else [],
                               key=lambda c: c.get("start_timestamp", 0), reverse=True)
                for c in chats:
                    dv = c.get("retell_llm_dynamic_variables", {}) or {}
                    if digits in str(dv.get("patient_phone_number", "")) and \
                       c.get("start_timestamp", 0) / 1000 >= session.created_at - 240:
                        return c
            return None

        # Retell can lag indexing the record by 10-40s after the call/chat ends, so a
        # single fetch sometimes misses it (empty EHR panel / no deep-link). Retry a
        # few times until it appears.
        rec = None
        for _attempt in range(5):
            try:
                rec = _lookup()
            except Exception:
                rec = None
            if rec is not None:
                break
            time.sleep(6)

        record_found = rec is not None
        msgs = None
        if rec is not None:
            if session.trigger_type == "inbound_call":
                session.retell_id = rec.get("call_id", "")      # for the dashboard deep-link
                msgs = rec.get("transcript_with_tool_calls") or rec.get("message_with_tool_calls")
            else:
                session.retell_id = rec.get("chat_id", "")      # for the dashboard deep-link
                msgs = rec.get("message_with_tool_calls")

        # ── Failure triage (#31): cross-reference Retell to explain WHY it failed ──
        if session.status == "failed":
            agent_msgs = sum(1 for m in (msgs or []) if m.get("role") == "agent")
            if not record_found:
                session.triage = (
                    "No Retell session found for this number — the AI never engaged. The SMS Agent "
                    "will NOT start a new engagement while an earlier conversation with this number is "
                    "still active. Fix: finish that conversation, click Takeover in the ADIT app, or "
                    "wait for the 24-hour window — then retry. (Could also be the trigger not reaching ADIT.)")
            elif agent_msgs and session.failure_type == "no_followup_sms":
                session.triage = ("Retell DID run a session and the agent spoke, but its messages never "
                                  "reached our number — ADIT/carrier did not deliver them (delivery gap).")
            elif session.failure_type == "reply_timeout":
                session.triage = ("Retell session exists but the agent stopped responding mid-conversation "
                                  "(agent-side stall), not a delivery issue.")
            else:
                session.triage = "Retell session found; failure appears agent-side (see transcript)."

        if not msgs:
            return

        # ── Voice grading (#32): replace garbled Twilio STT with Retell's clean
        # transcript so the judge + the displayed conversation use accurate text ──
        if session.trigger_type == "inbound_call":
            clean = _retell_turns(msgs)
            if clean:
                session.turns = clean
                session.log("Voice transcript replaced with Retell's clean version")

        calls = _extract_ehr_calls(msgs)
        session.ehr_calls = calls                                   # full list for the session card
        session.issues = _diagnose_ehr(calls)                       # root-cause findings for the card
        _ingest_ehr(calls, session.env, session.scenario_id, session.session_id)  # deduped global
        note = f"EHR: {len(calls)} function call(s)"
        if session.issues:
            note += f" — {len(session.issues)} issue(s) diagnosed"
        session.log(note)
    except Exception as exc:
        session.log(f"EHR fetch failed: {exc}")


def _retell_turns(msgs: list) -> list:
    """Build clean RealTurn objects from Retell's message log (role agent/user
    with content), skipping tool-call entries — used to grade voice on the real
    transcript instead of our Twilio speech-to-text."""
    out: list = []
    for m in msgs or []:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "agent":
            out.append(RealTurn("agent", content, "voice"))
        elif role == "user":
            out.append(RealTurn("patient", content, "voice"))
    return out


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
    return _timed("twilio", "sms",
                  lambda: _tw_post("/Messages.json", {
                      "From": from_number, "To": to_number, "Body": body}),
                  cost=_COST["twilio.sms"], detail="BETA SMS")


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
    extra_context: str = ""      # optional reviewer-supplied scenario context (text/screenshot-derived)
    mode: str = "auto"           # auto (AI drives patient) | manual (human drives patient)
    patient_name: str = ""       # identity used (from NUMBER_IDENTITIES)
    dyn_first: str = ""          # new-patient runs: fresh unique first name (so EHR sees a NEW patient)
    dyn_dob: str = ""            # new-patient runs: fresh unique DOB
    status: str = "starting"     # starting | calling | waiting_for_sms | in_conversation | completed | failed
    outcome: str = ""            # booking_confirmed | task_created | incomplete | error
    failure_type: str = ""       # no_followup_sms | reply_timeout | error | max_turns | ""
    call_sid: str = ""
    call_status: str = ""
    call_ended_at: float = 0.0
    recording_sid: str = ""
    recording_duration_s: int = 0
    retell_id: str = ""          # Retell call_id (voice) or chat_id (SMS) → dashboard deep-link
    turns: list = field(default_factory=list)
    events: list = field(default_factory=list)
    score: int = 0
    judge_reason: str = ""
    suite_id: str = ""
    first_sms_latency_s: float = 0.0   # call end → first AI SMS
    awaiting_reply_since: float = 0.0  # set when patient sends; cleared on agent reply
    nudged: bool = False               # sent one "still there?" nudge for the current stall
    ehr_calls: list = field(default_factory=list)  # EHR tool calls pulled from Retell
    issues: list = field(default_factory=list)     # auto-diagnosed root-cause findings
    triage: str = ""                               # failure triage (Retell cross-reference)
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
    # New-patient runs carry a fresh per-session identity (set in _start_session)
    # so the EHR sees a brand-new person; existing-patient runs use the number's
    # stable identity so they're found.
    if session.dyn_first:
        return srv.PatientPersona(
            session.dyn_first, QA_LAST_NAME, session.dyn_dob, ident["insurance"],
            base.reason, base.preferred_day, base.preferred_time, True,
        )
    return srv.PatientPersona(
        ident["first"], ident["last"], ident["dob"], ident["insurance"],
        base.reason, base.preferred_day, base.preferred_time, False,
    )


def _patient_reply(session: RealSession, agent_msg: str) -> tuple[str, bool]:
    srv = _sim()
    persona = _persona_for(session)
    history = [srv.Turn(t.role, t.message) for t in session.turns if t.role in ("patient", "agent")]
    oai_key = srv._resolve_openai_key("")
    return _timed("openai", "patient_reply",
                  lambda: srv.smart_patient_reply(
                      agent_msg, persona, history, session.goal, oai_key,
                      patient_phone=session.patient_number,
                      extra_context=session.extra_context),
                  session_id=session.session_id, env=session.env, cost=_COST["openai.patient"])


def _judge_session(session: RealSession) -> None:
    try:
        srv = _sim()
        turns = [srv.Turn(t.role, t.message) for t in session.turns if t.role in ("patient", "agent")]
        if not turns:
            return
        oai_key = srv._resolve_openai_key("")
        score, reason = _timed("openai", "judge",
                               lambda: srv._llm_judge(session.scenario_label or session.scenario_id, turns, oai_key),
                               session_id=session.session_id, env=session.env, cost=_COST["openai.judge"])
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
        time.sleep(8)                  # let Retell finalize the chat/call record
        _fetch_ehr_calls(session)      # pull EHR tool calls from Retell
        _judge_session(session)        # fills score/judge_reason
        _save_sessions()               # local /tmp snapshot
        try:
            import supa
            supa.record_session(_session_dict(session))  # durable Supabase row
        except Exception:
            pass

    threading.Thread(target=_judge_and_save, daemon=True).start()


# Outcomes that count as a PASS (a meaningful goal was reached).
PASS_OUTCOMES = ("booking_confirmed", "task_created", "cancel_confirmed", "reschedule_confirmed")


def _check_completion(session: RealSession, agent_msg: str) -> bool:
    srv = _sim()
    low = agent_msg.lower()
    # EHR not connected → this practice can't actually book/reschedule/cancel,
    # so it's not a meaningful test. End it and flag it as not-testable.
    if any(kw in low for kw in EHR_NOT_CONNECTED_KWS):
        _finish(session, "completed", "ehr_not_connected",
                "Agent has no EHR/system access — not a valid test")
        return True
    # Cancel / reschedule are checked first — their confirmations also contain
    # "appointment", which booking phrases would otherwise swallow.
    if any(kw in low for kw in srv.CANCEL_CONFIRMED_KWS):
        _finish(session, "completed", "cancel_confirmed", "Goal reached: appointment canceled")
    elif any(kw in low for kw in srv.RESCHEDULE_CONFIRMED_KWS):
        _finish(session, "completed", "reschedule_confirmed", "Goal reached: appointment rescheduled")
    elif any(kw in low for kw in srv.BOOKING_CONFIRMED_KWS):
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
                    s.triage = (
                        "No follow-up SMS — the SMS Agent won't start a new engagement while an "
                        "earlier conversation with this number is still active. To re-engage: finish "
                        "that conversation, click Takeover in the ADIT app, or wait for the 24-hour "
                        "window to elapse — then retry. (Could also be the trigger not reaching ADIT.)")
                    _finish(s, "failed", "error",
                            f"No AI follow-up SMS within {FOLLOWUP_SMS_TIMEOUT_S}s of the "
                            f"{s.trigger_type.replace('_', ' ')} — agent did not engage",
                            failure_type="no_followup_sms")
                elif (s.status == "in_conversation" and s.mode == "auto"
                      and s.awaiting_reply_since
                      and now - s.awaiting_reply_since > REPLY_TIMEOUT_S):
                    if not s.nudged and s.trigger_type != "inbound_call":
                        # The SMS agent often pauses on EHR lookups. Before giving up,
                        # send one gentle nudge (a real patient would) — it also
                        # re-prompts a momentarily-stalled agent.
                        try:
                            _send_patient_sms(s, "Hi, are you still there?")
                            s.turns.append(RealTurn("patient", "Hi, are you still there?", "sms"))
                        except Exception:
                            pass
                        s.nudged = True
                        s.awaiting_reply_since = now
                        s.log(f"No agent reply in {REPLY_TIMEOUT_S}s — sent one nudge, waiting again")
                    else:
                        _finish(s, "failed", "incomplete",
                                f"Agent did not reply within {REPLY_TIMEOUT_S}s"
                                + (" (after a nudge)" if s.nudged else "") + " — conversation ended",
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
        threading.Thread(target=_ehr_sync_loop, daemon=True).start()


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
    return _timed("twilio", "call_placed",
                  lambda: _tw_post("/Calls.json", body),
                  session_id=session.session_id, env=session.env,
                  detail=session.trigger_type)


# A missed call = let it actually ring for a few seconds, then hang up — like a
# caller who gives up. Validated manually: ringing the practice and hanging up at
# ~5s registers as a missed call and triggers the follow-up SMS to the caller. Too
# short (0s) and the practice never registers an inbound call. One tunable knob.
MISSED_RING_HOLD_S = 5.0


def _run_missed_call(session: RealSession) -> None:
    try:
        # Long pause so that IF the far end answers, our side just stays silent —
        # we end the call ourselves after the brief ring window below.
        call = _call_common(session, {
            "Twiml": "<Response><Pause length='30'/><Hangup/></Response>",
        })
        session.call_sid = call.get("sid", "")
        session.status = "calling"
        session.log(f"Single call placed — letting it ring ~{MISSED_RING_HOLD_S:g}s, then cutting "
                    f"(missed call: rang, then hung up). One attempt only — repeated calls suppress "
                    f"the AI's follow-up SMS.")

        # Let it ring/connect for the hold window so the practice registers a real
        # inbound call, then cut it — exactly a caller hanging up right after it rings.
        time.sleep(MISSED_RING_HOLD_S)

        # End the call: cancel if it's still ringing/queued, else hang up the
        # answered call. (Twilio only cancels queued/ringing calls; in-progress
        # calls must be 'completed'.)
        try:
            st = _tw_get(f"/Calls/{session.call_sid}.json").get("status", "")
        except Exception:
            st = ""
        end_status = "canceled" if st in ("queued", "initiated", "ringing") else "completed"
        try:
            r = _tw_post(f"/Calls/{session.call_sid}.json", {"Status": end_status})
            session.call_status = r.get("status", end_status)
        except Exception:
            session.call_status = st
        session.log(f"Cut the call after ~{MISSED_RING_HOLD_S:g}s (was {st or 'unknown'} → {session.call_status}) "
                    f"— missed call registered")

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
                   label_override: str = "", extra_context: str = "") -> RealSession:
    _ensure_watchdog()
    cfg = _resolve_scenario(scenario_id)
    srv = _sim()
    base = srv.PERSONAS[cfg.get("persona_idx", 0)]
    needs_existing = not base.is_new

    # PROD SMS conversations MUST use the RingCentral number — the practice
    # carrier drops SMS from unregistered Twilio numbers (A2P error 30034).
    # This is forced for every PROD SMS-capable trigger (missed/incomplete/inbound_sms),
    # OVERRIDING any patient_number a suite/journey worker passed (those are Twilio
    # numbers from the pool and would silently fail on PROD). Voice-only sessions
    # (inbound_call) place a pure phone call, which Twilio numbers handle fine.
    is_prod = practice == PRACTICE_NUMBERS.get("prod", "")
    force_rc = is_prod and trigger_type != "inbound_call" and _rc_configured()
    if force_rc:
        patient = RC_NUMBER
        if _number_busy(patient):
            raise HTTPException(status_code=503,
                                detail="The RingCentral number is busy with another PROD SMS session — "
                                       "PROD SMS runs one at a time (single number). Try again shortly.")
    else:
        patient = _pick_patient_number(practice, patient_number,
                                       needs_existing=needs_existing,
                                       prefer_new=base.is_new)
    if not patient:
        raise HTTPException(status_code=503, detail="All patient numbers are busy — try again shortly.")

    ident = NUMBER_IDENTITIES.get(patient, {})
    # New-patient scenarios mint a fresh name+DOB each run (so the agent treats
    # them as genuinely new); existing-patient scenarios keep the number's stable
    # identity so they ARE recognized.
    if base.is_new:
        dyn_first, dyn_dob = _fresh_new_patient()
        disp_name = f"{dyn_first} {QA_LAST_NAME}"
    else:
        dyn_first, dyn_dob = "", ""
        disp_name = f"{ident.get('first', '')} {ident.get('last', '')}".strip()
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
        patient_name=disp_name,
        dyn_first=dyn_first,
        dyn_dob=dyn_dob,
        suite_id=suite_id,
        mode=mode,
        extra_context=extra_context,
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
        "supabase_configured": _supa_configured(),
    }


class RealTriggerRequest(BaseModel):
    trigger_type: str
    practice_number: str = ""
    env: str = "beta"
    scenario_id: str = "new-patient-cleaning"
    patient_number: str = ""
    opener: str = ""
    extra_context: str = ""


@router.post("/api/real/trigger")
def real_trigger(req: RealTriggerRequest):
    _require_twilio()
    if req.trigger_type not in VALID_TRIGGERS:
        raise HTTPException(status_code=400, detail=f"Unknown trigger_type: {req.trigger_type}")
    practice = (req.practice_number or PRACTICE_NUMBERS.get(req.env, "")).strip()
    if req.env == "custom" or req.practice_number:
        practice = _normalize_number(practice)   # friendly error on a bad custom number
    if not practice:
        raise HTTPException(status_code=400, detail=f"No practice number configured for env '{req.env}'.")
    session = _start_session(req.trigger_type, practice, req.scenario_id, req.env,
                             req.patient_number, req.opener, extra_context=req.extra_context)
    return {"session": _session_dict(session)}


def _supa_session_dict(r: dict) -> dict:
    """Shape a persisted qa_sessions row like a live session for the UI cards."""
    turns = r.get("transcript") or []
    return {
        "session_id": r.get("session_id"), "trigger_type": r.get("trigger_type", ""),
        "patient_number": r.get("patient_number", ""), "practice_number": r.get("practice_number", ""),
        "env": r.get("env", ""), "scenario_id": r.get("scenario_id", ""),
        "scenario_label": r.get("scenario_label", ""), "goal": "", "mode": r.get("mode", "auto"),
        "patient_name": r.get("patient_name", ""), "status": r.get("status", ""),
        "outcome": r.get("outcome", ""), "failure_type": r.get("failure_type", ""),
        "call_sid": "", "call_status": "", "turns": turns, "events": [],
        "score": r.get("score") or 0, "judge_reason": r.get("judge_reason", ""),
        "suite_id": r.get("suite_id", ""), "first_sms_latency_s": r.get("first_sms_latency_s") or 0,
        "avg_reply_latency_s": r.get("avg_reply_latency_s") or 0,
        "recording_sid": r.get("recording_sid", ""), "retell_id": r.get("retell_id", ""),
        "ehr_calls": [], "issues": [],
        "created_at": supa_epoch(r.get("created_at")), "updated_at": supa_epoch(r.get("ended_at")),
        "cooldown_remaining_s": 0,
        "recording_url": f"/api/real/recording/{r.get('recording_sid')}" if r.get("recording_sid") else "",
    }


def supa_epoch(iso):
    try:
        import supa
        return supa.epoch(iso)
    except Exception:
        return 0.0


@router.get("/api/real/sessions")
def real_sessions():
    with _SESSIONS_LOCK:
        live = sorted(REAL_SESSIONS.values(), key=lambda s: s.created_at, reverse=True)
        live_dicts = [_session_dict(s) for s in live]
    live_ids = {d["session_id"] for d in live_dicts}
    # Merge in persisted history from Supabase (deduped — live takes precedence)
    history: list = []
    try:
        import supa
        if supa.configured():
            history = [_supa_session_dict(r) for r in supa.fetch_sessions()
                       if r.get("session_id") not in live_ids]
    except Exception:
        history = []
    merged = live_dicts + history
    merged.sort(key=lambda d: d.get("created_at", 0), reverse=True)
    return {"sessions": merged[:200]}


@router.get("/api/real/session/{session_id}")
def real_session(session_id: str):
    s = REAL_SESSIONS.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_dict(s)


def _hangup_if_live(s: RealSession) -> None:
    if s.call_sid and s.call_status not in ("completed", "failed", "busy", "no-answer", "canceled"):
        try:
            _tw_post(f"/Calls/{s.call_sid}.json", {"Status": "completed"})
        except Exception:
            pass


@router.post("/api/real/session/{session_id}/stop")
def real_session_stop(session_id: str):
    s = REAL_SESSIONS.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    _hangup_if_live(s)
    _finish(s, "completed" if s.outcome else "failed", s.outcome or "incomplete", "Stopped by user")
    return _session_dict(s)


@router.get("/api/real/active")
def real_active():
    """Live count of in-flight work — drives the header Stop-All indicator."""
    active_sessions = [s for s in REAL_SESSIONS.values()
                       if s.status not in ("completed", "failed")]
    running_suites = [s for s in SUITES.values() if s.status == "running" and not s.aborted]
    return {
        "active_sessions": len(active_sessions),
        "running_suites": len(running_suites),
        "busy": bool(active_sessions or running_suites),
        "sessions": [{"session_id": s.session_id, "label": s.scenario_label,
                      "env": s.env, "status": s.status, "trigger": s.trigger_type}
                     for s in sorted(active_sessions, key=lambda x: x.created_at, reverse=True)],
    }


@router.post("/api/real/stop-all")
def real_stop_all():
    """KILL SWITCH — abort every running suite and end every active session,
    hanging up any live calls. Stops all real-world communication at once."""
    # 1. Abort suites first so worker loops stop spawning new conversations
    aborted_suites = 0
    for suite in SUITES.values():
        if suite.status == "running" and not suite.aborted:
            suite.aborted = True
            suite.status = "completed"
            suite.finished_at = time.time()
            aborted_suites += 1
    # 2. End every active session + hang up live calls
    stopped = 0
    for s in list(REAL_SESSIONS.values()):
        if s.status not in ("completed", "failed"):
            _hangup_if_live(s)
            _finish(s, "failed", s.outcome or "incomplete", "Stopped by Stop-All",
                    failure_type=s.failure_type or "stopped")
            stopped += 1
    return {"stopped_sessions": stopped, "aborted_suites": aborted_suites}


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
    if req.env == "custom" or req.practice_number:
        practice = _normalize_number(practice)   # friendly error on a bad custom number
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
    aborted: bool = False          # set by Stop-All — workers stop spawning
    current_idx: int = 0
    done: int = 0                  # finished scenarios (suites run in parallel)
    session_ids: list = field(default_factory=list)
    pinned_number: str = ""        # journeys pin one number for identity continuity
    opener: str = ""               # repro override
    goal: str = ""                 # repro override
    label: str = ""                # repro override
    extra_context: str = ""        # reviewer-supplied scenario context for the AI patient
    concurrency: int = 0           # max simultaneous sessions (0 = auto = patient-number pool)
    repeat: int = 1                # runs per scenario (display/telemetry)
    started_at: float = field(default_factory=time.time)
    finished_at: float = 0.0


SUITES: dict[str, SuiteRun] = {}
SESSION_TERMINAL_TIMEOUT_S = 12 * 60

# Scenarios that need the patient to already exist in ADIT
_NEEDS_BOOKING = {"existing-routine", "reschedule", "cancel", "post-treatment-followup"}


def _wait_terminal(session: RealSession, suite: "SuiteRun | None" = None) -> None:
    deadline = time.time() + SESSION_TERMINAL_TIMEOUT_S
    while time.time() < deadline:
        time.sleep(5)
        if session.status in ("completed", "failed"):
            return
        if suite is not None and suite.aborted:
            return  # Stop-All — let the session's own stop handle hangup
    if session.status not in ("completed", "failed"):
        _finish(session, "failed", "incomplete", "Suite watchdog: scenario hard timeout",
                failure_type="error")


# Serializes number selection + session creation so two parallel workers can
# never grab the same patient number in the pick/create race window.
_PICK_LOCK = threading.Lock()


def _run_journey(suite: SuiteRun) -> None:
    """Journeys are inherently sequential — same identity through every phase."""
    for idx, sid in enumerate(suite.scenario_ids):
        if suite.aborted:
            break
        suite.current_idx = idx
        try:
            with _PICK_LOCK:
                session = _start_session(suite.trigger_type, suite.practice_number, sid, suite.env,
                                         patient_number=suite.pinned_number, suite_id=suite.suite_id,
                                         extra_context=suite.extra_context)
        except Exception:
            continue
        suite.session_ids.append(session.session_id)
        if not suite.pinned_number:
            suite.pinned_number = session.patient_number
        _wait_terminal(session, suite)
        suite.done += 1
        if suite.aborted:
            break
        time.sleep(30)  # gap between real conversations — lets trailing SMS drain


def _suite_worker(suite: SuiteRun, q) -> None:
    import queue as _q
    while True:
        if suite.aborted:
            return
        try:
            sid = q.get_nowait()
        except _q.Empty:
            return
        try:
            # Existing-patient scenarios: secure a number and make sure it has a
            # booking first (the booking runs on the SAME number, same worker).
            pinned = ""
            if sid in _NEEDS_BOOKING:
                for _ in range(60):           # wait up to ~5 min for a free number
                    with _PICK_LOCK:
                        probe = _pick_patient_number(suite.practice_number, needs_existing=True)
                    if probe:
                        pinned = probe
                        break
                    time.sleep(5)
                if pinned and not _is_booked(pinned, suite.practice_number) and not suite.aborted:
                    try:
                        with _PICK_LOCK:
                            prep = _start_session(suite.trigger_type, suite.practice_number,
                                                  "new-patient-cleaning", suite.env,
                                                  patient_number=pinned, suite_id=suite.suite_id)
                        prep.log(f"Prior-booking step for '{sid}' — registering {prep.patient_name} first")
                        suite.session_ids.append(prep.session_id)
                        _wait_terminal(prep, suite)
                        time.sleep(15)
                    except Exception:
                        pass
            if suite.aborted:
                continue

            session = None
            for _ in range(60):               # wait for a free number if all busy
                try:
                    with _PICK_LOCK:
                        session = _start_session(suite.trigger_type, suite.practice_number, sid,
                                                 suite.env, patient_number=pinned,
                                                 suite_id=suite.suite_id,
                                                 opener=suite.opener, goal_override=suite.goal,
                                                 label_override=suite.label,
                                                 extra_context=suite.extra_context)
                    break
                except HTTPException:
                    time.sleep(5)
            if session is None:
                continue
            suite.session_ids.append(session.session_id)
            _wait_terminal(session, suite)
        except Exception:
            pass
        finally:
            suite.done += 1
            q.task_done()


def _run_suite(suite: SuiteRun) -> None:
    if suite.kind == "journey":
        _run_journey(suite)
    else:
        # PARALLEL: scenarios fan out across all free patient numbers at once —
        # an 8-scenario regression takes ~2 conversation-lengths, not 8.
        import queue
        q: "queue.Queue[str]" = queue.Queue()
        for sid in suite.scenario_ids:
            q.put(sid)
        # PROD SMS is single-number (RingCentral) → must run one at a time.
        # BETA (and PROD voice) fan out across the Twilio pool.
        is_prod_sms = (suite.practice_number == PRACTICE_NUMBERS.get("prod", "")
                       and suite.trigger_type != "inbound_call" and _rc_configured())
        if is_prod_sms:
            n_workers = 1                          # single RingCentral number
        else:
            pool = len(TWILIO_NUMBERS)
            want = suite.concurrency or pool       # 0 → auto = full pool
            # Never exceed the physical pool — a number can't run two sessions at once.
            # Surplus runs queue and auto-start as numbers free up.
            n_workers = max(1, min(want, pool, len(suite.scenario_ids)))
        threads = [threading.Thread(target=_suite_worker, args=(suite, q), daemon=True)
                   for _ in range(n_workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

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
    repeat: int = 1         # runs per scenario (repro + suite); total runs capped at 20
    concurrency: int = 0    # max simultaneous sessions (0 = auto = patient-number pool)
    extra_context: str = "" # reviewer-supplied scenario context for the AI patient


@router.post("/api/real/run-suite")
def real_run_suite(req: SuiteRequest):
    _require_twilio()
    practice = (req.practice_number or PRACTICE_NUMBERS.get(req.env, "")).strip()
    if req.env == "custom" or req.practice_number:
        practice = _normalize_number(practice)   # friendly error on a bad custom number
    if not practice:
        raise HTTPException(status_code=400, detail=f"No practice number configured for env '{req.env}'.")
    srv = _sim()

    runs = 1
    if req.kind == "journey":
        ids = ["new-patient-cleaning", "reschedule", "cancel"]
    elif req.kind == "repro":
        ids = ["new-patient-cleaning"] * max(1, min(req.repeat, 5))
    else:
        base = req.scenario_ids or list(srv.SCENARIOS.keys())
        bad = [i for i in base if i not in srv.SCENARIOS]
        if bad:
            raise HTTPException(status_code=400, detail=f"Unknown scenarios: {bad}")
        # "Runs per scenario": run the whole selection N times (parallel, pool-limited).
        runs = max(1, min(req.repeat, 20))
        ids = base * runs
        if len(ids) > 20:
            raise HTTPException(status_code=400,
                                detail=f"Too many runs: {len(ids)} ({len(base)} scenario(s) × {runs}). Max 20 per launch.")

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
        extra_context=req.extra_context,
        concurrency=max(0, req.concurrency),
        repeat=runs,
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
                          if x.status == "completed" and x.outcome in PASS_OUTCOMES)
        d["failed"] = sum(1 for x in sessions if x.status == "failed")
        d["total"] = len(s.scenario_ids)
        out.append(d)
    return {"suites": out}


# ── Insights: engineering performance metrics ─────────────────────────────────

def _pct(vals: list, p: float) -> float:
    if not vals:
        return 0.0
    vals = sorted(vals)
    return round(vals[min(len(vals) - 1, int(len(vals) * p))], 1)


def _all_api_calls() -> list:
    """Complete API-call history: from Supabase if configured (survives deploys),
    else the in-memory buffer."""
    try:
        import supa
        if supa.configured():
            return [{"ts": supa.epoch(r.get("ts")), "provider": r.get("provider", ""),
                     "operation": r.get("operation", ""), "latency_ms": r.get("latency_ms") or 0,
                     "ok": r.get("ok", True), "cost": r.get("cost") or 0.0,
                     "session_id": r.get("session_id", ""), "env": r.get("env", ""),
                     "detail": r.get("detail", "")} for r in supa.fetch_api_calls()]
    except Exception:
        pass
    with _API_LOCK:
        return list(API_CALLS)


@router.get("/api/real/api-metrics")
def real_api_metrics():
    """Performance + spend of every meaningful API call the platform makes."""
    calls = _all_api_calls()
    if not calls:
        return {"total": 0, "providers": {}, "operations": [], "recent": [], "total_cost": 0.0}

    PROVIDER_LABEL = {"twilio": "Twilio", "ringcentral": "RingCentral", "openai": "OpenAI"}

    def agg(rows: list) -> dict:
        lat = [r["latency_ms"] for r in rows if r["latency_ms"] > 0]
        errs = sum(1 for r in rows if not r["ok"])
        return {
            "count": len(rows),
            "errors": errs,
            "error_rate": round(100 * errs / len(rows)) if rows else 0,
            "avg_ms": round(sum(lat) / len(lat)) if lat else 0,
            "p95_ms": round(_pct(lat, 0.95)) if lat else 0,
            "cost": round(sum(r["cost"] for r in rows), 4),
        }

    providers: dict = {}
    for p in sorted(set(r["provider"] for r in calls)):
        rows = [r for r in calls if r["provider"] == p]
        providers[PROVIDER_LABEL.get(p, p)] = agg(rows)

    operations = []
    for key in sorted(set(f'{r["provider"]}.{r["operation"]}' for r in calls)):
        prov, op = key.split(".", 1)
        rows = [r for r in calls if r["provider"] == prov and r["operation"] == op]
        d = agg(rows)
        d["provider"] = PROVIDER_LABEL.get(prov, prov)
        d["operation"] = op.replace("_", " ")
        operations.append(d)
    operations.sort(key=lambda x: x["count"], reverse=True)

    recent = [{**r, "ago_s": round(time.time() - r["ts"])}
              for r in sorted(calls, key=lambda x: x["ts"], reverse=True)[:40]]
    return {
        "total": len(calls),
        "total_cost": round(sum(r["cost"] for r in calls), 4),
        "total_errors": sum(1 for r in calls if not r["ok"]),
        "providers": providers,
        "operations": operations,
        "recent": recent,
    }


@router.post("/api/real/ehr-sync")
def real_ehr_sync():
    """Pull EHR tool-calls from recent Retell chats right now (both workspaces).
    The background loop does this every 25s; this triggers an immediate pass."""
    srv = _sim()
    before = len(EHR_CALLS)
    for env, api_base in (("prod", "https://frontdeskchatagent.adit.com"),
                          ("beta", "https://betafrontdeskchatagent.adit.com")):
        try:
            key = srv._resolve_retell_key(api_base)
            hdrs = {"Authorization": f"Bearer {key}"}
            r = httpx.get("https://api.retellai.com/list-chat", headers=hdrs, timeout=15)
            if r.status_code != 200:
                continue
            cutoff = (time.time() - 6 * 3600) * 1000   # last 6h on manual trigger
            recent = [c for c in r.json() if c.get("start_timestamp", 0) >= cutoff]
            for c in sorted(recent, key=lambda x: x.get("start_timestamp", 0), reverse=True)[:25]:
                full = httpx.get(f"https://api.retellai.com/get-chat/{c['chat_id']}", headers=hdrs, timeout=15)
                if full.status_code == 200:
                    _ingest_ehr(_extract_ehr_calls(full.json().get("message_with_tool_calls")),
                                env, session_id=c["chat_id"])
        except Exception:
            pass
    return {"ingested": len(EHR_CALLS) - before, "total": len(EHR_CALLS)}


@router.get("/api/real/ehr-metrics")
def real_ehr_metrics():
    """Per-EHR-function call metrics pulled from the Retell agent's tool-call logs —
    the create_new_patient / get_available_slot / book_appointment / modify /
    create_task flow. Shows volume, business success vs failure, and latency."""
    calls = None
    try:
        import supa
        if supa.configured():
            calls = [{"ts": supa.epoch(r.get("ts")), "name": r.get("name", ""),
                      "ok": r.get("ok", True), "business_ok": r.get("business_ok", True),
                      "latency_ms": r.get("latency_ms") or 0, "result": r.get("result", ""),
                      "env": r.get("env", "")} for r in supa.fetch_ehr_calls()]
    except Exception:
        calls = None
    if calls is None:
        with _API_LOCK:
            calls = list(EHR_CALLS)
    if not calls:
        return {"total": 0, "functions": [], "recent": []}

    FN_LABEL = {
        "create_new_patient": "Create New Patient", "fetch_patient_details": "Fetch Patient Details",
        "get_available_slot": "Get Available Slots", "get_rescheduling_slots": "Get Rescheduling Slots",
        "book_appointment": "Book Appointment", "modify_appointment": "Modify Appointment",
        "upcoming_appointments": "Upcoming Appointment", "provider_list": "Provider List",
        "create_task": "Create Task",
    }
    functions = []
    for name in sorted(set(c["name"] for c in calls)):
        rows = [c for c in calls if c["name"] == name]
        lat = [c["latency_ms"] for c in rows if c["latency_ms"] > 0]
        biz_fail = sum(1 for c in rows if not c["business_ok"])
        functions.append({
            "name": name, "label": FN_LABEL.get(name, name),
            "count": len(rows),
            "success": sum(1 for c in rows if c["business_ok"]),
            "failures": biz_fail,
            "success_rate": round(100 * (len(rows) - biz_fail) / len(rows)) if rows else 0,
            "avg_ms": round(sum(lat) / len(lat)) if lat else 0,
        })
    functions.sort(key=lambda x: x["count"], reverse=True)
    recent = [{**c, "ago_s": round(time.time() - c["ts"])}
              for c in sorted(calls, key=lambda x: x["ts"], reverse=True)[:50]]
    issues = [{**i, "ago_s": round(time.time() - i["ts"])} for i in list(EHR_ISSUES)[::-1]]
    return {
        "total": len(calls),
        "total_failures": sum(1 for c in calls if not c["business_ok"]),
        "functions": functions,
        "issues": issues,
        "recent": recent,
    }


def _sessions_for_insights() -> list:
    """All terminal sessions for scoring — from Supabase (full history) if
    configured, else in-memory. Returns objects exposing .status/.outcome/.env/
    .trigger_type/.scenario_id/.score/.first_sms_latency_s/.failure_type/.turns."""
    try:
        import supa
        if supa.configured():
            from types import SimpleNamespace
            out = []
            for r in supa.fetch_sessions():
                turns = [SimpleNamespace(role=t.get("role"), latency_s=t.get("latency_s", 0) or 0)
                         for t in (r.get("transcript") or [])]
                out.append(SimpleNamespace(
                    status=r.get("status", ""), outcome=r.get("outcome", ""), env=r.get("env", ""),
                    trigger_type=r.get("trigger_type", ""), scenario_id=r.get("scenario_id", ""),
                    scenario_label=r.get("scenario_label", ""), score=r.get("score") or 0,
                    first_sms_latency_s=r.get("first_sms_latency_s") or 0,
                    failure_type=r.get("failure_type", ""), turns=turns))
            return out
    except Exception:
        pass
    return list(REAL_SESSIONS.values())


@router.get("/api/real/trends")
def real_trends():
    """Pass-rate / score / volume over time from Supabase, plus a per-suite
    comparison — so prompt/config changes can be tracked run-over-run."""
    try:
        import supa
        rows = supa.fetch_sessions(1500) if supa.configured() else []
    except Exception:
        rows = []
    from collections import defaultdict
    by_day: dict = defaultdict(lambda: {"total": 0, "passed": 0, "scores": []})
    by_suite: dict = defaultdict(lambda: {"total": 0, "passed": 0, "scores": [], "env": "", "created": ""})
    for r in rows:
        if r.get("outcome") == "ehr_not_connected":
            continue
        passed = r.get("outcome") in PASS_OUTCOMES
        score = r.get("score") or 0
        d = (r.get("created_at") or "")[:10]
        if d:
            b = by_day[d]; b["total"] += 1; b["passed"] += int(passed)
            if score: b["scores"].append(score)
        sid = r.get("suite_id") or ""
        if sid:
            b = by_suite[sid]; b["total"] += 1; b["passed"] += int(passed)
            b["env"] = r.get("env", ""); b["created"] = r.get("created_at", "")
            if score: b["scores"].append(score)

    def pack(d: dict) -> dict:
        return {"total": d["total"], "passed": d["passed"],
                "pass_rate": round(100 * d["passed"] / d["total"]) if d["total"] else 0,
                "avg_score": round(sum(d["scores"]) / len(d["scores"])) if d["scores"] else 0}

    days = [{"date": d, **pack(by_day[d])} for d in sorted(by_day)[-30:]]
    suites = sorted(([{"suite_id": k, "env": v["env"], "created": v["created"], **pack(v)}
                      for k, v in by_suite.items()]),
                    key=lambda x: x["created"], reverse=True)[:15]
    return {"days": days, "suites": suites}


@router.get("/api/real/insights")
def real_insights():
    all_terminal = [s for s in _sessions_for_insights() if s.status in ("completed", "failed")]
    # EHR-not-connected sessions aren't valid tests (practice has no system access)
    # → keep them visible but EXCLUDE from pass/fail and quality scoring.
    not_testable = [s for s in all_terminal if s.outcome == "ehr_not_connected"]
    sessions = [s for s in all_terminal if s.outcome != "ehr_not_connected"]
    if not all_terminal:
        return {"total": 0}
    if not sessions:
        return {"total": 0, "not_testable": len(not_testable),
                "note": "All sessions hit 'EHR not connected' — no valid tests yet."}

    pct = _pct

    by_trigger: dict[str, dict] = {}
    for t in VALID_TRIGGERS:
        ts = [s for s in sessions if s.trigger_type == t]
        if not ts:
            continue
        first_lat = [s.first_sms_latency_s for s in ts if s.first_sms_latency_s > 0]
        by_trigger[t] = {
            "total": len(ts),
            "passed": sum(1 for s in ts if s.outcome in PASS_OUTCOMES),
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
        if s.outcome in PASS_OUTCOMES:
            b["passed"] += 1
        if s.score:
            b["_scores"].append(s.score)
    for b in by_scenario.values():
        b["avg_score"] = round(sum(b["_scores"]) / len(b["_scores"])) if b["_scores"] else 0
        del b["_scores"]

    passed = sum(1 for s in sessions if s.outcome in PASS_OUTCOMES)
    return {
        "total": len(sessions),
        "not_testable": len(not_testable),   # EHR-not-connected, excluded from scoring
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
                               if s.env == env and s.outcome in PASS_OUTCOMES]),
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
    RingCentral poller, so both providers behave identically.
    Runs in a worker thread (contains an LLM call + a human-typing sleep), so
    many conversations can progress concurrently without blocking each other."""
    # Journey phases reuse ONE number for identity continuity. The AI's closing
    # SMS from the previous phase can land after that phase ended, while the next
    # phase's session is already active — it would be mis-attributed and (worse)
    # match a completion keyword and end the new phase instantly. For call
    # triggers the legit follow-up SMS only arrives AFTER the call ends, so any
    # SMS before call_ended_at is a stray from a prior conversation — drop it.
    if session.trigger_type in ("missed_call", "incomplete_call") and not session.call_ended_at:
        session.log(f"Ignored stray SMS before call ended: \"{body[:50]}\"")
        return
    now = time.time()
    latency = round(now - session.awaiting_reply_since, 1) if session.awaiting_reply_since else 0.0
    session.turns.append(RealTurn("agent", body, "sms", latency_s=latency))
    session.awaiting_reply_since = 0.0
    session.nudged = False    # agent replied — a later stall may earn its own nudge
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
        # Fire-and-forget into a worker thread: respond to Twilio instantly and
        # never block the event loop (the handler sleeps 8-12s before replying).
        threading.Thread(target=_handle_agent_message,
                         args=(session, body, from_number), daemon=True).start()
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
    if any(kw in agent_text for kw in srv.CANCEL_CONFIRMED_KWS):
        return "cancel_confirmed"
    if any(kw in agent_text for kw in srv.RESCHEDULE_CONFIRMED_KWS):
        return "reschedule_confirmed"
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
        # Now that the call has ended we know its real duration → record the
        # actual Twilio voice spend (placement telemetry had cost 0).
        minutes = max(1, -(-s.recording_duration_s // 60))  # ceil to whole minutes
        _record_api("twilio", "call_charge", 0, True, session_id=s.session_id, env=s.env,
                    cost=minutes * _COST["twilio.call_minute"] + _COST["twilio.recording"],
                    detail=f"{s.recording_duration_s}s call")
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


# ── Live audio: Twilio Media Streams → WebSocket relay → browser ─────────────
# The call's audio (both directions) is forked to /api/twilio/media-stream and
# relayed to any browser connected on /api/real/listen/{session_id}, so QA can
# LISTEN to the conversation while it is happening.

_LISTENERS: dict[str, list] = {}   # session_id → [browser WebSockets]


def _stream_start_xml(session_id: str) -> str:
    ws_url = PUBLIC_BASE.replace("https://", "wss://") + "/api/twilio/media-stream"
    return (f'<Start><Stream url="{ws_url}" track="both_tracks">'
            f'<Parameter name="session_id" value="{session_id}"/>'
            f"</Stream></Start>")


@router.websocket("/api/twilio/media-stream")
async def twilio_media_stream(ws: WebSocket):
    """Twilio connects here and pushes base64 μ-law audio frames for the call."""
    await ws.accept()
    session_id = ""
    try:
        while True:
            frame = await ws.receive_json()
            ev = frame.get("event")
            if ev == "start":
                params = (frame.get("start", {}) or {}).get("customParameters", {}) or {}
                session_id = params.get("session_id", "")
                s = REAL_SESSIONS.get(session_id)
                if s:
                    s.log("🔴 Live audio stream active")
            elif ev == "media" and session_id:
                listeners = _LISTENERS.get(session_id)
                if listeners:
                    msg = {"track": frame.get("media", {}).get("track", "inbound"),
                           "payload": frame.get("media", {}).get("payload", "")}
                    dead = []
                    for lw in listeners:
                        try:
                            await lw.send_json(msg)
                        except Exception:
                            dead.append(lw)
                    for d in dead:
                        try:
                            listeners.remove(d)
                        except ValueError:
                            pass
            elif ev == "stop":
                break
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        for lw in _LISTENERS.pop(session_id, []):
            try:
                await lw.close()
            except Exception:
                pass


@router.websocket("/api/real/listen/{session_id}")
async def real_listen(ws: WebSocket, session_id: str):
    """Browser connects here to hear the live call audio."""
    await ws.accept()
    _LISTENERS.setdefault(session_id, []).append(ws)
    try:
        while True:
            await ws.receive_text()   # keepalive pings; we never expect content
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        try:
            _LISTENERS.get(session_id, []).remove(ws)
        except (ValueError, KeyError):
            pass


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
    # Fork live audio to the browser listeners, then start the conversation loop
    return _twiml(_stream_start_xml(session_id) + _gather(session_id))


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

        # NO mid-call keyword completion: agent questions contain confirmation-like
        # substrings ("your appointment on…?") and twice caused premature hangups.
        # Like a real call, the conversation runs until the AGENT ends the call
        # (Retell end_call) — the outcome is derived from the full transcript when
        # the call completes (status/recording callbacks → _derive_voice_outcome).
        try:
            # LLM call runs in the threadpool — parallel voice calls don't block
            # each other (or the SMS webhooks) on the event loop.
            loop = asyncio.get_running_loop()
            reply, _should_end = await loop.run_in_executor(None, _patient_reply, s, agent_speech)
        except Exception as exc:
            s.log(f"Patient reply failed: {exc}")
            return _twiml("<Hangup/>")

        s.turns.append(RealTurn("patient", reply, "voice"))
        s.awaiting_reply_since = time.time()
        if n_patient_turns + 1 >= MAX_SMS_TURNS:
            _finish(s, "completed", s.outcome or _derive_voice_outcome(s),
                    f"Voice safety cap ({MAX_SMS_TURNS} turns) — hanging up")
            return _twiml(f'<Say voice="Polly.Joanna">{xml_escape(reply)}</Say><Hangup/>')
        return _twiml(_gather(session_id, say=reply))

    # Empty gather — far end hasn't said anything we could transcribe.
    s._empty_gathers = getattr(s, "_empty_gathers", 0) + 1
    s.log(f"empty gather #{s._empty_gathers}")

    # If we haven't spoken yet and the far end isn't greeting (or its greeting
    # didn't transcribe), the AI patient OPENS the conversation itself. This makes
    # the call work whether the agent greets first OR waits for the caller —
    # essential for Custom numbers / agents that expect the caller to speak first.
    if n_patient_turns == 0 and s._empty_gathers <= 2:
        cfg = _sim().SCENARIOS.get(s.scenario_id, {})
        opener = cfg.get("opener") or "Hi, I'd like to book an appointment."
        s.turns.append(RealTurn("patient", opener, "voice"))
        s.awaiting_reply_since = time.time()
        s.log("No greeting heard — AI patient opening the conversation")
        return _twiml(_gather(session_id, say=opener))

    if s._empty_gathers >= 5:
        _finish(s, "completed", s.outcome or _derive_voice_outcome(s),
                "Call went silent — ending; outcome derived from transcript")
        return _twiml("<Hangup/>")
    return _twiml(_gather(session_id))
