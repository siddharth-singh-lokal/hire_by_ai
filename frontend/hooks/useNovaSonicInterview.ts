"use client";

import { useState, useRef, useEffect, useCallback } from "react";

/**
 * Amazon Nova Sonic speech-to-speech interview client.
 *
 * Browsers cannot speak HTTP/2 bidirectional streams, so this talks to the
 * Express relay over a WebSocket and the relay faces Bedrock.
 *
 * Only an opaque session id travels to the browser. The questions and grading
 * criteria stay server-side, so a candidate cannot read what they are about to
 * be asked or how it will be scored.
 */

export type ConnectionState =
  | "idle"
  | "requesting_permission"
  | "connecting"
  | "active"
  | "paused"
  | "disconnected"
  | "error";

export interface TranscriptItem {
  id: string;
  sender: "candidate" | "interviewer";
  text: string;
  /** English gloss when the spoken line was in Hindi/Hinglish/etc. */
  textEn?: string;
  timestamp: number;
  isFinal: boolean;
}

export interface UseNovaSonicInterviewReturn {
  connectionState: ConnectionState;
  error: string | null;
  transcripts: TranscriptItem[];
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMicMuted: boolean;
  isVideoMuted: boolean;
  isAiSpeaking: boolean;
  isUserSpeaking: boolean;
  aiVolume: number;
  userVolume: number;
  startInterview: (isReconnect?: boolean) => Promise<void>;
  endInterview: () => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  sendTextMessage: (text: string) => void;
  cancelAiResponse: () => void;
  /** Sends a control frame to the relay (proctor warnings, termination). */
  sendControl: (message: Record<string, unknown>) => void;
  /** Set when Sonic hears the candidate ask to stop. */
  endRequested: boolean;
  /** Set when the interviewer says her closing line — the interview is over. */
  concluded: boolean;
  /** True while the client is re-establishing a dropped connection. */
  reconnecting: boolean;
}

/**
 * ONE AudioContext, at whatever rate the hardware runs.
 *
 * The original design requested two contexts at two non-native rates (16kHz mic,
 * 24kHz speaker) and let the browser resample. On 48kHz hardware that is two
 * device streams with two resamplers contending on the audio thread — a known
 * Chrome glitching source. Conversion now happens inside the worklets, which
 * also removes any dependence on the browser honouring a sampleRate hint; it is
 * free to ignore one and nothing was checking.
 */

/**
 * Volume meters drive an animated canvas, not a readout — 20fps is smooth to the
 * eye and a twentieth of the re-renders. Without this cap the interview page
 * re-rendered on every audio chunk and the whole UI stuttered.
 */
const METER_INTERVAL_MS = 50;

/**
 * Client-side WebSocket reconnect cap. The relay retries the Bedrock stream on
 * its own; this covers the *other* connection — the browser↔relay socket dropping
 * (backend restart, network blip) or failing to open in the first place.
 */
const MAX_WS_RECONNECTS = 5;

/**
 * A barge-in flush throws away buffered speech, so a spurious one is heard as
 * the interviewer being cut off mid-word. Sonic's turn detection runs on the
 * audio we send it, which on speakers includes an echo of the interviewer's own
 * voice — so it can decide the candidate interrupted when they did not.
 *
 * Guard: only honour a flush if the local microphone has been genuinely loud
 * for a sustained stretch. Real speech sustains; an echo transient does not.
 */
const BARGE_IN_LEVEL = 0.05;
const BARGE_IN_SUSTAIN_MS = 130;

/**
 * How long the candidate must be speaking before we duck her playback
 * LOCALLY, without waiting for Sonic to report the interruption.
 *
 * Sonic's own barge-in detection can lag or miss entirely, which is heard as
 * the interviewer talking straight over the candidate. Ducking locally makes
 * the call feel responsive immediately; we only discard her buffered speech
 * once Sonic confirms, so a false positive costs a moment of low volume rather
 * than a lost sentence.
 */
const LOCAL_DUCK_AFTER_MS = 90;

/**
 * How long sustained candidate speech must continue before we stop her
 * playback outright, without waiting for Sonic.
 *
 * Measured against the live relay: Sonic takes ~5.8 SECONDS to report a
 * barge-in on clean, full-volume speech. Waiting for it is what "she just
 * keeps going and never stops" actually is — six seconds of being talked over
 * is a broken conversation. So after this long we discard her buffered audio
 * ourselves. Sonic still catches up and ends its turn; the only cost of a
 * false positive is one dropped sentence of hers, against the certainty of
 * talking over a real candidate.
 *
 * 700ms is well past a cough or a chair creak and well short of feeling rude.
 */
const LOCAL_FLUSH_AFTER_MS = 700;

/**
 * Live audio diagnostics, readable from the console as `__round0Audio`.
 * The failure only reproduces with a real microphone in a real room, so this is
 * how a real test session reports which mechanism actually fired.
 */
export interface AudioDiagnostics {
  underruns: number;
  flushesHonoured: number;
  flushesIgnored: number;
  chunksReceived: number;
  /** Times we stopped her ourselves rather than waiting on Sonic. */
  localBargeIns: number;
}

/** Chunked base64 — a per-byte string concat stalls on larger buffers. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[]
    );
  }
  return btoa(binary);
}

/** 512 samples @16kHz — keeps Sonic's VAD alive before the mic worklet streams. */
const SILENCE_FRAME_B64 = toBase64(new Uint8Array(1024));

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function backendWsUrl(sessionId?: string | null): string {
  const httpUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
  const base = httpUrl.replace(/^http/, "ws") + "/ws/interview";
  // Only the opaque id travels to the browser. The questions and grading
  // criteria stay server-side, so a candidate cannot read what they will be
  // asked or how it will be scored.
  return sessionId ? `${base}?sessionId=${encodeURIComponent(sessionId)}` : base;
}

export function useNovaSonicInterview(
  sessionId?: string | null,
  options?: {
    /** Session was already underway — skip opening kick and preserve transcript. */
    isResuming?: boolean;
    initialTranscripts?: TranscriptItem[];
  }
): UseNovaSonicInterviewReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>(
    options?.initialTranscripts ?? []
  );
  const isResumingRef = useRef(!!options?.isResuming);
  const skipOpeningKickRef = useRef(
    !!options?.isResuming || (options?.initialTranscripts?.length ?? 0) > 0
  );
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [aiVolume, setAiVolume] = useState(0);
  const [userVolume, setUserVolume] = useState(0);
  const [endRequested, setEndRequested] = useState(false);
  const [concluded, setConcluded] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackNodeRef = useRef<AudioWorkletNode | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const closingRef = useRef(false);
  /** User (or the interview flow) intentionally ended — never auto-reconnect. */
  const intentionalCloseRef = useRef(false);
  /** Hard error (permission, creds, no-session) — reconnecting cannot help. */
  const noReconnectRef = useRef(false);
  const wsAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Nudges the relay after long silence so the interviewer stays on the last question. */
  const silenceNudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceNudgeSentRef = useRef(false);
  /** Sends silent frames until the mic worklet is streaming (Sonic needs continuous audio). */
  const preMicSilenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const openingKickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micStreamingRef = useRef(false);
  const startInterviewRef = useRef<((isReconnect?: boolean) => Promise<void>) | null>(null);

  /** Decays the user's meter so it falls smoothly instead of snapping to zero. */
  const userVolumeRef = useRef(0);
  const lastUserMeterRef = useRef(0);
  const lastAiMeterRef = useRef(0);

  /** When the mic first crossed the barge-in threshold in the current burst. */
  const loudSinceRef = useRef<number | null>(null);
  /** Mirrors isAiSpeaking for use inside the mic callback. */
  const isAiSpeakingRef = useRef(false);
  /** True while her playback is locally attenuated by a suspected barge-in. */
  const duckedRef = useRef(false);
  /** True once we have stopped her ourselves for the current burst of speech. */
  const locallyFlushedRef = useRef(false);
  const diagnosticsRef = useRef<AudioDiagnostics>({
    underruns: 0,
    flushesHonoured: 0,
    flushesIgnored: 0,
    chunksReceived: 0,
    localBargeIns: 0,
  });

  useEffect(() => {
    isResumingRef.current = !!options?.isResuming;
    skipOpeningKickRef.current =
      !!options?.isResuming || (options?.initialTranscripts?.length ?? 0) > 0;
    if (options?.initialTranscripts?.length) {
      setTranscripts(options.initialTranscripts);
    }
  }, [options?.isResuming, options?.initialTranscripts]);

  const cleanup = useCallback((opts?: { sendStop?: boolean }) => {
    const sendStop = opts?.sendStop !== false;
    closingRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (silenceNudgeTimerRef.current) {
      clearTimeout(silenceNudgeTimerRef.current);
      silenceNudgeTimerRef.current = null;
    }
    silenceNudgeSentRef.current = false;
    if (preMicSilenceTimerRef.current) {
      clearInterval(preMicSilenceTimerRef.current);
      preMicSilenceTimerRef.current = null;
    }
    if (openingKickTimerRef.current) {
      clearTimeout(openingKickTimerRef.current);
      openingKickTimerRef.current = null;
    }
    micStreamingRef.current = false;

    if (sendStop && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
      wsRef.current.close();
    } else if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "detach" }));
      wsRef.current.close();
    } else if (wsRef.current) {
      wsRef.current.close();
    }
    wsRef.current = null;

    micNodeRef.current?.disconnect();
    micNodeRef.current = null;
    playbackNodeRef.current?.disconnect();
    playbackNodeRef.current = null;

    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;

    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);

    setAiVolume(0);
    setUserVolume(0);
    setIsAiSpeaking(false);
    setIsUserSpeaking(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  // Client-side reconnect for the browser↔relay WebSocket. The relay handles
  // Bedrock stream drops itself; this covers the socket to the relay going away —
  // a backend restart, a network blip, or the relay giving up after its own
  // retries. A user-initiated end and non-recoverable errors are excluded.
  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current || noReconnectRef.current) return;
    if (reconnectTimerRef.current) return;
    if (wsAttemptsRef.current >= MAX_WS_RECONNECTS) {
      setReconnecting(false);
      setConnectionState("error");
      setError("Lost the connection and couldn't get it back. Please rejoin.");
      return;
    }
    wsAttemptsRef.current += 1;
    setReconnecting(true);
    const delay = Math.min(8000, 800 * wsAttemptsRef.current);
    console.warn(
      `[NovaSonic] connection lost — reconnecting ` +
        `(attempt ${wsAttemptsRef.current}/${MAX_WS_RECONNECTS}) in ${delay}ms`
    );
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (intentionalCloseRef.current || noReconnectRef.current) return;
      skipOpeningKickRef.current = true;
      isResumingRef.current = true;
      startInterviewRef.current?.(true);
    }, delay);
  }, []);

  const clearSilenceNudge = useCallback(() => {
    if (silenceNudgeTimerRef.current) {
      clearTimeout(silenceNudgeTimerRef.current);
      silenceNudgeTimerRef.current = null;
    }
  }, []);

  const scheduleSilenceNudge = useCallback(() => {
    clearSilenceNudge();
    silenceNudgeSentRef.current = false;
    silenceNudgeTimerRef.current = setTimeout(() => {
      silenceNudgeTimerRef.current = null;
      if (silenceNudgeSentRef.current || intentionalCloseRef.current || closingRef.current) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        silenceNudgeSentRef.current = true;
        wsRef.current.send(JSON.stringify({ type: "continuity_nudge" }));
      }
    }, 20000);
  }, [clearSilenceNudge]);

  const appendTranscript = useCallback(
    (sender: "candidate" | "interviewer", text: string) => {
      if (!text?.trim()) return;
      setTranscripts((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sender,
          text,
          timestamp: Date.now(),
          isFinal: true,
        },
      ]);
    },
    []
  );

  const startInterview = useCallback(async (isReconnect = false) => {
    // Tear down any previous attempt. Reconnects must NOT send stop — that ends
    // the interview server-side and triggers grading.
    cleanup({ sendStop: !isReconnect });
    setError(null);
    closingRef.current = false;
    if (isReconnect) {
      skipOpeningKickRef.current = true;
      isResumingRef.current = true;
    }
    intentionalCloseRef.current = false;
    noReconnectRef.current = false;
    setEndRequested(false);
    setConcluded(false);
    setConnectionState("requesting_permission");

    try {
      // Video is for the candidate tile and the proctoring pipeline; only the
      // audio track is forwarded to Sonic.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: { width: 1280, height: 720, facingMode: "user" },
      });
      localStreamRef.current = stream;
      setLocalStream(stream);

      setConnectionState("connecting");

      // No sampleRate hint: take the native rate, convert in the worklets.
      // latencyHint "interactive" asks for the smallest output buffer the device
      // will sustain.
      const audioContext = new AudioContext({ latencyHint: "interactive" });
      audioContextRef.current = audioContext;
      if (audioContext.state === "suspended") await audioContext.resume();

      await audioContext.audioWorklet.addModule("/worklets/mic-processor.js");
      await audioContext.audioWorklet.addModule("/worklets/playback-processor.js");

      console.info(
        `[audio] context ${audioContext.sampleRate}Hz · ` +
          `output latency ${(audioContext.baseLatency * 1000).toFixed(1)}ms`
      );

      const ws = new WebSocket(backendWsUrl(sessionId));
      wsRef.current = ws;

      // Wire the message/close handlers up BEFORE awaiting open, and keep them.
      // The relay can reject a connection the instant it opens — a missing or
      // expired prepared session sends an error then closes immediately. If these
      // are attached only after the open resolves (and after the audio nodes are
      // built), that first error and close land in the gap and are dropped,
      // leaving the UI stuck on "Connecting…" forever with no error shown.
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case "ready":
            wsAttemptsRef.current = 0;
            setReconnecting(false);
            setConnectionState("active");
            if (msg.resuming) {
              skipOpeningKickRef.current = true;
              isResumingRef.current = true;
            }
            micStreamingRef.current = false;
            if (!preMicSilenceTimerRef.current) {
              preMicSilenceTimerRef.current = setInterval(() => {
                if (micStreamingRef.current || intentionalCloseRef.current) {
                  if (preMicSilenceTimerRef.current) {
                    clearInterval(preMicSilenceTimerRef.current);
                    preMicSilenceTimerRef.current = null;
                  }
                  return;
                }
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(
                    JSON.stringify({ type: "audio", data: SILENCE_FRAME_B64 })
                  );
                }
              }, 32);
            }
            if (!skipOpeningKickRef.current) {
              if (openingKickTimerRef.current) clearTimeout(openingKickTimerRef.current);
              openingKickTimerRef.current = setTimeout(() => {
                openingKickTimerRef.current = null;
                if (intentionalCloseRef.current || closingRef.current) return;
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: "kickoff" }));
                }
              }, 2000);
            }
            break;

          case "transcript_history":
            if (Array.isArray(msg.transcripts) && msg.transcripts.length) {
              setTranscripts(
                msg.transcripts.map((t: any, i: number) => ({
                  id: `hist-${t.timestamp ?? i}-${i}`,
                  sender: t.sender,
                  text: t.text,
                  textEn: t.textEn,
                  timestamp: t.timestamp ?? Date.now(),
                  isFinal: true,
                }))
              );
              skipOpeningKickRef.current = true;
              isResumingRef.current = true;
            }
            break;

          case "audio": {
            diagnosticsRef.current.chunksReceived++;
            const bytes = fromBase64(msg.data);
            playbackNodeRef.current?.port.postMessage(
              { type: "push", pcm: bytes.buffer },
              [bytes.buffer]
            );
            break;
          }

          case "transcript":
            appendTranscript(msg.sender, msg.text);
            if (msg.sender === "interviewer") {
              scheduleSilenceNudge();
            } else if (msg.sender === "candidate") {
              clearSilenceNudge();
              silenceNudgeSentRef.current = false;
            }
            break;

          case "transcript_en":
            if (msg.text && msg.textEn) {
              setTranscripts((prev) => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].text === msg.text && !prev[i].textEn) {
                    const next = [...prev];
                    next[i] = { ...next[i], textEn: msg.textEn };
                    return next;
                  }
                }
                return prev;
              });
            }
            break;

          case "end_requested":
            setEndRequested(true);
            break;

          case "concluded":
            setConcluded(true);
            break;

          case "reconnecting":
            clearSilenceNudge();
            // Bedrock dropped the stream (NGHTTP2_INTERNAL_ERROR /
            // ModelStreamErrorException are both common). The relay is starting
            // a fresh one; discard half-played audio so the resumed turn does
            // not collide with a stale fragment.
            playbackNodeRef.current?.port.postMessage({ type: "flush" });
            setIsAiSpeaking(false);
            setAiVolume(0);
            setError(null);
            setReconnecting(true);
            // The candidate otherwise just hears silence and assumes they broke
            // something. One system line in the transcript, once per drop.
            setTranscripts((prev) =>
              prev.length && prev[prev.length - 1].id.startsWith("sys-drop")
                ? prev
                : [
                    ...prev,
                    {
                      id: `sys-drop-${Date.now()}`,
                      sender: "interviewer",
                      text: "Reconnecting… hold on a moment, we'll pick up where we left off.",
                      timestamp: Date.now(),
                      isFinal: true,
                    },
                  ]
            );
            console.warn(`[audio] voice stream dropped, reconnecting (attempt ${msg.attempt})`);
            break;

          case "interrupted": {
            const loudFor = loudSinceRef.current ? Date.now() - loudSinceRef.current : 0;
            if (loudFor >= BARGE_IN_SUSTAIN_MS) {
              diagnosticsRef.current.flushesHonoured++;
              playbackNodeRef.current?.port.postMessage({ type: "flush" });
              duckedRef.current = false;
              isAiSpeakingRef.current = false;
              setIsAiSpeaking(false);
              setAiVolume(0);
            } else {
              diagnosticsRef.current.flushesIgnored++;
              console.warn(
                `[audio] ignored spurious barge-in (mic loud for only ${loudFor}ms) — ` +
                  `total ignored: ${diagnosticsRef.current.flushesIgnored}`
              );
            }
            break;
          }

          case "error":
            setError(
              [msg.error, msg.message].filter(Boolean).join(" — ") ||
                "The interview stream failed."
            );
            // Non-recoverable (bad creds, no model access, no session) → don't
            // loop. A recoverable error means the relay exhausted its own retries;
            // the socket close that follows will drive a fresh client reconnect.
            if (msg.recoverable === false || msg.error === "NO_SESSION") {
              noReconnectRef.current = true;
            }
            setConnectionState("error");
            break;

          case "closed":
            if (!closingRef.current) setConnectionState("disconnected");
            break;
        }
      };

      ws.onclose = () => {
        if (closingRef.current) return; // our own teardown (restart or end)
        if (intentionalCloseRef.current || noReconnectRef.current) {
          setConnectionState((s) => (s === "error" ? s : "disconnected"));
          return;
        }
        // Unexpected drop (network, backend restart) or a recoverable relay
        // error — reconnect automatically.
        scheduleReconnect();
      };

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out connecting to the interview relay.")),
          15000
        );
        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("Could not reach the interview relay. Is the backend running?"));
        };
      });

      // --- playback path ---
      const playbackNode = new AudioWorkletNode(audioContext, "playback-processor", {
        numberOfInputs: 0,
        outputChannelCount: [1],
      });
      playbackNodeRef.current = playbackNode;
      playbackNode.connect(audioContext.destination);
      playbackNode.port.onmessage = (e) => {
        const { type, playing, peak } = e.data || {};
        if (type === "playing") {
          // Transitions are never throttled — the speaking indicator must be
          // immediate or the orb lags behind the voice.
          isAiSpeakingRef.current = playing;
          setIsAiSpeaking(playing);
          if (playing) {
            // A fresh turn of hers — allow it to be interrupted again.
            locallyFlushedRef.current = false;
          } else {
            setAiVolume(0);
            duckedRef.current = false;
          }
          // Close the mic gate while she speaks so her echo can't self-interrupt.
          micNodeRef.current?.port.postMessage({ type: "remoteSpeaking", value: playing });
        } else if (type === "level") {
          // The mic gate scales with her volume, so it needs this unthrottled —
          // the UI meter is what gets throttled, not the gate.
          micNodeRef.current?.port.postMessage({ type: "remoteLevel", value: peak });
          const now = performance.now();
          if (now - lastAiMeterRef.current >= METER_INTERVAL_MS) {
            lastAiMeterRef.current = now;
            setAiVolume(peak);
          }
        } else if (type === "underrun") {
          // The buffer ran dry mid-speech. If this climbs during a session, the
          // cause is delivery (network or a blocked main thread), not barge-in.
          diagnosticsRef.current.underruns = e.data.count;
          console.warn(
            `[audio] playback underrun #${e.data.count} — jitter buffer now primes at ${e.data.primeMs}ms`
          );
        }
      };

      // --- capture path ---
      const source = audioContext.createMediaStreamSource(stream);
      const micNode = new AudioWorkletNode(audioContext, "mic-processor", {
        numberOfOutputs: 0,
      });
      micNodeRef.current = micNode;
      source.connect(micNode);

      micNode.port.onmessage = (e) => {
        const { pcm, peak } = e.data || {};
        if (!pcm) return;

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          if (!micStreamingRef.current) {
            micStreamingRef.current = true;
            if (preMicSilenceTimerRef.current) {
              clearInterval(preMicSilenceTimerRef.current);
              preMicSilenceTimerRef.current = null;
            }
          }
          wsRef.current.send(
            JSON.stringify({ type: "audio", data: toBase64(new Uint8Array(pcm)) })
          );
        }

        // Smooth the meter: fast attack, slow release.
        userVolumeRef.current = Math.max(peak, userVolumeRef.current * 0.85);

        // Track sustained loudness for the barge-in guard.
        if (userVolumeRef.current > BARGE_IN_LEVEL) {
          if (loudSinceRef.current === null) loudSinceRef.current = Date.now();

          // Duck her immediately once the candidate is clearly talking, rather
          // than waiting on Sonic to notice. This is what makes interrupting
          // her feel like interrupting a person.
          const loudFor = Date.now() - loudSinceRef.current;

          if (
            isAiSpeakingRef.current &&
            !duckedRef.current &&
            loudFor >= LOCAL_DUCK_AFTER_MS
          ) {
            duckedRef.current = true;
            playbackNodeRef.current?.port.postMessage({ type: "duck", gain: 0.12 });
          }

          // Still going after the duck: she is genuinely being talked over, and
          // Sonic will not tell us for another few seconds. Stop her now.
          if (
            isAiSpeakingRef.current &&
            !locallyFlushedRef.current &&
            loudFor >= LOCAL_FLUSH_AFTER_MS
          ) {
            locallyFlushedRef.current = true;
            duckedRef.current = false;
            isAiSpeakingRef.current = false;
            diagnosticsRef.current.localBargeIns++;
            playbackNodeRef.current?.port.postMessage({ type: "flush" });
            setIsAiSpeaking(false);
            setAiVolume(0);
            console.info(`[audio] stopped her locally after ${loudFor}ms of candidate speech`);
          }
        } else {
          loudSinceRef.current = null;
          locallyFlushedRef.current = false;
          if (duckedRef.current) {
            duckedRef.current = false;
            playbackNodeRef.current?.port.postMessage({ type: "duck", gain: 1 });
          }
        }

        const now = performance.now();
        if (now - lastUserMeterRef.current >= METER_INTERVAL_MS) {
          lastUserMeterRef.current = now;
          setUserVolume(userVolumeRef.current);
          setIsUserSpeaking(userVolumeRef.current > 0.04);
        }
      };

      // Exposed for diagnosing audio complaints from a real session:
      //   > __round0Audio
      if (typeof window !== "undefined") {
        (window as any).__round0Audio = diagnosticsRef.current;
      }
    } catch (err: any) {
      console.error("[NovaSonic] start failed:", err);
      const permission =
        err?.name === "NotAllowedError" ||
        err?.name === "NotFoundError" ||
        err?.name === "NotReadableError";
      setError(
        permission
          ? "Camera and microphone access denied. Grant permission and try again."
          : err?.message || "Failed to start the interview."
      );
      setConnectionState("error");
      cleanup();
      if (permission) {
        // The user has to fix hardware/permission; retrying would just fail again.
        noReconnectRef.current = true;
      } else {
        // Backend down / relay unreachable / transient — keep trying to connect.
        closingRef.current = false;
        scheduleReconnect();
      }
    }
  }, [appendTranscript, cleanup, sessionId, scheduleReconnect, scheduleSilenceNudge, clearSilenceNudge]);

  // Keep a ref so the reconnect timer can invoke the latest startInterview.
  useEffect(() => {
    startInterviewRef.current = startInterview;
  }, [startInterview]);

  const endInterview = useCallback(() => {
    intentionalCloseRef.current = true;
    cleanup();
    setConnectionState("disconnected");
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    setIsMicMuted((prev) => {
      const next = !prev;
      // Mute inside the worklet rather than disabling the track, so the stream
      // to Sonic stays continuous and its turn detection keeps working.
      micNodeRef.current?.port.postMessage({ type: "mute", muted: next });
      if (next) {
        userVolumeRef.current = 0;
        setUserVolume(0);
        setIsUserSpeaking(false);
      }
      return next;
    });
  }, []);

  const toggleVideo = useCallback(() => {
    setIsVideoMuted((prev) => {
      const next = !prev;
      localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !next));
      return next;
    });
  }, []);

  const sendTextMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Testing aid: feed a typed candidate turn into the live relay so the whole
    // flow (interviewer reply, ending, grading) runs without speaking.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "text_input", text: trimmed }));
    }
  }, []);

  const sendControl = useCallback((message: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const cancelAiResponse = useCallback(() => {
    playbackNodeRef.current?.port.postMessage({ type: "flush" });
    setIsAiSpeaking(false);
    setAiVolume(0);
  }, []);

  return {
    connectionState,
    error,
    transcripts,
    localStream,
    remoteStream: null,
    isMicMuted,
    isVideoMuted,
    isAiSpeaking,
    isUserSpeaking,
    aiVolume,
    userVolume,
    startInterview,
    endInterview,
    toggleMute,
    toggleVideo,
    sendTextMessage,
    cancelAiResponse,
    sendControl,
    endRequested,
    concluded,
    reconnecting,
  };
}
