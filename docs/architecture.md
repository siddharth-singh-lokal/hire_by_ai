# Architecture — connections & reconnect

This document describes the **calling architecture** of the Round-0 interview
system: which connections exist, where each is stored, what happens when one
drops, and how each is retried.

There are **two independent connections** in the live voice path, each with its
own retry loop:

- **Browser ↔ Relay** — a **WebSocket** (`/ws/interview`), held client-side in
  `wsRef` inside `useNovaSonicInterview`.
- **Relay ↔ Bedrock** — the **Nova Sonic bidirectional stream**
  (`InvokeModelWithBidirectionalStream`), held server-side per-connection as
  `SonicSession.queue`.

Durable state (bank, transcripts, flags, scorecard) lives in `sessionStore`
(in-memory `Map` mirrored to `.sessions.json`), keyed by `sessionId`. The relay
appends the transcript as it streams, so it survives *both* connections dropping —
which is what makes a mid-interview reconnect resume instead of starting over.

---

## 1. Calling architecture — the two connections & where state lives

```mermaid
graph LR
  subgraph Browser["Browser · Next.js :3030"]
    Admin["/admin<br/>prepareInterview()"]
    Signin["/ · candidateSignIn()"]
    Room["/interview<br/>useNovaSonicInterview hook"]
    subgraph ClientState["client refs (in the hook)"]
      WSref["wsRef · the WebSocket"]
      AudioRef["audioContextRef<br/>micNodeRef · playbackNodeRef"]
      ReconRef["reconnect state:<br/>wsAttemptsRef, reconnectTimerRef,<br/>intentionalCloseRef, noReconnectRef"]
    end
    Room --> WSref & AudioRef & ReconRef
  end

  subgraph Backend["Express :4000"]
    Prepare["POST /api/prepare"]
    SigninAPI["POST /api/candidate/signin"]
    Complete["POST /api/interview/:id/complete"]
    ScorecardAPI["GET /api/scorecard/:id"]
    Relay["WS /ws/interview<br/>attachNovaSonicRelay()"]
    subgraph RelayState["per-connection (in the relay closure)"]
      Session["SonicSession<br/>queue: EventQueue<br/>attempt · finished"]
    end
    Store[("sessionStore<br/>Map + byEmail + .sessions.json<br/>bank · transcripts · flags · scorecard")]
    Relay --> Session
  end

  subgraph Bedrock["Amazon Bedrock · us-west-2"]
    Converse["Converse API<br/>Claude Sonnet 4.6<br/>bank + grading"]
    Sonic["InvokeModelWithBidirectionalStream<br/>Nova Sonic · voice"]
  end

  Admin -->|"① HTTP"| Prepare --> Converse
  Prepare --> Store
  Signin -->|"② HTTP"| SigninAPI --> Store
  WSref <-->|"③ WebSocket<br/>audio / text / control"| Relay
  Session <-->|"④ HTTP/2 bidi stream<br/>base64 PCM"| Sonic
  Relay -->|append transcript| Store
  Room -->|"⑤ HTTP flags"| Complete --> Store
  ScorecardAPI --> Store
```

**Which connection / where stored:**

- **③ Browser ↔ Relay = a WebSocket.** Stored client-side in **`wsRef`** (inside
  `useNovaSonicInterview`). This is the only "connection" the browser holds.
- **④ Relay ↔ Bedrock = the Nova Sonic bidirectional stream.** Stored server-side
  per-connection as the **`SonicSession.queue`** (an `EventQueue` fed to
  `InvokeModelWithBidirectionalStream`). One WS connection → one live `SonicSession`.
- **Durable state** (bank, transcripts, flags, scorecard) lives in the
  **`sessionStore` Map** mirrored to `.sessions.json`, keyed by `sessionId`.

---

## 2. Connection setup (happy path)

```mermaid
sequenceDiagram
  participant A as Admin
  participant C as Candidate (browser)
  participant BE as Express relay
  participant NS as Nova Sonic

  A->>BE: POST /api/prepare (JD+resume)
  BE->>BE: generate bank, createSession() -> sessionId
  Note over BE: stored in Map + .sessions.json
  C->>BE: POST /api/candidate/signin (email) -> sessionId
  C->>BE: WS connect /ws/interview?sessionId=  (wsRef)
  BE->>BE: getSession(id) · newSonicSession()
  BE->>NS: InvokeModelWithBidirectionalStream (session.queue)
  NS-->>BE: stream open
  BE-->>C: {type:"ready"}  -> connectionState = "active"
  loop live call
    C->>BE: {audio} PCM chunks
    BE->>NS: audioInput events
    NS-->>BE: audioOutput + textOutput
    BE-->>C: {audio}, {transcript}
    BE->>BE: appendTranscript() -> store
  end
```

---

## 3. What happens on a drop, and how we retry — two independent loops

```mermaid
flowchart TD
  subgraph L1["Layer A · Relay - Bedrock stream (server-side)"]
    A0["Bedrock stream errors / ends unexpectedly"] --> A1{"RECOVERABLE?<br/>ModelStreamError, NGHTTP2,<br/>Throttling, ECONNRESET…"}
    A1 -->|"yes & attempt <= 4<br/>& WS still open"| A2["send reconnecting to client<br/>backoff 400·attempt ms<br/>newSonicSession()<br/>buildResumeNote (already-asked Qs)"]
    A2 --> A3["startStream(resumeNote)<br/>-> she continues, no re-greet"]
    A3 --> A0
    A1 -->|"no, or attempts exhausted"| A4["send error {recoverable}<br/>finish() -> grade partial transcript"]
  end

  subgraph L2["Layer B · Browser - Relay WebSocket (client-side)"]
    B0["ws.onclose (unexpected)<br/>or connect fails<br/>or relay error(recoverable:true)"] --> B1{"intentionalClose?<br/>or noReconnect?<br/>(perm/creds/no-session)"}
    B1 -->|"yes"| B2["stop -> show error / rejoin panel"]
    B1 -->|"no & attempt <= 5"| B3["scheduleReconnect()<br/>backoff min(8s, 800·attempt)<br/>show 'reconnecting…'"]
    B3 --> B4["startInterview() again<br/>-> NEW wsRef WebSocket"]
    B4 --> B5["relay sees session has transcripts<br/>-> buildResumeNote() on initial<br/>-> resumes, no re-greet"]
    B5 -->|"success: {ready}"| B6["reset wsAttempts=0<br/>connectionState=active"]
    B1 -->|"attempts > 5"| B2
  end

  A4 -.->|"recoverable:true<br/>relay gave up its own retries"| B0
```

**Retry rules:**

| Drop type | Detected by | Retries | Backoff | Resume? |
|---|---|---|---|---|
| Bedrock stream (recoverable) | relay `catch` | **4×** (`MAX_STREAM_ATTEMPTS`) | `400·attempt` ms | ✅ `buildResumeNote` |
| WebSocket drop / connect fail | client `ws.onclose` / catch | **5×** (`MAX_WS_RECONNECTS`) | `min(8s, 800·attempt)` | ✅ resumes on new WS |
| Relay exhausted its stream retries | relay sends `error{recoverable:true}` | → hands off to **Layer B** | — | ✅ |
| Creds / model-access / validation / no-session | `recoverable:false` | **never** (`noReconnectRef`) | — | — |
| User ended / hardware permission | `intentionalCloseRef` / `NotAllowedError` | **never** | — | — |

The two loops are decoupled on purpose: **Layer A** keeps the browser's WebSocket
alive while it re-establishes the Bedrock stream underneath; **Layer B** rebuilds
the WebSocket itself when *that* is what broke.

---

## Key files

| File | Role |
|---|---|
| `frontend/hooks/useNovaSonicInterview.ts` | WebSocket client (`wsRef`), audio worklets, **Layer B** reconnect (`scheduleReconnect`, `MAX_WS_RECONNECTS`) |
| `frontend/app/interview/page.tsx` | Interview room UI; reconnect overlay + Rejoin/End panel |
| `backend/src/novaSonic.ts` | Relay: `SonicSession`, `startStream`, **Layer A** reconnect (`RECOVERABLE`, `MAX_STREAM_ATTEMPTS`, `buildResumeNote`) |
| `backend/src/sessionStore.ts` | Durable `Map` + `.sessions.json` (bank, transcripts, flags, scorecard) |
| `backend/src/server.ts` | HTTP routes (`/api/prepare`, `/api/candidate/signin`, `/api/interview/:id/complete`, `/api/scorecard/:id`) |
