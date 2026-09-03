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
  | "TAB_SWITCH_DETECTED"
  | "PHONE_DETECTED"
  | "LOOKING_AWAY";

/**
 * Only these prompt the interviewer to ask the candidate about it, live.
 *
 * The interview is never ended over a proctoring signal — the interviewer just
 * works a natural question into the conversation ("is someone with you?", "are
 * you referring to notes?"). Tab switches and brief absences are recorded for
 * the recruiter but never interrupt the conversation: they are far too easy to
 * trigger innocently. The ones here all require sustained detection first.
 */
export const PROBEABLE_FLAGS: RedFlagType[] = [
  "MULTIPLE_FACES_DETECTED",
  "PHONE_DETECTED",
  "LOOKING_AWAY",
];

export interface RedFlag {
  id: string;
  type: RedFlagType;
  description: string;
  /** Wall-clock time the flag fired. */
  timestamp: number;
  /** Offset into the recording, in seconds — drives "jump to time". */
  timeInSeconds: number;
  /** Base64 data URL of the JPEG snapshot (would be an S3 URL in production). */
  snapshotUrl: string | null;
  /** Base64 data URL of a short video clip around the violation, for re-verification. */
  clipUrl?: string | null;
}

export const RED_FLAG_LABELS: Record<RedFlagType, string> = {
  MULTIPLE_FACES_DETECTED: "Multiple People Detected",
  CANDIDATE_ABSENT: "Candidate Left Frame",
  TAB_SWITCH_DETECTED: "Navigated Away From Tab",
  PHONE_DETECTED: "Phone In Frame",
  LOOKING_AWAY: "Looking Away From Screen",
};

/** What the interviewer is told she is seeing, so she can ask about it naturally. */
export const RED_FLAG_WARNINGS: Record<RedFlagType, string> = {
  MULTIPLE_FACES_DETECTED:
    "Another person seems to be in the room or on camera with the candidate, and there may be a second voice",
  CANDIDATE_ABSENT: "The candidate has moved out of camera view",
  TAB_SWITCH_DETECTED: "The candidate has navigated away from the interview tab",
  PHONE_DETECTED: "The candidate appears to be looking at or using a phone or handheld device",
  LOOKING_AWAY:
    "The candidate keeps looking away from the screen, as if reading an answer from somewhere else",
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

/** Attaches a short video clip to a flag once its recording finishes (a few seconds later). */
export function attachClip(flagId: string, clipUrl: string): void {
  const flag = session.redFlags.find((f) => f.id === flagId);
  if (flag) flag.clipUrl = clipUrl;
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
