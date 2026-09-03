import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";
import { getSession, updateSession, appendTranscript } from "./sessionStore";
import { gradeSession } from "./grading";
import { renderInterviewerPrompt } from "./questionBank";

/**
 * Gemini Live relay — a drop-in alternative to the Nova Sonic relay, selected via
 * `VOICE_PROVIDER=gemini`.
 *
 * Same shape as `attachNovaSonicRelay`: a WebSocket faces the browser, and a
 * second WebSocket faces Google's Live API. The browser protocol is identical
 * (`audio` / `transcript` / `ready` / `interrupted` / `error` …), so the client
 * hook and worklets are unchanged. Audio is base64 PCM16 — 16 kHz in, 24 kHz out,
 * exactly like Nova Sonic.
 *
 * Chosen because Nova Sonic drops its Bedrock bidi stream repeatedly
 * (NGHTTP2_INTERNAL_ERROR); the Gemini Live session is far more stable and its VAD
 * is tunable (`silenceDurationMs`), which also fixes premature turn-taking.
 */

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-native-audio-latest";
const GEMINI_VOICE = process.env.GEMINI_VOICE || "Aoede";
const GEMINI_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** How much recent conversation a reconnecting session is shown, to resume silently. */
const RESUME_TAIL_LINES = 12;

const END_INTENT = [
  /\b(?:i|we)(?:'?d| would)? (?:want|like) to (?:end|stop|finish|leave|quit)\b/i,
  /\bi(?:'?m| am) done\b/i,
  /\bend the (?:interview|call|session)\b/i,
  /\bstop the (?:interview|call|session)\b/i,
];
const CLOSING_INTENT = [
  /\bteam will (?:be in touch|follow up|reach out|get back)\b/i,
  /\bwe(?:'ll| will) be in touch\b/i,
  /\bthat (?:concludes|wraps up|brings us to the end)\b/i,
  /\bthank you (?:so much |very much )?for your time\b/i,
  /\bbest of luck\b/i,
];
const detectsEndIntent = (t: string) => END_INTENT.some((re) => re.test(t));
const detectsClosing = (t: string) => CLOSING_INTENT.some((re) => re.test(t));

export function attachGeminiLiveRelay(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/interview" });

  wss.on("connection", (ws: WebSocket, req) => {
    const sessionId = new URL(req.url || "", "http://localhost").searchParams.get("sessionId");
    const prepared = sessionId ? getSession(sessionId) : undefined;

    if (!prepared) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: "NO_SESSION",
          recoverable: false,
          message: "No prepared interview found for this link. Please sign in again with your email.",
        })
      );
      ws.close();
      return;
    }
    if (!GEMINI_API_KEY) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: "NO_KEY",
          recoverable: false,
          message: "GEMINI_API_KEY is not set on the backend.",
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
      `[Gemini] Client connected — session ${prepared.id} (${prepared.candidateName}, ` +
        `${prepared.bank.role}, ${prepared.bank.questions.length} questions)`
    );

    let gws: WebSocket | null = null;
    let ready = false;
    let finished = false;
    let concludedSent = false;
    let outBuf = ""; // interviewer transcript accumulator
    let inBuf = ""; // candidate transcript accumulator

    const send = (payload: any) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      console.log(`[Gemini] Session closing: ${reason}`);
      try {
        gws?.close();
      } catch {
        /* ignore */
      }
      if (ws.readyState === WebSocket.OPEN) ws.close();
      const id = prepared.id;
      setTimeout(() => {
        gradeSession(id, reason).catch((e) => console.error("[Gemini] Auto-grade failed:", e?.message));
      }, 3000);
    };

    // The opening turn: greet fresh, or resume SILENTLY on a reconnect (never
    // mention the drop — same rule as the voice path).
    const openingNudge = (): string => {
      const hasProgress = prepared.transcripts.some((t) => t.sender === "candidate");
      if (!hasProgress) {
        return "[Begin the interview now: greet the candidate by name and ask your first question.]";
      }
      const tail = prepared.transcripts
        .slice(-RESUME_TAIL_LINES)
        .map((t) => `${t.sender === "candidate" ? prepared.candidateName : "You"}: ${t.text}`)
        .join("\n");
      return (
        "[Reconnected mid-interview. Do NOT greet again, do NOT reintroduce yourself, and do NOT " +
        "mention or apologise for any connection issue. Recent conversation:\n" +
        tail +
        "\nContinue naturally from here.]"
      );
    };

    const sendText = (text: string) => {
      if (gws?.readyState === WebSocket.OPEN) {
        gws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }));
      }
    };

    const openGemini = () => {
      const g = new WebSocket(`${GEMINI_WS_BASE}?key=${GEMINI_API_KEY}`);
      gws = g;

      g.on("open", () => {
        g.send(
          JSON.stringify({
            setup: {
              model: GEMINI_MODEL,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } } },
              },
              systemInstruction: { parts: [{ text: instructions }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              // Tunable VAD — the knob Nova Sonic never exposed. Longer silence
              // means she waits instead of talking over a thinking candidate.
              realtimeInputConfig: {
                automaticActivityDetection: { silenceDurationMs: 800, prefixPaddingMs: 200 },
              },
            },
          })
        );
      });

      g.on("message", (data) => {
        let m: any;
        try {
          m = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (m.setupComplete) {
          ready = true;
          send({ type: "ready" });
          sendText(openingNudge());
          return;
        }

        const sc = m.serverContent;
        if (!sc) return;

        if (sc.inputTranscription?.text) inBuf += sc.inputTranscription.text;

        if (sc.modelTurn?.parts) {
          // Model started responding → the candidate's turn is over; flush it first.
          const inText = inBuf.trim();
          if (inText) {
            inBuf = "";
            send({ type: "transcript", sender: "candidate", text: inText });
            appendTranscript(prepared.id, { sender: "candidate", text: inText, timestamp: Date.now() });
            if (detectsEndIntent(inText)) send({ type: "end_requested" });
          }
          for (const p of sc.modelTurn.parts) {
            if (p.inlineData?.data) send({ type: "audio", data: p.inlineData.data });
            // p.text is the model's private "thinking" — never forward it.
          }
        }

        if (sc.outputTranscription?.text) outBuf += sc.outputTranscription.text;

        if (sc.interrupted) send({ type: "interrupted" });

        if (sc.turnComplete) {
          const outText = outBuf.trim();
          outBuf = "";
          if (outText) {
            send({ type: "transcript", sender: "interviewer", text: outText });
            appendTranscript(prepared.id, { sender: "interviewer", text: outText, timestamp: Date.now() });
            if (!concludedSent && detectsClosing(outText)) {
              concludedSent = true;
              send({ type: "concluded" });
            }
          }
        }
      });

      g.on("close", () => {
        if (finished) return;
        // Let the client reconnect the browser socket (it resumes from transcript).
        send({ type: "error", error: "GEMINI_CLOSED", recoverable: true, message: "The voice connection dropped." });
        finish("gemini closed");
      });
      g.on("error", (e: any) => {
        if (finished) return;
        console.error("[Gemini] stream error:", e?.message);
        const expired = /API key|expired|PERMISSION|invalid/i.test(e?.message || "");
        send({
          type: "error",
          error: "GEMINI_ERROR",
          recoverable: !expired,
          message: expired ? "Gemini credentials rejected — check GEMINI_API_KEY." : e?.message || "Voice stream failed.",
        });
        finish("gemini error");
      });
    };

    // --- browser -> Gemini ---
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "audio":
          if (ready && gws?.readyState === WebSocket.OPEN) {
            gws.send(
              JSON.stringify({
                realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: msg.data }] },
              })
            );
          }
          break;

        case "text_input": {
          const t = String(msg.text || "").trim();
          if (!t) break;
          send({ type: "transcript", sender: "candidate", text: t });
          appendTranscript(prepared.id, { sender: "candidate", text: t, timestamp: Date.now() });
          sendText(t);
          if (detectsEndIntent(t)) send({ type: "end_requested" });
          break;
        }

        case "proctor_probe":
          sendText(
            `SYSTEM NOTE — do not read aloud verbatim. ${msg.description}. Work a short, natural question about ` +
              `this into the conversation to understand why — calm and non-accusatory — then continue. Do NOT end the interview.`
          );
          break;

        case "wind_down":
          sendText(
            "SYSTEM NOTE — do not read aloud verbatim. You are now at time. Do not start new topics; let the " +
              "candidate finish, then wind the conversation down."
          );
          break;

        case "terminate":
          sendText(
            "SYSTEM NOTE — do not read aloud verbatim. The interview is ending now. Thank the candidate warmly in " +
              "one or two sentences and tell them the team will follow up. Do not ask anything further."
          );
          setTimeout(() => finish("terminated"), 6000);
          break;

        case "stop":
          finish("client stop");
          break;
      }
    });

    ws.on("close", () => finish("websocket closed"));
    ws.on("error", () => finish("websocket error"));

    openGemini();
  });

  console.log(`[Gemini] Relay listening on ws://localhost:<port>/ws/interview (model ${GEMINI_MODEL})`);
}
