import * as fs from "fs";
import * as path from "path";
import { QuestionBank } from "./questionBank";
import { GroundedScorecard } from "./scorecardTypes";

/**
 * In-memory store for prepared interviews.
 *
 * Two access paths, deliberately different:
 *
 *  - The ADMIN prepares an interview ahead of time. Bank generation takes the
 *    better part of a minute, and that cost is paid here, before the candidate
 *    is anywhere near the app.
 *  - The CANDIDATE looks their interview up by email and starts immediately.
 *    No generation, no waiting. This is the whole reason the flows are split.
 *
 * The bank itself never travels to the candidate's browser — they receive an
 * opaque session id, and the questions and grading criteria stay server-side.
 *
 * Prototype scope: an in-memory Map, mirrored to a JSON file so a server restart
 * does not destroy completed interviews. That is not a database — there is no
 * concurrency control and it rewrites the whole file on every change — but a
 * restart losing a candidate's finished interview is a real failure, and this
 * costs twenty lines. Swapping in Redis or Postgres means replacing this file
 * alone.
 */

export type InterviewStatus =
  | "ready"
  | "in_progress"
  | "grading"
  | "completed"
  | "terminated";

export interface StoredTranscript {
  sender: "candidate" | "interviewer";
  text: string;
  timestamp: number;
  /**
   * Roman Hinglish display form of `text` (Latin script). Populated after grading
   * or live during the call. `text` stays the verbatim ASR original.
   */
  textEn?: string;
}

export interface StoredRedFlag {
  type: string;
  description: string;
  timeInSeconds: number;
  /** Base64 JPEG data URL captured when the flag fired, so the recruiter can re-verify it. */
  snapshot?: string;
  /** Base64 data URL of a short video clip around the violation. */
  clip?: string;
}

export interface InterviewSession {
  id: string;
  candidateName: string;
  candidateEmail: string;
  role: string;
  /** Interview language code (see languages.ts). Defaults to English. */
  language: string;
  bank: QuestionBank;
  status: InterviewStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /**
   * Accumulated server-side as the interview runs.
   *
   * The relay already sees every transcript event, so it records them here
   * rather than trusting the browser to hand them back at the end. The earlier
   * design kept them in the candidate's localStorage and lost the whole
   * interview if they closed the tab.
   */
  transcripts: StoredTranscript[];
  /** Proctoring runs in the browser, so these are posted on completion. */
  redFlags: StoredRedFlag[];
  durationSeconds: number;
  /** Populated after grading, so the admin list can show outcomes. */
  scorecard?: GroundedScorecard;
  /** Last substantive question asked — anchors resume after drops or long silence. */
  lastQuestionAsked?: string;
  /** Set if grading itself failed, so the admin sees why rather than nothing. */
  gradingError?: string;
  /** Why the interview ended early, when it did. */
  terminationReason?: string;
  /**
   * How many times the Bedrock voice stream dropped and was re-established
   * mid-interview. Recorded by the relay. The grader is told about it so a
   * candidate is never marked down for fragmentation the platform caused, and
   * the scorecard surfaces it so a recruiter can tell "weak answers" from
   * "broken call" at a glance.
   */
  streamDrops?: number;
  /**
   * MIME type of the full interview recording, set once the browser uploads it
   * on completion. Presence of this field is how the scorecard knows a recording
   * exists to play. The bytes live in `.evidence/<id>.rec`, never in this store.
   */
  recordingMime?: string;
}

const sessions = new Map<string, InterviewSession>();
/** email (lowercased) -> session id. The candidate's only lookup key. */
const byEmail = new Map<string, string>();

/** Gitignored: contains candidate names, emails and transcripts. */
const STORE_PATH = path.join(__dirname, "..", ".sessions.json");
/**
 * Proctoring evidence (base64 JPEG snapshots and ~6s video clips) lives in its
 * own directory, one file per session, written once when the interview
 * completes. It must stay OUT of the hot store: a single clip is ~2.7MB of
 * base64, and the store used to be rewritten in full — synchronously — on every
 * transcript line. With two sessions' worth of clips that was an 8MB
 * JSON.stringify + writeFileSync on the same event loop that relays the live
 * audio, several times a second while the interviewer spoke. It grew with every
 * interview of the day, and it was heard as audio stutter.
 */
const EVIDENCE_DIR = path.join(__dirname, "..", ".evidence");

/** Coalesces bursts of updates (ASR emits several lines per utterance). */
const PERSIST_DEBOUNCE_MS = 250;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight = false;
let persistDirty = false;

/** The store without evidence blobs — small enough to rewrite freely. */
function serialiseStore(): string {
  const rows = [...sessions.values()].map((s) => ({
    ...s,
    redFlags: s.redFlags.map(({ snapshot, clip, ...flag }) => flag),
  }));
  return JSON.stringify(rows);
}

async function flushPersist(): Promise<void> {
  if (persistInFlight) {
    persistDirty = true;
    return;
  }
  persistInFlight = true;
  try {
    // JSON.stringify is still synchronous, but without the blobs it is tens of
    // kilobytes. Write to a temp file and rename so a crash mid-write can never
    // leave a truncated store behind.
    const body = serialiseStore();
    const tmp = `${STORE_PATH}.tmp`;
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, STORE_PATH);
  } catch (err: any) {
    // Persistence is a convenience, never a reason to fail a live interview.
    console.error("[sessionStore] Could not persist:", err?.message);
  } finally {
    persistInFlight = false;
    if (persistDirty) {
      persistDirty = false;
      schedulePersist();
    }
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushPersist();
  }, PERSIST_DEBOUNCE_MS);
}

function persist(): void {
  schedulePersist();
}

/** Writes a session's evidence blobs to their own file. Once, on completion. */
function persistEvidence(session: InterviewSession): void {
  const hasBlobs = session.redFlags.some((f) => f.snapshot || f.clip);
  if (!hasBlobs) return;
  const file = path.join(EVIDENCE_DIR, `${session.id}.json`);
  const body = JSON.stringify(
    session.redFlags.map((f, i) => ({ index: i, snapshot: f.snapshot, clip: f.clip }))
  );
  fs.promises
    .mkdir(EVIDENCE_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(`${file}.tmp`, body))
    .then(() => fs.promises.rename(`${file}.tmp`, file))
    .catch((err: any) => console.error("[sessionStore] Could not persist evidence:", err?.message));
}

/** Re-attaches evidence blobs to a restored session, if a file exists. */
function restoreEvidence(session: InterviewSession): void {
  const file = path.join(EVIDENCE_DIR, `${session.id}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const rows: { index: number; snapshot?: string; clip?: string }[] = JSON.parse(
      fs.readFileSync(file, "utf8")
    );
    for (const row of rows) {
      const flag = session.redFlags[row.index];
      if (!flag) continue;
      if (row.snapshot) flag.snapshot = row.snapshot;
      if (row.clip) flag.clip = row.clip;
    }
  } catch (err: any) {
    console.error(`[sessionStore] Could not restore evidence for ${session.id}:`, err?.message);
  }
}

function restore(): void {
  if (!fs.existsSync(STORE_PATH)) return;
  try {
    const rows: InterviewSession[] = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    let migrated = false;
    for (const row of rows) {
      // An interview that was mid-flight when the server died cannot resume,
      // so it is recorded as interrupted rather than left looking active.
      if (row.status === "in_progress" || row.status === "grading") {
        row.status = "terminated";
        row.terminationReason = row.terminationReason || "server restarted mid-interview";
      }
      // Older stores kept the evidence blobs inline. Move them out on first load.
      if (row.redFlags?.some((f) => f.snapshot || f.clip)) {
        if (!fs.existsSync(path.join(EVIDENCE_DIR, `${row.id}.json`))) persistEvidence(row);
        migrated = true;
      } else {
        restoreEvidence(row);
      }
      sessions.set(row.id, row);
      byEmail.set(row.candidateEmail, row.id);
    }
    console.log(`[sessionStore] Restored ${rows.length} session(s)`);
    if (migrated) {
      console.log("[sessionStore] Moving inline proctoring evidence out of the hot store");
      persist();
    }
  } catch (err: any) {
    console.error("[sessionStore] Could not restore:", err?.message);
  }
}

restore();

/** Demo-scoped. Keeps a long-running server from growing without bound. */
const TTL_MS = 12 * 60 * 60 * 1000;

function evictExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) {
      sessions.delete(id);
      if (byEmail.get(session.candidateEmail) === id) {
        byEmail.delete(session.candidateEmail);
      }
    }
  }
}

export function normaliseEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

export function createSession(input: {
  candidateName: string;
  candidateEmail: string;
  bank: QuestionBank;
  language?: string;
}): InterviewSession {
  evictExpired();

  const email = normaliseEmail(input.candidateEmail);
  const id = `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const session: InterviewSession = {
    id,
    candidateName: input.candidateName,
    candidateEmail: email,
    role: input.bank.role,
    language: input.language || "en",
    bank: input.bank,
    status: "ready",
    createdAt: Date.now(),
    transcripts: [],
    redFlags: [],
    durationSeconds: 0,
  };

  sessions.set(id, session);
  // Re-preparing for the same email replaces the old interview rather than
  // creating an ambiguous second one the candidate might land on.
  byEmail.set(email, id);
  persist();

  return session;
}

export function getSession(id: string): InterviewSession | undefined {
  return sessions.get(id);
}

/** The candidate's login. Email is the only thing they have to remember. */
export function getSessionByEmail(email: string): InterviewSession | undefined {
  const id = byEmail.get(normaliseEmail(email));
  return id ? sessions.get(id) : undefined;
}

/** Appends a line as the interview runs. Called from the relay. */
export function appendTranscript(id: string, line: StoredTranscript): void {
  const session = sessions.get(id);
  if (!session) return;

  // Sonic occasionally re-emits a line; the relay dedupes for the client, but
  // guard here too so the graded transcript never contains doubled turns.
  const last = session.transcripts[session.transcripts.length - 1];
  if (last && last.sender === line.sender && last.text === line.text) return;

  session.transcripts.push(line);
  persist();
}

/** Attaches an English gloss to a line already stored (live translation path). */
export function patchTranscriptEnglish(id: string, text: string, textEn: string): void {
  const session = sessions.get(id);
  if (!session || !textEn.trim()) return;
  for (let i = session.transcripts.length - 1; i >= 0; i--) {
    const line = session.transcripts[i];
    if (line.text === text && !line.textEn) {
      line.textEn = textEn.trim();
      persist();
      return;
    }
  }
}

export function updateSession(id: string, patch: Partial<InterviewSession>): void {
  const session = sessions.get(id);
  if (!session) return;
  Object.assign(session, patch);
  if (patch.redFlags) persistEvidence(session);
  persist();
}

/**
 * Stores the full interview recording as a raw binary file, out of the hot
 * store. Recordings are tens of megabytes — base64 in JSON would be ruinous, so
 * the bytes go straight to disk and only the MIME type is kept on the session.
 */
export function saveRecording(id: string, data: Buffer, mime: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  const file = path.join(EVIDENCE_DIR, `${id}.rec`);
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, data);
    fs.renameSync(`${file}.tmp`, file);
    session.recordingMime = mime || "video/webm";
    persist();
    return true;
  } catch (err: any) {
    console.error(`[sessionStore] Could not save recording for ${id}:`, err?.message);
    return false;
  }
}

/** Path + MIME of a session's recording, or null if none was uploaded. */
export function getRecording(id: string): { path: string; mime: string } | null {
  const session = sessions.get(id);
  const file = path.join(EVIDENCE_DIR, `${id}.rec`);
  if (!session?.recordingMime || !fs.existsSync(file)) return null;
  return { path: file, mime: session.recordingMime };
}

/** Increments the relay's drop counter for a session. */
export function recordStreamDrop(id: string): number {
  const session = sessions.get(id);
  if (!session) return 0;
  session.streamDrops = (session.streamDrops || 0) + 1;
  persist();
  return session.streamDrops;
}

export function listSessions(): InterviewSession[] {
  evictExpired();
  return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}
