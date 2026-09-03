"use client";

/** Shared client for the Round-0 backend. */

export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.message || `Request failed (${res.status})`);
  }
  return data as T;
}

export interface RubricAxis {
  name: string;
  rationale: string;
  strongSignal: string;
  weakSignal: string;
  generated: boolean;
}

export interface BankQuestion {
  id: string;
  kind: "resume_probe" | "scenario" | "jd_gap";
  question: string;
  intent: string;
  axes: string[];
  escalations: string[];
  fallback?: string;
  strongAnswer: string[];
  weakAnswer: string[];
  scenarioId?: string;
  minutes: number;
}

export interface QuestionBank {
  generatedAt: string;
  role: string;
  seniority: string;
  durationMinutes: 1 | 5 | 15 | 30 | 45;
  rubric: RubricAxis[];
  questions: BankQuestion[];
  claimsToVerify: { claim: string; jdRequirement: string }[];
  unevidencedRequirements: string[];
  openingLine: string;
}

export interface CandidateSession {
  sessionId: string;
  candidateName: string;
  role: string;
  durationMinutes: number;
  questionCount: number;
}

/** Candidate lookup by email. Returns nothing that reveals the questions. */
export function candidateSignIn(email: string): Promise<CandidateSession> {
  return post<CandidateSession>("/api/candidate/signin", { email });
}

export interface AdminSessionRow {
  id: string;
  candidateName: string;
  candidateEmail: string;
  role: string;
  seniority: string;
  durationMinutes: number;
  questionCount: number;
  status: "ready" | "in_progress" | "grading" | "completed" | "terminated";
  createdAt: number;
  terminationReason?: string;
  verdict?: string;
  overallScore?: number;
  transcriptCount?: number;
  gradingError?: string;
  streamDrops?: number;
  screenQuality?: "clean" | "degraded" | "compromised";
  rescreenRecommended?: boolean;
}

export async function listAdminSessions(): Promise<AdminSessionRow[]> {
  const res = await fetch(`${BACKEND_URL}/api/admin/sessions`);
  if (!res.ok) throw new Error("Could not load interviews.");
  return (await res.json()).sessions;
}

export async function getAdminSession(id: string): Promise<any> {
  const res = await fetch(`${BACKEND_URL}/api/admin/sessions/${id}`);
  if (!res.ok) throw new Error("Could not load that interview.");
  return (await res.json()).session;
}

export interface PrepareResult {
  success: boolean;
  sessionId: string;
  candidateName: string;
  candidateEmail: string;
  bank: QuestionBank;
  grounded: boolean;
}

export function prepareInterview(input: {
  jdText: string;
  resumeText: string;
  candidateName: string;
  candidateEmail: string;
  durationMinutes: 1 | 5 | 15 | 30 | 45;
}): Promise<PrepareResult> {
  return post<PrepareResult>("/api/prepare", input);
}

/** Server-side PDF extraction — keeps a heavy PDF.js bundle out of the client. */
export async function extractPdfText(file: File): Promise<string> {
  const fileBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });

  const { text } = await post<{ text: string }>("/api/extract-text", { fileBase64 });
  return text;
}

export interface ContextPackSummary {
  approved: boolean;
  generatedAt?: string;
  stackProfile: Record<string, string[]> | null;
  sourceSummary?: { source: string; documentCount: number }[];
  scenarios: {
    id: string;
    title: string;
    stack: string[];
    constraints: string[];
    difficulty: number;
    competencies: string[];
  }[];
}

export async function fetchContextPack(): Promise<ContextPackSummary> {
  const res = await fetch(`${BACKEND_URL}/api/context-pack`);
  if (!res.ok) throw new Error("Could not load the context pack.");
  return res.json();
}

/**
 * Reports the end of an interview.
 *
 * Only proctoring flags and elapsed time travel from the browser — the
 * transcript was recorded server-side by the relay as it streamed, so the
 * result no longer depends on the candidate's tab staying open.
 */
export function completeInterview(
  sessionId: string,
  input: { redFlags: unknown[]; durationSeconds: number; terminationReason?: string }
): Promise<{ success: boolean }> {
  return post(`/api/interview/${sessionId}/complete`, input);
}

export interface ScorecardResponse {
  status: "ready" | "in_progress" | "grading" | "completed" | "failed";
  candidateName?: string;
  role?: string;
  evaluation?: any;
  genericComparison?: any;
  transcripts?: any[];
  redFlags?: {
    type: string;
    description: string;
    timeInSeconds: number;
    snapshot?: string;
    clip?: string;
  }[];
  transcriptCount?: number;
  terminationReason?: string;
  message?: string;
}

export async function fetchScorecard(sessionId: string): Promise<ScorecardResponse> {
  const res = await fetch(`${BACKEND_URL}/api/scorecard/${sessionId}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 500) {
    throw new Error((data as any)?.message || "Could not load that scorecard.");
  }
  return data as ScorecardResponse;
}

export function regradeInterview(sessionId: string): Promise<{ success: boolean }> {
  return post(`/api/scorecard/${sessionId}/regrade`, {});
}

/**
 * One turn of the TEXT interview (OpenRouter-backed). Send an empty string to
 * get the interviewer's opening line; otherwise send the candidate's message.
 */
export function sendInterviewMessage(
  sessionId: string,
  text: string
): Promise<{ reply: string }> {
  return post(`/api/interview/${sessionId}/message`, { text });
}
