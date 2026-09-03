# CLAUDE.md

Entry point for an AI agent picking this repo up cold.

**Read `AGENTS.md` first and in full.** It holds the architecture, the design
commitments that must not be quietly reversed, and ~40 hard-won gotchas about
the voice path. Everything there is still current. This file covers only what
`AGENTS.md` cannot: the state of the work right now, what is verified versus
assumed, and the pitch context that shapes what to build next.

---

## What this is, in one paragraph

A Round-0 screening interview that runs as a live voice call. An admin pastes a
JD and a resume; Claude generates a role-specific question bank grounded in the
org's own engineering context; the candidate talks to Amazon Nova Sonic for
5-45 minutes in English, Hinglish or Hindi; Claude grades the transcript and
hands a hiring manager evidence — verbatim quotes, a JD gap matrix, and a
Round-1 briefing saying what to skip and what to probe. Runs entirely on
Amazon Bedrock. Built for Lokal's internal AI hackathon (AI*thon 4.0, 3-4 Sep
2026).

## Status as of 4 Sep 2026, ~03:00 IST

Working and **verified against the live stack**, not just type-checked:

| Thing | Evidence |
|---|---|
| Full voice interview | 6+ consecutive `npm run e2e` runs, **zero stream drops**, 2.6-3.0s to first audio |
| Hindi interview | 16/16 interviewer lines in Devanagari, 92s of real speech, `backend/e2e-hi.wav` |
| Grading | 6/6 rubric axes every run; problem-solver 82 vs rote-memoriser 62 |
| Backend endpoints | 29/29 functional checks (see the audit script pattern below) |
| Proctoring | flags survive browser → API → `.evidence/` → recruiter view |
| Proctoring cannot bias scores | same transcript ± flags: identical verdict, ratings, all six axes |
| Frontend | all 5 pages build, prerender and serve with no runtime errors |
| Text-call failover | proven under genuinely expired AWS creds: same verdict, same axes, 68 vs 72 |

**Not verified, needs a human with a browser and headphones:**

- Barge-in end to end. The e2e harness talks straight to the relay and
  **bypasses the mic worklet**, so it can measure Sonic's yield latency but not
  the gate or the local duck. See the barge-in section in `AGENTS.md`.
- Proctoring detection itself (MediaPipe is browser-only).
- Whether the Hindi voice sounds good to a native speaker.

## Known-open items

- **Nothing is committed.** All of the above is uncommitted work on branch
  `sept-3-poc-1-30-pm`.
- **AWS workshop credentials expire mid-session** — observed twice. They live in
  `backend/.env` (gitignored) as an explicit key/secret/session-token triple,
  with `AWS_PROFILE` commented out. When Bedrock starts 403ing, that is why.
  Text calls fail over to OpenRouter automatically; **voice cannot** and the
  demo is dead until the triple is refreshed.
- `frontend/lib/scorecardTypes.ts` is still unimported; the scorecard page uses
  `any`. Harmless, low priority.
- No auth on `/admin`, no database, no S3. Deliberate prototype scope.

## The pitch context — this changes what is worth building

The final presentation is judged by **investors and founders, not internal HR
or engineering leaders**: two India Quotient investors (Lokal's own investor),
Siddharth Dialani (founder, BharatAgri), and Dharmesh BA (1990 Research Labs).
Five minutes per team. Historic rubric: Impact 30 / Execution 30 / UX 20 /
Production-readiness 20, with a "Magical AI Quotient" (wow factor) category in
earlier editions.

That audience does not reward "we saved our own recruiters some time". It
rewards a wedge into a real market with a defensible advantage. The reframe
that matters, and it is not a stretch:

> We built this to screen our own engineers. In doing so we built the thing
> **Lokal Jobs** needs most.

Grounding, from Lokal's own Confluence (MONETISATI space):

- **Lokal already employs a human screening team that phone-calls job seekers.**
  The "Seeker ADS improvements for Screening Team" page has fields `Is Screened`,
  `Screened by`, `Screened Timestamp`, `Call/Screening Status`,
  `Screened_Role Mismatch`, `Screened_Location`. That is a salaried, serial,
  business-hours process. This system does the same job in the seeker's own
  language, at any volume, at marginal cost.
- **The B2B recruiter product already has a "screening questions" concept** —
  static text fields an advertiser attaches to a job post. This turns those into
  an actual conversation.
- **Employers churn for exactly the reasons a pre-screen fixes.** The "Lokal Jobs
  Expiry" page lists advertiser reasons including candidates lacking the
  skillset, candidates not coming for interviews, and candidates being rude on
  calls.
- Monetisation already runs on job posts and contact unlocks, so better
  applicant relevance maps directly onto revenue and retention.

**Implication for an agent working here:** the highest-leverage additions are
whatever makes the Lokal Jobs framing concrete and demoable, not more polish on
the engineering-hiring path. A blue-collar/vernacular screening demo is worth
more than another refactor.

## Ground rules specific to this repo

Beyond the design commitments in `AGENTS.md`:

1. **Never add a fallback provider to the voice path.** Nova Sonic is the only
   realtime bidirectional speech-to-speech option available. Verified directly:
   of OpenRouter's 425 models, four emit audio at all and none are realtime.
   Request/response audio would make this a walkie-talkie, which is a worse
   product, not a fallback. Text calls go through `src/llm.ts`, which keeps
   Bedrock primary and falls back once on provider-level failures.
2. **Grade problem solvers, not recall.** The grading prompt states this
   explicitly and it is load-bearing — see the Grading section of `AGENTS.md`
   for the measured 82-vs-62 contrast. `strongAnswer`/`weakAnswer` are
   illustrative, never a marking scheme.
3. **A broken call is never the candidate's fault.** `screenQuality` is clamped
   to the relay's own drop count so the grader cannot invent degradation.
4. **Test the voice path against the live relay.** `npm run e2e`. Every failure
   mode in `AGENTS.md` was found by running real audio, none by reading code.

## Commands

```bash
npm run dev                      # both servers (backend :4000, frontend :3030)
npm run typecheck                # backend + harness + frontend
npm run e2e                      # a full interview over the WebSocket, no mic
npm run e2e -- --loop 3          # measure the Bedrock drop rate
npm run e2e -- --lang hi         # Hindi run; writes backend/e2e-hi.wav
npm run e2e -- --barge-in        # talk over her with real speech, measure the yield
npm --prefix backend run verify:redaction   # Context Pack regression test
```

The e2e harness needs the backend up with `NODE_ENV` unset, so that
`POST /api/dev/prepare-from-bank` is enabled — sessions live in the server
process's memory, so the harness cannot create one directly.

## Where the interesting code is

`AGENTS.md` has the full table. The three files that hold the most hard-won
behaviour:

- `backend/src/novaSonic.ts` — the relay. Reconnect, resume-without-re-greeting,
  drop counting, barge-in relay, graceful ending.
- `frontend/public/worklets/mic-processor.js` — the mic gate, which is where
  "she talks over the candidate" was fixed. Plain JS, **not type-checked**;
  a syntax error here only appears at runtime, so parse-check it after editing.
- `backend/src/evaluate.ts` — the grading prompt, the call-quality clamp, and
  the problem-solver-over-recall framing.
