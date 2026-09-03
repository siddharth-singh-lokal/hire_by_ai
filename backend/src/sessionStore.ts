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
  /** Set if grading itself failed, so the admin sees why rather than nothing. */
  gradingError?: string;
  /** Why the interview ended early, when it did. */
  terminationReason?: string;
}

const sessions = new Map<string, InterviewSession>();
/** email (lowercased) -> session id. The candidate's only lookup key. */
const byEmail = new Map<string, string>();

/** Gitignored: contains candidate names, emails and transcripts. */
const STORE_PATH = path.join(__dirname, "..", ".sessions.json");

function persist(): void {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify([...sessions.values()]));
  } catch (err: any) {
    // Persistence is a convenience, never a reason to fail a live interview.
    console.error("[sessionStore] Could not persist:", err?.message);
  }
}

function restore(): void {
  if (!fs.existsSync(STORE_PATH)) return;
  try {
    const rows: InterviewSession[] = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    for (const row of rows) {
      // An interview that was mid-flight when the server died cannot resume,
      // so it is recorded as interrupted rather than left looking active.
      if (row.status === "in_progress" || row.status === "grading") {
        row.status = "terminated";
        row.terminationReason = row.terminationReason || "server restarted mid-interview";
      }
      sessions.set(row.id, row);
      byEmail.set(row.candidateEmail, row.id);
    }
    console.log(`[sessionStore] Restored ${rows.length} session(s)`);
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
}): InterviewSession {
  evictExpired();

  const email = normaliseEmail(input.candidateEmail);
  const id = `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const session: InterviewSession = {
    id,
    candidateName: input.candidateName,
    candidateEmail: email,
    role: input.bank.role,
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

export function updateSession(id: string, patch: Partial<InterviewSession>): void {
  const session = sessions.get(id);
  if (!session) return;
  Object.assign(session, patch);
  persist();
}

export function listSessions(): InterviewSession[] {
  evictExpired();
  return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}
