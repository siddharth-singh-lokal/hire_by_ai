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
npm run dev              # both, via concurrently
npm run dev:backend      # :4000  API + Nova Sonic relay
npm run dev:frontend     # :3030  UI
npm run typecheck        # tsc --noEmit in backend, harness and frontend
npm run e2e              # end-to-end interview against the LIVE relay (see Testing)
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

7. **A broken call is never the candidate's fault.** The relay counts voice
   stream drops; the grader is told, must not read "hello? can you hear me" as
   disengagement, and reports `screenQuality` (`clean` / `degraded` /
   `compromised`) plus `rescreenRecommended`. The scorecard shows this above the
   verdict. A real candidate was graded "Do not advance 22" on a call that
   dropped four times; with this in place the same transcript grades "Needs
   discussion 38, re-screen recommended".

8. **Hinglish is a first-class answer.** The interviewer accepts English, Hindi
   or a mix and never comments on it; the grader scores content, not polish,
   and is told the transcript is machine-transcribed speech. This matters for
   who Lokal hires.

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
| `backend/src/sessionStore.ts` | In-memory Map, mirrored (debounced, async) to `.sessions.json`; evidence blobs in `.evidence/` |
| `backend/src/contextPack/` | fetch -> redact -> sanitize -> validate pipeline |
| `frontend/hooks/useNovaSonicInterview.ts` | Audio capture/playback, WS client |
| `frontend/public/worklets/` | Mic capture (16kHz) and playback (24kHz) |
| `frontend/hooks/useProctoring.ts` | MediaPipe face + object detection |
| `backend/src/languages.ts` | Interview languages, per-language voice and prompt directive |
| `backend/src/contextPack/role-context/*.md` | Hand-written, human-approved role context for non-backend disciplines |
| `backend/scripts/e2e.ts` | Drives a whole interview over the WebSocket, no microphone |

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
- **Workshop credentials expire with the event, and they expire mid-session.**
  Observed live: `sts get-caller-identity` succeeded, and ten minutes later
  every Bedrock call returned `ExpiredTokenException`. Refresh the `workshop`
  profile in `~/.aws/credentials` (the AWS sandbox hands out a new
  key/secret/session-token triple) and restart the backend. A 403 or a 424 is
  almost always this, not misconfiguration.
- **Voice has no fallback provider, by necessity.** Nova Sonic is the only
  realtime bidirectional speech-to-speech option available here. OpenRouter was
  checked directly: of 425 models, four emit audio at all (two are music
  generation, two are request/response `gpt-audio`) and none are realtime, so
  barge-in and VAD turn-taking are impossible on it. If Bedrock is down, the
  interview cannot run — say so rather than degrading it to a walkie-talkie.
- **Text calls DO have a fallback.** `src/llm.ts` is the single call site for
  bank generation, grading, the counterfactual and the pack sanitizer. Bedrock
  is primary; on a provider-level failure (expired token, revoked model access,
  throttling) it retries once on OpenRouter and records the truth in the
  scorecard's `modelUsed`. Verified against genuinely expired credentials:
  identical axis scores and verdict, overall 68 vs 72. `LLM_PROVIDER=openrouter`
  forces it for testing. Prompt-level errors are NOT retried — a bad prompt
  fails the same way everywhere.
- **Load `./env` first in every entry point.** Module bodies run at import
  time, so a `dotenv.config()` below the import list runs too late and any
  module-level `process.env.X` has already been read as empty. That silently
  disabled the OpenRouter fallback while the key sat in `.env`. `src/llm.ts`
  now also reads env lazily so import order cannot break it again.

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
- **Two-layer reconnect.** The relay retries the *Bedrock* stream itself on
  `RECOVERABLE` errors (`MAX_STREAM_ATTEMPTS` *consecutive* failures — the
  counter resets once the new stream carries a real candidate turn, so a flaky
  call is not killed on its Nth drop), sending `{type:"reconnecting"}` while
  the browser socket stays open. Every drop is counted on the session
  (`streamDrops`) and reaches the grader and the scorecard. The client separately reconnects the *browser↔relay* WebSocket
  (`scheduleReconnect`, `MAX_WS_RECONNECTS`) when that socket drops or fails to
  open — backend restart, network blip, or a non-recoverable relay error after its
  retries. A reconnecting client re-attaches to the same in-progress session and
  the relay resumes without re-greeting (the session already has transcripts).
  A user-initiated end and hard errors (permission, creds, no-session) never
  reconnect — those set `intentionalCloseRef` / `noReconnectRef`.
- **The resume note shows the model the transcript tail, not a count.** An
  earlier version counted candidate lines as "questions answered", but the ASR
  emits several lines per utterance ("two", "hello", "yeah"), so after one drop
  the interviewer was told both questions were done and skipped to a scenario
  she had never asked. It also *replaces* the `HOW TO OPEN` section
  (`renderInterviewerPrompt(..., { resumeNote })`) — appending it after left
  the opening instructions in force and she re-greeted the candidate after
  every drop.
- **The opening line uses a `{{name}}` token.** The generator once baked a
  name off the resume ("Sai Kumar") that did not match what the candidate
  signed up as ("Venkata Sai Reddy"), and the interviewer used the wrong name
  for the whole call. `personaliseOpening` substitutes the admin-entered name;
  legacy banks with a baked-in greeting name get it swapped too.

### Languages

- **Nova Sonic speaks Hindi and English, and no other Indian language.** The AI
  Service Card lists English, Spanish, German, French, Italian, Portuguese and
  Hindi, and explicitly advises against the rest. Telugu, Tamil, Kannada,
  Malayalam, Marathi, Gujarati and Bengali are in `languages.ts` with
  `sonicSupported: false` and render disabled in the admin picker — the honest
  next step for them is Sarvam AI (native realtime speech-to-speech for all 22
  Indian languages) or a Transcribe → LLM → Polly cascade, NOT an unsupported
  Sonic locale.
- Voices: `kiara` (f) / `arjun` (m) are the native hi-IN and en-IN voices;
  `tiffany` / `matthew` are polyglot and code-switch Hinglish mid-sentence,
  which is why Hinglish uses tiffany. Full enum in the research notes.
- The bank is always generated in English. Only the **spoken** interview is
  translated, by a directive in the rendered prompt (`languages.ts`), so
  grading, the gap matrix and the R1 briefing stay comparable across languages.
  The grader is told the language and asked to quote verbatim with an English
  gloss.

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
  and then outputs silence — heard as speech chopping mid-word. `PRIME_SECONDS`
  in `playback-processor.js` holds the cushion, and it is **adaptive**: every
  underrun grows the prime for the next turn by half, up to `MAX_PRIME_SECONDS`,
  so a bad path trades latency for continuity only after continuity was
  actually lost. `__round0Audio.underruns` climbing during a call means the
  delivery path (relay event loop, main thread, network) is the problem.
- **Bluetooth headsets sound bad by design.** When the mic is open, AirPods and
  most BT headsets drop to the hands-free profile (8/16kHz codec) — the
  interviewer sounds tinny and crackly regardless of anything in this code.
  Test with wired headphones or the laptop's own mic and speakers.
- **Interrupting her is a three-layer problem, and the mic gate was the bug.**
  Reported as "she just keeps talking and never stops when we speak". Causes,
  in the order they bite:

  1. **The old mic gate deafened her to the candidate.** `mic-processor.js` used
     a FIXED `BARGE_GATE` of 0.12 and **zeroed** every chunk below it while she
     spoke. Measured against a real 92s speech waveform: only **55% of chunks
     cleared 0.12**, and the rest became digital silence — so Sonic received
     chopped fragments separated by silence, which its VAD does not read as
     someone starting to talk. It never registered a barge-in, so she talked
     straight over them. The gate is now `GATE_FLOOR + remoteLevel *
     GATE_ECHO_RATIO` — proportional to how loud SHE is, which is what echo
     scales with — and sub-gate audio is **attenuated to `DUCK_GAIN`, never
     zeroed**, so the waveform stays continuous. Same clip now passes 71-76% at
     normal playback levels. The playback worklet forwards its level to the mic
     worklet unthrottled (`remoteLevel`) to drive this.
  2. **Sonic's own barge-in is slow: ~5.8-6.2 seconds**, measured with
     `npm run e2e -- --barge-in` feeding real speech. Waiting for it is not an
     option; six seconds of being talked over is a broken conversation.
  3. **So the client stops her itself.** `LOCAL_DUCK_AFTER_MS` (90ms) drops her
     to 12% volume the moment the candidate is clearly speaking, which is the
     "it heard me" cue, and `LOCAL_FLUSH_AFTER_MS` (700ms) discards her buffered
     audio outright. Sonic catches up later and ends its turn anyway. A false
     positive costs one dropped sentence of hers — the right trade against
     talking over a real candidate. `__round0Audio.localBargeIns` counts these.

  Any flush Sonic *does* send is still ignored unless the mic was genuinely loud
  for `BARGE_IN_SUSTAIN_MS`, because Sonic emits spurious INTERRUPTED events
  (observed 3-6 per run against pure silence). Headphones remove echo entirely.
  Note: switching the LLM does nothing here, and OpenRouter can't help — it has
  no realtime S2S audio (verified: 4 of 425 models emit audio, none realtime).
- **Her turn length is capped structurally, not just asked for.**
  `maxTokens` in the relay's `sessionStart` is **400**, not 1024 — 1024 is ~90
  seconds of speech, which is what "goes on and on" was. The prompt also tells
  her to stop mid-word when the candidate starts and to let silence sit. Total
  measured: her speaking time fell from 138.8s to 98.4s across the same six
  candidate turns. Do not push maxTokens much below 400 or she truncates
  mid-sentence.
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

### Grading

- **We are grading problem solvers, not recall.** The prompt says so explicitly
  and it changes outcomes: a candidate who says "I don't remember the exact
  method names" and then reasons correctly through the durability trade-off and
  the stampede mechanism scores **Advance 82** with authenticity 5, while one
  who names WebSocket fallback, at-least-once semantics and XFetch but cannot
  say why the spike lands at the same time daily scores **Advance with focus
  62** with "reasoning collapses under follow-up" as a red flag. The
  `strongAnswer`/`weakAnswer` fields are handed over as **illustrative, not a
  marking scheme** — counting how many listed points a candidate hit is exactly
  the failure mode to avoid. Note the rote candidate is still not rejected;
  discriminating is not the same as harsh.
- **`screenQuality` is clamped to the relay's drop count.** The model may
  escalate a call we already know dropped, but it may not invent degradation on
  a clean one — it did exactly that on a zero-drop run, reading ordinary spoken
  fragmentation as a connection fault, which would have put a "connection
  problems" banner on a healthy screen. `assessCallQuality` in `evaluate.ts` is
  the authority; see the clamp at the bottom of `evaluateInterview`.
- **Role context fills the gap the Context Pack cannot.** The pack is built from
  engineering documents, so it only ever yields backend/infra scenarios — a
  Product Analyst was getting connection-pooling questions. PRDs cannot fix
  that: the sanitizer rejects business logic by design and correctly returns no
  scenarios for them. `contextPack/role-context/{product,data,mobile,frontend}.md`
  are therefore hand-written at the same trust level as `company-profile.md`,
  bypass sanitization because there is nothing in them to sanitize, and describe
  the *shape* of the work (low-end devices, ten languages, lossy mobile events)
  with no metric, price or experiment result. A human reviews them; that review
  IS the approval step.

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

- **Never do synchronous work on the relay's event loop.** `persist()` used to
  `JSON.stringify` + `writeFileSync` the whole store on every transcript line,
  and the store carried every proctoring clip inline as base64 (~2.7MB each).
  Two sessions in, that was an 8MB blocking write (~25ms, growing with every
  interview of the day) several times a second while Sonic audio was being
  relayed. Writes are now debounced and async, and evidence blobs live in
  `backend/.evidence/<sessionId>.json` (gitignored), written once on
  completion. Keep it that way: anything CPU-heavy (PDF parsing, big
  serialisation) either stays off the hot path or goes in a worker.
- `pdf-parse` v2 exports a `PDFParse` **class**, not a function. v1 examples
  from the internet will not work. It is also CPU-heavy on the main thread —
  an admin uploading a PDF while a candidate is live will stall their audio.
- The Confluence/Slack allowlist is hardcoded in `contextPack/sources.ts`. For a
  different org: replace `company-profile.md`, edit that allowlist, set the env
  tokens. With no tokens at all it still works — profile plus JD-derived scenarios.

## Testing

```bash
npm run typecheck                  # backend + harness + frontend
npm run e2e                        # one full interview against the live relay
npm run e2e -- --loop 3            # measure the Bedrock drop rate
npm run e2e -- --lang hi           # Hindi run; writes backend/e2e-hi.wav to listen to
npm run e2e -- --session <id>      # drive a session prepared in the admin UI
npm run e2e -- --barge-in          # talk over her with REAL speech, measure when she stops
npm --prefix backend run verify:redaction   # the Context Pack regression test
```

**`backend/scripts/e2e.ts` is the only automated test of the voice path**, and it
deliberately does not mock Bedrock — every failure mode in this file was found by
running a real stream, and a mock would have hidden all of them. It connects to
the relay exactly as the browser does, answers with scripted turns, and asserts
on the resulting scorecard (verdict, one axis score per rubric axis,
`screenQuality`, and `streamDrops` matching what the client observed).

Two things it relies on:

- **It must stream silence.** Sonic's VAD closes a turn only when it hears
  audio stop, so a text-only turn with no `audioInput` never gets a reply — the
  run just hangs. The harness sends a 1024-byte zero frame every 32 ms.
- **`POST /api/dev/prepare-from-bank`** creates a session from a checked-in bank
  fixture, skipping the ~50 s generation, so a loop is repeatable and comparable.
  It is guarded on `NODE_ENV !== "production"`. Sessions live in the server
  process's memory, so the harness cannot call `createSession` directly.

Still verify by hand in a browser before demoing: proctoring, the audio worklets
and barge-in only exist there.

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
- The candidate's URL carries **only** the opaque session id. Name, duration and
  language are fetched from `GET /api/candidate/session/:id`; they used to ride
  in the query string, where a candidate could edit their own timer and a
  missing param silently meant a 30-minute interview.
- Voice-only. R0 tests reasoning, not implementation.
- Local credentials only. Deploying needs real IAM.
