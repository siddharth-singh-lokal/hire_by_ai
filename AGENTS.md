# AGENTS.md

Context for AI agents working in this repo. Read this before changing anything —
most of it is hard-won and not inferable from the code.

## What this is

A Round-0 screening interview system. An admin uploads a JD and a resume; the
system generates a role-specific question bank grounded in the org's own
engineering context; a candidate has a live voice interview with it; a hiring
manager gets evidence.

Runs entirely on **Amazon Bedrock**. No OpenAI anywhere.

```
backend/   Express + WebSocket relay, port 4000
frontend/  Next.js 14 App Router, port 3030
```

## Running it

```bash
npm run dev:backend      # :4000  API + Nova Sonic relay
npm run dev:frontend     # :3030  UI
```

Backend needs AWS credentials in `backend/.env` (`AWS_PROFILE=...` or the
`AWS_ACCESS_KEY_ID`/`SECRET`/`SESSION_TOKEN` triple) plus `AWS_REGION=us-west-2`.

Context Pack commands (all from `backend/`):

```bash
npm run pack:fetch                 # Confluence + Slack -> raw/
npm run pack:build                 # redact -> abstract -> validate
npm run pack:build -- --approve    # only after a human reads the output
npm run verify:redaction           # regression test: plants secrets, proves they're caught
```

**Never run `next build` while the dev server is running** — it overwrites
`.next/` and the running server starts throwing `MODULE_NOT_FOUND`. Kill the dev
server, build, restart.

## Design commitments — do not quietly reverse these

1. **Evidence, not verdicts.** The system never decides a hire. Verdicts are
   advancement language (`Advance` / `Advance with focus` / `Needs discussion` /
   `Do not advance`) and a human decides. Every score above or below neutral must
   cite a verbatim quote.

2. **This is a screening bar, not a hiring bar.** Absence of evidence is
   neutral (score 3), never negative. A skill someone did not list but clearly
   has is a plus. A skill they lack only counts against them if it is needed on
   day one. Grading harshly here loses good candidates, which is far more
   expensive than advancing a mediocre one — later rounds catch those.

3. **The live agent has no retrieval.** It receives a rendered prompt and
   nothing else: no MCP, no tools, no path to Slack or Confluence. It cannot
   leak what it was never given. Do not add tool access to the interview path.

4. **The candidate never sees their score.** They land on `/thank-you`. The
   scorecard is admin-only, reached from `/admin`.

5. **Business logic stays out of the Context Pack.** Stack names are fine
   ("we run PostgreSQL behind Django"). Pricing, payouts, wallet economics,
   ranking formulas are not. Enforced in `sanitize.ts` and `validate.ts`.

6. **Proctoring flags never lower technical scores.** They feed the authenticity
   rating only. A tab switch says nothing about whether someone understands
   connection pooling.

## Architecture

### The four inputs

```
JD           -> which competencies to test, the bar, culture criteria
Resume       -> which claims to verify, which projects to probe
Context Pack -> what the scenarios testing those competencies are MADE OF
Duration     -> how many probes actually fit (1 / 5 / 15 / 30 / 45; 1 is a smoke test)
```

The pack is the **setting, never the syllabus**. Candidates are never quizzed on
internal trivia — that would be unfair and measure nothing.

### Request flow

```
/admin      POST /api/prepare        JD+resume -> bank -> session (keyed by email)
/           POST /api/candidate/signin   email -> sessionId (26ms lookup, no generation)
/interview  WS   /ws/interview?sessionId=...
            POST /api/interview/:id/complete   proctoring flags + elapsed time
/scorecard  GET  /api/scorecard/:id  polls while status is in_progress | grading
```

Generation (~50-70s) happens on the **admin** side, before the candidate exists.
The candidate never waits on a model call. Do not move generation into the
candidate path.

### Key files

| File | Role |
|---|---|
| `backend/src/bedrock.ts` | Model IDs per task, client, JSON extraction |
| `backend/src/questionBank.ts` | JD+resume+pack -> bank; renders the live prompt |
| `backend/src/novaSonic.ts` | WS <-> Bedrock bidirectional stream relay |
| `backend/src/grading.ts` | Auto-grades when a stream ends |
| `backend/src/evaluate.ts` | Scoring prompt + generic counterfactual |
| `backend/src/sessionStore.ts` | In-memory Map, mirrored to `.sessions.json` |
| `backend/src/contextPack/` | fetch -> redact -> sanitize -> validate pipeline |
| `frontend/hooks/useNovaSonicInterview.ts` | Audio capture/playback, WS client |
| `frontend/public/worklets/` | Mic capture (16kHz) and playback (24kHz) |
| `frontend/hooks/useProctoring.ts` | MediaPipe face + object detection |

There is **no fallback interviewer**. A WebSocket connection without a valid
prepared session is rejected. Running a generic hardcoded interview against a
real candidate would produce an assessment nobody asked for, against a rubric
nobody reviewed — refusing is the honest outcome.

## Gotchas that will cost you an hour

### Bedrock

- **Claude needs the `us.` inference-profile prefix.** Bare `anthropic.claude-*`
  fails with "on-demand throughput isn't supported".
- **Nova Sonic is the opposite** — ON_DEMAND only, bare `amazon.nova-2-sonic-v1:0`,
  no inference profile exists.
- In this sandbox `opus-5`, `sonnet-5`, `gpt-5.6-*` and `grok-4.6` all return
  **AccessDenied**. Available: sonnet-4-5/4-6, opus-4-5/4-6, haiku-4-5.
- Workshop credentials expire with the event. A 403 usually means expiry, not
  misconfiguration.

### Nova Sonic protocol

- **Exactly one SYSTEM content block per prompt.** A second returns
  `Duplicate SYSTEM content`. Mid-conversation injections (proctoring probes,
  typed candidate turns, termination) must use `role: "USER"` — see `injectSystemNote`.
- **Text-input test mode.** The client can send `{type:"text_input"}` and the
  relay feeds it in as a candidate USER turn, so the whole flow (reply, ending,
  grading) runs without a microphone. The interview room shows a text box for this.
- **Time-up is graceful, never a hard cut.** When the clock hits 0 the client
  sends `wind_down` (stop new topics, wind down) and only closes on a real lull —
  neither party speaking for a few seconds. A 3-minute grace cap then sends
  `terminate` with `wrapUp:true`, asking the candidate to finish their final point
  before the goodbye. `terminate` is single-shot (`session.terminating`).
- **Auto-end on conclusion.** A finished interview would otherwise sit open until
  someone clicked End. When the interviewer says a closing line (`detectsClosing`
  in the relay) it sends `concluded`; the client waits ~8s for her audio to finish,
  then closes — without injecting a second goodbye (she already said it).
- **Its VAD needs continuous audio, including silence.** Muting must zero the
  samples, not stop the stream. Stop sending and it never detects end-of-turn,
  so it never replies — the interview silently hangs.
- **It re-emits lines.** The `generationStage` marker is unreliable (some blocks
  arrive without one), and filtering on it silently drops *every* interviewer
  line. Dedupe on content with a rolling window instead.
- **Control payloads arrive through the text channel** (e.g. `{"interrupted":true}`).
  Filter them or they land in the transcript.

### The live prompt

The agent is deliberately **not** given `intent`, `strongAnswer` or
`weakAnswer`. It read them aloud in testing — it told a candidate "someone who
did the work would mention why ClickHouse over TimescaleDB", which is handing
over the answer key. The grader reads those fields off the bank afterwards, so
withholding them costs nothing.

### Audio

- **AudioWorklet `process()` runs every 128 frames** — 125×/sec at 16kHz. Posting
  per call means 125 WebSocket sends and 125 React renders a second, which
  visibly janks the UI. Batch to ~32ms chunks and throttle meters to ~20fps.
- **Playback needs a jitter buffer.** Sonic delivers in bursts (p50 1ms inside a
  burst, p99 699ms between them). Playing on the first chunk drains it in ~40ms
  and then outputs silence — heard as speech chopping mid-word. `PRIME_SAMPLES`
  in `playback-processor.js` holds the cushion.
- **A barge-in flush discards buffered speech**, so a spurious one cuts the
  interviewer off regardless of buffering. Echo from speakers is the usual cause
  of constant mid-sentence interruptions. Two guards: while she speaks the mic is
  gated (`BARGE_GATE` in `mic-processor.js` — residual echo below it is sent as
  silence, so Sonic never hears it as a barge-in), and any flush Sonic does send
  is ignored unless the mic was genuinely loud for `BARGE_IN_SUSTAIN_MS`.
  Headphones remove the echo entirely and make both a no-op. Note: switching the
  LLM does nothing here, and OpenRouter can't help — it has no realtime S2S audio;
  the only S2S alternatives are OpenAI Realtime or Gemini Live.
- Live diagnostics: `__round0Audio` in the browser console.

### Context Pack

- **`raw/` is gitignored and must never be committed** — unsanitized internal docs.
- **An unapproved pack is treated as absent.** Passing validation is not the same
  as a human having read it.
- **The validator fails closed.** If the adversarial check cannot run, that is a
  FAIL. An unavailable check is not a passed check.
- **Rule order in `redact.ts` matters.** Credentials and personal data run first:
  redacting the company domain before emails turns `alice@company.com` into
  `alice@<domain>` — domain gone, name still there.
- **Incident fingerprints are not matchable tokens.** An exact timestamp plus a
  date plus a cache-key version identifies an incident with every hostname
  removed. Regex cannot catch that; the adversarial LLM pass exists for it.

### Proctoring

- Phone detection requires **2s sustained** detection. Object detectors
  false-positive on mugs, notebooks and hands.
- Proctoring never ends a call. `PROBEABLE_FLAGS` (`MULTIPLE_FACES_DETECTED`,
  `PHONE_DETECTED`, `LOOKING_AWAY`) make the interviewer ask about it live, in her
  own voice (`proctor_probe` → `injectSystemNote`), then continue. Tab switches
  and brief absences are logged for the recruiter only. Ending a real candidate's
  interview on a false positive would be indefensible — earlier strike-to-terminate
  logic was removed for exactly this reason.
- `LOOKING_AWAY` is a best-effort head-pose heuristic (nose vs. eye-midpoint from
  the face keypoints), deliberately conservative and sustained; it flags "may be
  reading from elsewhere" but is noisier than face-count or phone detection.
- The grader also judges authenticity from the transcript — answers that read as
  recited/scripted lower authenticity — independently of any proctoring flag.
- MediaPipe `detectForVideo` is **synchronous on the main thread**. Adding more
  detectors or raising the rate starves the WebSocket handler and degrades audio.

### Misc

- `pdf-parse` v2 exports a `PDFParse` **class**, not a function. v1 examples
  from the internet will not work.
- The Confluence/Slack allowlist is hardcoded in `contextPack/sources.ts`. For a
  different org: replace `company-profile.md`, edit that allowlist, set the env
  tokens. With no tokens at all it still works — profile plus JD-derived scenarios.

## Testing

There is no test suite. Verification is done by running things:

```bash
npm run verify:redaction    # the one real regression test
npx tsc --noEmit            # in both backend/ and frontend/
```

For anything touching the voice path, **test against the live relay** — every
failure mode listed above was found by running real audio through it, not by
reading code. Reading the code would not have revealed any of them.

## Prototype limitations (deliberate)

- No S3. The full recording stays an in-memory blob URL (same-tab only). Per-flag
  evidence — a JPEG snapshot AND a short (~6s) video clip recorded from the moment
  the violation fires — is sent to the backend as base64 on completion and
  persisted with the session, so the recruiter can re-verify from their own machine.
  This bloats `.sessions.json`; real deployments should move it all to object
  storage. A clip still recording when the interview ends is simply dropped.
- No database. `.sessions.json` is a convenience mirror, not storage — no
  concurrency control, rewrites the whole file per change.
- No auth on `/admin`.
- Voice-only. R0 tests reasoning, not implementation.
- Local credentials only. Deploying needs real IAM.
