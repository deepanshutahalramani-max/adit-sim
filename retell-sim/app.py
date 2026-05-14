"""
Retell SMS Agent – Parallel Testing Platform
=============================================
Streamlit app for stress-testing the fd-sms API with:
  • Up to 20 parallel simulations
  • Screenshot analysis (GPT-4o Vision → reproducibility verdict)
  • Instruction-based test generation (GPT-4o-mini → scenario → run)
  • Live performance dashboard
"""

from __future__ import annotations

import base64
import json
import random
import string
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Any, Optional

import httpx
import streamlit as st

# ── Page config ───────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="Retell SMS Tester",
    page_icon="🤖",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Constants ─────────────────────────────────────────────────────────────────
API_BASE = "https://gjqwwdfeo35edl-8009.proxy.runpod.net"
MAX_PARALLEL = 20

PRESET_SCENARIOS: dict[str, list[str]] = {
    "Book Appointment (New Patient)": [
        "Hi, I'd like to schedule a new patient appointment",
        "I need a cleaning and check-up",
        "I'm a new patient",
        "Saturday morning would work best for me",
        "My name is Jamie Chen, date of birth April 12 1990",
        "Yes, please confirm the booking",
    ],
    "Book Appointment (Existing Patient)": [
        "Hi, I need to book an appointment",
        "I'm an existing patient, John Smith, DOB March 5 1985",
        "I have a toothache on my lower left side",
        "As soon as possible please, it's been hurting for two days",
        "Thursday afternoon works",
        "Yes, confirm please",
    ],
    "Emergency / Pain": [
        "I'm having really bad tooth pain",
        "It started yesterday, I can barely eat",
        "Yes I'm a current patient, Sarah Johnson",
        "My date of birth is July 22 1978",
        "Do you have anything today or tomorrow?",
        "Yes that slot works, please book it",
    ],
    "Reschedule Appointment": [
        "Hi, I need to reschedule my appointment",
        "My name is Mike Davis, born January 10 1992",
        "I have an appointment this Friday at 2pm",
        "Can I move it to next Tuesday instead?",
        "Morning would be great",
        "Perfect, thanks for rescheduling",
    ],
    "Cancel Appointment": [
        "I need to cancel my appointment",
        "My name is Lisa Park, DOB September 3 1988",
        "I have an appointment tomorrow at 10am",
        "I have a family emergency",
        "No I don't need to reschedule right now",
        "Thank you",
    ],
    "Ask About Hours & Services": [
        "What are your office hours?",
        "Are you open on weekends?",
        "Do you offer teeth whitening?",
        "What about Invisalign?",
        "Do you accept Delta Dental insurance?",
        "Great, thank you for the info",
    ],
    "Insurance & Pricing Question": [
        "Do you accept Cigna dental insurance?",
        "What other insurances do you take?",
        "How much is a cleaning without insurance roughly?",
        "What about X-rays?",
        "Do you offer payment plans?",
        "Thanks, I'll call back to book",
    ],
    "Recall / Overdue Checkup": [
        "Hi, I got a reminder that I'm due for a checkup",
        "My name is Tom Wilson, DOB February 28 1975",
        "It's been about 18 months since my last visit",
        "Any day next week works for me",
        "Wednesday at 3pm sounds good",
        "Great, I'll see you then",
    ],
}

# ── Session state ─────────────────────────────────────────────────────────────
for key, default in {
    "results": [],
    "running": False,
    "run_counter": 0,
}.items():
    if key not in st.session_state:
        st.session_state[key] = default


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fake_phone() -> str:
    """Generate a unique fake E.164 number (+1555XXXXXXX)."""
    suffix = "".join(random.choices(string.digits, k=7))
    return f"+1555{suffix}"


def _headers(token: str) -> dict:
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


@dataclass
class TurnResult:
    turn: int
    user_msg: str
    ai_response: str
    latency_ms: int


@dataclass
class SimResult:
    run_id: str
    scenario: str
    patient_phone: str
    status: str           # "success" | "error" | "partial"
    turns: list[TurnResult]
    duration_s: float
    avg_latency_ms: float
    score: Optional[int]
    error: Optional[str]
    timestamp: str

    def to_dict(self) -> dict:
        d = asdict(self)
        d["turns"] = [asdict(t) for t in self.turns]
        return d


def run_simulation(
    *,
    scenario_name: str,
    messages: list[str],
    agent_phone: str,
    bearer_token: str,
    openai_key: str = "",
    use_llm_judge: bool = False,
    run_id: str = "",
) -> SimResult:
    """Run one multi-turn conversation against the fd-sms API (synchronous)."""
    patient_phone = _fake_phone()
    chat_id: Optional[str] = None
    turns: list[TurnResult] = []
    t0 = time.time()

    try:
        for i, msg in enumerate(messages):
            turn_t0 = time.time()
            is_last = i == len(messages) - 1

            payload: dict[str, Any] = {
                "message": msg,
                "patient_phone_number": patient_phone,
                "agent_phone_number": agent_phone,
            }
            if chat_id:
                payload["chat_id"] = chat_id
            if is_last:
                payload["end_conversation"] = True

            resp = httpx.post(
                f"{API_BASE}/engage/forward-to-agent",
                json=payload,
                headers=_headers(bearer_token),
                timeout=45,
            )
            latency = round((time.time() - turn_t0) * 1000)

            if resp.status_code != 200:
                return SimResult(
                    run_id=run_id,
                    scenario=scenario_name,
                    patient_phone=patient_phone,
                    status="error",
                    turns=turns,
                    duration_s=round(time.time() - t0, 2),
                    avg_latency_ms=0,
                    score=None,
                    error=f"HTTP {resp.status_code}: {resp.text[:300]}",
                    timestamp=datetime.utcnow().isoformat(),
                )

            data = resp.json()
            # Response shape: {"status": "success", "data": {"chat_id": "...", "agent_response": "..."}}
            inner = data.get("data", data)
            chat_id = inner.get("chat_id") or chat_id
            ai_reply = inner.get("agent_response") or inner.get("message") or ""

            turns.append(TurnResult(
                turn=i + 1,
                user_msg=msg,
                ai_response=ai_reply,
                latency_ms=latency,
            ))

        duration = round(time.time() - t0, 2)
        avg_lat = round(sum(t.latency_ms for t in turns) / len(turns)) if turns else 0

        score = None
        if use_llm_judge and openai_key and turns:
            score = _llm_judge(scenario_name, turns, openai_key)

        return SimResult(
            run_id=run_id,
            scenario=scenario_name,
            patient_phone=patient_phone,
            status="success",
            turns=turns,
            duration_s=duration,
            avg_latency_ms=avg_lat,
            score=score,
            error=None,
            timestamp=datetime.utcnow().isoformat(),
        )

    except Exception as exc:
        return SimResult(
            run_id=run_id,
            scenario=scenario_name,
            patient_phone=patient_phone,
            status="error",
            turns=turns,
            duration_s=round(time.time() - t0, 2),
            avg_latency_ms=0,
            score=None,
            error=str(exc),
            timestamp=datetime.utcnow().isoformat(),
        )


def _llm_judge(scenario: str, turns: list[TurnResult], openai_key: str) -> Optional[int]:
    """Score 0-100 using GPT-4o-mini."""
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        transcript = "\n".join(
            f"Patient: {t.user_msg}\nAI Agent: {t.ai_response}" for t in turns
        )
        prompt = (
            f"You are evaluating a dental practice AI SMS receptionist.\n"
            f"Scenario: {scenario}\n\nConversation:\n{transcript}\n\n"
            "Rate 0-100 where 100=perfect helpful professional resolution, "
            "70-99=good with minor issues, 40-69=acceptable but incomplete, 0-39=poor/confusing.\n"
            'Return ONLY valid JSON: {"score": <int>, "reason": "<one sentence>"}'
        )
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=120,
            temperature=0,
        )
        result = json.loads(resp.choices[0].message.content.strip())
        return int(result.get("score", 50))
    except Exception:
        return None


def analyze_screenshot(image_bytes: bytes, openai_key: str, extra_context: str = "") -> str:
    """Send screenshot to GPT-4o Vision and return reproducibility analysis."""
    from openai import OpenAI
    client = OpenAI(api_key=openai_key)
    b64 = base64.b64encode(image_bytes).decode()
    context_block = f"\nExtra context: {extra_context}" if extra_context else ""
    prompt = (
        "You are a QA analyst for an AI-powered dental practice SMS agent.\n"
        "Analyze this screenshot of an SMS conversation and answer:\n"
        "1. What is the issue or unexpected behavior shown?\n"
        "2. Is this likely a reproducible bug or a one-off edge case?\n"
        "3. What specific test scenario (patient message sequence) would reproduce this?\n"
        "4. What should the AI have responded instead?\n"
        f"5. Severity: Critical / High / Medium / Low{context_block}\n\n"
        "Be concise and specific."
    )
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"}},
            ],
        }],
        max_tokens=600,
    )
    return resp.choices[0].message.content.strip()


def generate_test_scenarios(instruction: str, openai_key: str, n: int = 5) -> list[dict]:
    """Generate N test scenarios from a free-text instruction using GPT-4o-mini."""
    from openai import OpenAI
    client = OpenAI(api_key=openai_key)
    prompt = (
        f"You are creating test cases for a dental practice AI SMS receptionist agent.\n"
        f"Instruction / requirement to test: {instruction}\n\n"
        f"Generate {n} distinct test conversations (patient message sequences) that test this requirement.\n"
        "Each conversation should have 4-6 patient messages simulating a realistic SMS exchange.\n"
        "Return ONLY valid JSON — a list of objects:\n"
        '[{"name": "Test name", "messages": ["msg1", "msg2", ...]}, ...]'
    )
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=1500,
        temperature=0.7,
        response_format={"type": "json_object"},
    )
    raw = resp.choices[0].message.content.strip()
    parsed = json.loads(raw)
    # Handle both {"scenarios": [...]} and direct list
    if isinstance(parsed, list):
        return parsed
    for v in parsed.values():
        if isinstance(v, list):
            return v
    return []


# ── Sidebar ───────────────────────────────────────────────────────────────────
with st.sidebar:
    st.title("⚙️ Configuration")
    st.caption("Settings applied to all tabs")

    bearer_token = st.text_input(
        "Bearer Token (API_ACCESS_TOKEN)",
        type="password",
        placeholder="Ask your team for API_ACCESS_TOKEN",
        help="The API_ACCESS_TOKEN env var set on the RunPod server",
    )
    agent_phone = st.text_input(
        "Agent Phone Number",
        value="+14122652546",
        help="The AI Front Desk SMS number (E.164 format)",
    )
    openai_key = st.text_input(
        "OpenAI API Key",
        type="password",
        placeholder="sk-proj-...",
        help="Required for LLM judge scoring and screenshot analysis",
    )
    use_judge = st.toggle(
        "Enable LLM Judge (costs tokens)",
        value=False,
        help="Grade each conversation 0-100 with GPT-4o-mini",
    )

    st.divider()
    if st.button("🔍 Test API Connection", use_container_width=True):
        with st.spinner("Checking..."):
            try:
                r = httpx.get(f"{API_BASE}/health", timeout=5)
                data = r.json()
                st.success(f"✅ API reachable — env: **{data.get('env', '?')}**")
            except Exception as e:
                st.error(f"❌ {e}")

    st.divider()
    col1, col2 = st.columns(2)
    with col1:
        st.metric("Total Runs", len(st.session_state.results))
    with col2:
        successes = sum(1 for r in st.session_state.results if r["status"] == "success")
        pct = round(successes / len(st.session_state.results) * 100) if st.session_state.results else 0
        st.metric("Pass Rate", f"{pct}%")

    if st.button("🗑️ Clear Results", use_container_width=True):
        st.session_state.results = []
        st.rerun()


# ── Main Tabs ─────────────────────────────────────────────────────────────────
tab_sim, tab_screenshot, tab_instruct, tab_dash = st.tabs([
    "🚀 Parallel Simulations",
    "📸 Screenshot Analysis",
    "📋 Instruction Tests",
    "📊 Dashboard",
])


# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — Parallel Simulations
# ══════════════════════════════════════════════════════════════════════════════
with tab_sim:
    st.header("🚀 Parallel Simulations")
    st.caption("Run up to 20 scenarios at once against the live AI agent")

    col_left, col_right = st.columns([1, 1])

    with col_left:
        selected_scenarios = st.multiselect(
            "Select preset scenarios to run",
            options=list(PRESET_SCENARIOS.keys()),
            default=list(PRESET_SCENARIOS.keys())[:3],
            help="Each selected scenario will count as one run",
        )

    with col_right:
        repeat_count = st.number_input(
            "Repeat each scenario N times",
            min_value=1,
            max_value=MAX_PARALLEL,
            value=1,
            help=f"Total runs = scenarios × repeats (max {MAX_PARALLEL})",
        )

    # Build final job list
    jobs: list[tuple[str, list[str]]] = []
    for s in selected_scenarios:
        for _ in range(repeat_count):
            jobs.append((s, PRESET_SCENARIOS[s]))

    total_jobs = len(jobs)
    if total_jobs > MAX_PARALLEL:
        st.warning(f"⚠️ {total_jobs} runs requested but capped at {MAX_PARALLEL}. Trimming.")
        jobs = jobs[:MAX_PARALLEL]
        total_jobs = MAX_PARALLEL

    st.info(f"**{total_jobs}** run(s) queued — {min(total_jobs, MAX_PARALLEL)} will execute in parallel")

    run_btn = st.button(
        f"▶️ Run {total_jobs} Simulation(s)",
        disabled=st.session_state.running or not bearer_token or not jobs,
        use_container_width=True,
        type="primary",
    )

    if not bearer_token:
        st.warning("⚠️ Enter your Bearer Token in the sidebar to enable runs")

    if run_btn and jobs and bearer_token:
        st.session_state.running = True
        progress_bar = st.progress(0, text="Starting simulations…")
        results_placeholder = st.empty()
        completed = 0
        batch_results = []

        with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
            futures = {
                pool.submit(
                    run_simulation,
                    scenario_name=name,
                    messages=msgs,
                    agent_phone=agent_phone,
                    bearer_token=bearer_token,
                    openai_key=openai_key,
                    use_llm_judge=use_judge,
                    run_id=f"run-{st.session_state.run_counter + i + 1}",
                ): (name, i)
                for i, (name, msgs) in enumerate(jobs)
            }

            for future in as_completed(futures):
                completed += 1
                result = future.result()
                batch_results.append(result.to_dict())
                st.session_state.run_counter += 1
                pct = completed / total_jobs
                status_icon = "✅" if result.status == "success" else "❌"
                progress_bar.progress(
                    pct,
                    text=f"{status_icon} {completed}/{total_jobs} — last: {result.scenario[:40]}",
                )

        # Persist to session state
        st.session_state.results.extend(batch_results)
        st.session_state.running = False

        # Summary
        success_count = sum(1 for r in batch_results if r["status"] == "success")
        progress_bar.empty()
        if success_count == total_jobs:
            st.success(f"✅ All {total_jobs} simulations passed!")
        else:
            st.warning(f"⚠️ {success_count}/{total_jobs} passed — {total_jobs - success_count} failed")

        # Show this batch's results
        st.subheader("This batch results")
        for r in batch_results:
            status_color = "🟢" if r["status"] == "success" else "🔴"
            with st.expander(
                f"{status_color} {r['scenario']} | {r['duration_s']}s | "
                f"avg {r['avg_latency_ms']}ms"
                + (f" | score: {r['score']}/100" if r.get('score') is not None else ""),
                expanded=r["status"] != "success",
            ):
                if r.get("error"):
                    st.error(r["error"])
                for turn in r.get("turns", []):
                    st.markdown(f"**Turn {turn['turn']}** _{turn['latency_ms']}ms_")
                    c1, c2 = st.columns(2)
                    with c1:
                        st.info(f"👤 **Patient:** {turn['user_msg']}")
                    with c2:
                        st.success(f"🤖 **AI:** {turn['ai_response']}")


# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — Screenshot Analysis
# ══════════════════════════════════════════════════════════════════════════════
with tab_screenshot:
    st.header("📸 Screenshot Analysis")
    st.caption("Upload a chat screenshot → AI identifies the issue and suggests a test scenario")

    if not openai_key:
        st.warning("⚠️ OpenAI API Key required (set in sidebar)")

    uploaded = st.file_uploader(
        "Upload SMS conversation screenshot",
        type=["png", "jpg", "jpeg", "webp"],
        help="Screenshot of the patient ↔ AI SMS conversation showing the problematic behaviour",
    )
    extra_context = st.text_area(
        "Additional context (optional)",
        placeholder="e.g. 'This happened when patient tried to book after hours' or paste the conversation text",
        height=80,
    )

    col_a, col_b = st.columns([1, 3])
    analyze_btn = col_a.button(
        "🔍 Analyse Screenshot",
        disabled=not uploaded or not openai_key,
        type="primary",
    )

    if uploaded:
        st.image(uploaded, caption="Uploaded screenshot", use_column_width=False, width=400)

    if analyze_btn and uploaded and openai_key:
        with st.spinner("Analysing with GPT-4o Vision…"):
            try:
                analysis = analyze_screenshot(uploaded.read(), openai_key, extra_context)
                st.subheader("Analysis")
                st.markdown(analysis)

                # Offer to run a simulation based on identified scenario
                st.divider()
                st.subheader("Run a test based on this analysis")
                st.caption("Generate a test scenario from the analysis and run it now")
                if st.button("🤖 Generate & Run Reproducer Test", disabled=not bearer_token):
                    with st.spinner("Generating test scenario…"):
                        scenarios = generate_test_scenarios(
                            f"Reproduce this issue: {analysis[:500]}",
                            openai_key,
                            n=1,
                        )
                    if scenarios:
                        s = scenarios[0]
                        st.info(f"Running: **{s['name']}** ({len(s['messages'])} turns)")
                        with st.spinner("Running simulation…"):
                            result = run_simulation(
                                scenario_name=s["name"],
                                messages=s["messages"],
                                agent_phone=agent_phone,
                                bearer_token=bearer_token,
                                openai_key=openai_key,
                                use_llm_judge=use_judge,
                                run_id=f"screenshot-{int(time.time())}",
                            )
                        st.session_state.results.append(result.to_dict())
                        status = "✅ PASS" if result.status == "success" else "❌ FAIL"
                        st.markdown(f"**Result:** {status} | {result.duration_s}s")
                        for turn in result.turns:
                            c1, c2 = st.columns(2)
                            with c1:
                                st.info(f"👤 {turn.user_msg}")
                            with c2:
                                st.success(f"🤖 {turn.ai_response}")
                        if result.error:
                            st.error(result.error)
            except Exception as e:
                st.error(f"Analysis failed: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — Instruction Tests
# ══════════════════════════════════════════════════════════════════════════════
with tab_instruct:
    st.header("📋 Instruction-Based Tests")
    st.caption(
        "Describe a behaviour or requirement → AI generates test scenarios → runs them all in parallel"
    )

    if not openai_key:
        st.warning("⚠️ OpenAI API Key required (set in sidebar)")
    if not bearer_token:
        st.warning("⚠️ Bearer Token required (set in sidebar)")

    instruction = st.text_area(
        "Test instruction / requirement",
        placeholder=(
            "Examples:\n"
            "• The AI should politely refuse to book for patients under 18 without guardian consent\n"
            "• Test that the AI correctly handles cancellation requests within the cancellation window\n"
            "• Verify the AI asks for DOB before looking up an existing patient\n"
            "• Test how the AI responds to angry or frustrated patients"
        ),
        height=130,
    )

    col1, col2 = st.columns([1, 2])
    n_tests = col1.slider("Number of test scenarios to generate", 1, 10, 5)
    run_instruct_btn = col2.button(
        f"🧪 Generate & Run {n_tests} Tests",
        disabled=not instruction or not openai_key or not bearer_token,
        type="primary",
        use_container_width=True,
    )

    if run_instruct_btn and instruction and openai_key and bearer_token:
        with st.spinner(f"Generating {n_tests} test scenarios with GPT-4o-mini…"):
            try:
                scenarios = generate_test_scenarios(instruction, openai_key, n=n_tests)
            except Exception as e:
                st.error(f"Scenario generation failed: {e}")
                scenarios = []

        if not scenarios:
            st.warning("No scenarios generated. Try rephrasing your instruction.")
        else:
            st.success(f"Generated {len(scenarios)} scenario(s) — running in parallel…")

            # Show generated scenarios
            with st.expander("📋 Generated scenarios", expanded=False):
                for i, s in enumerate(scenarios, 1):
                    st.markdown(f"**{i}. {s.get('name', 'Unnamed')}**")
                    for j, msg in enumerate(s.get("messages", []), 1):
                        st.caption(f"  Turn {j}: {msg}")

            progress_bar = st.progress(0, text="Running tests…")
            completed = 0
            batch_results = []

            jobs_instruct = [
                (s.get("name", f"Test {i}"), s.get("messages", []))
                for i, s in enumerate(scenarios, 1)
                if s.get("messages")
            ]

            with ThreadPoolExecutor(max_workers=min(len(jobs_instruct), MAX_PARALLEL)) as pool:
                futures = {
                    pool.submit(
                        run_simulation,
                        scenario_name=name,
                        messages=msgs,
                        agent_phone=agent_phone,
                        bearer_token=bearer_token,
                        openai_key=openai_key,
                        use_llm_judge=use_judge,
                        run_id=f"instruct-{int(time.time())}-{i}",
                    ): name
                    for i, (name, msgs) in enumerate(jobs_instruct)
                }

                for future in as_completed(futures):
                    completed += 1
                    result = future.result()
                    batch_results.append(result.to_dict())
                    st.session_state.results.extend([result.to_dict()])
                    progress_bar.progress(
                        completed / len(jobs_instruct),
                        text=f"{'✅' if result.status == 'success' else '❌'} {completed}/{len(jobs_instruct)}",
                    )

            progress_bar.empty()
            passed = sum(1 for r in batch_results if r["status"] == "success")
            st.metric("Results", f"{passed}/{len(batch_results)} passed")

            for r in batch_results:
                icon = "🟢" if r["status"] == "success" else "🔴"
                with st.expander(
                    f"{icon} {r['scenario']}"
                    + (f" — score: {r['score']}/100" if r.get("score") is not None else ""),
                    expanded=r["status"] != "success",
                ):
                    if r.get("error"):
                        st.error(r["error"])
                    for turn in r.get("turns", []):
                        c1, c2 = st.columns(2)
                        with c1:
                            st.info(f"👤 {turn['user_msg']}")
                        with c2:
                            st.success(f"🤖 {turn['ai_response']}")


# ══════════════════════════════════════════════════════════════════════════════
# TAB 4 — Dashboard
# ══════════════════════════════════════════════════════════════════════════════
with tab_dash:
    st.header("📊 Performance Dashboard")

    results = st.session_state.results

    if not results:
        st.info("No results yet — run some simulations first.")
    else:
        # Summary metrics
        total = len(results)
        passed = sum(1 for r in results if r["status"] == "success")
        failed = total - passed
        avg_dur = round(sum(r.get("duration_s", 0) for r in results) / total, 2)
        avg_lat = round(
            sum(r.get("avg_latency_ms", 0) for r in results if r.get("avg_latency_ms")) / max(passed, 1)
        )
        scores = [r["score"] for r in results if r.get("score") is not None]
        avg_score = round(sum(scores) / len(scores)) if scores else None

        m1, m2, m3, m4, m5 = st.columns(5)
        m1.metric("Total Runs", total)
        m2.metric("✅ Passed", passed)
        m3.metric("❌ Failed", failed)
        m4.metric("Avg Duration", f"{avg_dur}s")
        m5.metric("Avg Latency", f"{avg_lat}ms")

        if avg_score is not None:
            st.metric("Avg AI Score", f"{avg_score}/100")

        st.divider()

        # Results table
        import pandas as pd

        rows = []
        for r in reversed(results):
            turn_count = len(r.get("turns", []))
            rows.append({
                "Run ID": r.get("run_id", "—"),
                "Scenario": r["scenario"],
                "Status": "✅ Pass" if r["status"] == "success" else "❌ Fail",
                "Turns": turn_count,
                "Duration (s)": r.get("duration_s", "—"),
                "Avg Latency (ms)": r.get("avg_latency_ms", "—"),
                "Score": r.get("score", "—"),
                "Timestamp": r.get("timestamp", "—")[:19].replace("T", " "),
                "Error": (r.get("error") or "")[:80],
            })

        df = pd.DataFrame(rows)
        st.dataframe(df, use_container_width=True, height=400)

        # Pass rate by scenario
        st.subheader("Pass Rate by Scenario")
        scenario_stats: dict[str, dict] = {}
        for r in results:
            s = r["scenario"]
            if s not in scenario_stats:
                scenario_stats[s] = {"total": 0, "pass": 0, "latencies": []}
            scenario_stats[s]["total"] += 1
            if r["status"] == "success":
                scenario_stats[s]["pass"] += 1
            if r.get("avg_latency_ms"):
                scenario_stats[s]["latencies"].append(r["avg_latency_ms"])

        stat_rows = []
        for s, v in scenario_stats.items():
            pass_rate = round(v["pass"] / v["total"] * 100)
            avg_l = round(sum(v["latencies"]) / len(v["latencies"])) if v["latencies"] else "—"
            stat_rows.append({
                "Scenario": s,
                "Runs": v["total"],
                "Pass Rate": f"{pass_rate}%",
                "Avg Latency (ms)": avg_l,
            })
        st.dataframe(pd.DataFrame(stat_rows), use_container_width=True)

        # Full conversation browser
        st.subheader("Conversation Browser")
        filter_status = st.radio("Filter by status", ["All", "Pass", "Fail"], horizontal=True)
        filtered = [
            r for r in reversed(results)
            if filter_status == "All"
            or (filter_status == "Pass" and r["status"] == "success")
            or (filter_status == "Fail" and r["status"] != "success")
        ]

        for r in filtered[:20]:  # show latest 20
            icon = "🟢" if r["status"] == "success" else "🔴"
            label = (
                f"{icon} {r['scenario']} | {r.get('duration_s')}s"
                + (f" | score {r['score']}/100" if r.get("score") is not None else "")
                + f" | {r.get('timestamp', '')[:19].replace('T', ' ')}"
            )
            with st.expander(label):
                if r.get("error"):
                    st.error(r["error"])
                for turn in r.get("turns", []):
                    c1, c2 = st.columns(2)
                    with c1:
                        st.info(f"👤 **Turn {turn['turn']}:** {turn['user_msg']}")
                    with c2:
                        ai_text = turn["ai_response"] or "_(no response)_"
                        st.success(f"🤖 {ai_text}")
                        st.caption(f"⏱ {turn['latency_ms']}ms")

        # Export
        st.divider()
        if st.button("📥 Export Results as JSON"):
            st.download_button(
                label="Download results.json",
                data=json.dumps(results, indent=2),
                file_name=f"retell_test_results_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json",
                mime="application/json",
            )
