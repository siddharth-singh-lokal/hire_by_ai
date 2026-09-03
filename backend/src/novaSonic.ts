import { randomUUID } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";
import { InvokeModelWithBidirectionalStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, SONIC_MODEL_ID } from "./bedrock";
import { getSession, updateSession, appendTranscript } from "./sessionStore";
import { gradeSession } from "./grading";
import { renderInterviewerPrompt } from "./questionBank";

/**
 * Nova Sonic relay.
 *
 * Browsers cannot speak HTTP/2 bidirectional streams, so this sits in the middle:
 * a WebSocket faces the browser, and an InvokeModelWithBidirectionalStream faces
 * Bedrock. Audio flows both directions as base64 PCM.
 *
 *   browser mic (16kHz PCM16) -> ws -> audioInput events  -> Nova Sonic
 *   browser speaker (24kHz)   <- ws <- audioOutput events <- Nova Sonic
 *
 * Nova Sonic also emits textOutput for BOTH speakers (role USER is its ASR of the
 * candidate, role ASSISTANT is what it said), which is where the live transcript
 * and the scorecard input come from. No separate speech-to-text needed.
 */

const AUDIO_INPUT_SAMPLE_RATE = 16000;
const AUDIO_OUTPUT_SAMPLE_RATE = 24000;

/** Sarah Chen reads as female; Nova Sonic ships tiffany/matthew/amy. */
const VOICE_ID = process.env.BEDROCK_SONIC_VOICE || "tiffany";

/**
 * An async iterable the Bedrock SDK can consume, that we can push into from
 * WebSocket callbacks. The SDK pulls one event at a time; pushes that arrive
 * while it is waiting resolve the pending promise directly.
 */
class EventQueue {
  private buffer: any[] = [];
  private pending: ((value: IteratorResult<any>) => void)[] = [];
  private closed = false;

  push(event: any): void {
    if (this.closed) return;
    const payload = {
      chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) },
    };
    const waiter = this.pending.shift();
    if (waiter) {
      waiter({ value: payload, done: false });
    } else {
      this.buffer.push(payload);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Release anything still waiting so the SDK's iteration terminates.
    while (this.pending.length) {
      this.pending.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<any>> => {
        if (this.buffer.length) {
          return Promise.resolve({ value: this.buffer.shift(), done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.pending.push(resolve));
      },
    };
  }
}

interface SonicSession {
  queue: EventQueue;
  promptName: string;
  audioContentName: string;
  /** Guards against sending audio before promptStart, which Sonic rejects. */
  ready: boolean;
  closed: boolean;
  /** Set once a termination goodbye has been injected, so it only happens once. */
  terminating: boolean;
}

/**
 * Injects an out-of-band instruction into a live Sonic conversation.
 *
 * Used to tell the interviewer something the candidate did not say — a
 * proctoring violation, or that the session is ending.
 *
 * The note goes in as a USER turn, not a SYSTEM one: Sonic permits exactly one
 * SYSTEM content block per prompt and rejects a second with "Duplicate SYSTEM
 * content". Nothing leaks into the transcript as a result, because transcripts
 * are built from textOutput events and this is an input.
 */
function injectSystemNote(session: SonicSession, note: string): void {
  const contentName = randomUUID();

  session.queue.push({
    event: {
      contentStart: {
        promptName: session.promptName,
        contentName,
        type: "TEXT",
        role: "USER",
        interactive: true,
        textInputConfiguration: { mediaType: "text/plain" },
      },
    },
  });
  session.queue.push({
    event: { textInput: { promptName: session.promptName, contentName, content: note } },
  });
  session.queue.push({
    event: { contentEnd: { promptName: session.promptName, contentName } },
  });
}

/** Closes the Bedrock stream cleanly so Sonic flushes its final audio. */
function closeSonicStream(session: SonicSession): void {
  session.queue.push({
    event: {
      contentEnd: {
        promptName: session.promptName,
        contentName: session.audioContentName,
      },
    },
  });
  session.queue.push({ event: { promptEnd: { promptName: session.promptName } } });
  session.queue.push({ event: { sessionEnd: {} } });
}

/**
 * Phrases that mean "I want to stop", checked against the candidate's own
 * transcript. Deliberately narrow: "end" or "stop" alone appear constantly in
 * normal technical conversation ("stop the workers", "end of the queue"), so
 * only unambiguous first-person requests count.
 */
const END_INTENT = [
  /\b(?:i|we)(?:'?d| would)? (?:want|like) to (?:end|stop|finish|leave|quit)\b/i,
  /\b(?:can|could) (?:we|you) (?:please )?(?:end|stop|finish|wrap up)\b/i,
  /\bi(?:'?m| am) done\b/i,
  /\bend the (?:interview|call|session)\b/i,
  /\bstop the (?:interview|call|session)\b/i,
  /\bi(?:'?d| would)? (?:rather|prefer to) not continue\b/i,
];

function detectsEndIntent(text: string): boolean {
  return END_INTENT.some((re) => re.test(text));
}

/**
 * Phrases the interviewer uses to close the interview. When she says one, the
 * conversation is over — there is otherwise no signal to hang up on, so the call
 * would sit open until the candidate happened to click End. Deliberately strong,
 * unambiguous closings only, so a mid-interview "thanks" doesn't end it early.
 */
const CLOSING_INTENT = [
  /\bteam will (?:be in touch|follow up|reach out|get back)\b/i,
  /\bwe(?:'ll| will) be in touch\b/i,
  /\bthat (?:concludes|wraps up|brings us to the end)\b/i,
  /\bthank you (?:so much |very much )?for your time\b/i,
  /\bbest of luck\b/i,
];

function detectsClosing(text: string): boolean {
  return CLOSING_INTENT.some((re) => re.test(text));
}

function newSonicSession(): SonicSession {
  return {
    queue: new EventQueue(),
    promptName: randomUUID(),
    audioContentName: randomUUID(),
    ready: false,
    closed: false,
    terminating: false,
  };
}

/**
 * Bedrock drops these bidirectional streams. Observed repeatedly in testing:
 * NGHTTP2_INTERNAL_ERROR and ModelStreamErrorException, sometimes seconds into
 * a session. Previously that ended the interview outright — the candidate was
 * left with a silent interviewer and the transcript held four turns of
 * introduction, which the grader then correctly reported as empty.
 */
const RECOVERABLE = /ModelStreamError|ServiceUnavailable|Throttl|InternalServer|NGHTTP2|ECONNRESET|EPIPE|stream closed/i;
const MAX_STREAM_ATTEMPTS = 4;

/**
 * Rough count of how far the interview got, used to tell a reconnected stream
 * what has already been asked. Deliberately approximate — over-reporting risks
 * skipping a question, so it is biased low.
 */
function countAnswered(transcripts: { sender: string }[], total: number): number {
  const answers = transcripts.filter((t) => t.sender === "candidate").length;
  return Math.min(total, Math.max(0, answers));
}

export function attachNovaSonicRelay(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/interview" });

  wss.on("connection", (ws: WebSocket, req) => {
    // The prepared session is looked up server-side from an opaque id. The
    // questions and grading criteria never reach the browser, so the candidate
    // cannot read what they are about to be asked.
    const sessionId = new URL(req.url || "", "http://localhost").searchParams.get("sessionId");
    const prepared = sessionId ? getSession(sessionId) : undefined;

    // Every interview is prepared in advance by an admin. There is deliberately
    // no fallback interviewer: running a generic hardcoded interview against a
    // real candidate would produce an assessment nobody asked for, against a
    // rubric nobody reviewed. Refusing is the honest outcome.
    if (!prepared) {
      console.warn(`[Sonic] Rejected connection — unknown session: ${sessionId || "(none)"}`);
      ws.send(
        JSON.stringify({
          type: "error",
          error: "NO_SESSION",
          message:
            "No prepared interview found for this link. Please sign in again with your email.",
        })
      );
      ws.close();
      return;
    }

    const instructions = renderInterviewerPrompt(prepared.bank, prepared.candidateName);

    if (prepared.status === "ready") {
      updateSession(prepared.id, { status: "in_progress", startedAt: Date.now() });
    }

    console.log(
      `[Sonic] Client connected — session ${prepared.id} (${prepared.candidateName}, ` +
        `${prepared.bank.role}, ${prepared.bank.durationMinutes}min, ` +
        `${prepared.bank.questions.length} questions)`
    );

    // Mutable: a dropped Bedrock stream is replaced in place while the
    // candidate's WebSocket stays open. See startStream below.
    let session: SonicSession = newSonicSession();
    let attempt = 0;
    let finished = false;

    const send = (payload: any) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    const teardown = (reason: string) => {
      if (session.closed) return;
      session.closed = true;
      console.log(`[Sonic] Session closing: ${reason}`);
      session.queue.close();
    };

    // --- Outbound: browser -> Bedrock -------------------------------------

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "audio": {
          // Continuous stream of base64 PCM16 @16kHz from the mic worklet.
          if (!session.ready || session.closed) return;
          session.queue.push({
            event: {
              audioInput: {
                promptName: session.promptName,
                contentName: session.audioContentName,
                content: msg.data,
              },
            },
          });
          break;
        }

        // Integrity observation. The frontend detects it; the relay injects a
        // note so the interviewer works a brief, natural question about it into
        // the conversation — in her own voice — and keeps going. The interview
        // is NEVER ended over a proctoring signal: a false positive cutting off a
        // real candidate would be indefensible.
        case "proctor_probe": {
          if (!session.ready || session.closed) return;
          injectSystemNote(
            session,
            `SYSTEM NOTE — do not read this aloud verbatim, and do not say you were "notified" or "flagged". ${msg.description}. Work a short, natural question about this into the conversation to understand why — stay calm and non-accusatory, it may be entirely innocent. One or two sentences, then continue with your interview questions. Do NOT end the interview.`
          );
          break;
        }

        // Candidate typed a message instead of speaking (text-input test mode).
        // Show and record it as their turn, then feed it to Sonic as a USER turn
        // so the interviewer replies — the whole flow runs without a microphone.
        case "text_input": {
          if (!session.ready || session.closed) return;
          const typed = String(msg.text || "").trim();
          if (!typed) return;
          send({ type: "transcript", sender: "candidate", text: typed });
          appendTranscript(prepared.id, { sender: "candidate", text: typed, timestamp: Date.now() });
          injectSystemNote(session, typed);
          if (detectsEndIntent(typed)) send({ type: "end_requested" });
          break;
        }

        // Time is up. Tell the interviewer to stop starting new topics and wind
        // the conversation down — the candidate is never cut off mid-answer.
        case "wind_down": {
          if (!session.ready || session.closed) return;
          injectSystemNote(
            session,
            `SYSTEM NOTE — do not read this aloud verbatim. You are now at time. Do NOT start any new topics or questions. Let the candidate finish whatever they are currently saying, then begin winding the conversation down naturally. Keep your turns short.`
          );
          break;
        }

        // The candidate asked to stop, or the interview ran out of time. Guarded
        // so overlapping triggers can't make the interviewer say goodbye twice.
        case "terminate": {
          if (session.closed || session.terminating) return;
          session.terminating = true;
          injectSystemNote(
            session,
            msg.wrapUp
              ? `SYSTEM NOTE — do not read this aloud verbatim. You are over time and the candidate is still going. Warmly let them know you're now at time, ask them to finish their final point in a sentence or two, then thank them and tell them the team will follow up. Do not start anything new.`
              : `SYSTEM NOTE — do not read this aloud verbatim. The interview is ending now (${msg.reason || "requested"}). Thank the candidate warmly in one or two sentences and tell them the team will follow up. Do not explain the reason and do not ask further questions.`
          );
          // Give her a moment to say goodbye before tearing the stream down —
          // longer when we've asked the candidate to wrap up their final point.
          setTimeout(
            () => {
              if (session.closed) return;
              finished = true; // a deliberate ending, not a dropped stream
              closeSonicStream(session);
              teardown(`terminated: ${msg.reason || "requested"}`);
            },
            msg.wrapUp ? 15000 : 8000
          );

          break;
        }

        case "stop": {
          if (session.closed) return;
          finished = true; // a normal end, not a drop — do not reconnect
          closeSonicStream(session);
          teardown("client requested stop");
          break;
        }
      }
    });

    ws.on("close", () => {
      finished = true;
      teardown("websocket closed");
    });
    ws.on("error", (err) => {
      console.error("[Sonic] WebSocket error:", err);
      teardown("websocket error");
    });

    // --- Session bootstrap -------------------------------------------------

    /**
     * Pushes the opening event sequence into a fresh queue.
     *
     * `resumeNote` is set when this is a reconnection: Sonic has no memory of
     * the dropped stream, so it is told what has already been covered and asked
     * to continue rather than start the interview over.
     */
    const bootstrap = (resumeNote?: string) => {
    session.queue.push({
      event: {
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: 1024,
            topP: 0.9,
            temperature: 0.7,
          },
        },
      },
    });

    session.queue.push({
      event: {
        promptStart: {
          promptName: session.promptName,
          textOutputConfiguration: { mediaType: "text/plain" },
          audioOutputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: AUDIO_OUTPUT_SAMPLE_RATE,
            sampleSizeBits: 16,
            channelCount: 1,
            voiceId: VOICE_ID,
            encoding: "base64",
            audioType: "SPEECH",
          },
        },
      },
    });

    // System prompt is delivered as a TEXT content block before any audio.
    const systemContentName = randomUUID();
    session.queue.push({
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: systemContentName,
          type: "TEXT",
          role: "SYSTEM",
          interactive: true,
          textInputConfiguration: { mediaType: "text/plain" },
        },
      },
    });
    session.queue.push({
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: systemContentName,
          content: resumeNote ? `${instructions}\n\n${resumeNote}` : instructions,
        },
      },
    });
    session.queue.push({
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: systemContentName,
        },
      },
    });

    // Open the microphone content block. Audio chunks stream into this until stop.
    session.queue.push({
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: session.audioContentName,
          type: "AUDIO",
          role: "USER",
          interactive: true,
          audioInputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: AUDIO_INPUT_SAMPLE_RATE,
            sampleSizeBits: 16,
            channelCount: 1,
            audioType: "SPEECH",
            encoding: "base64",
          },
        },
      },
    });

    session.ready = true;
    };

    // --- Inbound: Bedrock -> browser ---------------------------------------

    // Sonic can emit the same assistant line more than once — a SPECULATIVE pass
    // while it is still generating, then a FINAL one. Relying on the
    // generationStage marker proved fragile (some blocks arrive with no stage at
    // all, and filtering on it silently dropped every interviewer line). Content
    // equality is the robust check: emit each distinct line once per speaker.
    // A ring of recently-emitted lines per speaker rather than just the last
    // one. Sonic can re-emit a whole multi-line block (A,B,C then A,B,C again),
    // which a single-value comparison lets straight through — the candidate
    // then hears the same warning twice.
    const recentlyEmitted: Record<string, string[]> = { candidate: [], interviewer: [] };
    const DEDUPE_WINDOW = 12;
    // Fire the auto-end signal at most once, when she first says a closing line.
    let concludedSent = false;

    /** What to tell a fresh stream so it resumes instead of starting over. */
    const buildResumeNote = (): string => {
      const answered = countAnswered(prepared.transcripts, prepared.bank.questions.length);
      const covered = prepared.bank.questions
        .map((q, i) => `${i + 1}. ${q.question}`)
        .filter((_, i) => i < answered);
      return (
        `RESUMING AN INTERRUPTED CALL. The connection dropped and has been restored. ` +
        `Do NOT reintroduce yourself and do NOT start over.\n` +
        (covered.length
          ? `Already asked:\n${covered.join("\n")}\n`
          : `Nothing substantive has been covered yet.\n`) +
        `Say one short line acknowledging the drop, then continue from where you left off.`
      );
    };

    const startStream = async (resumeNote?: string): Promise<void> => {
      bootstrap(resumeNote);

      try {
        const response = await bedrockClient.send(
          new InvokeModelWithBidirectionalStreamCommand({
            modelId: SONIC_MODEL_ID,
            body: session.queue as any,
          })
        );

        send({ type: "ready" });

        for await (const chunk of response.body as any) {
          const bytes = chunk?.chunk?.bytes;
          if (!bytes) continue;

          let event: any;
          try {
            event = JSON.parse(new TextDecoder().decode(bytes)).event;
          } catch {
            continue;
          }
          if (!event) continue;

          if (event.audioOutput) {
            send({ type: "audio", data: event.audioOutput.content });
          } else if (event.textOutput) {
            // role USER  -> Sonic's transcription of the candidate
            // role ASSISTANT -> what the interviewer said
            const { role, content } = event.textOutput;
            const sender = role === "USER" ? "candidate" : "interviewer";
            const text = String(content || "").trim();

            // Sonic occasionally emits control payloads (e.g. {"interrupted":true})
            // through the same channel as speech. Those are not dialogue.
            const isControlPayload = /^\s*[{[]/.test(text) && /"\w+"\s*:/.test(text);

            const seen = recentlyEmitted[sender];
            if (text && !isControlPayload && !seen.includes(text)) {
              seen.push(text);
              if (seen.length > DEDUPE_WINDOW) seen.shift();
              send({ type: "transcript", sender, text });

              // Persist server-side so the result survives the browser closing.
              appendTranscript(prepared.id, { sender, text, timestamp: Date.now() });

              // If the candidate asks to stop, there is no signal left to
              // gather — respect it rather than pressing on.
              if (sender === "candidate" && detectsEndIntent(text)) {
                console.log(`[Sonic] Candidate requested to end: "${text}"`);
                send({ type: "end_requested" });
              }

              // The interviewer said her closing line — the interview is over.
              // Signal the client to wind down once she has finished speaking.
              if (sender === "interviewer" && !concludedSent && detectsClosing(text)) {
                console.log(`[Sonic] Interviewer concluded: "${text}"`);
                concludedSent = true;
                send({ type: "concluded" });
              }
            }
          } else if (event.contentStart?.type === "AUDIO") {
            send({ type: "speech_start" });
          }

          if (event.contentEnd) {
            // Sonic reports barge-in here; the client flushes its playback queue
            // so the interviewer stops mid-sentence when the candidate speaks.
            if (event.contentEnd.stopReason === "INTERRUPTED") {
              send({ type: "interrupted" });
            } else if (event.contentEnd.type === "AUDIO") {
              send({ type: "speech_end" });
            }
          }
        }

        // The stream ended on Bedrock's side without an error. If the client
        // asked to stop, that is the normal end of the interview. If not, the
        // stream lapsed and should be picked back up.
        if (finished || ws.readyState !== WebSocket.OPEN) {
          send({ type: "closed" });
          return finish("stream ended");
        }
        throw new Error("stream closed unexpectedly");
      } catch (err: any) {
        const label = `${err?.name || "Error"}: ${err?.message || "unknown"}`;
        const recoverable = RECOVERABLE.test(label);

        if (recoverable && !finished && ws.readyState === WebSocket.OPEN && ++attempt <= MAX_STREAM_ATTEMPTS) {
          console.warn(
            `[Sonic] ${prepared.id} — stream dropped (${label}). ` +
              `Reconnecting, attempt ${attempt}/${MAX_STREAM_ATTEMPTS}.`
          );

          // Tell the client so it can flush stale audio and show a brief notice
          // rather than sitting in silence wondering.
          send({ type: "reconnecting", attempt });

          // Sonic has no memory of the dropped stream. Hand it back what has
          // already been covered so it continues instead of reintroducing itself.
          const resumeNote = buildResumeNote();

          session = newSonicSession();
          // Exponential-ish backoff; Bedrock faults often clear within a second.
          await new Promise((r) => setTimeout(r, 400 * attempt));
          return startStream(resumeNote);
        }

        console.error(`[Sonic] ${prepared.id} — stream failed: ${label}`);
        send({
          type: "error",
          error: err?.name || "SONIC_STREAM_FAILED",
          recoverable,
          message: recoverable
            ? "The voice connection dropped and could not be restored. Please rejoin."
            : /expired|security token/i.test(err?.message || "")
            ? "Session credentials have expired. Please contact the recruiter."
            : err?.message || "The interview stream failed unexpectedly.",
        });
        finish("stream failed");
      }
    };

    /**
     * Ends the interview once, no matter which path got here, and kicks off
     * grading. The browser may already be gone.
     */
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      teardown(reason);
      if (ws.readyState === WebSocket.OPEN) ws.close();

      const id = prepared.id;
      setTimeout(() => {
        gradeSession(id, reason).catch((e) =>
          console.error("[Sonic] Auto-grade failed:", e?.message)
        );
      }, 3000);
    };

    // If this session already has candidate turns, the browser is reconnecting
    // (its WebSocket dropped — e.g. a backend restart) rather than starting fresh,
    // so resume from progress instead of greeting again.
    const resuming = prepared.transcripts.some((t) => t.sender === "candidate");
    startStream(resuming ? buildResumeNote() : undefined).catch((e) =>
      console.error("[Sonic] startStream:", e?.message)
    );
  });

  console.log("[Sonic] Relay listening on ws://localhost:<port>/ws/interview");
}
