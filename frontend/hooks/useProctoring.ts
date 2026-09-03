"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FaceDetector, ObjectDetector, FilesetResolver } from "@mediapipe/tasks-vision";
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
 *   PHONE_DETECTED           - a handheld device is visible
 *
 * Phone detection is the one that needs care. Object detection false-positives
 * readily on mugs, notebooks and hands, so a single frame is never enough: the
 * device must be seen continuously for over two seconds before it flags at all.
 * That is also why only sustained multi-person and sustained phone detections
 * are allowed to escalate toward ending a call — a proctoring tool that cries
 * wolf is worse than one that stays quiet.
 *
 * Every flag captures a JPEG snapshot as evidence. Detection runs at a throttled
 * rate rather than every frame so it doesn't compete with the audio pipeline.
 */

/**
 * detectForVideo is SYNCHRONOUS — it blocks the main thread until results
 * return. That thread also carries audio chunks from the WebSocket to the
 * playback worklet, so every detection is a window in which audio cannot be
 * delivered. Block long enough and the player starves, heard as stuttering.
 *
 * Mitigations, in order of effect: detect on a downscaled copy rather than the
 * full 1280x720 frame; run object detection far less often than face detection
 * (a phone does not appear for 200ms); never run both in the same frame.
 */
const FACE_INTERVAL_MS = 400;
const OBJECT_INTERVAL_MS = 1600;
const DETECT_WIDTH = 480;
const SLOW_DETECTION_MS = 40;
const ABSENCE_THRESHOLD_MS = 3000;
const COOLDOWN_MS = 8000; // per flag type, prevents duplicate spam

/** A phone must be visible continuously for this long before it counts. */
const PHONE_SUSTAIN_MS = 2000;
/** Likewise for a second face — people walk past doorways. */
const MULTI_FACE_SUSTAIN_MS = 1500;
/** Head must stay turned away this long before it reads as looking elsewhere. */
const LOOK_AWAY_SUSTAIN_MS = 3000;
/** Nose offset from the eye midpoint (relative to eye spacing) that reads as turned. */
const LOOK_AWAY_RATIO = 0.34;
/** Object-detector confidence floor. Deliberately high. */
const PHONE_CONFIDENCE = 0.55;
/** COCO classes that count as a handheld device. */
const PHONE_LABELS = ["cell phone", "mobile phone", "remote"];

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
  /** True while a device is currently visible — drives the live indicator. */
  phoneVisible: boolean;
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
  const [phoneVisible, setPhoneVisible] = useState(false);

  const detectorRef = useRef<FaceDetector | null>(null);
  const objectDetectorRef = useRef<ObjectDetector | null>(null);
  const phoneSinceRef = useRef<number | null>(null);
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastFaceRef = useRef(0);
  const lastObjectRef = useRef(0);
  const slowWarnedRef = useRef(false);
  const multiFaceSinceRef = useRef<number | null>(null);
  const lookAwaySinceRef = useRef<number | null>(null);
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

      // A base64 data URL rather than an object URL: it renders locally the same
      // way, but can also be POSTed to the backend on completion so the recruiter
      // can re-verify the frame from their own session — an object URL can't leave
      // the browser that made it. Quality kept modest to bound the payload size.
      resolve(canvas.toDataURL("image/jpeg", 0.6));
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

        // Object detection is best-effort: if the model fails to load the
        // interview still runs with face-based proctoring rather than dying.
        try {
          objectDetectorRef.current = await ObjectDetector.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: "/models/efficientdet_lite0.tflite",
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            scoreThreshold: PHONE_CONFIDENCE,
            maxResults: 5,
          });
        } catch (err) {
          console.warn("[Proctoring] Object detector unavailable, continuing without it:", err);
        }

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
      const doFace = now - lastFaceRef.current >= FACE_INTERVAL_MS;
      const doObject = !doFace && now - lastObjectRef.current >= OBJECT_INTERVAL_MS;
      if (!doFace && !doObject) return;

      // Downscale once; both detectors read the smaller frame. Keypoints come
      // back normalised, so head-pose maths below is unaffected by the scale.
      if (!detectCanvasRef.current) detectCanvasRef.current = document.createElement("canvas");
      const dc = detectCanvasRef.current;
      dc.width = DETECT_WIDTH;
      dc.height = Math.round(video.videoHeight * (DETECT_WIDTH / video.videoWidth));
      const dctx = dc.getContext("2d", { willReadFrequently: true });
      if (!dctx) return;
      dctx.drawImage(video, 0, 0, dc.width, dc.height);
      const blockStart = performance.now();

      // Declared out here because the look-away check below needs the keypoints.
      let count = faceCount;
      let result: any = null;
      if (doFace) {
        lastFaceRef.current = now;
        try {
          // detectForVideo requires a strictly increasing timestamp.
          result = detector.detectForVideo(dc, now);
          count = result.detections?.length ?? 0;
        } catch {
          return; // transient decode errors are not worth flagging
        }
      }

      setFaceCount(count);

      // --- handheld device, sustained ---
      const objectDetector = objectDetectorRef.current;
      if (doObject && objectDetector) {
        lastObjectRef.current = now;
        try {
          const objects = objectDetector.detectForVideo(dc, now);
          const seesPhone = (objects.detections || []).some((d) =>
            (d.categories || []).some(
              (c) =>
                PHONE_LABELS.includes((c.categoryName || "").toLowerCase()) &&
                (c.score ?? 0) >= PHONE_CONFIDENCE
            )
          );

          setPhoneVisible(seesPhone);

          if (seesPhone) {
            if (phoneSinceRef.current === null) {
              phoneSinceRef.current = now;
            } else if (now - phoneSinceRef.current > PHONE_SUSTAIN_MS) {
              raiseFlag("PHONE_DETECTED", "Phone or handheld device visible in frame");
              phoneSinceRef.current = now; // cooldown handles spacing
            }
          } else {
            phoneSinceRef.current = null;
          }
        } catch {
          /* transient decode error — ignore this frame */
        }
      }

      const blocked = performance.now() - blockStart;
      if (blocked > SLOW_DETECTION_MS && !slowWarnedRef.current) {
        slowWarnedRef.current = true;
        console.warn(
          `[proctoring] detection blocked the main thread for ${blocked.toFixed(0)}ms — ` +
            `this can starve audio. Raise FACE_INTERVAL_MS or lower DETECT_WIDTH.`
        );
      }

      if (!doFace) return; // presence logic only runs on a face pass

      if (count > 1) {
        absentSinceRef.current = null;
        lookAwaySinceRef.current = null;
        // Sustained, so someone crossing behind the candidate does not flag.
        if (multiFaceSinceRef.current === null) {
          multiFaceSinceRef.current = now;
        } else if (now - multiFaceSinceRef.current > MULTI_FACE_SUSTAIN_MS) {
          raiseFlag("MULTIPLE_FACES_DETECTED", "Another person detected in camera frame");
          multiFaceSinceRef.current = now;
        }
      } else if (count === 0) {
        multiFaceSinceRef.current = null;
        lookAwaySinceRef.current = null;
        // Debounced: a brief turn away shouldn't trip the flag.
        if (absentSinceRef.current === null) {
          absentSinceRef.current = now;
        } else if (now - absentSinceRef.current > ABSENCE_THRESHOLD_MS) {
          raiseFlag("CANDIDATE_ABSENT", "Candidate left camera view");
          absentSinceRef.current = now; // restart window; cooldown handles spacing
        }
      } else {
        // Exactly one face. Estimate whether the head is turned away from the
        // screen — a rough proxy for reading an answer off to the side. Uses the
        // nose position relative to the eye midpoint; deliberately conservative
        // and sustained, since head pose from a bounding box is inherently noisy.
        absentSinceRef.current = null;
        multiFaceSinceRef.current = null;

        const kp = result?.detections?.[0]?.keypoints;
        if (kp && kp.length >= 3) {
          const [rightEye, leftEye, noseTip] = kp;
          const eyeSpan = Math.abs(leftEye.x - rightEye.x) || 0.0001;
          const turnRatio = Math.abs(noseTip.x - (rightEye.x + leftEye.x) / 2) / eyeSpan;

          if (turnRatio > LOOK_AWAY_RATIO) {
            if (lookAwaySinceRef.current === null) {
              lookAwaySinceRef.current = now;
            } else if (now - lookAwaySinceRef.current > LOOK_AWAY_SUSTAIN_MS) {
              raiseFlag("LOOKING_AWAY", "Candidate repeatedly looking away from the screen");
              lookAwaySinceRef.current = now; // cooldown handles spacing
            }
          } else {
            lookAwaySinceRef.current = null;
          }
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      detectorRef.current?.close();
      detectorRef.current = null;
      objectDetectorRef.current?.close();
      objectDetectorRef.current = null;
      setIsReady(false);
      setPhoneVisible(false);
    };
  }, [enabled, videoRef, raiseFlag]);

  return { flags, faceCount, isReady, error, phoneVisible };
}
