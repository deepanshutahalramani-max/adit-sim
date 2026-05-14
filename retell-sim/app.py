"""
ADIT SMS Agent – Parallel Testing Platform
==========================================
Complete testing harness for the fd-sms / Retell SMS agent with:
  • 20 parallel simulations against live or dev host
  • GPT-4o Vision screenshot analysis for bug reproducibility
  • Instruction-based test generation via GPT-4o-mini
  • Live performance dashboard with pass-rates and scoring
"""
from __future__ import annotations

import base64
import json
import os
import random
import string
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Any, Optional

import httpx
import pandas as pd
import streamlit as st

# ── Page config ───────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="ADIT SMS Agent Tester",
    page_icon="🦷",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Hosts ─────────────────────────────────────────────────────────────────────
HOSTS = {
    "🟢 Live  (frontdeskchatagent.adit.com)": "https://frontdeskchatagent.adit.com",
    "🔵 Dev   (RunPod beta)": "https://gjqwwdfeo35edl-8009.proxy.runpod.net",
}

MAX_PARALLEL = 20
DEFAULT_AGENT_PHONE = "+14122652546"   # Sofia – Elegant Dental

# ── Preset scenarios ──────────────────────────────────────────────────────────
PRESET_SCENARIOS: dict[str, list[str]] = {
    "🆕 Book – New Patient": [
        "Hi, I'd like to book a new patient appointment",
        "I need a general cleaning and check-up",
        "Saturday morning works best for me",
        "My name is Jamie Chen, date of birth April 12 1990",
        "Great, please confirm the booking",
    ],
    "📅 Book – Existing Patient": [
        "Hi, I need to schedule an appointment",
        "I'm an existing patient – John Smith, DOB March 5 1985",
        "I have a toothache on my lower left side",
        "As soon as possible please",
        "Yes, confirm it",
    ],
    "🚨 Dental Emergency": [
        "I have a severe toothache and need help urgently",
        "It started this morning, it's really painful",
        "I'm an existing patient, Maria Garcia",
        "Today if possible",
        "Yes please book me in",
    ],
    "🔄 Reschedule Appointment": [
        "Hi, I need to reschedule my appointment",
        "It's booked for next Tuesday at 2pm",
        "I'd prefer Thursday afternoon instead",
        "Yes, that works perfectly",
    ],
    "❌ Cancel Appointment": [
        "I need to cancel my appointment",
        "It's for tomorrow at 10am",
        "Something came up at work",
        "Yes please cancel it",
    ],
    "🕐 Check Office Hours": [
        "What are your office hours?",
        "Are you open on Saturdays?",
        "What about Sunday?",
        "Thanks, that's all I needed",
    ],
    "🏥 Insurance Question": [
        "Do you accept Delta Dental insurance?",
        "What about Cigna?",
        "I have PPO coverage",
        "Great, I'd like to book an appointment",
        "Next week if possible",
    ],
    "📞 Recall / Follow-up": [
        "I haven't been in for a while and wanted to check in",
        "It's been about 18 months since my last cleaning",
        "I'm available weekday mornings",
        "My name is Robert Lee, DOB June 20 1978",
        "Yes, book me in",
    ],
    "🔕 Out of Hours": [
        "Hi, is anyone there?",
        "I wanted to book an appointment for next week",
        "Monday or Tuesday morning",
        "Yes, that would work",
    ],
    "💊 Post-Treatment Follow-up": [
        "I had a filling done last week and it's still sensitive",
        "It hurts when I drink cold water",
        "Should I come back in?",
        "Yes please book me for a check",
    ],
}

# ── Data classes ──────────────────────────────────────────────────────────────
@dataclass
class Turn:
    role: str        # "patient" | "agent"
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

# ── Session state init ────────────────────────────────────────────────────────
if "results" not in st.session_state:
    st.session_state.results: list[SimResult] = []
if "running" not in st.session_state:
    st.session_state.running = False

# ── Sidebar ───────────────────────────────────────────────────────────────────
with st.sidebar:
    st.title("🦷 ADIT SMS Tester")
    st.divider()

    host_label = st.selectbox("API Host", list(HOSTS.keys()))
    api_base = HOSTS[host_label]

    bearer_token = st.text_input(
        "Bearer Token (API_ACCESS_TOKEN)",
        value=os.environ.get("API_ACCESS_TOKEN", ""),
        type="password",
        help="The API_ACCESS_TOKEN set on the fd-sms server",
    )

    agent_phone = st.text_input(
        "Agent Phone (E.164)",
        value=os.environ.get("AGENT_PHONE", DEFAULT_AGENT_PHONE),
        help="The practice/agent phone that resolves to Sofia",
    )

    openai_key = st.text_input(
        "OpenAI API Key",
        value=os.environ.get("OPENAI_API_KEY", ""),
        type="password",
        help="Used for LLM judge scoring and screenshot analysis",
    )

    use_llm_judge = st.toggle("LLM Judge (GPT-4o-mini)", value=True)

    st.divider()
    st.caption(f"Agent: **Sofia** · Elegant Dental")
    st.caption(f"Phone: `{agent_phone}`")
    st.caption(f"Host: `{api_base}`")

# ── Helpers ───────────────────────────────────────────────────────────────────
def _phone() -> str:
    return "+1555" + "".join(random.choices(string.digits, k=7))

def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

def _call_agent(
    api_base: str,
    token: str,
    message: str,
    patient_phone: str,
    agent_phone: str,
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
        headers=_headers(token),
        json=payload,
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()

def _llm_judge(scenario: str, turns: list[Turn], oai_key: str) -> tuple[int, str]:
    """Score 0-100 + reason using GPT-4o-mini."""
    if not oai_key:
        return 70, "No OpenAI key – default score"
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)
        transcript = "\n".join(
            f"[{t.role.upper()}] {t.message}" for t in turns
        )
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a quality evaluator for a dental front-desk AI SMS agent called Sofia. "
                        "Score the conversation 0-100 where 100=perfect. "
                        "Evaluate: correct intent handling, professional tone, booking completion, "
                        "no hallucinations. Reply with JSON only: {\"score\": <int>, \"reason\": \"<string>\"}"
                    ),
                },
                {
                    "role": "user",
                    "content": f"Scenario: {scenario}\n\nTranscript:\n{transcript}",
                },
            ],
            max_tokens=150,
            temperature=0,
        )
        data = json.loads(resp.choices[0].message.content)
        return int(data["score"]), data["reason"]
    except Exception as e:
        return 50, f"Judge error: {e}"

def run_simulation(
    scenario_name: str,
    messages: list[str],
    api_base: str,
    token: str,
    agent_phone: str,
    use_judge: bool,
    oai_key: str,
) -> SimResult:
    patient_phone = _phone()
    result = SimResult(scenario=scenario_name, patient_phone=patient_phone)
    chat_id: Optional[str] = None
    start = time.time()

    try:
        for i, msg in enumerate(messages):
            is_last = i == len(messages) - 1
            t0 = time.time()
            resp = _call_agent(
                api_base, token, msg, patient_phone, agent_phone,
                chat_id=chat_id,
                end_conversation=is_last,
            )
            latency = int((time.time() - t0) * 1000)
            data = resp.get("data", {})
            chat_id = data.get("chat_id") or chat_id

            result.turns.append(Turn("patient", msg))
            agent_resp = data.get("agent_response", "")
            if agent_resp:
                result.turns.append(Turn("agent", agent_resp, latency_ms=latency))

        result.total_ms = int((time.time() - start) * 1000)
        result.chat_id = chat_id or ""

        if use_judge and oai_key:
            result.score, reason = _llm_judge(scenario_name, result.turns, oai_key)
        else:
            result.score = 75

        result.passed = result.score >= 60 and len(result.turns) >= 2
        if not result.passed:
            result.failure_reason = "Low score or empty response"

    except httpx.HTTPStatusError as e:
        result.failure_reason = f"HTTP {e.response.status_code}: {e.response.text[:200]}"
        result.score = 0
    except Exception as e:
        result.failure_reason = str(e)[:200]
        result.score = 0

    return result

def analyze_screenshot(img_b64: str, bug_desc: str, oai_key: str) -> str:
    if not oai_key:
        return "⚠️ No OpenAI key configured."
    try:
        from openai import OpenAI
        client = OpenAI(api_key=oai_key)
        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"You are a QA engineer reviewing the ADIT dental SMS agent (Sofia). "
                                f"The reported bug is: '{bug_desc}'. "
                                "Analyze this screenshot and determine: "
                                "1) Is this bug visible/reproducible here? "
                                "2) What exactly is wrong? "
                                "3) What is the likely root cause? "
                                "4) Suggested fix? "
                                "Be concise and specific."
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{img_b64}"},
                        },
                    ],
                }
            ],
            max_tokens=500,
        )
        return resp.choices[0].message.content
    except Exception as e:
        return f"❌ Analysis failed: {e}"

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
                        "You generate SMS test scenarios for a dental AI agent called Sofia at Elegant Dental. "
                        "Given a test instruction, output a JSON array of scenarios. "
                        "Each scenario: {\"name\": str, \"messages\": [str, str, ...]} "
                        "Messages are what the PATIENT sends (2-6 messages). "
                        "Generate 3-5 scenarios covering edge cases. Output only valid JSON."
                    ),
                },
                {"role": "user", "content": instruction},
            ],
            max_tokens=1000,
            temperature=0.7,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        return json.loads(raw)
    except Exception as e:
        st.error(f"Scenario generation failed: {e}")
        return []

# ── Tabs ──────────────────────────────────────────────────────────────────────
tab_sim, tab_ss, tab_instr, tab_dash = st.tabs([
    "🚀 Parallel Simulations",
    "📸 Screenshot Analysis",
    "📋 Instruction Tests",
    "📊 Dashboard",
])

# ── Tab 1: Parallel Simulations ───────────────────────────────────────────────
with tab_sim:
    st.header("🚀 Parallel Simulations")

    col1, col2 = st.columns([2, 1])
    with col1:
        selected = st.multiselect(
            "Select scenarios to run",
            list(PRESET_SCENARIOS.keys()),
            default=list(PRESET_SCENARIOS.keys())[:5],
        )
    with col2:
        n_parallel = st.slider("Parallel workers", 1, MAX_PARALLEL, 5)
        runs_per = st.number_input("Runs per scenario", 1, 5, 1)

    custom_expander = st.expander("➕ Add custom scenario")
    with custom_expander:
        custom_name = st.text_input("Scenario name", placeholder="e.g. Angry patient")
        custom_msgs_raw = st.text_area(
            "Patient messages (one per line)",
            placeholder="Hi I need help\nI've been waiting 3 weeks\nThis is unacceptable",
        )

    run_btn = st.button(
        "▶ Run Simulations",
        type="primary",
        disabled=st.session_state.running,
        use_container_width=True,
    )

    if run_btn:
        if not bearer_token:
            st.error("⚠️ Enter the Bearer Token in the sidebar first.")
        elif not selected and not (custom_name and custom_msgs_raw):
            st.error("⚠️ Select at least one scenario.")
        else:
            # Build job list
            jobs: list[tuple[str, list[str]]] = []
            for name in selected:
                for _ in range(int(runs_per)):
                    jobs.append((name, PRESET_SCENARIOS[name]))
            if custom_name and custom_msgs_raw:
                msgs = [m.strip() for m in custom_msgs_raw.strip().splitlines() if m.strip()]
                for _ in range(int(runs_per)):
                    jobs.append((custom_name, msgs))

            st.session_state.running = True
            st.session_state.results = []

            progress = st.progress(0, text=f"Running {len(jobs)} simulations…")
            results_container = st.container()

            with ThreadPoolExecutor(max_workers=n_parallel) as ex:
                futures = {
                    ex.submit(
                        run_simulation,
                        name, msgs, api_base, bearer_token,
                        agent_phone, use_llm_judge, openai_key,
                    ): (name, msgs)
                    for name, msgs in jobs
                }
                done = 0
                for fut in as_completed(futures):
                    done += 1
                    res = fut.result()
                    st.session_state.results.append(res)
                    progress.progress(done / len(jobs), text=f"Completed {done}/{len(jobs)}")

                    icon = "✅" if res.passed else "❌"
                    with results_container:
                        with st.expander(
                            f"{icon} {res.scenario} · Score: {res.score}/100 · {res.total_ms}ms",
                            expanded=not res.passed,
                        ):
                            if res.failure_reason:
                                st.error(res.failure_reason)
                            for t in res.turns:
                                if t.role == "patient":
                                    st.markdown(f"**👤 Patient:** {t.message}")
                                else:
                                    st.markdown(f"**🤖 Sofia:** {t.message}")
                                    if t.latency_ms:
                                        st.caption(f"↳ {t.latency_ms}ms")
                            if res.chat_id:
                                st.caption(f"chat_id: `{res.chat_id}`")

            progress.empty()
            st.session_state.running = False

            total = len(st.session_state.results)
            passed = sum(1 for r in st.session_state.results if r.passed)
            avg_score = sum(r.score for r in st.session_state.results) / total if total else 0
            avg_ms = sum(r.total_ms for r in st.session_state.results) / total if total else 0

            st.divider()
            m1, m2, m3, m4 = st.columns(4)
            m1.metric("Total Runs", total)
            m2.metric("Pass Rate", f"{passed/total*100:.0f}%" if total else "—")
            m3.metric("Avg Score", f"{avg_score:.0f}/100")
            m4.metric("Avg Latency", f"{avg_ms/1000:.1f}s")

# ── Tab 2: Screenshot Analysis ────────────────────────────────────────────────
with tab_ss:
    st.header("📸 Screenshot Analysis")
    st.write("Upload a screenshot of a bug in Sofia's responses and get a GPT-4o Vision analysis.")

    bug_desc = st.text_area(
        "Describe the bug you're investigating",
        placeholder="e.g. Sofia is confirming a booking but the patient never gave their name or DOB",
    )
    uploaded = st.file_uploader("Upload screenshot", type=["png", "jpg", "jpeg", "webp"])

    if st.button("🔍 Analyse Screenshot", type="primary"):
        if not openai_key:
            st.error("⚠️ OpenAI key required.")
        elif not uploaded:
            st.error("⚠️ Please upload a screenshot.")
        elif not bug_desc.strip():
            st.error("⚠️ Please describe the bug.")
        else:
            with st.spinner("Analysing with GPT-4o Vision…"):
                img_b64 = base64.b64encode(uploaded.read()).decode()
                analysis = analyze_screenshot(img_b64, bug_desc, openai_key)
            st.divider()
            st.subheader("Analysis")
            st.markdown(analysis)

# ── Tab 3: Instruction Tests ──────────────────────────────────────────────────
with tab_instr:
    st.header("📋 Instruction-Based Tests")
    st.write("Describe what you want to test in plain English and GPT-4o-mini will generate and run the scenarios.")

    instruction = st.text_area(
        "Test instruction",
        placeholder=(
            "e.g. Test edge cases where a patient tries to book outside business hours, "
            "gives incomplete information, or asks about multiple services at once"
        ),
        height=120,
    )

    col_gen, col_run = st.columns([1, 1])

    if col_gen.button("⚙️ Generate Scenarios", use_container_width=True):
        if not openai_key:
            st.error("⚠️ OpenAI key required.")
        elif not instruction.strip():
            st.error("⚠️ Enter an instruction.")
        else:
            with st.spinner("Generating with GPT-4o-mini…"):
                scenarios = generate_test_scenarios(instruction, openai_key)
            if scenarios:
                st.session_state["gen_scenarios"] = scenarios
                st.success(f"Generated {len(scenarios)} scenarios")
                for s in scenarios:
                    with st.expander(s["name"]):
                        for m in s["messages"]:
                            st.markdown(f"• {m}")

    gen = st.session_state.get("gen_scenarios", [])
    if gen and col_run.button("▶ Run Generated Tests", type="primary", use_container_width=True):
        if not bearer_token:
            st.error("⚠️ Enter the Bearer Token in the sidebar.")
        else:
            progress2 = st.progress(0, text="Running generated tests…")
            gen_results = []
            with ThreadPoolExecutor(max_workers=min(len(gen), 10)) as ex:
                futures2 = {
                    ex.submit(
                        run_simulation,
                        s["name"], s["messages"], api_base, bearer_token,
                        agent_phone, use_llm_judge, openai_key,
                    ): s
                    for s in gen
                }
                done2 = 0
                for fut2 in as_completed(futures2):
                    done2 += 1
                    res2 = fut2.result()
                    gen_results.append(res2)
                    st.session_state.results.append(res2)
                    progress2.progress(done2 / len(gen))
                    icon = "✅" if res2.passed else "❌"
                    with st.expander(f"{icon} {res2.scenario} · {res2.score}/100", expanded=False):
                        for t in res2.turns:
                            label = "**👤 Patient:**" if t.role == "patient" else "**🤖 Sofia:**"
                            st.markdown(f"{label} {t.message}")
                        if res2.failure_reason:
                            st.error(res2.failure_reason)
            progress2.empty()
            passed2 = sum(1 for r in gen_results if r.passed)
            st.success(f"Done: {passed2}/{len(gen_results)} passed")

# ── Tab 4: Dashboard ──────────────────────────────────────────────────────────
with tab_dash:
    st.header("📊 Dashboard")

    results = st.session_state.results
    if not results:
        st.info("No results yet — run some simulations first.")
    else:
        total = len(results)
        passed = sum(1 for r in results if r.passed)
        failed = total - passed
        avg_score = sum(r.score for r in results) / total
        avg_ms = sum(r.total_ms for r in results) / total

        c1, c2, c3, c4, c5 = st.columns(5)
        c1.metric("Total Runs", total)
        c2.metric("✅ Passed", passed)
        c3.metric("❌ Failed", failed)
        c4.metric("Avg Score", f"{avg_score:.0f}/100")
        c5.metric("Avg Latency", f"{avg_ms/1000:.1f}s")

        st.divider()

        # Score by scenario
        df = pd.DataFrame([
            {
                "Scenario": r.scenario,
                "Passed": r.passed,
                "Score": r.score,
                "Latency (s)": round(r.total_ms / 1000, 2),
                "Turns": len(r.turns),
                "Failure": r.failure_reason or "—",
                "chat_id": r.chat_id,
            }
            for r in results
        ])

        st.subheader("Results by Scenario")
        scenario_summary = (
            df.groupby("Scenario")
            .agg(
                Runs=("Score", "count"),
                Pass_Rate=("Passed", lambda x: f"{x.mean()*100:.0f}%"),
                Avg_Score=("Score", lambda x: f"{x.mean():.0f}"),
                Avg_Latency=("Latency (s)", lambda x: f"{x.mean():.1f}s"),
            )
            .reset_index()
        )
        st.dataframe(scenario_summary, use_container_width=True)

        st.subheader("All Runs")
        st.dataframe(df.drop(columns=["chat_id"]), use_container_width=True)

        # Score distribution
        st.subheader("Score Distribution")
        bins = {"0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0}
        for r in results:
            if r.score <= 20: bins["0-20"] += 1
            elif r.score <= 40: bins["21-40"] += 1
            elif r.score <= 60: bins["41-60"] += 1
            elif r.score <= 80: bins["61-80"] += 1
            else: bins["81-100"] += 1
        st.bar_chart(pd.DataFrame.from_dict(bins, orient="index", columns=["Count"]))

        # Failures
        failures = [r for r in results if not r.passed]
        if failures:
            st.subheader("❌ Failure Analysis")
            for r in failures:
                with st.expander(f"{r.scenario} · Score {r.score}"):
                    st.error(r.failure_reason)
                    for t in r.turns:
                        label = "**👤 Patient:**" if t.role == "patient" else "**🤖 Sofia:**"
                        st.markdown(f"{label} {t.message}")

        if st.button("🗑 Clear All Results"):
            st.session_state.results = []
            st.rerun()

        # Export
        csv = df.to_csv(index=False)
        st.download_button(
            "⬇ Export CSV",
            csv,
            file_name=f"adit_sms_test_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            mime="text/csv",
        )
