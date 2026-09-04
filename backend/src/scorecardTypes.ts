/**
 * Advancement language, not hiring language. The AI never decides a hire — it
 * says what should happen next and a human makes the call.
 */
export type VerdictType =
  | "Advance"
  | "Advance with focus"
  | "Needs discussion"
  | "Do not advance";

export interface ScorecardEvaluation {
  verdict: VerdictType;
  overallScore: number; // 0 - 100
  ratings: {
    technicalCompetence: number; // 1 - 5
    systemDesign: number; // 1 - 5
    communication: number; // 1 - 5
    authenticity: number; // 1 - 5
  };
  summary: string;
  recommendationReason: string;
  keyStrengths: {
    title: string;
    explanation: string;
    evidenceQuote?: string;
  }[];
  redFlags: {
    title: string;
    explanation: string;
    evidenceQuote?: string;
  }[];
  directQuotes: {
    competency: string;
    quote: string;
    analysis: string;
    impact: "positive" | "negative" | "neutral";
  }[];
  projectAssessments: {
    projectName: string;
    rating: number; // 1 - 5
    strengthsObserved: string[];
    unresolvedConcerns: string[];
  }[];
  durationSeconds: number;
  evaluatedAt: string;
  evaluationMode: "realtime_llm" | "offline_simulation";
  modelUsed?: string;
}

/**
 * Additions for the org-grounded flow.
 *
 * The original scorecard had four fixed ratings. Those are kept so older
 * sessions still render, but a bank-driven interview grades against the rubric
 * the bank generated — which differs per role — plus two outputs aimed squarely
 * at saving the hiring manager time.
 */

/** Score against one generated rubric axis, with the evidence behind it. */
export interface AxisScore {
  axis: string;
  score: number; // 1 - 5, calibrated to the JD's seniority
  justification: string;
  /** Verbatim candidate quotes supporting the score. */
  evidence: string[];
}

/** Timestamped moment worth a recruiter's attention. */
export interface EvidenceMoment {
  timeInSeconds: number;
  speaker: "candidate" | "interviewer";
  quote: string;
  significance: string;
  impact: "positive" | "negative" | "neutral";
}

/** The hand-off: what the human interviewer should do with their hour. */
export interface R1Briefing {
  /** Covered convincingly — re-asking wastes the engineer's time. */
  skip: { topic: string; reason: string }[];
  /** Weak, dodged, or unverified — where R1 should spend its time. */
  probe: { topic: string; reason: string; suggestedQuestion: string }[];
  /** A ready-made opening line so R1 starts warm, not cold. */
  suggestedOpener: string;
}

/** JD requirement vs. what the interview actually established. */
export interface GapMatrixRow {
  requirement: string;
  status: "evidenced" | "partial" | "unevidenced" | "contradicted";
  finding: string;
}

/** Per-question validation: was the candidate's answer substantively correct? */
export type AnswerAccuracy =
  | "correct"
  | "mostly_correct"
  | "partial"
  | "incorrect"
  | "not_established";

export interface QuestionAnswerReview {
  questionId: string;
  kind: string;
  question: string;
  accuracy: AnswerAccuracy;
  /** One-line recruiter summary. */
  summary: string;
  whatTheyGotRight: string[];
  gapsOrErrors: string[];
  candidateQuote?: string;
}

export interface GroundedScorecard extends ScorecardEvaluation {
  candidateName: string;
  role: string;
  seniority: string;
  axisScores: AxisScore[];
  evidenceMoments: EvidenceMoment[];
  r1Briefing: R1Briefing;
  gapMatrix: GapMatrixRow[];
  /** Question-by-question answer validation against the bank. */
  questionReviews?: QuestionAnswerReview[];
  /** True when questions were grounded in the org Context Pack. */
  orgGrounded: boolean;
  /**
   * Whether the platform, rather than the candidate, shaped this transcript.
   * "compromised" means the recruiter should read the verdict as provisional.
   */
  screenQuality?: "clean" | "degraded" | "compromised";
  rescreenRecommended?: boolean;
  screenQualityNote?: string;
  /** Voice-stream drops during the call, as counted by the relay. */
  streamDrops?: number;
}
