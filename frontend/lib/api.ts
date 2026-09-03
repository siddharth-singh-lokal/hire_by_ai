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
  durationMinutes: 15 | 30 | 45;
  rubric: RubricAxis[];
  questions: BankQuestion[];
  claimsToVerify: { claim: string; jdRequirement: string }[];
  unevidencedRequirements: string[];
  openingLine: string;
}

export interface PrepareResult {
  success: boolean;
  sessionId: string;
  candidateName: string;
  bank: QuestionBank;
  grounded: boolean;
}

export function prepareInterview(input: {
  jdText: string;
  resumeText: string;
  candidateName: string;
  durationMinutes: 15 | 30 | 45;
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

export function evaluateInterview(input: {
  sessionId?: string;
  transcripts: unknown[];
  durationSeconds: number;
  redFlags: unknown[];
}): Promise<{ evaluation: any; genericComparison: any }> {
  return post("/api/evaluate", input);
}
