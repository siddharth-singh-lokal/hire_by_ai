# Round-0: Org-Grounded Technical Screening

An AI screening round that interviews candidates against **your** engineering reality — not a generic bar — and hands a hiring manager evidence instead of a score.

Runs entirely on **Amazon Bedrock**. No OpenAI key required.

---

## The problem

HR owns the top of the engineering funnel but cannot assess technical depth. Candidates who were never going to clear the bar reach Round 1, where a senior engineer discovers it in the first fifteen minutes. That engineer's hour is the scarcest resource in the org, and it is being spent on discovery that should have happened upstream.

**Why not buy this.** AI voice interviewers with webcam proctoring are a commodity — Mercor, Micro1, HireVue, CodeSignal, HireSnap at ₹200 a session. They all screen for *generic* engineering ability, which correlates only loosely with succeeding here. Someone excellent at a well-funded SaaS company can still fail on a cost-constrained Django/Postgres stack that pivots every few weeks.

**The asymmetry.** Vendors have breadth. You have depth. No vendor can read your postmortems.

---

## How it works

```
JD           ──▶  which competencies to test, the bar, culture criteria
Resume       ──▶  which claims to verify, which projects to drill into
Context Pack ──▶  what the scenarios testing those competencies are MADE OF
Duration     ──▶  how many probes actually fit
                        │
                        ▼
              Question bank  ──▶  live voice interview  ──▶  evidence scorecard
```

The Context Pack is the **setting, never the syllabus**. Candidates are never quizzed on internal trivia — that would be unfair and would measure nothing. They are asked to reason about problems *shaped like* the ones this org actually has.

### Two phases that never touch

A live Slack/Confluence connection on an agent talking to an external candidate is a data-exfiltration surface with a microphone on it. So:

```
PHASE 1 — offline, re-runnable, human-approved
  Confluence + Slack (read-only, hardcoded allowlist)
      ├─▶ redact    deterministic rules, before any model sees the text
      ├─▶ abstract  rewrite as standalone engineering problems
      ├─▶ validate  regex gate + adversarial LLM review, FAILS CLOSED
      └─▶ approve   a human reads it and says yes
                          │
                    context-pack.json
                          │
PHASE 2 — live call, ZERO retrieval
  The voice agent receives only the approved question bank.
  No MCP. No tools. No network path to Slack.
  It cannot leak what it was never given.
```

---

## Models

| Task | Model | Why |
|---|---|---|
| Voice interview | `amazon.nova-2-sonic-v1:0` | Only speech-to-speech on Bedrock. Barge-in, plus text transcripts on the same stream |
| Question bank | `us.anthropic.claude-sonnet-4-6` | Benchmarked level with Opus 4.6 on the same transcript at a fraction of the cost; runs once before the call |
| Evaluation | `us.anthropic.claude-sonnet-4-6` | Same structured output as Opus 4.6 on the transcript; Opus stays a one-line override when a decision warrants it |
| Sanitize + validate | `us.anthropic.claude-sonnet-4-6` | Bulk offline workload; low-temperature extraction, not generation |

Measured: **~1.8s** end-of-speech to first audio byte.

---

## Quickstart

```bash
# backend/.env
PORT=4000
AWS_PROFILE=workshop          # or AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN
AWS_REGION=us-west-2

# optional — enables live Confluence/Slack fetch
CONFLUENCE_BASE_URL=https://<site>.atlassian.net
CONFLUENCE_EMAIL=you@company.com
CONFLUENCE_API_TOKEN=...       # id.atlassian.com/manage-profile/security/api-tokens
SLACK_BOT_TOKEN=xoxb-...       # channels:history + channels:read
```

```bash
npm run dev:backend    # :4000  — API + Nova Sonic relay
npm run dev:frontend   # :3030  — setup, interview room, scorecard
```

Open **http://localhost:3030**, paste or upload a JD and a resume, set the candidate's name and interview length, generate the plan, review it, start.

### Context Pack commands

```bash
npm run pack:fetch                 # Confluence + Slack -> raw/  (gitignored)
npm run pack:build                 # redact -> abstract -> validate
npm run pack:build -- --approve    # only after a human reads it
npm run verify:redaction           # regression test: plants secrets, proves they're caught
```

Nothing loads an unapproved pack. `raw/` holds unsanitized internal docs and must never be committed.

---

## What the sanitizer removes

Written against things actually found in real Confluence:

| Category | Examples |
|---|---|
| Credentials | API keys, `AWS_SECRET_ACCESS_KEY=…`, bare 40-char base64 |
| Personal data | emails, phone numbers |
| Network | private IPs, EC2/RDS hostnames, internal URLs |
| Code refs | commit SHAs, Jira keys, PR numbers, repo URLs, k8s secret names, GCP projects |
| **Incident fingerprints** | exact wall-clock times, dates, cache-key version numbers, instance SKUs |
| **Business logic** | pricing, payouts, tax, wallet economics, tier schemes, ranking formulas |

That last pair matters most. *"We run PostgreSQL and Redis behind Django"* is a stack — every job ad says as much. *"Users are charged an escalating rate after N minutes"* is the business. And a timestamp plus a date plus a version number is a fingerprint even with every hostname gone: anyone who was there recognises the incident.

**The regex gate cannot catch fingerprints** — they aren't a matchable token, they're a pattern across facts. That is why there is a second, adversarial reviewer, and why it fails closed if it cannot run.

---

## Output

- **Rubric** — 5 fixed axes (comparable across candidates) + 1–2 generated from the JD, with bars calibrated to that JD's seniority
- **Evidence moments** — timestamped verbatim quotes, linked to the recording
- **JD gap matrix** — every requirement marked evidenced / partial / unevidenced / contradicted
- **Round-1 briefing** — *skip this, probe that, open with this.* Saves engineer time at R0 **and again** at R1
- **Counterfactual** — the same transcript scored against a generic rubric, side by side, so "is the org context doing real work?" has an answer
- **Integrity audit** — recording, proctoring flags, snapshot timeline

Proctoring flags feed the **authenticity** rating only. They are explicitly excluded from technical scoring — an unexplained tab switch says nothing about whether someone understands connection pooling.

---

## Prototype limitations

Deliberate scope cuts, not oversights:

- **No S3, no database.** The recording stays an in-memory blob URL (same-tab only); red-flag snapshots are sent to the backend as base64 and persisted with the session so a recruiter can re-verify them from their own machine (which bloats `.sessions.json`). Prepared sessions live in a `Map`. Object storage is the real fix.
- **Voice-only.** R0 tests reasoning, not implementation. R1 still tests code.
- **Calibration is directional.** Validating against a handful of known engineers is evidence, not statistics.
- **Local credentials.** The AWS profile only exists on the machine that configured it. Deploying needs real IAM.

Phone detection *is* implemented (`useProctoring.ts`), but guarded: a handheld device must be seen continuously for over two seconds before it flags, since object detection false-positives on mugs and hands. Only sustained multi-person and phone detections can escalate toward ending a call.
