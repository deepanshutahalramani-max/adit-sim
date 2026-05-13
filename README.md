# ADIT Simulation Platform — v0

Stress-tests the AI Front Desk SMS agent by running scripted and persona-driven conversations against it, capturing transcripts, evaluating them on deterministic outcomes and conversation quality, and surfacing results in a web dashboard.

---

## Quick start (zero API keys required)

```bash
git clone <repo>
cd adit-sim
cp .env.example .env        # defaults are already set for mock mode
docker compose up
```

Open **http://localhost:5173** — the dashboard is live.

Click **New Run**, pick any scenario, leave provider as **mock**, hit **Run Simulation**. Watch the conversation appear in real time. Evaluation results appear automatically when the conversation closes.

No external services, no API keys needed for this path. The mock provider uses scripted agent replies from each scenario's YAML.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TARGET_ENVIRONMENT` | **yes** | — | `mock`, `staging`, or `production`. App refuses to start without it. |
| `MESSAGING_PROVIDER` | **yes** | — | `mock` or `ringcentral` |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string (`postgresql+asyncpg://...`) |
| `ANTHROPIC_API_KEY` | no | — | If set: LLM persona (dynamic) + LLM judge. If absent: scripted persona + judge skipped. |
| `RINGCENTRAL_CLIENT_ID` | if RC | — | |
| `RINGCENTRAL_CLIENT_SECRET` | if RC | — | |
| `RINGCENTRAL_JWT` | if RC | — | |
| `RINGCENTRAL_SERVER_URL` | if RC | `https://platform.ringcentral.com` | |
| `RINGCENTRAL_FROM_NUMBER` | if RC | — | The simulator's outbound SMS number |
| `TARGET_AGENT_NUMBER` | if RC | — | The AI Front Desk's SMS number |
| `PUBLIC_WEBHOOK_URL` | if RC | — | Publicly reachable base URL for inbound webhook |

> **Security note:** `TARGET_ENVIRONMENT` has no default intentionally. This prevents accidental real-SMS firing when environment variables are misconfigured.

> **Auth note:** v0 has no authentication. Single-user, no login. Add auth before exposing to the internet.

---

## Running with a real Anthropic key (enhanced mock)

Set `ANTHROPIC_API_KEY` in `.env`. The mock provider still handles messaging (no RingCentral needed), but now:
- Persona replies are generated dynamically by `claude-opus-4-7` instead of using the scripted YAML turns.
- LLM judge (`claude-opus-4-7`) scores each completed conversation on clarity, empathy, task completion, hallucination risk, and scheduling accuracy.

---

## Running against a real AI Front Desk (RingCentral)

1. Set `MESSAGING_PROVIDER=ringcentral` and `TARGET_ENVIRONMENT=staging` or `production`.
2. Fill in all `RINGCENTRAL_*` vars and `TARGET_AGENT_NUMBER`.
3. Set `PUBLIC_WEBHOOK_URL` to your publicly reachable server URL (needed for inbound webhook registration).
4. `ANTHROPIC_API_KEY` is now required for persona generation.

The simulator will send real SMS messages from `RINGCENTRAL_FROM_NUMBER` to `TARGET_AGENT_NUMBER`. The AI Front Desk's replies arrive via the webhook at `POST /api/webhooks/ringcentral`.

---

## Adding a scenario

1. Create `backend/app/scenarios/<your_id>.yaml` using the schema below.
2. Restart the backend (or `docker compose restart backend`). Scenarios are upserted on startup.

```yaml
id: your_scenario_id          # unique slug, matches filename
name: "Human-readable name"
description: "What this scenario tests (used in LLM judge prompt)"
persona_description: >
  Full description of the persona's identity, mood, and behaviour.
persona_traits:
  - trait_one
  - trait_two
opening_message: "The first message the patient sends"
expected_outcomes:
  booked: true                # bool — was appointment confirmed?
  patient_type: new           # new | existing
  call_type: scheduling       # scheduling | rescheduling | cancellation | billing | insurance | other
  task_created: false         # bool — was a follow-up task created?
  tags_include: []            # list — every tag here must appear in agent messages
end_conditions:
  max_turns: 20
  timeout_seconds: 300
mock_turns:
  # Used for scripted agent replies (always) and scripted persona replies (no API key)
  - persona_says: "Opening message"
    agent_replies: "Agent's reply to the opening"
    is_complete: false
  - persona_says: "Patient's second message"
    agent_replies: "Agent's reply"
    is_complete: false
  - persona_says: "Final message"
    agent_replies: "Agent's closing reply"
    is_complete: true
```

---

## Architecture

```
Patient (Simulator)                      AI Front Desk
       │                                       │
       │  openingMessage ──────────────────────►│
       │                    agentReply  ◄────────│
       │  personaReply   ──────────────────────►│
       │                    agentReply  ◄────────│
       │        ...                             │
       │  [conversation ends]                   │
       │
   DeterministicEvaluator  ─── keyword matching
   LLMJudgeEvaluator        ─── claude-opus-4-7 rubric scoring
```

**Key files:**
- `backend/app/orchestrator/single_run.py` — drives one run's full lifecycle
- `backend/app/messaging/mock.py` — deterministic provider, simulates async webhook flow
- `backend/app/messaging/ringcentral.py` — real SMS via RingCentral JWT auth
- `backend/app/personas/generator.py` — LLM persona with scripted fallback
- `backend/app/evaluators/` — deterministic + LLM judge evaluators
- `backend/app/scenarios/*.yaml` — seed scenario definitions

**Extensibility hooks for future milestones:**
- `MessagingProvider` ABC in `messaging/base.py` — add providers without touching orchestrator
- `BaseEvaluator` in `evaluators/base.py` — add evaluators without touching orchestrator
- `RunOrchestrator` in `orchestrator/single_run.py` — `BatchOrchestrator` and `AdversarialOrchestrator` will call the same `execute()` pattern

---

## Deploying to Render (one click)

1. Fork the repo and connect it to Render.
2. Click **New** → **Blueprint** → select the repo. Render reads `render.yaml`.
3. Set secret env vars in the Render dashboard: `ANTHROPIC_API_KEY`, and RingCentral vars if needed.
4. The build command compiles the React frontend and embeds it in the Python container — one service, one URL.

---

## Seed scenarios

| ID | Name | Key test |
|---|---|---|
| `new_patient_tuesday` | New Patient — Tuesday Cleaning | Happy path scheduling |
| `reschedule_with_insurance` | Existing Patient — Reschedule + Insurance | Rescheduling + tangential question |
| `angry_billing_complaint` | Angry Patient — Billing Dispute | Empathy under pressure, task creation |
| `esl_vague_time` | ESL Patient — Vague Time Preference | Clarity for non-native speaker |
| `changes_mind_midcall` | Indecisive Patient — Cancels Then Reschedules | Mid-conversation intent shift |
