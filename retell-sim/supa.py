"""
Supabase persistence for the QA platform.
=========================================
Durable storage of test sessions, API-call telemetry, and KPIs so history,
trends, and metrics survive deploys (Railway's filesystem is ephemeral).

Talks to Supabase's PostgREST API over httpx — no extra dependency.
Everything is a graceful no-op until these Railway env vars are set:
  SUPABASE_URL          e.g. https://abcd.supabase.co
  SUPABASE_SERVICE_KEY  the service_role key (server-side only, never shipped to the browser)

One-time schema (run in the Supabase SQL editor):

  create table if not exists qa_sessions (
    session_id text primary key,
    created_at timestamptz,
    ended_at   timestamptz default now(),
    env text, trigger_type text, scenario_id text, scenario_label text,
    patient_name text, patient_number text, practice_number text,
    status text, outcome text, failure_type text,
    score int, judge_reason text,
    turns int, first_sms_latency_s real, avg_reply_latency_s real,
    recording_sid text, suite_id text, mode text,
    transcript jsonb
  );
  create table if not exists qa_api_calls (
    id bigint generated always as identity primary key,
    ts timestamptz, provider text, operation text,
    latency_ms int, ok boolean, cost real,
    session_id text, env text, detail text
  );
  create table if not exists qa_ehr_calls (
    id bigint generated always as identity primary key,
    ts timestamptz, session_id text, env text, scenario_id text,
    name text, ok boolean, business_ok boolean, latency_ms int, result text
  );
  create table if not exists qa_audit (
    id bigint generated always as identity primary key,
    ts timestamptz, email text, action text, detail text, env text
  );
  create table if not exists qa_comments (
    id bigint generated always as identity primary key,
    ts timestamptz, email text, target_type text, target_id text,
    comment text, refined_analysis text
  );
  create index if not exists qa_api_calls_ts on qa_api_calls(ts);
  create index if not exists qa_ehr_calls_ts on qa_ehr_calls(ts);
  create index if not exists qa_sessions_created on qa_sessions(created_at);
  create index if not exists qa_audit_ts on qa_audit(ts);
"""
from __future__ import annotations

import os
import threading
from datetime import datetime, timezone

import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# small background buffer for api_calls so we batch inserts and never block callers
_buf: list[dict] = []
_buf_lock = threading.Lock()
_BATCH = 25


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_KEY)


def _headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _post(table: str, rows: list[dict]) -> None:
    if not configured() or not rows:
        return
    try:
        httpx.post(f"{SUPABASE_URL}/rest/v1/{table}",
                   headers=_headers(), json=rows, timeout=10)
    except Exception:
        pass  # telemetry must never break a test run


def record_session(s: dict) -> None:
    """Upsert one finished session (keyed by session_id)."""
    if not configured():
        return
    row = {
        "session_id": s.get("session_id"),
        "created_at": _iso(s.get("created_at")),
        "ended_at": _iso(s.get("updated_at")),
        "env": s.get("env"), "trigger_type": s.get("trigger_type"),
        "scenario_id": s.get("scenario_id"), "scenario_label": s.get("scenario_label"),
        "patient_name": s.get("patient_name"), "patient_number": s.get("patient_number"),
        "practice_number": s.get("practice_number"),
        "status": s.get("status"), "outcome": s.get("outcome"),
        "failure_type": s.get("failure_type"),
        "score": s.get("score"), "judge_reason": s.get("judge_reason"),
        "turns": len(s.get("turns", [])),
        "first_sms_latency_s": s.get("first_sms_latency_s"),
        "avg_reply_latency_s": s.get("avg_reply_latency_s"),
        "recording_sid": s.get("recording_sid"), "suite_id": s.get("suite_id"),
        "mode": s.get("mode"),
        "transcript": s.get("turns", []),
    }
    threading.Thread(target=_post, args=("qa_sessions", [row]), daemon=True).start()


def record_api_call(rec: dict) -> None:
    """Buffer an API-call telemetry row; flush in batches."""
    if not configured():
        return
    with _buf_lock:
        _buf.append({
            "ts": _iso(rec.get("ts")), "provider": rec.get("provider"),
            "operation": rec.get("operation"), "latency_ms": rec.get("latency_ms"),
            "ok": rec.get("ok"), "cost": rec.get("cost"),
            "session_id": rec.get("session_id"), "env": rec.get("env"),
            "detail": rec.get("detail"),
        })
        if len(_buf) >= _BATCH:
            batch, _buf[:] = _buf[:], []
            threading.Thread(target=_post, args=("qa_api_calls", batch), daemon=True).start()


def record_ehr_call(rec: dict) -> None:
    """Persist one EHR/agent function-call telemetry row."""
    if not configured():
        return
    row = {
        "ts": _iso(rec.get("ts")), "session_id": rec.get("session_id"),
        "env": rec.get("env"), "scenario_id": rec.get("scenario_id"),
        "name": rec.get("name"), "ok": rec.get("ok"),
        "business_ok": rec.get("business_ok"), "latency_ms": rec.get("latency_ms"),
        "result": rec.get("result"),
    }
    threading.Thread(target=_post, args=("qa_ehr_calls", [row]), daemon=True).start()


def record_audit(email: str, action: str, detail: str = "", env: str = "") -> None:
    if not configured():
        return
    row = {"ts": _iso(__import__("time").time()), "email": email,
           "action": action, "detail": detail[:300], "env": env}
    threading.Thread(target=_post, args=("qa_audit", [row]), daemon=True).start()


def record_comment(email: str, target_type: str, target_id: str,
                   comment: str, refined: str = "") -> None:
    if not configured():
        return
    row = {"ts": _iso(__import__("time").time()), "email": email,
           "target_type": target_type, "target_id": target_id,
           "comment": comment, "refined_analysis": refined}
    threading.Thread(target=_post, args=("qa_comments", [row]), daemon=True).start()


def flush() -> None:
    with _buf_lock:
        if _buf:
            batch, _buf[:] = _buf[:], []
            threading.Thread(target=_post, args=("qa_api_calls", batch), daemon=True).start()


def fetch_sessions(limit: int = 200) -> list[dict]:
    if not configured():
        return []
    try:
        r = httpx.get(f"{SUPABASE_URL}/rest/v1/qa_sessions",
                      headers=_headers(),
                      params={"select": "*", "order": "created_at.desc", "limit": str(limit)},
                      timeout=10)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return []
