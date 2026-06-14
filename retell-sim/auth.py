"""
Auth (Google Sign-In, @adit.com only) + audit logging + self-improving feedback.
================================================================================
- Google Sign-In: the frontend gets a Google ID token; we verify it server-side
  against Google and only allow @adit.com emails. Admins (ADMIN_EMAILS) get the
  audit/usage dashboard.
- Audit: every meaningful action is attributed to the signed-in user.
- Self-improving feedback: a user comment on a detected issue is fed to an LLM
  that re-reads the conversation + EHR calls and returns a refined diagnosis.

Config (Railway env vars):
  GOOGLE_CLIENT_ID    OAuth 2.0 Web client ID from Google Cloud Console
                      (public value; authorize the Railway URL as a JS origin)
  ALLOWED_DOMAIN      default "adit.com"
  ADMIN_EMAILS        comma-separated admin emails (default deepanshu.tahalramani@adit.com)
  AUTH_ENABLED        auto: gate turns ON only when GOOGLE_CLIENT_ID is set

When GOOGLE_CLIENT_ID is unset the gate is OFF (app stays open) so a missing
config can never lock anyone out.
"""
from __future__ import annotations

import os
import time
from collections import deque

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
ALLOWED_DOMAIN   = os.environ.get("ALLOWED_DOMAIN", "adit.com")
ADMIN_EMAILS = {e.strip().lower() for e in
                os.environ.get("ADMIN_EMAILS", "deepanshu.tahalramani@adit.com").split(",") if e.strip()}


def auth_enabled() -> bool:
    return bool(GOOGLE_CLIENT_ID)


# ── Token verification (cached) ──────────────────────────────────────────────
_token_cache: dict[str, tuple[float, dict]] = {}   # token → (exp_ts, claims)


def verify_token(id_token: str) -> dict | None:
    """Verify a Google ID token and return its claims if valid + @adit.com."""
    if not id_token:
        return None
    cached = _token_cache.get(id_token)
    if cached and cached[0] > time.time():
        return cached[1]
    try:
        r = httpx.get("https://oauth2.googleapis.com/tokeninfo",
                      params={"id_token": id_token}, timeout=10)
        if r.status_code != 200:
            return None
        c = r.json()
        if GOOGLE_CLIENT_ID and c.get("aud") != GOOGLE_CLIENT_ID:
            return None
        email = (c.get("email") or "").lower()
        domain = c.get("hd") or (email.split("@")[-1] if "@" in email else "")
        if domain != ALLOWED_DOMAIN:
            return None
        if c.get("email_verified") in ("false", False):
            return None
        claims = {"email": email, "name": c.get("name", email),
                  "picture": c.get("picture", ""), "is_admin": email in ADMIN_EMAILS}
        _token_cache[id_token] = (time.time() + 3600, claims)
        return claims
    except Exception:
        return None


def user_from_request(request: Request) -> dict | None:
    if not auth_enabled():
        return {"email": "open-access", "name": "Open access", "is_admin": True}
    return verify_token(request.headers.get("X-Id-Token", ""))


def require_admin(request: Request) -> dict:
    u = user_from_request(request)
    if not u or not u.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required.")
    return u


# ── Audit log ─────────────────────────────────────────────────────────────────
AUDIT: deque = deque(maxlen=5000)


def record_action(email: str, action: str, detail: str = "", env: str = "") -> None:
    rec = {"ts": time.time(), "email": email or "anonymous", "action": action,
           "detail": detail[:300], "env": env}
    AUDIT.append(rec)
    try:
        import supa
        supa.record_audit(rec["email"], action, detail, env)
    except Exception:
        pass


# ── Endpoints: auth ───────────────────────────────────────────────────────────

@router.get("/api/auth/config")
def auth_config():
    """Runtime config so the frontend gate activates without a rebuild."""
    return {"enabled": auth_enabled(), "google_client_id": GOOGLE_CLIENT_ID,
            "allowed_domain": ALLOWED_DOMAIN}


@router.post("/api/auth/me")
async def auth_me(request: Request):
    u = user_from_request(request)
    if not u:
        raise HTTPException(status_code=401, detail=f"Sign in with your @{ALLOWED_DOMAIN} Google account.")
    if auth_enabled():
        record_action(u["email"], "login")
    return u


# ── Endpoints: admin (usage + audit) ─────────────────────────────────────────

@router.get("/api/admin/usage")
def admin_usage(request: Request):
    require_admin(request)
    # Per-user usage rolled up from the audit log + real-phone sessions
    import real_phone as rp
    by_user: dict[str, dict] = {}
    for a in AUDIT:
        u = by_user.setdefault(a["email"], {"email": a["email"], "actions": 0,
                                            "simulations": 0, "last_seen": 0, "first_seen": a["ts"]})
        u["actions"] += 1
        u["last_seen"] = max(u["last_seen"], a["ts"])
        u["first_seen"] = min(u["first_seen"], a["ts"])
        if a["action"] in ("trigger", "run_suite", "manual_start"):
            u["simulations"] += 1
    users = sorted(by_user.values(), key=lambda x: x["last_seen"], reverse=True)
    return {
        "users": users,
        "totals": {
            "users": len(users),
            "actions": len(AUDIT),
            "sessions": len([s for s in rp.REAL_SESSIONS.values()]),
        },
    }


@router.get("/api/admin/audit")
def admin_audit(request: Request, limit: int = 200):
    require_admin(request)
    rows = [{**a, "ago_s": round(time.time() - a["ts"])} for a in list(AUDIT)[-limit:][::-1]]
    return {"audit": rows}


# ── Endpoints: self-improving feedback (LLM re-analysis) ─────────────────────

COMMENTS: deque = deque(maxlen=2000)


class FeedbackRequest(BaseModel):
    session_id: str = ""
    issue_title: str = ""
    comment: str


@router.post("/api/feedback/reanalyze")
async def feedback_reanalyze(req: FeedbackRequest, request: Request):
    """Take a human comment on an issue/session, re-read the conversation + EHR
    calls with an LLM, and return a refined diagnosis. The comment + refined
    analysis are stored so the platform's understanding compounds over time."""
    u = user_from_request(request)
    if not u:
        raise HTTPException(status_code=401, detail="Sign in required.")
    if not req.comment.strip():
        raise HTTPException(status_code=400, detail="Comment is required.")

    import real_phone as rp
    import server as srv

    session = rp.REAL_SESSIONS.get(req.session_id)
    transcript = ""
    ehr = ""
    if session:
        transcript = "\n".join(f"{t.role}: {t.message}" for t in session.turns)
        ehr = "\n".join(
            f"{c['name']}({c.get('args','')}) -> {'OK' if c['business_ok'] else 'FAIL'}: {c.get('result','')[:160]}"
            for c in session.ehr_calls)

    prompt = f"""You are a senior QA engineer for a dental AI front-desk agent.
A human reviewer left this comment about a detected issue:

ISSUE: {req.issue_title or '(general)'}
REVIEWER COMMENT: {req.comment}

CONVERSATION TRANSCRIPT:
{transcript or '(not available)'}

EHR API CALLS (function(args) -> result):
{ehr or '(not available)'}

Using the reviewer's comment as a strong signal, re-analyze what went wrong.
Return a sharp, engineer-ready root cause and a concrete fix recommendation.
Be specific about API parameters (service_name, patient_type) and call ordering
if relevant. 4-6 sentences max."""

    refined = ""
    try:
        from openai import OpenAI
        client = OpenAI(api_key=srv._resolve_openai_key(""))
        resp = client.chat.completions.create(
            model="gpt-4o", temperature=0.2,
            messages=[{"role": "user", "content": prompt}],
        )
        refined = resp.choices[0].message.content.strip()
    except Exception as exc:
        refined = f"(LLM re-analysis unavailable: {exc})"

    rec = {"ts": time.time(), "email": u["email"], "target_type": "issue" if req.issue_title else "session",
           "target_id": req.issue_title or req.session_id, "comment": req.comment, "refined": refined}
    COMMENTS.append(rec)
    record_action(u["email"], "feedback_reanalyze", req.issue_title or req.session_id)
    try:
        import supa
        supa.record_comment(u["email"], rec["target_type"], rec["target_id"], req.comment, refined)
    except Exception:
        pass
    return {"refined_analysis": refined, "comment": req.comment, "author": u["name"]}


@router.get("/api/feedback/comments")
def feedback_comments(request: Request):
    u = user_from_request(request)
    if not u:
        raise HTTPException(status_code=401, detail="Sign in required.")
    rows = [{**c, "ago_s": round(time.time() - c["ts"])} for c in list(COMMENTS)[::-1]]
    return {"comments": rows}
