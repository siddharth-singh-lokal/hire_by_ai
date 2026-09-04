import { randomUUID } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";
import { InvokeModelWithBidirectionalStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { sonicClient, SONIC_MODEL_ID } from "./bedrock";
import { getSession, updateSession, appendTranscript, patchTranscriptEnglish, recordStreamDrop } from "./sessionStore";
import { gradeSession } from "./grading";
import { renderInterviewerPrompt } from "./questionBank";
import { resolveLanguage } from "./languages";
import { shouldLocalizeTranscript, translateLineToHinglish } from "./translate";

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

/** 512 samples @16kHz ≈ 32ms — Sonic's VAD needs a continuous stream, silence included. */
const SILENCE_B64 = Buffer.alloc(1024).toString("base64");

/** Injected USER text to kick off the opening turn; filtered from the live transcript. */
const OPENING_TRIGGER = "\u200b";

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
  /**
   * Aborts the Bedrock request after teardown. Closing our input queue alone
   * does NOT end Bedrock's response stream promptly — observed to stay open for
   * minutes — which left the relay's read loop hanging and the session's GPU
   * resources allocated. sessionEnd is sent first; this is the backstop.
   */
  abort: AbortController;
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
  injectUserTextTurn(session, note);
}

/** Push silent PCM frames so Sonic's VAD sees an open mic before the browser worklet is up. */
function injectSilentAudio(session: SonicSession, frames: number): void {
  for (let i = 0; i < frames; i++) {
    session.queue.push({
      event: {
        audioInput: {
          promptName: session.promptName,
          contentName: session.audioContentName,
          content: SILENCE_B64,
        },
      },
    });
  }
}

function injectUserTextTurn(session: SonicSession, text: string): void {
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
    event: { textInput: { promptName: session.promptName, contentName, content: text } },
  });
  session.queue.push({
    event: { contentEnd: { promptName: session.promptName, contentName } },
  });
}

function isOpeningTrigger(text: string): boolean {
  const t = text.trim();
  return t === OPENING_TRIGGER || t === "." || t === "…";
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
    abort: new AbortController(),
  };
}

/**
 * Bedrock drops these bidirectional streams. Observed repeatedly in testing:
 * NGHTTP2_INTERNAL_ERROR, ModelStreamErrorException and "Truncated event
 * message received" (the HTTP/2 stream closing mid-frame, so the eventstream
 * decoder sees a short message) — sometimes seconds into a session. Every one
 * of these is transport-level and transient: the ONLY wrong response is to end
 * the interview, so this pattern is deliberately broad. A phrase missing from
 * it costs a candidate their interview, while a false positive costs one
 * harmless retry. Previously that ended the interview outright — the candidate was
 * left with a silent interviewer and the transcript held four turns of
 * introduction, which the grader then correctly reported as empty.
 */
const RECOVERABLE =
  /ModelStreamError|ServiceUnavailable|Throttl|InternalServer|NGHTTP2|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|stream closed|Truncated event message|Unexpected end|socket hang up|GOAWAY|ERR_HTTP2|TimeoutError|aborted/i;
/**
 * Consecutive failed attempts before giving up. The counter resets once a
 * re-established stream has carried a real candidate turn: a call that drops
 * four times over five minutes but works in between is a flaky call, not a dead
 * one, and used to be killed on the fourth drop mid-answer.
 */
const MAX_STREAM_ATTEMPTS = 5;

/** How much recent conversation a resumed stream is shown. */
const RESUME_TAIL_LINES = 18;

/** Brief check-ins that are not real interview questions — skip when resuming. */
function isPingTurn(text: string): boolean {
  const t = text.trim();
  if (!t || /reconnecting/i.test(t)) return true;
  if (/^(hey|hi|hello|are you (still )?there|still (there|with me)|can you hear|you there)/i.test(t)) {
    return true;
  }
  // Very short lines with no question mark are usually silence check-ins.
  return t.length < 30 && !t.includes("?");
}

function lastSubstantiveInterviewerTurn(
  transcripts: { sender: string; text: string }[]
): string | undefined {
  for (let i = transcripts.length - 1; i >= 0; i--) {
    const line = transcripts[i];
    if (line.sender === "interviewer" && !isPingTurn(line.text)) return line.text;
  }
  return undefined;
}

/**
 * Delay between the stream ending and grading starting, so the browser's
 * completion POST (proctoring flags plus base64 snapshots and clips) arrives
 * first. 3s was cutting it fine with several megabytes of evidence.
 */
const GRADE_DELAY_MS = 8000;

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

    if (prepared.status === "ready") {
      updateSession(prepared.id, { status: "in_progress", startedAt: Date.now() });
    }

    // Interview language decides the voice and a prompt directive. Unsupported
    // codes fall back to English inside resolveLanguage, so a bad value never
    // hands Sonic a locale it cannot speak.
    const lang = resolveLanguage((prepared as any).language);

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
    let openingKickTimer: ReturnType<typeof setTimeout> | null = null;
    let candidateSpokeThisStream = false;
    let openingKickFired = false;
    let serverSilenceTimer: ReturnType<typeof setInterval> | null = null;
    let clientMicActive = false;

    const cancelOpeningKick = () => {
      if (openingKickTimer) {
        clearTimeout(openingKickTimer);
        openingKickTimer = null;
      }
    };

    const stopServerSilence = () => {
      if (serverSilenceTimer) {
        clearInterval(serverSilenceTimer);
        serverSilenceTimer = null;
      }
    };

    /** Keeps Sonic's VAD alive until the browser mic worklet is streaming. */
    const startServerSilence = () => {
      if (serverSilenceTimer) return;
      serverSilenceTimer = setInterval(() => {
        if (session.closed || !session.ready) {
          stopServerSilence();
          return;
        }
        const fresh = getSession(prepared.id);
        if (fresh?.transcripts.some((t) => t.sender === "interviewer")) {
          stopServerSilence();
          return;
        }
        if (clientMicActive) {
          stopServerSilence();
          return;
        }
        session.queue.push({
          event: {
            audioInput: {
              promptName: session.promptName,
              contentName: session.audioContentName,
              content: SILENCE_B64,
            },
          },
        });
      }, 32);
    };

    const fireOpeningKick = () => {
      if (openingKickFired || session.closed || !session.ready) return;
      if (candidateSpokeThisStream) return;
      const fresh = getSession(prepared.id) ?? prepared;
      if (fresh.transcripts.some((t) => t.sender === "interviewer")) return;

      openingKickFired = true;
      cancelOpeningKick();

      console.log(`[Sonic] ${prepared.id} — opening kick (candidate silent)`);
      injectSilentAudio(session, 32);
      injectUserTextTurn(session, OPENING_TRIGGER);
      injectSystemNote(
        session,
        `[The candidate is connected and silent. Start the interview NOW: deliver your opening greeting exactly as in HOW TO OPEN, then ask your first question.]`
      );
    };
    /**
     * Mic chunks that arrived while the Bedrock stream was being re-established.
     * 32ms per chunk, so this is ~2s of audio — enough to cover a reconnect
     * without replaying so much that Sonic hears a stale sentence.
     */
    const pendingAudio: string[] = [];
    const MAX_PENDING_AUDIO_CHUNKS = 64;

    const send = (payload: any) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    const teardown = (reason: string) => {
      if (session.closed) return;
      session.closed = true;
      cancelOpeningKick();
      stopServerSilence();
      console.log(`[Sonic] Session closing: ${reason}`);
      session.queue.close();
      // Give the queued contentEnd/promptEnd/sessionEnd two seconds to reach
      // Bedrock, then abort so the read loop exits and resources are freed.
      const s = session;
      setTimeout(() => s.abort.abort(), 2000);
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
          if (session.closed) return;
          if (!session.ready) {
            // Mid-reconnect: Sonic is not listening yet. Hold the most recent
            // couple of seconds rather than dropping it, so a candidate who
            // keeps talking through a drop is not cut off mid-word.
            pendingAudio.push(msg.data);
            if (pendingAudio.length > MAX_PENDING_AUDIO_CHUNKS) pendingAudio.shift();
            return;
          }
          clientMicActive = true;
          stopServerSilence();
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
          // A real candidate turn proves the stream works — reset the
          // consecutive-failure budget (ASR turns do this too, but a text-only
          // run never emits ASR, so a long call would otherwise die on drop #6).
          if (attempt > 0) attempt = 0;
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

        // Long silence after a question — anchor the model so it does not
        // re-greet or jump back to an earlier question from the list.
        case "continuity_nudge": {
          if (!session.ready || session.closed) return;
          const fresh = getSession(prepared.id);
          const lastQ =
            fresh?.lastQuestionAsked ||
            lastSubstantiveInterviewerTurn(fresh?.transcripts ?? prepared.transcripts);
          if (!lastQ) return;
          injectSystemNote(
            session,
            `SYSTEM NOTE — do not read this aloud verbatim. The candidate has been quiet while thinking. ` +
              `Do NOT say hello, hey, or re-introduce yourself. Do NOT return to earlier questions they already answered. ` +
              `Your last question, which is still open, was: "${lastQ.slice(0, 500)}". ` +
              `Either stay silent a little longer or repeat ONLY that question in one short sentence, then listen.`
          );
          break;
        }

        // Browser backup: candidate still silent ~2s after ready.
        case "kickoff": {
          if (!session.ready || session.closed) return;
          fireOpeningKick();
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
              closeSonicStream(session);
              // The goodbye audio has already been delivered; the browser closes
              // its own socket once it finishes playing. Grading starts here.
              finish(`terminated: ${msg.reason || "requested"}`, { closeWs: false });
            },
            msg.wrapUp ? 15000 : 8000
          );

          break;
        }

        case "stop": {
          if (session.closed) return;
          closeSonicStream(session);
          finish("client requested stop", { closeWs: false });
          break;
        }
      }
    });

    // A closed tab, a crashed browser, a lost network: the transcript is already
    // server-side, so the interview is graded regardless. This used to only
    // tear the stream down, and grading silently depended on the browser
    // posting /complete afterwards.
    ws.on("close", () => finish("websocket closed", { closeWs: false }));
    ws.on("error", (err) => {
      console.error("[Sonic] WebSocket error:", err);
      finish("websocket error", { closeWs: false });
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
            // A hard ceiling on how long one spoken turn can run. 1024 tokens
            // is ~90 seconds of speech, which is what "she just keeps going"
            // felt like; the prompt asks for two or three sentences and this
            // makes it structural rather than advisory. Not lower than this:
            // an over-tight cap truncates her mid-sentence.
            maxTokens: 400,
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
            // Per-language voice, overridable at runtime with BEDROCK_SONIC_VOICE
            // so a different voice (e.g. an Indian male one) can be tried without
            // a code change. An invalid id makes Sonic reject the stream, so only
            // set the override to a voice the account actually has.
            voiceId: process.env.BEDROCK_SONIC_VOICE || lang.voiceId,
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
          // On a resume the opening instructions are replaced by the resume
          // note. Appending it after them left "HOW TO OPEN" in force, and the
          // interviewer greeted the candidate afresh after every drop.
          content: renderInterviewerPrompt(prepared.bank, prepared.candidateName, {
            resumeNote,
            language: lang,
          }),
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

    // Prime VAD before the browser mic worklet connects (~1s of silence).
    injectSilentAudio(session, 32);

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

    /**
     * What to tell a fresh stream so it resumes instead of starting over.
     *
     * Shows the model the tail of the actual conversation rather than a count.
     * The earlier version counted candidate transcript lines as "questions
     * answered" — but the ASR emits several lines per utterance ("two", "hello",
     * "yeah") — so after one drop it told the interviewer both questions were
     * done and she skipped straight to a scenario she had never asked.
     */
    const buildResumeNote = (): string => {
      const fresh = getSession(prepared.id) ?? prepared;
      const name = prepared.candidateName;
      const transcripts = fresh.transcripts;
      const lastQ =
        fresh.lastQuestionAsked || lastSubstantiveInterviewerTurn(transcripts);
      const lastLine = transcripts[transcripts.length - 1];
      const waitingForAnswer = lastLine?.sender === "interviewer";
      const tail = transcripts
        .slice(-RESUME_TAIL_LINES)
        .map((t) => `${t.sender === "candidate" ? name : "You"}: ${t.text}`)
        .join("\n");
      return (
        `The call dropped and has just been restored. You are MID-INTERVIEW.\n\n` +
        `FORBIDDEN: greeting ${name} again, saying "hey" or "hello", re-introducing yourself, ` +
        `or asking any question that already appears answered in the transcript below.\n\n` +
        (lastQ
          ? `CONTINUE FROM YOUR LAST QUESTION (do NOT go back to earlier ones):\n"${lastQ}"\n\n` +
            (waitingForAnswer
              ? `${name} had not answered yet when we dropped — they may have been thinking. ` +
                `Repeat that question briefly in one sentence, then listen.\n\n`
              : `${name}'s last answer is in the transcript below — respond to it, ` +
                `then ask the NEXT question from your list, not an earlier one.\n\n`)
          : "") +
        (tail
          ? `Recent conversation, verbatim:\n${tail}\n\n`
          : `You had only just opened; nothing substantive has been asked yet.\n\n`) +
        `Any question fully answered above is DONE. Questions not visible above have NOT been asked yet.`
      );
    };

    const startStream = async (resumeNote?: string): Promise<void> => {
      bootstrap(resumeNote);

      try {
        const response = await sonicClient.send(
          new InvokeModelWithBidirectionalStreamCommand({
            modelId: SONIC_MODEL_ID,
            body: session.queue as any,
          }),
          { abortSignal: session.abort.signal }
        );

        send({ type: "ready" });

        // Fresh interview: keep silence flowing server-side until the mic is up,
        // then nudge the interviewer to open if the candidate stays quiet.
        if (!resumeNote && !prepared.transcripts.some((t) => t.sender === "interviewer")) {
          startServerSilence();
          cancelOpeningKick();
          candidateSpokeThisStream = false;
          openingKickTimer = setTimeout(() => {
            openingKickTimer = null;
            if (session.closed || !session.ready || ws.readyState !== WebSocket.OPEN) return;
            fireOpeningKick();
          }, 2000);
        }

        // Replay whatever the candidate said while we were reconnecting.
        if (pendingAudio.length) {
          const held = pendingAudio.splice(0, pendingAudio.length);
          for (const content of held) {
            session.queue.push({
              event: {
                audioInput: {
                  promptName: session.promptName,
                  contentName: session.audioContentName,
                  content,
                },
              },
            });
          }
          console.log(`[Sonic] ${prepared.id} — replayed ${held.length} buffered mic chunk(s)`);
        }

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
            const isSyntheticOpening = sender === "candidate" && isOpeningTrigger(text);

            const seen = recentlyEmitted[sender];
            if (text && !isControlPayload && !isSyntheticOpening && !seen.includes(text)) {
              seen.push(text);
              if (seen.length > DEDUPE_WINDOW) seen.shift();
              send({ type: "transcript", sender, text });

              // Persist server-side so the result survives the browser closing.
              appendTranscript(prepared.id, { sender, text, timestamp: Date.now() });

              if (sender === "candidate") {
                candidateSpokeThisStream = true;
                cancelOpeningKick();
              }

              if (sender === "interviewer") {
                stopServerSilence();
                if (!isPingTurn(text)) {
                  updateSession(prepared.id, { lastQuestionAsked: text });
                }
                cancelOpeningKick();
              }

              // Devanagari ASR → Roman Hinglish for the live transcript display.
              if (shouldLocalizeTranscript(text, lang.code)) {
                void translateLineToHinglish(text).then((textEn) => {
                  if (!textEn || textEn === text) return;
                  patchTranscriptEnglish(prepared.id, text, textEn);
                  send({ type: "transcript_en", text, textEn });
                });
              }

              // A real candidate turn proves this stream works: reset the
              // consecutive-failure budget so a flaky call is not killed on its
              // Nth drop mid-answer.
              if (sender === "candidate" && attempt > 0) attempt = 0;

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
        // A deliberate ending: finish() already ran (stop / terminate / tab
        // closed) and our own abort unwound the read loop. Nothing to report.
        if (finished || finishCalled || err?.name === "AbortError") {
          if (!finishCalled) finish("stream ended");
          return;
        }
        // ModelStreamErrorException (server-side, HTTP 424) carries these two;
        // NGHTTP2_INTERNAL_ERROR (client-side HTTP/2) does not. Logging them
        // apart is how we tell an Amazon-side fault from our own connection.
        const origin = err?.originalStatusCode
          ? ` [origin ${err.originalStatusCode}: ${err?.originalMessage || ""}]`
          : "";
        const label = `${err?.name || "Error"}: ${err?.message || "unknown"}${origin}`;
        const recoverable = RECOVERABLE.test(label);

        if (recoverable && !finished && ws.readyState === WebSocket.OPEN && ++attempt <= MAX_STREAM_ATTEMPTS) {
          // Counted per session so the grader and the recruiter can tell a
          // broken call from a weak candidate.
          const drops = recordStreamDrop(prepared.id);
          console.warn(
            `[Sonic] ${prepared.id} — stream dropped (${label}). ` +
              `Reconnecting, attempt ${attempt}/${MAX_STREAM_ATTEMPTS} (drop #${drops} this session).`
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
    let finishCalled = false;
    const finish = (reason: string, opts: { closeWs?: boolean } = {}) => {
      if (finishCalled) return;
      finishCalled = true;
      finished = true; // a deliberate ending, not a dropped stream — never reconnect
      teardown(reason);
      if (opts.closeWs !== false && ws.readyState === WebSocket.OPEN) ws.close();

      // Wait before grading so the browser's POST /complete — which carries the
      // proctoring flags and their base64 evidence, and can be several MB — has
      // landed. Grading first would produce a scorecard whose authenticity
      // assessment never saw the flags. The recruiter's integrity panel reads
      // them off the session either way, so this only affects the grader.
      const id = prepared.id;
      setTimeout(() => {
        gradeSession(id, reason).catch((e) =>
          console.error("[Sonic] Auto-grade failed:", e?.message)
        );
      }, GRADE_DELAY_MS);
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
