"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { setRecording } from "@/lib/sessionStore";

/**
 * Records the candidate's webcam + mic for the recruiter audit.
 *
 * The spec uploads the finished file to S3; here it is kept as an object URL in
 * the session store so the scorecard can play it back without any infrastructure.
 * See lib/sessionStore.ts for the trade-off that implies.
 */

/** First supported type wins; Safari won't take webm. */
const PREFERRED_TYPES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "video/mp4",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

export interface UseSessionRecorderReturn {
  isRecording: boolean;
  error: string | null;
  start: (stream: MediaStream) => void;
  /** Resolves with the final recording blob (or null) once stored. */
  stop: () => Promise<Blob | null>;
}

export function useSessionRecorder(): UseSessionRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  const start = useCallback((stream: MediaStream) => {
    if (recorderRef.current) return;

    const mimeType = pickMimeType();
    if (!mimeType) {
      setError("This browser cannot record the session (MediaRecorder unavailable).");
      return;
    }

    try {
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      startedAtRef.current = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = (e: any) => {
        console.error("[Recorder] error:", e);
        setError("Recording stopped unexpectedly.");
      };

      // Timeslice so chunks land periodically rather than only at stop — if the
      // tab dies mid-interview we still have most of the recording.
      recorder.start(1000);
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch (err: any) {
      console.error("[Recorder] start failed:", err);
      setError(err?.message || "Could not start recording.");
    }
  }, []);

  const stop = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        setIsRecording(false);
        return resolve(null);
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "video/webm",
        });
        const duration = Math.round((Date.now() - startedAtRef.current) / 1000);
        setRecording(blob, duration);

        chunksRef.current = [];
        recorderRef.current = null;
        setIsRecording(false);
        resolve(blob);
      };

      recorder.stop();
    });
  }, []);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
    };
  }, []);

  return { isRecording, error, start, stop };
}
