# Round-0 AI Interview — What We've Built So Far

A summary of the project as it stands, for sharing with the team.

---

## What it is

An **AI-powered Round-0 screening interview** that assesses candidates against
**our own engineering reality** — not a generic bar — and hands the hiring manager
**evidence**, not a black-box score.

- An admin uploads a **JD + resume** → the system generates a **role-specific
  question bank** grounded in the org's engineering context.
- The candidate signs in with their **email** and has a **live voice interview**
  with an AI interviewer ("Sarah Chen").
- The hiring manager gets an **evidence scorecard**: scores with verbatim quotes,
  a JD-coverage matrix, and a "what to probe in Round 1" briefing.

Runs on **Amazon Bedrock** (Claude for reasoning, Amazon Nova Sonic for voice),
with an **OpenRouter fallback** for the text/LLM calls.

---

## The problem we're solving

HR owns the top of the engineering funnel but can't assess technical depth.
Candidates who were never going to clear the bar reach Round 1, where a senior
engineer discovers it in the first 15 minutes. **That engineer's hour is the
scarcest resource in the org**, and it's being spent on discovery that should
happen upstream.

Off-the-shelf AI interviewers screen for *generic* engineering ability, which
correlates only loosely with succeeding **here** (cost-constrained Django/Postgres
stack, multi-product context-switching, Bharat-scale on a thin budget). **No
vendor can read our postmortems — we can.**

---

## How it works

```
JD           → which competencies to test, the seniority bar, culture criteria
Resume       → which claims to verify, which projects to drill into
Context Pack → what the scenarios testing those competencies are MADE OF
Duration     → how many probes actually fit (1 / 5 / 15 / 30 / 45 min)
                        │
                        ▼
            Question bank → live voice interview → evidence scorecard
```

The Context Pack is the **setting, never the syllabus** — candidates are never
quizzed on internal trivia; they reason about problems *shaped like* the ones we
actually have.

### Two phases that never touch (security)
1. **Offline** — Confluence/Slack → **redact** (deterministic rules) → **abstract**
   (rewrite as standalone problems) → **validate** (regex gate + adversarial LLM
   review, **fails closed**) → **human approves** → `context-pack.json`.
2. **Live call** — the voice agent receives **only** the approved question bank.
   No retrieval, no MCP, no path to Slack. **It cannot leak what it was never given.**

---

## What's been built

**Interview generation**
- JD + resume → **question bank**: fixed rubric axes + JD-generated axes, resume
  probes, org-grounded scenarios, and JD-gap questions — all calibrated to the
  role's seniority.
- **Role-scoped**: a frontend/analyst candidate gets frontend/analyst questions,
  never backend infra (scenarios are filtered by discipline).
- Generation runs on the **admin** side (~50–70s) before the candidate exists —
  the candidate never waits on a model call.

**Live voice interview**
- Real-time speech-to-speech via **Amazon Nova Sonic** (barge-in, live
  transcription, server-side VAD), relayed through a backend WebSocket.
- **Graceful behaviors**: never cuts the candidate off at time-up (winds down +
  grace period), auto-ends when the interviewer says her closing line, honours a
  candidate's request to stop.
- **Multi-language** support (English / Hindi / mix).

**Resilience (hard-won)**
- **Two-layer reconnect** — the relay retries the Bedrock stream *and* the browser
  reconnects the WebSocket, both resuming mid-interview from the stored transcript.
- **Silent resume** — a dropped connection is recovered in the background without
  the interviewer announcing it.
- **OpenRouter fallback** — if Bedrock's text calls fail (e.g. expired creds), bank
  generation and grading automatically fall back to OpenRouter.

**Proctoring & integrity**
- Client-side **MediaPipe** face + object detection: multiple people, phone in
  frame, looking away (reading), tab-switch — all sustained-detection to avoid
  false positives.
- Each flag captures a **snapshot + short video clip**, persisted for the recruiter
  to re-verify from their own machine.
- Proctoring **never lowers technical scores** — it feeds an authenticity signal only.

**Evidence scorecard (admin-only)**
- Per-axis scores (1–5) **each backed by a verbatim quote**.
- **Evidence moments** (timestamped), **JD gap matrix** (evidenced / partial /
  unevidenced / contradicted), and a **Round-1 briefing** ("skip this, probe that,
  open with this").
- **Generic counterfactual** — the same transcript scored with a generic rubric,
  side by side, to prove the org-grounding does real work.
- Verdicts are **advancement language** (`Advance` / `Advance with focus` /
  `Needs discussion` / `Do not advance`) — a human decides, the AI never does.

---

## Design principles (what makes it different)

1. **Evidence, not verdicts** — every score cites a quote; a human makes the call.
2. **Screening bar, not hiring bar** — absence of evidence is neutral, never
   negative; grading harshly loses good candidates.
3. **Org-grounded** — scenarios are made of our real engineering situations.
4. **Live agent has zero retrieval** — it can't leak internal data.
5. **Candidate never sees their score** — they land on a thank-you page.
6. **A broken call is never the candidate's fault** — stream drops are counted and
   surfaced to the grader so a flaky call isn't read as a weak candidate.

---

## Architecture / stack

```
Frontend  Next.js 14 (App Router), :3030   — admin, candidate sign-in, interview room, scorecard
Backend   Express + WebSocket relay, :4000 — prepare, sign-in, voice relay, grading, scorecard
Voice     Amazon Nova Sonic (speech-to-speech, via the relay)
LLM       Claude Sonnet 4.6 on Amazon Bedrock  (bank generation + grading)
Fallback  OpenRouter (text LLM only, when Bedrock fails)
Proctor   MediaPipe (in-browser, WASM)
Store     In-memory session Map, mirrored to disk (prototype)
```

---

## Current status

- ✅ **End-to-end flow works**: admin prepares → candidate signs in → interview →
  evidence scorecard. Verified: compiles clean, both servers boot, health green,
  prepare/sign-in/session-lookup all functional.
- ✅ **Resilience, proctoring, multi-language, role-scoping, OpenRouter fallback** —
  all in place.
- ⚠️ **Voice = Nova Sonic**, which is a real speech-to-speech model but drops its
  stream intermittently (an AWS-side limitation); mitigated by the two-layer
  reconnect + silent resume.
- ⚠️ **Runs on temporary workshop AWS credentials**, which expire — needs a refresh
  to run the Bedrock/voice path.

## Known limitations (deliberate prototype scope)

- No S3 — recordings and snapshots are held per-session (prototype storage).
- No database — sessions live in memory, mirrored to a JSON file.
- No auth on the admin console.
- Voice-only interview (Round-0 tests reasoning, not implementation).

## Evaluated / next steps

- **Voice stability**: evaluated alternatives to Nova Sonic — **Gemini Live** and
  **OpenAI Realtime** (both more stable, tunable turn-taking). Nova Sonic on
  Bedrock is the current default to stay AWS-only.
- **Storage**: move recordings/snapshots to S3 and sessions to Postgres/Redis for
  scale and durability.
- **Deployment**: real IAM instead of temporary workshop credentials.

---

*Repo: `hire_by_ai` · Branch: `sept-3-poc-1-30-pm`. Deeper technical reference in
`AGENTS.md`.*
