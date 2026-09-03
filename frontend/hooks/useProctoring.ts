"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { RedFlag, RedFlagType, recordFlag } from "@/lib/sessionStore";

/**
 * Client-side proctoring.
 *
 * Runs MediaPipe's short-range face detector over the candidate's webcam feed on
 * a requestAnimationFrame loop and raises flags for the three signals that are
 * reliable enough to show a recruiter:
 *
 *   MULTIPLE_FACES_DETECTED  - someone else is in frame
 *   CANDIDATE_ABSENT         - nobody in frame for >3s
 *   TAB_SWITCH_DETECTED      - window blur / visibility change
 *
 * Phone detection from the original spec is deliberately not implemented — object
 * detection for handheld devices false-positives on mugs, notebooks and hands,
 * and a proctoring tool that cries wolf is worse than one that stays quiet.
 *
 * Every flag captures a JPEG snapshot as evidence. Detection runs at a throttled
 * rate rather than every frame so it doesn't compete with the audio pipeline.
 */

const DETECTION_INTERVAL_MS = 300; // ~3fps is plenty for presence checks
const ABSENCE_THRESHOLD_MS = 3000;
const COOLDOWN_MS = 8000; // per flag type, prevents duplicate spam

export interface UseProctoringOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Detection only runs while this is true. */
  enabled: boolean;
  /** Seconds elapsed in the interview, used to timestamp flags on the recording. */
  getElapsedSeconds: () => number;
  onFlag?: (flag: RedFlag) => void;
}

export interface UseProctoringReturn {
  flags: RedFlag[];
  faceCount: number;
  isReady: boolean;
  error: string | null;
}

export function useProctoring({
  videoRef,
  enabled,
  getElapsedSeconds,
  onFlag,
}: UseProctoringOptions): UseProctoringReturn {
  const [flags, setFlags] = useState<RedFlag[]>([]);
  const [faceCount, setFaceCount] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectorRef = useRef<FaceDetector | null>(null);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastDetectionRef = useRef(0);
  const absentSinceRef = useRef<number | null>(null);
  const cooldownRef = useRef<Record<string, number>>({});
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  /** Grabs the current video frame as a JPEG object URL. */
  const captureSnapshot = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return resolve(null);

      if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(
        (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
        "image/jpeg",
        0.8
      );
    });
  }, [videoRef]);

  const raiseFlag = useCallback(
    async (type: RedFlagType, description: string) => {
      const now = Date.now();
      if (now - (cooldownRef.current[type] || 0) < COOLDOWN_MS) return;
      cooldownRef.current[type] = now;

      // Snapshot before awaiting anything else so the frame matches the event.
      const snapshotUrl = await captureSnapshot();

      const flag: RedFlag = {
        id: `flag_${now}_${Math.random().toString(36).slice(2, 7)}`,
        type,
        description,
        timestamp: now,
        timeInSeconds: getElapsedSeconds(),
        snapshotUrl,
      };

      recordFlag(flag);
      setFlags((prev) => [...prev, flag]);
      onFlag?.(flag);
    },
    [captureSnapshot, getElapsedSeconds, onFlag]
  );

  // --- Tab / window focus monitoring ---------------------------------------
  useEffect(() => {
    if (!enabled) return;

    const onHidden = () => {
      if (document.hidden) {
        raiseFlag("TAB_SWITCH_DETECTED", "Candidate navigated away from interview tab");
      }
    };
    const onBlur = () => {
      raiseFlag("TAB_SWITCH_DETECTED", "Interview window lost focus");
    };

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled, raiseFlag]);

  // --- Face detection loop --------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const init = async () => {
      try {
        // WASM and model are vendored into /public so the demo works without
        // reaching a CDN mid-presentation.
        const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        if (cancelled) return;

        const detector = await FaceDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: "/models/blaze_face_short_range.tflite",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          minDetectionConfidence: 0.6,
        });
        if (cancelled) {
          detector.close();
          return;
        }

        detectorRef.current = detector;
        setIsReady(true);
        loop();
      } catch (err: any) {
        console.error("[Proctoring] init failed:", err);
        setError(err?.message || "Failed to initialise proctoring.");
      }
    };

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);

      const video = videoRef.current;
      const detector = detectorRef.current;
      if (!video || !detector || !enabledRef.current) return;
      if (video.readyState < 2 || !video.videoWidth) return;

      const now = performance.now();
      if (now - lastDetectionRef.current < DETECTION_INTERVAL_MS) return;
      lastDetectionRef.current = now;

      let count = 0;
      try {
        // detectForVideo requires a strictly increasing timestamp.
        const result = detector.detectForVideo(video, now);
        count = result.detections?.length ?? 0;
      } catch {
        return; // transient decode errors are not worth flagging
      }

      setFaceCount(count);

      if (count > 1) {
        absentSinceRef.current = null;
        raiseFlag("MULTIPLE_FACES_DETECTED", "Another person detected in camera frame");
      } else if (count === 0) {
        // Debounced: a brief turn away shouldn't trip the flag.
        if (absentSinceRef.current === null) {
          absentSinceRef.current = now;
        } else if (now - absentSinceRef.current > ABSENCE_THRESHOLD_MS) {
          raiseFlag("CANDIDATE_ABSENT", "Candidate left camera view");
          absentSinceRef.current = now; // restart window; cooldown handles spacing
        }
      } else {
        absentSinceRef.current = null;
      }
    };

    init();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      detectorRef.current?.close();
      detectorRef.current = null;
      setIsReady(false);
    };
  }, [enabled, videoRef, raiseFlag]);

  return { flags, faceCount, isReady, error };
}
