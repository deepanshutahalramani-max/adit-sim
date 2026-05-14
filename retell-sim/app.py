"""
ADIT SMS Agent – Realistic Testing Platform
============================================
Smart patient simulation:
  • GPT-4o-mini acts as patient, reads every agent reply, responds contextually
  • Runs until booking/reschedule/cancel is CONFIRMED (not just chatted)
  • Full E2E chain: Book → Reschedule → Cancel with same phone number
  • Screenshot → analyse → auto-reproduce flow
  • Dashboard with pass-rates, latency, CSV export
"""
from __future__ import annotations

import base64
import json
import os
import random
import string
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any, Optional

import httpx
import pandas as pd
import streamlit as st

# ── Page config ───────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="ADIT Agent QA Platform",
    page_icon="https://app.adit.com/favicon.ico",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Global CSS ────────────────────────────────────────────────────────────────
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

*, html, body, [class*="css"] {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif !important;
    box-sizing: border-box;
}

/* chrome */
#MainMenu, footer, [data-testid="stToolbar"],
[data-testid="stDecoration"], .stDeployButton,
[data-testid="stHeader"], header { display: none !important; }

/* layout */
.stApp { background: #FAFAF8 !important; }
.block-container { padding-top: 0 !important; padding-bottom: 56px !important; max-width: 1160px !important; }

/* ─ Sidebar ──────────────────────────────────────────────── */
[data-testid="stSidebar"] {
    background: #fff !important;
    border-right: 1px solid #EAEAEA !important;
}
[data-testid="stSidebar"] .stSelectbox label,
[data-testid="stSidebar"] .stTextInput label,
[data-testid="stSidebar"] .stToggle label,
[data-testid="stSidebar"] .stNumberInput label {
    color: #ADADAD !important; font-size: 10px !important; font-weight: 700 !important;
    text-transform: uppercase !important; letter-spacing: 0.1em !important;
}
[data-testid="stSidebar"] .stTextInput input,
[data-testid="stSidebar"] [data-baseweb="select"] > div {
    background: #F7F7F5 !important; border: 1px solid #E5E5E5 !important;
    color: #111 !important; border-radius: 7px !important; font-size: 13px !important;
}
[data-testid="stSidebar"] .stTextInput input:focus {
    border-color: #F5820D !important; box-shadow: 0 0 0 2px rgba(245,130,13,0.14) !important;
}
[data-testid="stSidebar"] p, [data-testid="stSidebar"] small,
[data-testid="stSidebar"] .stCaption { color: #ADADAD !important; font-size: 12px !important; }
[data-testid="stSidebar"] code {
    background: #FFF3E8 !important; color: #D4620A !important;
    border-radius: 4px !important; padding: 1px 6px !important; font-size: 11.5px !important;
}
[data-testid="stSidebar"] hr { border-color: #F0F0EE !important; margin: 16px 0 !important; }

/* ─ Primary button ───────────────────────────────────────── */
.stButton > button[kind="primary"] {
    background: #F5820D !important; color: #fff !important; border: none !important;
    border-radius: 8px !important; font-weight: 600 !important; font-size: 14px !important;
    padding: 11px 26px !important; letter-spacing: 0.01em !important;
    transition: background 0.15s, box-shadow 0.15s !important;
    box-shadow: 0 1px 4px rgba(245,130,13,0.25) !important;
}
.stButton > button[kind="primary"]:hover {
    background: #D96D08 !important; box-shadow: 0 4px 12px rgba(245,130,13,0.35) !important;
}
.stButton > button[kind="secondary"] {
    background: #fff !important; color: #F5820D !important;
    border: 1.5px solid #FBCF9A !important; border-radius: 8px !important;
    font-weight: 600 !important; font-size: 14px !important;
}
.stButton > button[kind="secondary"]:hover { background: #FFF7EE !important; border-color: #F5820D !important; }

/* ─ Tabs ─────────────────────────────────────────────────── */
.stTabs [data-baseweb="tab-list"] {
    background: transparent !important; border-bottom: 1.5px solid #EAEAEA !important;
    padding: 0 !important; gap: 0 !important; margin-bottom: 32px !important; box-shadow: none !important;
}
.stTabs [data-baseweb="tab"] {
    border-radius: 0 !important; font-weight: 500 !important; font-size: 14px !important;
    color: #888 !important; padding: 11px 22px !important; background: transparent !important;
    border: none !important; border-bottom: 2px solid transparent !important; margin-bottom: -1.5px !important;
    transition: color 0.15s !important;
}
.stTabs [data-baseweb="tab"]:hover { color: #333 !important; }
.stTabs [aria-selected="true"] {
    color: #111 !important; font-weight: 700 !important;
    border-bottom: 2px solid #F5820D !important; background: transparent !important; box-shadow: none !important;
}

/* ─ Metric / stat cards ──────────────────────────────────── */
[data-testid="stMetric"] {
    background: #fff !important; border-radius: 10px !important; padding: 20px 22px !important;
    border: 1px solid #F5820D !important;
    box-shadow: 0 2px 8px rgba(245,130,13,0.08), 0 1px 2px rgba(0,0,0,0.04) !important;
}
[data-testid="stMetricLabel"] > div {
    font-size: 10.5px !important; font-weight: 700 !important; text-transform: uppercase !important;
    letter-spacing: 0.1em !important; color: #ADADAD !important;
}
[data-testid="stMetricValue"] > div {
    font-size: 30px !important; font-weight: 800 !important;
    color: #111 !important; letter-spacing: -1px !important; margin-top: 6px !important;
}
[data-testid="stMetricDelta"] { display: none !important; }

/* ─ Expanders / result cards ─────────────────────────────── */
.stExpander {
    background: #fff !important; border: 1px solid #EAEAEA !important;
    border-radius: 10px !important; margin-bottom: 10px !important; overflow: hidden !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03) !important;
    transition: box-shadow 0.2s !important;
}
.stExpander:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04) !important; }
details[open].stExpander { border-left: 3px solid #F5820D !important; }
.stExpander summary {
    font-weight: 600 !important; font-size: 13.5px !important;
    color: #111 !important; padding: 14px 20px !important; background: #fff !important;
}

/* ─ Inputs ───────────────────────────────────────────────── */
.stTextInput input, .stTextArea textarea, .stNumberInput input {
    border-radius: 8px !important; border: 1px solid #E5E5E5 !important;
    font-size: 14px !important; background: #fff !important;
    color: #111 !important; padding: 9px 12px !important; transition: border-color 0.15s !important;
}
.stTextInput input:focus, .stTextArea textarea:focus, .stNumberInput input:focus {
    border-color: #F5820D !important; box-shadow: 0 0 0 3px rgba(245,130,13,0.12) !important;
}
[data-baseweb="select"] > div {
    border-radius: 8px !important; border: 1px solid #E5E5E5 !important; background: #fff !important;
}
[data-baseweb="select"] > div:focus-within {
    border-color: #F5820D !important; box-shadow: 0 0 0 3px rgba(245,130,13,0.12) !important;
}
.stMultiSelect [data-baseweb="tag"] {
    background: #FFF3E8 !important; border: 1px solid #FBCF9A !important;
    color: #B85D0A !important; border-radius: 5px !important; font-weight: 500 !important;
}

/* ─ Alerts ───────────────────────────────────────────────── */
[data-testid="stAlert"] { border-radius: 8px !important; font-size: 13.5px !important; }

/* ─ Progress ─────────────────────────────────────────────── */
[data-testid="stProgressBar"] > div > div {
    background: linear-gradient(90deg, #F5820D, #FBAD5A) !important; border-radius: 4px !important;
}
[data-testid="stProgressBar"] > div {
    background: #F0EDE8 !important; border-radius: 4px !important;
}

/* ─ Dataframe ────────────────────────────────────────────── */
[data-testid="stDataFrame"] {
    border-radius: 10px !important; border: 1px solid #EAEAEA !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04) !important;
}

/* ─ Typography ───────────────────────────────────────────── */
h1 { color: #111 !important; font-weight: 800 !important; font-size: 24px !important; letter-spacing: -0.5px !important; }
h2 { color: #111 !important; font-weight: 700 !important; font-size: 18px !important; letter-spacing: -0.3px !important; }
h3 { color: #222 !important; font-weight: 600 !important; font-size: 15px !important; }
p  { color: #555 !important; font-size: 14px !important; line-height: 1.65 !important; }
.stCaption > div { color: #ADADAD !important; font-size: 12.5px !important; }
hr { border-color: #F0F0EE !important; }
label { color: #333 !important; font-size: 13.5px !important; }

/* ─ Chat bubbles ─────────────────────────────────────────── */
.patient-bubble {
    background: #F2F2F0; border-radius: 4px 14px 14px 14px;
    padding: 10px 14px; font-size: 13.5px; color: #222;
    display: inline-block; max-width: 76%; line-height: 1.55;
}
.agent-bubble {
    background: #FFF4E6; border: 1px solid #FBCF9A;
    border-radius: 14px 4px 14px 14px; padding: 10px 14px;
    font-size: 13.5px; color: #7C3A0A; display: inline-block;
    max-width: 76%; line-height: 1.55;
}
.latency-badge { font-size: 11px; color: #ADADAD; margin-left: 6px; }
</style>
""", unsafe_allow_html=True)

# ── Page header ───────────────────────────────────────────────────────────────
st.markdown("""
<div style="
    padding: 28px 0 24px;
    border-bottom: 1.5px solid #EAEAEA;
    margin-bottom: 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
">
    <div style="display:flex; align-items:center; gap:16px;">
        <div style="
            width: 42px; height: 42px; background: #F5820D; border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
            font-size: 22px; font-weight: 800; color: #fff; line-height: 1;
            box-shadow: 0 2px 10px rgba(245,130,13,0.3);
        ">a</div>
        <div>
            <div style="font-size:20px; font-weight:800; color:#111; letter-spacing:-0.5px; line-height:1.15;">
                Agent QA Platform
            </div>
            <div style="font-size:13px; color:#ADADAD; margin-top:2px; font-weight:400;">
                AI Front Desk &nbsp;·&nbsp; Simulate, test and evaluate your receptionist
            </div>
        </div>
    </div>
    <div style="display:flex; align-items:center; gap:12px;">
        <div style="text-align:right;">
            <div style="font-size:13.5px; font-weight:600; color:#333;">Siriyaa</div>
            <div style="font-size:11.5px; color:#ADADAD; margin-top:1px;">Test QA · AI Agent</div>
        </div>
        <div style="
            display:flex; align-items:center; gap:6px;
            background:#F2FDF4; border:1px solid #B8EFC8;
            padding:6px 14px; border-radius:20px;
        ">
            <div style="width:7px;height:7px;background:#22C55E;border-radius:50%;
                        box-shadow:0 0 0 3px rgba(34,197,94,0.2);"></div>
            <span style="font-size:12.5px; font-weight:600; color:#166534;">Live</span>
        </div>
    </div>
</div>
""", unsafe_allow_html=True)

# ── Constants ─────────────────────────────────────────────────────────────────
HOSTS = {
    "🟢 Live  (frontdeskchatagent.adit.com)": "https://frontdeskchatagent.adit.com",
    "🔵 Dev   (RunPod beta)": "https://gjqwwdfeo35edl-8009.proxy.runpod.net",
}
DEFAULT_AGENT_PHONE = "+12673565689"   # Siriyaa – Test QA (live prod)
MAX_PARALLEL = 10
MAX_TURNS = 14   # max patient↔agent turns per simulation

# Keywords that indicate a COMPLETED action (booking OR task creation)
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

# ── Patient personas ──────────────────────────────────────────────────────────
@dataclass
class PatientPersona:
    first_name: str
    last_name: str
    dob: str           # "April 12, 1990"
    insurance: str
    reason: str
    preferred_day: str
    preferred_time: str
    is_new: bool = True

PERSONAS = [
    PatientPersona("Jamie",  "Chen",    "April 12, 1990",    "Delta Dental PPO",   "cleaning and check-up",       "Monday or Tuesday",   "afternoon",  True),
    PatientPersona("Maria",  "Garcia",  "July 23, 1985",     "Cigna PPO",          "toothache on my lower left",  "as soon as possible", "any time",   True),
    PatientPersona("Robert", "Lee",     "June 20, 1978",     "Aetna",              "routine cleaning",            "weekday morning",     "morning",    False),
    PatientPersona("Sarah",  "Johnson", "November 8, 1995",  "MetLife PPO",        "tooth sensitivity to cold",   "Wednesday or Friday", "afternoon",  True),
    PatientPersona("David",  "Kim",     "March 15, 1982",    "United Concordia",   "crown came loose",            "today if possible",   "any time",   False),
]

# ── Scenario definitions ──────────────────────────────────────────────────────
SCENARIOS: dict[str, dict] = {
    "🆕 New Patient – Cleaning": {
        "goal": "Book a new patient dental cleaning/check-up appointment from start to full confirmation",
        "opener": "Hi, I need to book a new patient appointment",
        "type": "book",
        "persona_idx": 0,
    },
    "🚨 Dental Emergency": {
        "goal": "Get an urgent/emergency appointment as soon as possible today",
        "opener": "Hi I have a bad toothache and need to see someone urgently",
        "type": "book",
        "persona_idx": 1,
    },
    "📅 Existing Patient – Routine": {
        "goal": "Book a routine cleaning as an existing patient",
        "opener": "Hi, I'm an existing patient and need to schedule a cleaning",
        "type": "book",
        "persona_idx": 2,
    },
    "🔄 Reschedule Appointment": {
        "goal": "Reschedule an existing upcoming appointment to a different day/time",
        "opener": "Hi, I need to reschedule my upcoming appointment",
        "type": "reschedule",
        "persona_idx": 2,
    },
    "❌ Cancel Appointment": {
        "goal": "Cancel an upcoming appointment",
        "opener": "I need to cancel my appointment please",
        "type": "cancel",
        "persona_idx": 2,
    },
    "🏥 Insurance Check → Book": {
        "goal": "Confirm insurance is accepted then book appointment",
        "opener": "Do you accept Delta Dental insurance?",
        "type": "book",
        "persona_idx": 0,
    },
    "🕐 Office Hours → Book": {
        "goal": "Ask about office hours then book if available",
        "opener": "What are your office hours?",
        "type": "book",
        "persona_idx": 3,
    },
    "💊 Post-Treatment Follow-up": {
        "goal": "Report sensitivity after treatment and book a follow-up check as an existing patient",
        "opener": "I had a filling done last week and it's still sensitive to cold, I need a follow-up",
        "type": "book",
        "persona_idx": 2,   # Robert Lee – existing patient (is_new=False), correct for follow-up
    },
}

# ── Data classes ──────────────────────────────────────────────────────────────
@dataclass
class Turn:
    role: str          # "patient" | "agent"
    message: str
    latency_ms: int = 0

@dataclass
class SimResult:
    scenario: str
    patient_phone: str
    turns: list[Turn] = field(default_factory=list)
    passed: bool = False
    score: int = 0
    failure_reason: str = ""
    total_ms: int = 0
    chat_id: str = ""
    outcome_type: str = ""   # "booking_confirmed" | "task_created" | "incomplete" | "error"

# ── Session state ─────────────────────────────────────────────────────────────
for key, val in [("results", []), ("running", False), ("chain_results", None)]:
    if key not in st.session_state:
        st.session_state[key] = val

# ── Sidebar ───────────────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("""
    <div style="padding: 4px 0 18px; border-bottom: 1px solid #F0F0EE; margin-bottom: 8px;">
        <div style="display:flex; align-items:center; gap:10px;">
            <div style="
                width:32px; height:32px; background:#F5820D; border-radius:8px;
                display:flex; align-items:center; justify-content:center;
                font-size:16px; font-weight:800; color:#fff; line-height:1;
                box-shadow:0 2px 6px rgba(245,130,13,0.25);
            ">a</div>
            <div>
                <div style="color:#111; font-size:14px; font-weight:700; letter-spacing:-0.2px;">Agent QA</div>
                <div style="color:#ADADAD; font-size:11px; margin-top:1px;">AI Front Desk</div>
            </div>
        </div>
    </div>
    """, unsafe_allow_html=True)

    host_label = st.selectbox("Environment", list(HOSTS.keys()))
    api_base = HOSTS[host_label]

    bearer_token = st.text_input(
        "Bearer Token",
        value=os.environ.get("API_ACCESS_TOKEN", ""),
        type="password",
    )
    agent_phone = st.text_input(
        "Agent Phone",
        value=DEFAULT_AGENT_PHONE,
    )
    openai_key = st.text_input(
        "OpenAI API Key",
        value=os.environ.get("OPENAI_API_KEY", ""),
        type="password",
    )
    use_llm_judge = st.toggle("LLM Judge scoring", value=True)

    st.divider()
    st.markdown("""
    <div style="padding:4px 0 4px;">
        <div style="color:#ADADAD; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:8px;">Status</div>
    </div>
    """, unsafe_allow_html=True)
    st.caption(f"Agent · Siriyaa (Test QA)")
    st.caption(f"Phone · `{agent_phone}`")
    env_name = "Live Production" if "frontdeskchatagent" in api_base else "Dev / RunPod"
    st.caption(f"Env · {env_name}")

# ── Helpers ───────────────────────────────────────────────────────────────────
def _phone() -> str:
    return "+1555" + "".join(random.choices(string.digits, k=7))

def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

def _call_agent(
    api_base: str, token: str, message: str,
    patient_phone: str, agent_phone: str,
    chat_id: Optional[str] = None,
    end_conversation: bool = False,
    timeout: int = 45,
) -> dict:
    payload: dict[str, Any] = {
        "message": message,
        "patient_phone_number": patient_phone,
        "agent_phone_number": agent_phone,
        "end_conversation": end_conversation,
    }
    if chat_id:
        payload["chat_id"] = chat_id
    r = httpx.post(
        f"{api_base}/engage/forward-to-agent",
        headers=_headers(token), json=payload, timeout=timeout,
    )
    r.raise_for_status()
    return r.json()

def smart_patient_reply(
    agent_msg: str,
    persona: PatientPersona,
    history: list[Turn],
    goal: str,
    oai_key: str,
    patient_phone: str = "",
) -> tuple[str, bool]:
    """
    GPT-4o-mini reads the agent's actual message and generates a realistic
    patient SMS reply. Returns (reply_text, should_end).
    """
    if not oai_key:
        return "OK", False
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)

        # Last 10 turns for context
        recent = history[-10:]
        transcript = "\n".join(
            f"{'You' if t.role == 'patient' else 'Agent'}: {t.message}"
            for t in recent
        )

        # ── PRIORITY INTERCEPT: task creation / booking completion ──────────────
        agent_lower_check = agent_msg.lower()
        task_trigger_phrases = [
            "would you like me to create a note", "create a note so",
            "team member will reach out", "have someone contact",
            "team will reach out", "team will contact",
            "shall i create", "should i create a note",
            "like me to note", "create a task",
        ]
        if any(ph in agent_lower_check for ph in task_trigger_phrases):
            return "Yes please", False
        completion_phrases = [kw for kw in ALL_SUCCESS_KWS if kw in agent_lower_check]
        if completion_phrases:
            return "Great, thanks!", True
        # ─────────────────────────────────────────────────────────────────────

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
5. If asked "new or existing patient?" / "been here before?" → {"New patient" if persona.is_new else "Existing patient, I've been there before"}
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
                    f"Agent's latest question:\n\"{agent_msg}\"\n\n"
                    f"Your 1-sentence reply:"
                )},
            ],
            max_tokens=40,
            temperature=0.15,
        )
        reply = resp.choices[0].message.content.strip().strip('"').strip("'")

        agent_lower = agent_msg.lower()
        should_end = "[DONE]" in reply or any(kw in agent_lower for kw in ALL_SUCCESS_KWS)
        reply = reply.replace("[DONE]", "").strip()
        return reply, should_end

    except Exception as e:
        return "Yes please", False

def _llm_judge(scenario: str, turns: list[Turn], oai_key: str) -> tuple[int, str]:
    if not oai_key or not turns:
        return 70, "No OpenAI key – default score"
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)
        transcript = "\n".join(f"[{t.role.upper()}] {t.message}" for t in turns)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
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
                        "Also note: was the agent's tone professional? Did patient responses make sense?\n"
                        "Reply ONLY with JSON: {\"score\": <int>, \"reason\": \"<1-2 sentences>\"}"
                    ),
                },
                {"role": "user", "content": f"Scenario: {scenario}\n\nFull transcript:\n{transcript}"},
            ],
            max_tokens=150,
            temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:]).rstrip("`").strip()
        data = json.loads(raw)
        return int(data["score"]), data["reason"]
    except Exception as e:
        return 60, f"Judge error: {e}"

def run_simulation(
    scenario_name: str,
    api_base: str,
    token: str,
    agent_phone: str,
    oai_key: str,
    use_judge: bool = True,
    reuse_phone: Optional[str] = None,
) -> SimResult:
    """
    Smart simulation: GPT-4o-mini patient responds to ACTUAL agent messages.
    Runs until booking confirmed or MAX_TURNS reached.
    """
    config = SCENARIOS[scenario_name]
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
            failure_reason = f"HTTP {e.response.status_code}: {e.response.text[:120]}"
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

        # Handle empty agent response
        if not agent_msg:
            if turn_num == 0:
                failure_reason = "Agent returned no response on first message"
                outcome_type = "error"
                break
            # Empty mid-conversation: agent may be async-processing.
            # Re-generate patient reply from last known agent message and continue.
            last_agent = next((t.message for t in reversed(turns) if t.role == "agent"), "")
            if last_agent and oai_key:
                try:
                    current_msg, should_end = smart_patient_reply(last_agent, persona, turns, config["goal"], oai_key, patient_phone)
                    if should_end:
                        passed = True
                        outcome_type = "task_created" if any(kw in last_agent.lower() for kw in TASK_CREATED_KWS) else "booking_confirmed"
                        break
                    continue  # retry loop with new patient msg, no turn appended
                except Exception:
                    pass
            continue  # skip empty turn silently

        turns.append(Turn("patient", current_msg))
        turns.append(Turn("agent", agent_msg, latency_ms))

        agent_lower = agent_msg.lower()

        # Check for direct booking confirmation
        if any(kw in agent_lower for kw in BOOKING_CONFIRMED_KWS):
            passed = True
            outcome_type = "booking_confirmed"
            break

        # Check for task/note creation (valid fallback path)
        if any(kw in agent_lower for kw in TASK_CREATED_KWS):
            passed = True
            outcome_type = "task_created"
            break

        # Generate smart patient reply
        if not oai_key:
            failure_reason = "No OpenAI key – cannot drive patient responses"
            break

        try:
            current_msg, should_end = smart_patient_reply(
                agent_msg, persona, turns, config["goal"], oai_key, patient_phone
            )
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

    score, judge_reason = (70, "") if not use_judge else _llm_judge(scenario_name, turns, oai_key)
    if not failure_reason and not passed:
        failure_reason = judge_reason

    return SimResult(
        scenario=scenario_name,
        patient_phone=patient_phone,
        turns=turns,
        passed=passed,
        score=score,
        failure_reason=failure_reason if not passed else judge_reason,
        total_ms=total_ms,
        chat_id=chat_id or "",
        outcome_type=outcome_type,
    )

def run_full_chain(
    api_base: str, token: str, agent_phone: str, oai_key: str,
) -> dict[str, SimResult]:
    """
    Book → Reschedule → Cancel using the SAME phone number.
    Each phase uses the patient's actual phone so the agent can look up their appointment.
    """
    phone = _phone()
    results: dict[str, SimResult] = {}

    # Phase 1 – Book
    st.session_state["chain_status"] = "📞 Phase 1/3: Booking new appointment…"
    book = run_simulation("🆕 New Patient – Cleaning", api_base, token, agent_phone, oai_key, reuse_phone=phone)
    results["book"] = book

    # Phase 2 – Reschedule (only if booking worked)
    st.session_state["chain_status"] = "🔄 Phase 2/3: Rescheduling appointment…"
    reschedule = run_simulation("🔄 Reschedule Appointment", api_base, token, agent_phone, oai_key, reuse_phone=phone)
    results["reschedule"] = reschedule

    # Phase 3 – Cancel
    st.session_state["chain_status"] = "❌ Phase 3/3: Cancelling appointment…"
    cancel = run_simulation("❌ Cancel Appointment", api_base, token, agent_phone, oai_key, reuse_phone=phone)
    results["cancel"] = cancel

    st.session_state["chain_status"] = "✅ Chain complete"
    return results

def analyze_screenshot(image_bytes: bytes, oai_key: str, extra_context: str = "") -> dict:
    """GPT-4o Vision: analyse a screenshot → identify issue → generate reproduction steps."""
    if not oai_key:
        return {"analysis": "No OpenAI key provided.", "repro_scenario": None}
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)
        b64 = base64.b64encode(image_bytes).decode()
        prompt = (
            "You are a QA engineer analysing a dental AI receptionist SMS conversation screenshot.\n\n"
            "1. Describe exactly what is shown (conversation flow, agent responses, any errors).\n"
            "2. Identify if there is a bug, unexpected response, or broken flow.\n"
            "3. If there is an issue, describe how to reproduce it: what patient message triggers it.\n"
            "4. Output JSON only:\n"
            '{"summary": "...", "issue_found": true/false, "issue_description": "...", '
            '"repro_opener": "exact first patient message to reproduce", '
            '"repro_followups": ["msg2", "msg3"], "severity": "low|medium|high"}'
        )
        if extra_context:
            prompt += f"\n\nAdditional context from user: {extra_context}"

        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"}},
                    {"type": "text", "text": prompt},
                ],
            }],
            max_tokens=600,
        )
        raw = resp.choices[0].message.content.strip()
        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:])
        if raw.endswith("```"):
            raw = "\n".join(raw.split("\n")[:-1])
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"summary": raw, "issue_found": False, "issue_description": "", "repro_opener": None, "repro_followups": []}
    except Exception as e:
        return {"analysis": f"Error: {e}", "issue_found": False, "repro_opener": None}

def generate_test_scenarios(instruction: str, oai_key: str) -> list[dict]:
    if not oai_key:
        return []
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You generate test scenarios for a dental AI SMS receptionist. "
                        "Given a test description, output a JSON array of scenarios. "
                        "Each: {\"name\": str, \"goal\": str, \"opener\": str, \"followups\": [str, ...]}. "
                        "followups are 3-5 natural patient messages that continue the conversation. "
                        "Output JSON array only."
                    ),
                },
                {"role": "user", "content": f"Test description: {instruction}"},
            ],
            max_tokens=800,
            temperature=0.5,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:])
        if raw.endswith("```"):
            raw = "\n".join(raw.split("\n")[:-1])
        return json.loads(raw)
    except Exception as e:
        st.error(f"Generation error: {e}")
        return []

# ── Display helper ─────────────────────────────────────────────────────────────
def display_result(r: SimResult, expanded: bool = True):
    OUTCOME_META = {
        "booking_confirmed": ("📅", "Booking Confirmed", "#059669", "#F0FDF4", "#BBF7D0"),
        "task_created":      ("📋", "Task Created",      "#C2540A", "#FFF7ED", "#FED7AA"),
        "incomplete":        ("⏳", "Incomplete",         "#B45309", "#FFFBEB", "#FDE68A"),
        "error":             ("🚨", "Error",              "#DC2626", "#FEF2F2", "#FECACA"),
        "":                  ("",   "",                   "#6B7280", "#F9FAFB", "#E5E7EB"),
    }
    icon, label, color, bg, border = OUTCOME_META.get(r.outcome_type, OUTCOME_META[""])

    status_icon = "✅" if r.passed else "❌"
    score_color = "#F5820D" if r.score >= 80 else "#B45309" if r.score >= 60 else "#DC2626"
    header = f"{status_icon}  {r.scenario}   ·   {icon} {label}   ·   Score {r.score}/100   ·   {r.total_ms/1000:.1f}s   ·   {len(r.turns)//2} turns"

    with st.expander(header, expanded=expanded):
        # Outcome banner
        st.markdown(f"""
        <div style="
            background:{bg}; border:1px solid {border}; border-radius:8px;
            padding:10px 16px; margin-bottom:12px;
            display:flex; align-items:center; gap:10px;
        ">
            <span style="font-size:16px;">{icon}</span>
            <div>
                <span style="font-weight:700; color:{color}; font-size:13px;">{label}</span>
                {'<span style="color:#888888; font-size:12px; margin-left:8px;">— Direct booking by agent</span>' if r.outcome_type == "booking_confirmed" else
                 '<span style="color:#888888; font-size:12px; margin-left:8px;">— Agent collected info and created a task for the team (valid flow)</span>' if r.outcome_type == "task_created" else
                 f'<span style="color:#888888; font-size:12px; margin-left:8px;">{r.failure_reason[:80]}</span>' if r.outcome_type in ("error","incomplete") else ""}
            </div>
            <div style="margin-left:auto; background:white; border:1px solid {border}; border-radius:6px; padding:4px 12px; text-align:center;">
                <div style="font-size:10px; color:#94A3B8; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Score</div>
                <div style="font-size:20px; font-weight:800; color:{score_color}; letter-spacing:-0.5px;">{r.score}</div>
            </div>
        </div>
        """, unsafe_allow_html=True)

        # Conversation transcript
        st.markdown("""
        <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#94A3B8; margin-bottom:12px;">
            Conversation Transcript
        </div>""", unsafe_allow_html=True)

        for t in r.turns:
            if t.role == "patient":
                st.markdown(f"""
                <div style="display:flex; align-items:flex-start; gap:10px; margin-bottom:8px;">
                    <div style="width:28px; height:28px; background:#E2E8F0; border-radius:50%;
                                display:flex; align-items:center; justify-content:center;
                                font-size:13px; flex-shrink:0;">👤</div>
                    <div>
                        <div style="font-size:10px; font-weight:600; color:#94A3B8; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:3px;">Patient</div>
                        <div class="patient-bubble">{t.message}</div>
                    </div>
                </div>""", unsafe_allow_html=True)
            else:
                latency = f'<span class="latency-badge">· {t.latency_ms:,}ms</span>' if t.latency_ms else ""
                st.markdown(f"""
                <div style="display:flex; align-items:flex-start; gap:10px; margin-bottom:8px; flex-direction:row-reverse;">
                    <div style="width:28px; height:28px; background:#DBEAFE; border-radius:50%;
                                display:flex; align-items:center; justify-content:center;
                                font-size:13px; flex-shrink:0;">🤖</div>
                    <div style="text-align:right;">
                        <div style="font-size:10px; font-weight:600; color:#93C5FD; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:3px;">Siriyaa {latency}</div>
                        <div class="agent-bubble">{t.message}</div>
                    </div>
                </div>""", unsafe_allow_html=True)

        st.divider()
        if r.failure_reason:
            label_txt = "Judge note" if r.passed else "Failure reason"
            txt_color = "#059669" if r.passed else "#DC2626"
            st.markdown(f'<div style="font-size:12.5px; color:{txt_color};"><strong>{label_txt}:</strong> {r.failure_reason}</div>', unsafe_allow_html=True)
        st.markdown(f'<div style="font-size:11px; color:#94A3B8; margin-top:6px;">📞 {r.patient_phone} &nbsp;·&nbsp; 🔗 <code style="background:#F1F5F9;padding:1px 5px;border-radius:4px;font-size:11px;">{r.chat_id[:28] if r.chat_id else "—"}</code></div>', unsafe_allow_html=True)

# ── Tabs ──────────────────────────────────────────────────────────────────────
tab1, tab2, tab3, tab4, tab5 = st.tabs([
    "Simulations",
    "E2E Chain",
    "Screenshot",
    "Test Generator",
    "Dashboard",
])

# ────────────────────────────────────────────────────────────────────────────────
# TAB 1 – Smart Simulations
# ────────────────────────────────────────────────────────────────────────────────
with tab1:
    st.markdown("""
    <div style="margin-bottom:24px;">
        <div style="font-size:20px; font-weight:800; color:#111; letter-spacing:-0.4px; margin-bottom:5px;">Smart Simulations</div>
        <div style="font-size:13.5px; color:#888; line-height:1.5;">
            GPT-4o-mini acts as the patient — reads every agent reply and responds naturally.
            Runs until booking is confirmed or a task is created.
        </div>
    </div>
    """, unsafe_allow_html=True)

    col1, col2 = st.columns([2, 1])
    with col1:
        selected = st.multiselect(
            "Scenarios to run",
            list(SCENARIOS.keys()),
            default=list(SCENARIOS.keys())[:3],
        )
    with col2:
        repeats = st.number_input("Runs per scenario", 1, 5, 1)
        parallel_n = st.number_input("Max parallel", 1, MAX_PARALLEL, min(MAX_PARALLEL, len(selected) or 1))

    if st.button("▶ Run Simulations", type="primary", use_container_width=True, disabled=st.session_state.running):
        if not bearer_token:
            st.error("Bearer token required in sidebar.")
        elif not selected:
            st.error("Select at least one scenario.")
        elif not openai_key:
            st.warning("⚠️ No OpenAI key — simulations will only run 1 turn each (no smart patient).")
        else:
            st.session_state.running = True
            tasks = [(s, r) for s in selected for r in range(repeats)]
            new_results: list[SimResult] = []
            prog = st.progress(0, text="Starting…")
            status_area = st.empty()
            completed = 0

            with ThreadPoolExecutor(max_workers=parallel_n) as ex:
                futures = {
                    ex.submit(
                        run_simulation,
                        scenario_name=s,
                        api_base=api_base,
                        token=bearer_token,
                        agent_phone=agent_phone,
                        oai_key=openai_key,
                        use_judge=use_llm_judge,
                    ): (s, i)
                    for s, i in tasks
                }
                for fut in as_completed(futures):
                    completed += 1
                    prog.progress(completed / len(tasks), text=f"{completed}/{len(tasks)} done")
                    try:
                        res = fut.result()
                        new_results.append(res)
                        status_area.success(f"{'✅' if res.passed else '❌'} {res.scenario} — {res.score}/100")
                    except Exception as e:
                        s, _ = futures[fut]
                        st.error(f"❌ {s}: {e}")

            st.session_state.results = new_results + st.session_state.results
            st.session_state.running = False
            prog.empty()
            status_area.empty()
            st.rerun()

    if st.session_state.results:
        n_pass = sum(1 for r in st.session_state.results if r.passed)
        n_total = len(st.session_state.results)
        avg_score = sum(r.score for r in st.session_state.results) / n_total if n_total else 0
        avg_ms = sum(r.total_ms for r in st.session_state.results) / n_total if n_total else 0
        m1, m2, m3 = st.columns(3)
        m1.metric("Pass Rate", f"{n_pass}/{n_total} ({100*n_pass//n_total}%)")
        m2.metric("Avg Score", f"{avg_score:.0f}/100")
        m3.metric("Avg Time", f"{avg_ms/1000:.1f}s")
        st.divider()
        for r in st.session_state.results[:20]:
            display_result(r, expanded=False)
        if st.button("🗑 Clear results"):
            st.session_state.results = []
            st.rerun()

# ────────────────────────────────────────────────────────────────────────────────
# TAB 2 – Full E2E Chain
# ────────────────────────────────────────────────────────────────────────────────
with tab2:
    st.markdown("""
    <div style="margin-bottom:24px;">
        <div style="font-size:20px; font-weight:800; color:#111; letter-spacing:-0.4px; margin-bottom:5px;">Full E2E Chain</div>
        <div style="font-size:13.5px; color:#888; line-height:1.5;">
            Book → Reschedule → Cancel on one phone number. Each phase looks up the appointment
            from the previous — exercises the full API chain end-to-end.
        </div>
    </div>
    """, unsafe_allow_html=True)

    st.markdown("""
    <div style="display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap;">
        <div style="flex:1; min-width:220px; background:white; border:1px solid #E2E8F0; border-radius:12px; padding:20px; border-top:3px solid #2563EB;">
            <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#94A3B8; margin-bottom:12px;">Three Phases</div>
            <div style="font-size:13.5px; color:#444444; line-height:2;">
                <div>1 &nbsp;·&nbsp; 🆕 Book new appointment</div>
                <div>2 &nbsp;·&nbsp; 🔄 Reschedule that appointment</div>
                <div>3 &nbsp;·&nbsp; ❌ Cancel the appointment</div>
            </div>
        </div>
        <div style="flex:1; min-width:220px; background:white; border:1px solid #E2E8F0; border-radius:12px; padding:20px; border-top:3px solid #10B981;">
            <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#94A3B8; margin-bottom:12px;">API Chain Covered</div>
            <div style="font-size:13.5px; color:#444444; line-height:2;">
                <div>· Create New Patient</div>
                <div>· Get Available Slots</div>
                <div>· Book / Modify / Cancel Appointment</div>
                <div>· Upcoming Appointment lookup</div>
                <div>· Task Creation</div>
            </div>
        </div>
    </div>
    """, unsafe_allow_html=True)

    chain_status = st.empty()
    if "chain_status" in st.session_state:
        chain_status.info(st.session_state.get("chain_status", ""))

    if st.button("▶ Run Full Chain", type="primary", use_container_width=True):
        if not bearer_token:
            st.error("Bearer token required.")
        elif not openai_key:
            st.error("OpenAI key required for smart patient responses.")
        else:
            with st.spinner("Running Book → Reschedule → Cancel…"):
                chain_res = run_full_chain(api_base, bearer_token, agent_phone, openai_key)
                st.session_state.chain_results = chain_res

    if st.session_state.chain_results:
        cr = st.session_state.chain_results
        phases = [("📞 Phase 1 – Book", "book"), ("🔄 Phase 2 – Reschedule", "reschedule"), ("❌ Phase 3 – Cancel", "cancel")]
        cols = st.columns(3)
        for col, (label, key) in zip(cols, phases):
            if key in cr:
                r = cr[key]
                col.metric(label, f"{'✅ Passed' if r.passed else '❌ Failed'}", f"{r.score}/100 · {r.total_ms/1000:.1f}s")

        st.divider()
        for label, key in phases:
            if key in cr:
                st.subheader(label)
                display_result(cr[key], expanded=True)
                st.divider()

# ────────────────────────────────────────────────────────────────────────────────
# TAB 3 – Screenshot Reproduce
# ────────────────────────────────────────────────────────────────────────────────
with tab3:
    st.markdown("""
    <div style="margin-bottom:24px;">
        <div style="font-size:20px; font-weight:800; color:#111; letter-spacing:-0.4px; margin-bottom:5px;">Screenshot Reproduce</div>
        <div style="font-size:13.5px; color:#888; line-height:1.5;">
            Upload a conversation screenshot — GPT-4o Vision identifies the issue
            and auto-runs a reproduction simulation.
        </div>
    </div>
    """, unsafe_allow_html=True)

    uploaded = st.file_uploader("Upload screenshot (PNG/JPG)", type=["png", "jpg", "jpeg", "webp"])
    extra_ctx = st.text_area("Extra context (optional)", placeholder="e.g. 'This happens when patient says they have no insurance'")

    if uploaded and st.button("🔍 Analyse & Reproduce", type="primary"):
        if not openai_key:
            st.error("OpenAI key required for vision analysis.")
        else:
            img_bytes = uploaded.read()
            with st.spinner("Analysing screenshot with GPT-4o Vision…"):
                analysis = analyze_screenshot(img_bytes, openai_key, extra_ctx)

            st.subheader("Analysis")
            col1, col2 = st.columns([1, 2])
            with col1:
                st.image(img_bytes, caption="Uploaded screenshot", use_container_width=True)
            with col2:
                if analysis.get("issue_found"):
                    st.error(f"🐛 Issue found: **{analysis.get('issue_description', '')}**")
                    st.markdown(f"**Severity:** {analysis.get('severity', 'unknown')}")
                else:
                    st.success("No obvious issue detected.")
                st.markdown(f"**Summary:** {analysis.get('summary', '')}")

            repro_opener = analysis.get("repro_opener")
            if repro_opener:
                st.subheader("Reproduction test")
                st.markdown(f"**Opener:** `{repro_opener}`")
                followups = analysis.get("repro_followups", [])
                if followups:
                    st.markdown("**Follow-ups:**")
                    for i, msg in enumerate(followups, 1):
                        st.markdown(f"{i}. `{msg}`")

                if st.button("▶ Run Reproduction Test"):
                    if not bearer_token:
                        st.error("Bearer token required.")
                    else:
                        # Build a custom scenario from the analysis
                        custom_scenario = {
                            "goal": f"Reproduce: {analysis.get('issue_description', 'unknown issue')}",
                            "opener": repro_opener,
                            "type": "repro",
                            "persona_idx": 0,
                        }
                        SCENARIOS["🔬 Screenshot Repro"] = custom_scenario

                        with st.spinner("Running reproduction…"):
                            repro_result = run_simulation(
                                "🔬 Screenshot Repro",
                                api_base, bearer_token, agent_phone, openai_key,
                                use_judge=True,
                            )

                        if repro_result.passed:
                            st.warning("⚠️ Scenario ran to completion — issue may not be reproducible or behaves differently now.")
                        else:
                            st.error(f"❗ Reproduced: {repro_result.failure_reason}")

                        display_result(repro_result, expanded=True)
                        st.session_state.results.append(repro_result)

# ────────────────────────────────────────────────────────────────────────────────
# TAB 4 – Instruction Tests
# ────────────────────────────────────────────────────────────────────────────────
with tab4:
    st.markdown("""
    <div style="margin-bottom:24px;">
        <div style="font-size:20px; font-weight:800; color:#111; letter-spacing:-0.4px; margin-bottom:5px;">Test Generator</div>
        <div style="font-size:13.5px; color:#888; line-height:1.5;">
            Describe what you want to test in plain English — GPT-4o-mini generates
            realistic scenarios and runs them automatically.
        </div>
    </div>
    """, unsafe_allow_html=True)

    instruction = st.text_area(
        "Test description",
        placeholder=(
            "e.g. 'Test that the agent correctly handles a patient who initially asks about insurance, "
            "then decides to book, but wants to reschedule twice before confirming'"
        ),
        height=100,
    )

    if st.button("⚡ Generate & Run Tests", type="primary"):
        if not openai_key:
            st.error("OpenAI key required.")
        elif not instruction:
            st.error("Enter a test description.")
        elif not bearer_token:
            st.error("Bearer token required.")
        else:
            with st.spinner("Generating test scenarios…"):
                generated = generate_test_scenarios(instruction, openai_key)

            if not generated:
                st.error("Could not generate scenarios.")
            else:
                st.success(f"Generated {len(generated)} scenario(s). Running…")
                prog = st.progress(0)
                gen_results = []
                for i, sc in enumerate(generated):
                    SCENARIOS[sc["name"]] = {
                        "goal": sc["goal"],
                        "opener": sc["opener"],
                        "type": "generated",
                        "persona_idx": random.randint(0, len(PERSONAS) - 1),
                    }
                    with st.spinner(f"Running: {sc['name']}…"):
                        r = run_simulation(sc["name"], api_base, bearer_token, agent_phone, openai_key)
                    gen_results.append(r)
                    st.session_state.results.append(r)
                    prog.progress((i + 1) / len(generated))

                for r in gen_results:
                    display_result(r, expanded=True)

# ────────────────────────────────────────────────────────────────────────────────
# TAB 5 – Dashboard
# ────────────────────────────────────────────────────────────────────────────────
with tab5:
    st.markdown("""
    <div style="margin-bottom:24px;">
        <div style="font-size:20px; font-weight:800; color:#111; letter-spacing:-0.4px; margin-bottom:5px;">Results Dashboard</div>
        <div style="font-size:13.5px; color:#888; line-height:1.5;">
            Aggregated pass rates, scores and latency across all simulation runs.
        </div>
    </div>
    """, unsafe_allow_html=True)

    all_results = st.session_state.results
    chain = st.session_state.chain_results

    # Include chain results in dashboard
    all_display = list(all_results)
    if chain:
        all_display += [v for v in chain.values()]

    if not all_display:
        st.markdown("""
        <div style="text-align:center; padding:60px 20px; color:#94A3B8;">
            <div style="font-size:40px; margin-bottom:12px;">📊</div>
            <div style="font-size:16px; font-weight:600; color:#888888;">No results yet</div>
            <div style="font-size:13px; margin-top:6px;">Run simulations in the <strong>Simulations</strong> or <strong>E2E Chain</strong> tab to see results here.</div>
        </div>
        """, unsafe_allow_html=True)
    else:
        rows = []
        for r in all_display:
            rows.append({
                "Scenario": r.scenario,
                "Passed": "✅" if r.passed else "❌",
                "Score": r.score,
                "Total ms": r.total_ms,
                "Turns": len(r.turns) // 2,
                "Phone": r.patient_phone,
                "Failure / Note": r.failure_reason[:80] if r.failure_reason else "",
                "chat_id": r.chat_id,
            })
        df = pd.DataFrame(rows)

        c1, c2, c3, c4 = st.columns(4)
        n_pass = sum(1 for r in all_display if r.passed)
        c1.metric("Total runs", len(all_display))
        c2.metric("Passed", f"{n_pass} ({100*n_pass//len(all_display)}%)")
        c3.metric("Avg score", f"{df['Score'].mean():.0f}/100")
        c4.metric("Avg time", f"{df['Total ms'].mean()/1000:.1f}s")

        st.divider()

        # Per-scenario summary
        st.subheader("Per-Scenario Summary")
        grp = df.groupby("Scenario").agg(
            Runs=("Score", "count"),
            Pass_Rate=("Passed", lambda x: f"{(x=='✅').sum()}/{len(x)}"),
            Avg_Score=("Score", "mean"),
            Avg_ms=("Total ms", "mean"),
        ).reset_index()
        grp["Avg_Score"] = grp["Avg_Score"].round(0).astype(int)
        grp["Avg_ms"] = (grp["Avg_ms"] / 1000).round(1).astype(str) + "s"
        st.dataframe(grp, use_container_width=True, hide_index=True)

        st.subheader("All Runs")
        st.dataframe(df, use_container_width=True, hide_index=True)

        csv = df.to_csv(index=False)
        st.download_button(
            "⬇️ Download CSV",
            csv,
            f"adit_sim_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            "text/csv",
        )
