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
  startInterview: (customApiKey?: string) => Promise<void>;
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
 * A barge-in flush throws away buffered speech, so a spurious one is heard as
 * the interviewer being cut off mid-word. Sonic's turn detection runs on the
 * audio we send it, which on speakers includes an echo of the interviewer's own
 * voice — so it can decide the candidate interrupted when they did not.
 *
 * Guard: only honour a flush if the local microphone has been genuinely loud
 * for a sustained stretch. Real speech sustains; an echo transient does not.
 */
const BARGE_IN_LEVEL = 0.08;
const BARGE_IN_SUSTAIN_MS = 220;

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

export function useNovaSonicInterview(sessionId?: string | null): UseNovaSonicInterviewReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [aiVolume, setAiVolume] = useState(0);
  const [userVolume, setUserVolume] = useState(0);
  const [endRequested, setEndRequested] = useState(false);
  const [concluded, setConcluded] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackNodeRef = useRef<AudioWorkletNode | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const closingRef = useRef(false);

  /** Decays the user's meter so it falls smoothly instead of snapping to zero. */
  const userVolumeRef = useRef(0);
  const lastUserMeterRef = useRef(0);
  const lastAiMeterRef = useRef(0);

  /** When the mic first crossed the barge-in threshold in the current burst. */
  const loudSinceRef = useRef<number | null>(null);
  const diagnosticsRef = useRef<AudioDiagnostics>({
    underruns: 0,
    flushesHonoured: 0,
    flushesIgnored: 0,
    chunksReceived: 0,
  });

  const cleanup = useCallback(() => {
    closingRef.current = true;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
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

  const startInterview = useCallback(async () => {
    setError(null);
    closingRef.current = false;
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
            setConnectionState("active");
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
            break;

          case "end_requested":
            setEndRequested(true);
            break;

          case "concluded":
            setConcluded(true);
            break;

          case "reconnecting":
            // Bedrock dropped the stream (NGHTTP2_INTERNAL_ERROR /
            // ModelStreamErrorException are both common). The relay is starting
            // a fresh one; discard half-played audio so the resumed turn does
            // not collide with a stale fragment.
            playbackNodeRef.current?.port.postMessage({ type: "flush" });
            setIsAiSpeaking(false);
            setAiVolume(0);
            setError(null);
            console.warn(`[audio] voice stream dropped, reconnecting (attempt ${msg.attempt})`);
            break;

          case "interrupted": {
            const loudFor = loudSinceRef.current ? Date.now() - loudSinceRef.current : 0;
            if (loudFor >= BARGE_IN_SUSTAIN_MS) {
              diagnosticsRef.current.flushesHonoured++;
              playbackNodeRef.current?.port.postMessage({ type: "flush" });
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
            setError(msg.message || "The interview stream failed.");
            setConnectionState("error");
            break;

          case "closed":
            if (!closingRef.current) setConnectionState("disconnected");
            break;
        }
      };

      ws.onclose = () => {
        // Don't clobber a surfaced error with a generic "disconnected".
        if (!closingRef.current) {
          setConnectionState((s) => (s === "error" ? s : "disconnected"));
        }
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
          setIsAiSpeaking(playing);
          if (!playing) setAiVolume(0);
          // Close the mic gate while she speaks so her echo can't self-interrupt.
          micNodeRef.current?.port.postMessage({ type: "remoteSpeaking", value: playing });
        } else if (type === "level") {
          const now = performance.now();
          if (now - lastAiMeterRef.current >= METER_INTERVAL_MS) {
            lastAiMeterRef.current = now;
            setAiVolume(peak);
          }
        } else if (type === "underrun") {
          // The buffer ran dry mid-speech. If this climbs during a session, the
          // cause is delivery (network or a blocked main thread), not barge-in.
          diagnosticsRef.current.underruns = e.data.count;
          console.warn(`[audio] playback underrun #${e.data.count}`);
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
          wsRef.current.send(
            JSON.stringify({ type: "audio", data: toBase64(new Uint8Array(pcm)) })
          );
        }

        // Smooth the meter: fast attack, slow release.
        userVolumeRef.current = Math.max(peak, userVolumeRef.current * 0.85);

        // Track sustained loudness for the barge-in guard.
        if (userVolumeRef.current > BARGE_IN_LEVEL) {
          if (loudSinceRef.current === null) loudSinceRef.current = Date.now();
        } else {
          loudSinceRef.current = null;
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
      setError(
        err?.name === "NotAllowedError"
          ? "Camera and microphone access denied. Grant permission and try again."
          : err?.message || "Failed to start the interview."
      );
      setConnectionState("error");
      cleanup();
    }
  }, [appendTranscript, cleanup, sessionId]);

  const endInterview = useCallback(() => {
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
  };
}
