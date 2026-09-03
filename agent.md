# agent.md — start here (living status)

This is the quick-orientation / current-status note for agents. It is **not** the
reference. For architecture, design commitments, and gotchas, read:

- **`AGENTS.md`** — the canonical, deep reference (keep it authoritative; don't
  duplicate it here).
- **`docs/architecture.md`** — connection topology + the two-layer reconnect
  (Mermaid diagrams).

Keep this file short: pointers + what's currently hot + open decisions. Put
durable facts in `AGENTS.md`.

---

## What this is (one line)

Round-0 org-grounded screening interview: admin prepares a JD+resume → question
bank; candidate has a live **voice** interview; hiring manager gets evidence.
Runs on **Amazon Bedrock** (no OpenAI in the shipped code).

- Backend: Express + WS relay, `:4000`. Frontend: Next.js 14, `:3030`.
- Run: `npm run dev:backend` / `npm run dev:frontend` from the repo root.

---

## 🔴 Currently hot: voice-stream stability

The live voice model is **Amazon Nova Sonic** (`amazon.nova-2-sonic-v1:0`).
Confirmed via `aws bedrock list-foundation-models` to be the **only** speech-to-
speech model on the account and already **`ACTIVE` (GA)** — there is no more-stable
Sonic to switch to.

**The problem:** Nova Sonic drops its Bedrock bidirectional stream repeatedly
(`NGHTTP2_INTERNAL_ERROR` / `ModelStreamErrorException`), sometimes seconds in.
This is inherent to Nova Sonic / the HTTP-2 path, not a preview-vs-GA issue and
not fixable by a model-ID swap.

**Mitigations already in place** (see `backend/src/novaSonic.ts`):
- Two-layer reconnect: relay retries the Bedrock stream (`RECOVERABLE`,
  `MAX_STREAM_ATTEMPTS`, resume-from-progress via `buildResumeNote`); client
  retries the WebSocket (`scheduleReconnect`, `MAX_WS_RECONNECTS`).
- **Apologise at most once** per connection (`dropAcknowledged`) — otherwise a
  flaky stream made the interviewer say "sorry, we lost the connection" on a loop.
- **`MAX_TOTAL_DROPS`** cap — `attempt` resets on every candidate turn, so without
  a total cap a flaky stream reconnected forever.

## Open decision: migrate the voice transport (pending a key)

Nova Sonic is the source of the breaking. The real fix is a different real-time
voice provider. Only the **voice transport** swaps (`novaSonic.ts` +
`useNovaSonicInterview.ts`); bank/grading/scorecard/proctoring are transport-
agnostic and stay on Bedrock.

| Option | Model | Needs | Status |
|---|---|---|---|
| **Gemini Live** (leading pick) | `gemini-2.5-flash-native-audio-latest` | a durable **`AIza…`** Google AI Studio key | account has Live access; blocked on the durable key (the `AQ.…` token given is an ephemeral ~30-min token) |
| OpenAI Realtime | `gpt-realtime` | `sk-…` OpenAI key (billing) | not started |
| Stay on Nova Sonic | — | — | works with the mitigations above |

**OpenRouter cannot do any of this.** It only proxies text `/v1/chat/completions`
— no realtime-audio endpoint. An OpenRouter (`sk-or-…`) key is usable only for a
text interview or the LLM brain in a cascade, never for live voice.

---

## Operational gotchas that keep biting

- **`ts-node` does not hot-reload.** After any *backend* edit you MUST restart the
  backend or it runs stale code. (Frontend hot-reloads.) Consider switching
  `dev` to `ts-node-dev`.
- **AWS creds must be in the backend's process.** Put them in `backend/.env`
  (`AWS_ACCESS_KEY_ID`/`SECRET`/`SESSION_TOKEN` + `AWS_REGION=us-west-2`) or export
  them in the shell that runs the backend. Workshop creds expire; `Could not load
  credentials from any providers` = none present. Restart the backend from a shell
  that has them.
- Restart command: `lsof -ti tcp:4000 | xargs kill 2>/dev/null; npm run dev:backend`.

## Recent changes (this session)

- Client-side WebSocket reconnect + resume-on-reconnect (both layers).
- Per-error Bedrock classification; honest "Connection failed" vs "Connecting…"
  in the visualizer; Rejoin/End recovery panel.
- Echo mic-gate + tuned barge-in; graceful time-up (`wind_down` + grace);
  auto-end on the interviewer's closing line; text-input test mode.
- Per-flag video clips + snapshots persisted for recruiter re-verification.
- Apologise-once + `MAX_TOTAL_DROPS` (fixes the repeated "we lost the connection").
- Added `docs/architecture.md`.
