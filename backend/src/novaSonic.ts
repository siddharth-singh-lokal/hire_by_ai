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

    const session: SonicSession = {
      queue: new EventQueue(),
      promptName: randomUUID(),
      audioContentName: randomUUID(),
      ready: false,
      closed: false,
    };

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

        // Proctoring escalation. The frontend detects the violation; the relay
        // injects a note so Sarah raises it herself, in her own voice, mid
        // conversation. A banner the candidate can ignore is not a warning.
        case "proctor_warning": {
          if (!session.ready || session.closed) return;

          const note =
            msg.strike === 2
              ? `SYSTEM NOTE — do not read this aloud verbatim. This is a SECOND warning. ${msg.description}. Tell the candidate firmly that this is the final warning and the interview will end if it continues. Two sentences, then return to the question.`
              : `SYSTEM NOTE — do not read this aloud verbatim. ${msg.description}. Politely ask the candidate to correct this so the session stays valid. Stay calm and non-accusatory — it may be innocent. Two sentences, then return to the question.`;

          injectSystemNote(session, note);
          break;
        }

        // The candidate asked to stop, or escalation ran out of strikes.
        case "terminate": {
          if (session.closed) return;
          injectSystemNote(
            session,
            `SYSTEM NOTE — do not read this aloud verbatim. The interview is ending now (${msg.reason || "requested"}). Thank the candidate warmly in one or two sentences and tell them the team will follow up. Do not explain the reason and do not ask further questions.`
          );
          // Give her a moment to say goodbye before tearing the stream down.
          setTimeout(() => {
            if (session.closed) return;
            closeSonicStream(session);
            teardown(`terminated: ${msg.reason || "requested"}`);
          }, 8000);
          break;
        }

        case "stop": {
          if (session.closed) return;
          closeSonicStream(session);
          teardown("client requested stop");
          break;
        }
      }
    });

    ws.on("close", () => teardown("websocket closed"));
    ws.on("error", (err) => {
      console.error("[Sonic] WebSocket error:", err);
      teardown("websocket error");
    });

    // --- Session bootstrap -------------------------------------------------

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
          content: instructions,
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

    (async () => {
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

        send({ type: "closed" });
      } catch (err: any) {
        console.error("[Sonic] Stream error:", err?.name, err?.message);
        send({
          type: "error",
          error: err?.name || "SONIC_STREAM_FAILED",
          message:
            err?.message ||
            "Nova Sonic stream failed. Workshop credentials may have expired.",
        });
      } finally {
        teardown("bedrock stream ended");
        if (ws.readyState === WebSocket.OPEN) ws.close();

        // Grade unprompted. The browser may already be gone — a candidate who
        // closes the tab must still produce a result for the hiring manager.
        // Delayed slightly so a /complete call carrying proctoring flags can
        // land first; gradeSession is idempotent either way.
        const id = prepared.id;
        setTimeout(() => {
          gradeSession(id, "interview ended").catch((e) =>
            console.error("[Sonic] Auto-grade failed:", e?.message)
          );
        }, 3000);
      }
    })();
  });

  console.log("[Sonic] Relay listening on ws://localhost:<port>/ws/interview");
}
