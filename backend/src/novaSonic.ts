import { randomUUID } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";
import { InvokeModelWithBidirectionalStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, SONIC_MODEL_ID } from "./bedrock";
import { generateInterviewerSystemPrompt } from "./resumeData";

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

export function attachNovaSonicRelay(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/interview" });

  wss.on("connection", (ws: WebSocket) => {
    console.log("[Sonic] Client connected");

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

        case "stop": {
          if (session.closed) return;
          session.queue.push({
            event: {
              contentEnd: {
                promptName: session.promptName,
                contentName: session.audioContentName,
              },
            },
          });
          session.queue.push({
            event: { promptEnd: { promptName: session.promptName } },
          });
          session.queue.push({ event: { sessionEnd: {} } });
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
          content: generateInterviewerSystemPrompt(),
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

    // Sonic emits each assistant line twice: once as SPECULATIVE while it is
    // still generating, then again as FINAL. Forwarding both double-posts the
    // transcript, so track the stage per content block and drop speculative text.
    const speculativeContent = new Set<string>();

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
            const { role, content, contentId } = event.textOutput;
            if (contentId && speculativeContent.has(contentId)) {
              speculativeContent.delete(contentId);
            } else {
              send({
                type: "transcript",
                sender: role === "USER" ? "candidate" : "interviewer",
                text: content,
              });
            }
          } else if (event.contentStart) {
            if (event.contentStart.type === "AUDIO") {
              send({ type: "speech_start" });
            } else if (event.contentStart.type === "TEXT") {
              let stage: string | undefined;
              try {
                stage = JSON.parse(
                  event.contentStart.additionalModelFields || "{}"
                ).generationStage;
              } catch {
                /* absent on candidate ASR blocks */
              }
              if (stage === "SPECULATIVE" && event.contentStart.contentId) {
                speculativeContent.add(event.contentStart.contentId);
              }
            }
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
      }
    })();
  });

  console.log("[Sonic] Relay listening on ws://localhost:<port>/ws/interview");
}
