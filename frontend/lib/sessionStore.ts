"use client";

/**
 * In-memory evidence store for a single interview session.
 *
 * The spec called for uploading the recording and every red-flag snapshot to S3
 * via presigned URLs. For the prototype that is deliberately skipped: blobs live
 * as object URLs in this module, which survives client-side navigation from
 * /interview to /scorecard because Next keeps the module instance alive.
 *
 * The trade-off is explicit — a hard refresh or a new tab loses the evidence,
 * and nothing is shareable with an actual recruiter. Swapping in S3 later means
 * replacing persistSnapshot/persistRecording with presigned PUTs and storing the
 * returned URLs in the same shape; nothing else in the app needs to change.
 */

export type RedFlagType =
  | "MULTIPLE_FACES_DETECTED"
  | "CANDIDATE_ABSENT"
  | "TAB_SWITCH_DETECTED";

export interface RedFlag {
  id: string;
  type: RedFlagType;
  description: string;
  /** Wall-clock time the flag fired. */
  timestamp: number;
  /** Offset into the recording, in seconds — drives "jump to time". */
  timeInSeconds: number;
  /** Object URL of the JPEG snapshot (would be an S3 URL in production). */
  snapshotUrl: string | null;
}

export const RED_FLAG_LABELS: Record<RedFlagType, string> = {
  MULTIPLE_FACES_DETECTED: "Multiple People Detected",
  CANDIDATE_ABSENT: "Candidate Left Frame",
  TAB_SWITCH_DETECTED: "Navigated Away From Tab",
};

interface SessionEvidence {
  sessionId: string;
  redFlags: RedFlag[];
  recordingUrl: string | null;
  recordingMimeType: string | null;
  durationSeconds: number;
}

let session: SessionEvidence = emptySession();

function emptySession(): SessionEvidence {
  return {
    sessionId: "",
    redFlags: [],
    recordingUrl: null,
    recordingMimeType: null,
    durationSeconds: 0,
  };
}

export function startSession(): string {
  // Revoke the previous run's blobs so repeated demos don't leak memory.
  clearSession();
  const sessionId = `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  session.sessionId = sessionId;
  return sessionId;
}

export function clearSession(): void {
  if (session.recordingUrl) URL.revokeObjectURL(session.recordingUrl);
  session.redFlags.forEach((f) => {
    if (f.snapshotUrl) URL.revokeObjectURL(f.snapshotUrl);
  });
  session = emptySession();
}

export function recordFlag(flag: RedFlag): void {
  session.redFlags.push(flag);
}

export function setRecording(blob: Blob, durationSeconds: number): void {
  if (session.recordingUrl) URL.revokeObjectURL(session.recordingUrl);
  session.recordingUrl = URL.createObjectURL(blob);
  session.recordingMimeType = blob.type;
  session.durationSeconds = durationSeconds;
}

export function getSession(): SessionEvidence {
  return session;
}
