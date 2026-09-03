import { QuestionBank } from "./questionBank";

/**
 * In-memory store for prepared interview sessions.
 *
 * A session is created when a recruiter generates a question bank, then claimed
 * by the WebSocket when the candidate connects. The bank never travels through
 * the browser — the client holds only a session id, so a candidate cannot read
 * (or tamper with) the questions and grading criteria they are about to be
 * assessed against.
 *
 * Prototype scope: a Map, so everything is lost on restart. Swapping in Redis
 * or Postgres later means replacing this file and nothing else.
 */

export interface InterviewSession {
  id: string;
  candidateName: string;
  bank: QuestionBank;
  createdAt: number;
}

const sessions = new Map<string, InterviewSession>();

/** Sessions are demo-scoped; this keeps a long-running server from growing. */
const TTL_MS = 6 * 60 * 60 * 1000;

function evictExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}

export function createSession(candidateName: string, bank: QuestionBank): InterviewSession {
  evictExpired();

  const id = `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const session: InterviewSession = {
    id,
    candidateName,
    bank,
    createdAt: Date.now(),
  };

  sessions.set(id, session);
  return session;
}

export function getSession(id: string): InterviewSession | undefined {
  return sessions.get(id);
}

export function listSessions(): InterviewSession[] {
  evictExpired();
  return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}
