# Round-0 AI Technical Interview System

A prototype two-way conversational AI technical interview platform, with live proctoring and a recruiter audit trail. Runs entirely on **Amazon Bedrock** — no OpenAI key required.

Decoupled into two applications:
1. **`backend/`** — Express server: Nova Sonic speech-to-speech relay + Claude evaluation engine.
2. **`frontend/`** — Next.js 14 client: interview room, MediaPipe proctoring, session recording, recruiter scorecard.

---

## 🏗️ Architecture

```
+---------------------------------------------------------------------------+
|                     FRONTEND (Next.js - Port 3030)                        |
|                                                                           |
|  - AudioWorklet mic capture (16kHz PCM16) + playback queue (24kHz)         |
|  - MediaPipe FaceDetector proctoring (WASM, vendored locally)              |
|  - MediaRecorder session capture -> in-memory blob                         |
|  - Audio-reactive visualizer, rolling transcript, recruiter scorecard      |
+---------------------------------------------------------------------------+
       |                                              |
       | WebSocket /ws/interview                      | POST /api/evaluate
       v                                              v
+---------------------------------------------------------------------------+
|                      BACKEND (Express - Port 4000)                        |
|                                                                           |
|  Nova Sonic relay: browsers can't speak HTTP/2 bidirectional streams, so   |
|  this bridges WebSocket <-> InvokeModelWithBidirectionalStream.            |
+---------------------------------------------------------------------------+
       |                                              |
       v                                              v
+------------------------------------+  +---------------------------------------+
|  amazon.nova-2-sonic-v1:0          |  |  us.anthropic.claude-sonnet-4-5        |
|  SPEECH in -> SPEECH + TEXT out    |  |  Structured JSON scorecard             |
|  Server-side VAD, barge-in support |  |  Reads transcript + proctoring flags   |
+------------------------------------+  +---------------------------------------+
```

**Two model-ID gotchas that will cost you an hour if you miss them:**
- Claude requires the `us.` inference-profile prefix. Bare `anthropic.claude-*` IDs fail with *"on-demand throughput isn't supported"*.
- Nova Sonic is the opposite — ON_DEMAND only, bare model ID, no inference profile exists.

---

## ⚡ Quickstart

### 1. AWS credentials

Everything resolves through the standard AWS provider chain. Either set a profile:

```bash
# backend/.env
PORT=4000
AWS_PROFILE=workshop
AWS_REGION=us-west-2
```

…or export Workshop Studio credentials directly (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`).

Verify Bedrock reachability before starting:

```bash
aws bedrock list-foundation-models --region us-west-2 \
  --query "modelSummaries[?contains(modelId,'sonic')].[modelId,modelLifecycle.status]" --output text
```

### 2. Run

```bash
npm run dev:backend    # Express + Sonic relay on :4000
npm run dev:frontend   # Next.js on :3030
```

Open **http://localhost:3030**, grant camera and mic, and start the interview.

---

## 🎙️ How the voice loop works

Nova Sonic decides the candidate has finished speaking using **server-side voice activity detection**. The mic therefore streams **continuously, including silence** — muting zeroes the samples inside the worklet rather than stopping the stream. Cutting the stream entirely means Sonic never detects end-of-turn and never replies.

Barge-in is supported: interrupting mid-answer makes Sonic emit an `INTERRUPTED` event, and the client flushes its playback queue so the interviewer stops mid-sentence.

Measured latency, end-of-speech to first audio byte: **~1.8s**.

---

## 🛡️ Proctoring

Runs client-side via MediaPipe FaceDetector at ~3fps, throttled so it doesn't compete with the audio pipeline. WASM and the `blaze_face_short_range` model are vendored into `public/` so the demo doesn't depend on a CDN.

| Flag | Trigger |
|---|---|
| `MULTIPLE_FACES_DETECTED` | More than one face in frame |
| `CANDIDATE_ABSENT` | Zero faces for >3s (debounced) |
| `TAB_SWITCH_DETECTED` | `visibilitychange` / window `blur` |

Each flag captures a JPEG frame as evidence, with an 8s per-type cooldown to prevent duplicate spam. Flags feed the scorecard's **authenticity** rating but are explicitly excluded from technical scoring.

**Phone detection from the original spec is not implemented.** Object detection for handheld devices false-positives on mugs, notebooks and hands — a proctoring tool that cries wolf is worse than one that stays quiet.

---

## ⚠️ Prototype limitations

These are deliberate scope cuts, not oversights:

- **No S3.** The recording and flag snapshots are object URLs in a module-level store (`lib/sessionStore.ts`). They survive client-side navigation to `/scorecard` but **not a hard refresh or a new tab**, and nothing is shareable with a real recruiter. Swapping in S3 means replacing two functions with presigned PUTs; nothing else changes.
- **No session persistence.** Transcripts pass through `localStorage`; there is no database.
- **Credentials are local.** Workshop Studio credentials expire when the event ends, and the AWS profile only exists on the machine that configured it. Deploying anywhere requires real IAM.
- **Claude grades hard.** Sonnet 4.5 will reject a thin transcript that older models passed. Tune `CANDIDATE_RESUME.rubric` before demoing.

---

## 🌐 Endpoints

### Backend (`http://localhost:4000`)
- `GET /health` — service status, region, and active model IDs.
- `WS /ws/interview` — Nova Sonic speech-to-speech relay.
- `POST /api/evaluate` — Claude scorecard from transcript + proctoring flags. Falls back to a deterministic rubric matcher if Bedrock is unreachable, so a demo never hard-fails.

### Frontend (`http://localhost:3030`)
- `/` — hardware readiness check and candidate lobby.
- `/interview` — live interview room with proctoring overlay and flag ticker.
- `/scorecard` — recruiter scorecard with integrity audit, recording playback, and clickable flag timeline.
