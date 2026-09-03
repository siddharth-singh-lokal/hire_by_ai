"use client";

import { useState, useRef, useEffect, useCallback } from "react";

/**
 * Amazon Nova Sonic speech-to-speech interview client.
 *
 * Deliberately exposes the same surface as useWebRTCInterview so the interview
 * page can swap between them with a one-line import change. The transport is
 * different — a WebSocket to our Express relay rather than a direct WebRTC peer
 * connection — but the observable behaviour (transcripts, volumes, mute) matches.
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
}

const MIC_SAMPLE_RATE = 16000; // what Nova Sonic accepts
const SPEAKER_SAMPLE_RATE = 24000; // what Nova Sonic emits

/**
 * Volume meters drive an animated canvas, not a readout — 20fps is smooth to the
 * eye and a twentieth of the re-renders. Without this cap the interview page
 * re-rendered on every audio chunk and the whole UI stuttered.
 */
const METER_INTERVAL_MS = 50;

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

  const wsRef = useRef<WebSocket | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const speakerContextRef = useRef<AudioContext | null>(null);
  const micNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackNodeRef = useRef<AudioWorkletNode | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const closingRef = useRef(false);

  /** Decays the user's meter so it falls smoothly instead of snapping to zero. */
  const userVolumeRef = useRef(0);
  const lastUserMeterRef = useRef(0);
  const lastAiMeterRef = useRef(0);

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

    micContextRef.current?.close().catch(() => {});
    micContextRef.current = null;
    speakerContextRef.current?.close().catch(() => {});
    speakerContextRef.current = null;

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

      // Requesting the context at 16kHz lets the browser handle resampling.
      const micContext = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
      micContextRef.current = micContext;
      await micContext.audioWorklet.addModule("/worklets/mic-processor.js");

      const speakerContext = new AudioContext({ sampleRate: SPEAKER_SAMPLE_RATE });
      speakerContextRef.current = speakerContext;
      await speakerContext.audioWorklet.addModule("/worklets/playback-processor.js");

      const ws = new WebSocket(backendWsUrl(sessionId));
      wsRef.current = ws;

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
      const playbackNode = new AudioWorkletNode(speakerContext, "playback-processor");
      playbackNodeRef.current = playbackNode;
      playbackNode.connect(speakerContext.destination);
      playbackNode.port.onmessage = (e) => {
        const { type, playing, peak } = e.data || {};
        if (type === "playing") {
          // Transitions are never throttled — the speaking indicator must be
          // immediate or the orb lags behind the voice.
          setIsAiSpeaking(playing);
          if (!playing) setAiVolume(0);
        } else if (type === "level") {
          const now = performance.now();
          if (now - lastAiMeterRef.current >= METER_INTERVAL_MS) {
            lastAiMeterRef.current = now;
            setAiVolume(peak);
          }
        }
      };

      // --- capture path ---
      const source = micContext.createMediaStreamSource(stream);
      const micNode = new AudioWorkletNode(micContext, "mic-processor");
      micNodeRef.current = micNode;
      source.connect(micNode);
      // Route to destination with zero gain: some browsers won't pull from a
      // worklet that isn't connected to anything downstream.
      const mute = micContext.createGain();
      mute.gain.value = 0;
      micNode.connect(mute).connect(micContext.destination);

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

        const now = performance.now();
        if (now - lastUserMeterRef.current >= METER_INTERVAL_MS) {
          lastUserMeterRef.current = now;
          setUserVolume(userVolumeRef.current);
          setIsUserSpeaking(userVolumeRef.current > 0.04);
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case "ready":
            setConnectionState("active");
            break;

          case "audio": {
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

          case "interrupted":
            // Candidate talked over Sarah — drop buffered speech immediately.
            playbackNodeRef.current?.port.postMessage({ type: "flush" });
            setIsAiSpeaking(false);
            setAiVolume(0);
            break;

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
        if (!closingRef.current) setConnectionState("disconnected");
      };
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

  /**
   * Nova Sonic's bidirectional stream is audio-in only for the candidate turn,
   * so there is no text channel to inject into mid-session. Kept for interface
   * parity with the WebRTC hook.
   */
  const sendTextMessage = useCallback((_text: string) => {
    console.warn("[NovaSonic] Text input is not supported on the speech-to-speech stream.");
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
  };
}
