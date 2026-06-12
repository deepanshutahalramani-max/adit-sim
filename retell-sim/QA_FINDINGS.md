# QA Findings — Real Phone Platform
Living document of product bugs caught by the QA platform, with evidence.

---

## Finding 1 — ADIT BETA silently drops delivered inbound SMS mid-conversation
**Severity: HIGH · Status: OPEN · Owner: ADIT backend team · Reproduced: 2× (2026-06-10, 2026-06-11)**

A patient SMS that is carrier-confirmed **delivered** to the practice number never
reaches the Retell chat session. The agent keeps waiting, the conversation dies,
and the chat stays "ongoing". A real patient would simply never get an answer.

**All three reproductions stalled on the reply to the insurance question** —
strong signal the drop correlates with whatever ADIT's pipeline does at that
step of the booking flow.

| | Occurrence 1 | Occurrence 2 | Occurrence 3 |
|---|---|---|---|
| Date (UTC) | 2026-06-10 23:04 | 2026-06-11 10:00 | 2026-06-12 10:03 |
| Patient number | +18327725892 | +19314652485 | +18327725892 |
| Dropped message | "Delta Dental PPO." | "MetLife PPO." | "Cigna PPO." |
| Twilio status | delivered | delivered | delivered |
| Reply delay used | ~2s (could be race) | **8–12s (rules out race)** | 8–12s |

Successful conversations (Robert Lee BETA, David Kim PROD) passed the same
step fine — the drop is intermittent (~3 of 5 conversations) but always at
the same point when it happens.

**Ask for ADIT engineering:** trace the inbound SMS pipeline for the practice
number 832-476-8799 at the timestamps above — the message reached the number
(carrier-delivered) but was never forwarded into the Retell session.

---

## Finding 2 — PROD SMS replies blocked: A2P 10DLC registration required
**Severity: BLOCKER for PROD SMS testing · Status: OPEN · Owner: Adit (business action)**

Every SMS our test numbers send to the PROD practice number **402-503-1303** fails
with Twilio **error 30034** (US A2P 10DLC — message from an unregistered number).
The AI's outbound messages reach us fine; our replies are dropped by the carrier.
BETA's number/carrier doesn't filter (yet) — registration protects both.

**What's needed (one-time, in the Twilio console of account ACbc926c…):**
1. **A2P Brand registration** — legal business name, EIN, address ($4 one-time)
2. **Campaign registration** — use case "customer care / QA testing", sample messages
   ($15 one-time + ~$2–10/month)
3. Attach all 4 test numbers to the campaign
Approval typically takes 1–7 days. Until then, PROD testing works for **calls**
(voice + missed/incomplete triggers fire fine) but not SMS conversations.

---

## Fixed platform bugs (for reference)
- **False completion keywords** — "appointment for" matched agent questions →
  sim hung up mid-call saying "Great thanks, bye". Fixed 2026-06-11.
- **Voice speech chopping** — Twilio `speechTimeout=auto` split agent sentences;
  now 3s fixed silence threshold. Validated with a full 21-turn voice booking
  (judge 100/100).
- **Race-drop on fast replies** — replying <2s after the agent message got the
  reply dropped by ADIT; sim now types like a human (8–12s).
- **90s reply timeout** — conversations now fail fast with `failure_type=reply_timeout`
  instead of hanging; this is also the detector that caught Finding 1.
