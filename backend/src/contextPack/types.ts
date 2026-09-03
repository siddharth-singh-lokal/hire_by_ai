/**
 * Context Pack — the sanitized engineering corpus that gives interview questions
 * their shape.
 *
 * Important framing: the pack is the *setting*, not the syllabus. Candidates are
 * never quizzed on Lokal trivia (unfair, and it measures nothing). The JD decides
 * which competencies to test; the pack decides what the scenarios testing them are
 * made of — so a "database performance" requirement becomes a problem shaped like
 * our infrastructure instead of generic LeetCode.
 *
 * Everything here is derived from internal docs, so the sanitizer is not optional.
 * See sanitize.ts and validate.ts.
 */

/** A raw document pulled from Confluence or Slack. Never committed. */
export interface RawDocument {
  id: string;
  source: "confluence" | "slack";
  /** Space key or channel name — retained for provenance, stripped from output. */
  origin: string;
  title: string;
  body: string;
  fetchedAt: string;
}

/**
 * One abstracted engineering scenario. This is what survives sanitization: the
 * judgment is preserved, every identifier is gone.
 */
export interface Scenario {
  /** Stable slug, e.g. "db-pool-idle-timeout". */
  id: string;
  /** One-line description of the engineering situation. */
  title: string;
  /** Generic tech involved — "PostgreSQL", "Django", never a hostname or repo. */
  stack: string[];
  /** The environmental pressure that makes this interesting (cost, scale, latency). */
  constraints: string[];
  /** The question as it would be posed to a candidate. */
  prompt: string;
  /** Follow-ups used to escalate when an answer is strong. */
  probes: string[];
  /** Answer signatures, used both to generate rubrics and to grade. */
  weakAnswer: string[];
  strongAnswer: string[];
  /** Competency areas this scenario can assess, e.g. "databases", "reliability". */
  competencies: string[];
  /** Rough seniority band this suits: 0 = intern, 4 = staff. */
  difficulty: 0 | 1 | 2 | 3 | 4;
}

/** Generic profile of how the org builds — no product or service names. */
export interface StackProfile {
  languages: string[];
  datastores: string[];
  infrastructure: string[];
  observability: string[];
  /** e.g. "cost-sensitive instance sizing", "small autonomous pods". */
  operatingConstraints: string[];
}

export interface ContextPack {
  version: string;
  generatedAt: string;
  /**
   * Public-safe company context from company-profile.md — mission, values, how
   * the team works. Hand-maintained and always available, so the system produces
   * culture and environment signal even with no Confluence or Slack connected.
   */
  companyProfile: string;
  stackProfile: StackProfile;
  scenarios: Scenario[];
  /** Provenance for auditing — doc titles only, never bodies or URLs. */
  sourceSummary: { source: string; documentCount: number }[];
  /** Set true only after validate.ts passes and a human approves. */
  approved: boolean;
}

/** A single thing the redactor found and removed. */
export interface Finding {
  rule: string;
  /** Truncated sample, for the audit log. Never the full secret. */
  sample: string;
  count: number;
}

export interface ValidationResult {
  passed: boolean;
  findings: Finding[];
  /** Free-text reasoning from the adversarial LLM leak check. */
  llmVerdict?: string;
}
