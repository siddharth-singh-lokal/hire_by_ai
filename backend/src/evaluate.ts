import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, EVALUATION_MODEL_ID, AWS_REGION, extractJson } from "./bedrock";
import { QuestionBank } from "./questionBank";
import { GroundedScorecard } from "./scorecardTypes";

/**
 * Grades a completed interview against the rubric its question bank generated.
 *
 * Two design commitments show up in the prompt:
 *
 *  1. EVIDENCE OVER SCORES. A hiring manager will not trust "7.4/10", but they
 *     will trust ninety seconds of transcript. Every score must cite verbatim
 *     quotes; a score without evidence is treated as a failure of the grader,
 *     not a fact about the candidate.
 *
 *  2. THE R1 BRIEFING IS THE POINT. The output that actually saves engineer
 *     hours is "skip this, probe that, open with this" — it makes the human
 *     round shorter AND better. Everything else is supporting material.
 */

interface EvaluateInput {
  bank: QuestionBank;
  candidateName: string;
  transcripts: { sender: string; text: string; timestamp?: number }[];
  durationSeconds: number;
  redFlags: { type: string; description: string; timeInSeconds: number }[];
  orgGrounded: boolean;
}

function buildPrompt(input: EvaluateInput): string {
  const { bank, redFlags } = input;

  return `You are a hiring bar-raiser grading a Round-0 screening interview.

Your output is NOT a decision. It is evidence a hiring manager uses to decide whether to spend a senior engineer's hour on this candidate. Never recommend rejecting or hiring outright — describe what was demonstrated and what remains unknown.

ROLE: ${bank.role} (${bank.seniority} level), ${bank.durationMinutes} minute screen.

THE RUBRIC THIS INTERVIEW WAS DESIGNED AGAINST — score every axis:
${bank.rubric
  .map(
    (a) =>
      `- ${a.name}${a.generated ? " [role-specific]" : ""}\n    strong: ${a.strongSignal}\n    weak: ${a.weakSignal}`
  )
  .join("\n")}

CALIBRATION: these bars are written for a ${bank.seniority} hire. Score against THAT standard, not against engineers in general. A strong intern answer and a strong staff answer look nothing alike, and penalising an intern for not reasoning like a staff engineer is a grading error.

WHAT WAS ASKED, AND WHAT GOOD LOOKED LIKE:
${bank.questions
  .map(
    (q, i) =>
      `${i + 1}. [${q.kind}] ${q.question}\n   intent: ${q.intent}\n   strong: ${q.strongAnswer.join("; ")}\n   weak: ${q.weakAnswer.join("; ")}`
  )
  .join("\n")}

JD REQUIREMENTS WITH NO RESUME EVIDENCE (the interview was meant to probe these):
${bank.unevidencedRequirements.map((r) => `- ${r}`).join("\n") || "(none)"}

RESUME CLAIMS THE INTERVIEW WAS MEANT TO VERIFY:
${bank.claimsToVerify.map((c) => `- "${c.claim}" (relevant to: ${c.jdRequirement})`).join("\n") || "(none)"}

${
  redFlags.length
    ? `PROCTORING INCIDENTS — integrity signal ONLY. Factor into authenticity and mention in redFlags where warranted. Do NOT let these lower technical or reasoning scores; an unexplained tab switch says nothing about whether someone understands connection pooling:
${redFlags.map((f) => `- [${f.type}] at ${f.timeInSeconds}s: ${f.description}`).join("\n")}`
    : "PROCTORING: no incidents recorded."
}

RULES
- Every axis score needs at least one VERBATIM quote from the candidate. If you cannot quote them, the score must be low-confidence and you must say the topic went uncovered.
- Never invent quotes. If the transcript is thin, say so plainly — "insufficient evidence" is a legitimate and useful finding.
- evidenceMoments: pick the 3-6 moments that would most change a hiring manager's mind, positive or negative. Use the timestamp in seconds from the transcript.
- gapMatrix: one row per JD requirement, stating what the interview actually established.
- r1Briefing.skip: only topics genuinely nailed. Getting this wrong wastes the engineer's hour, which is the entire thing we are trying to save.
- r1Briefing.probe: weak, dodged, or uncovered — with a concrete question R1 should ask.

Return ONLY a JSON object:
{
  "verdict": "Strong Hire" | "Hire" | "Borderline" | "Reject",
  "overallScore": 0-100,
  "ratings": { "technicalCompetence": 1-5, "systemDesign": 1-5, "communication": 1-5, "authenticity": 1-5 },
  "axisScores": [{ "axis", "score": 1-5, "justification", "evidence": ["verbatim quote"] }],
  "summary": "what this interview established, for a hiring manager",
  "recommendationReason": "1-2 sentences on what to do next and why",
  "keyStrengths": [{ "title", "explanation", "evidenceQuote" }],
  "redFlags": [{ "title", "explanation", "evidenceQuote" }],
  "directQuotes": [{ "competency", "quote", "analysis", "impact": "positive"|"negative"|"neutral" }],
  "evidenceMoments": [{ "timeInSeconds", "speaker": "candidate"|"interviewer", "quote", "significance", "impact" }],
  "gapMatrix": [{ "requirement", "status": "evidenced"|"partial"|"unevidenced"|"contradicted", "finding" }],
  "r1Briefing": {
    "skip": [{ "topic", "reason" }],
    "probe": [{ "topic", "reason", "suggestedQuestion" }],
    "suggestedOpener": "..."
  },
  "projectAssessments": [{ "projectName", "rating": 1-5, "strengthsObserved": [], "unresolvedConcerns": [] }]
}

"verdict" means "how strong is the case for advancing", not a hiring decision.`;
}

export async function evaluateInterview(input: EvaluateInput): Promise<GroundedScorecard> {
  // Relative timestamps let the scorecard link a quote to a point in the recording.
  const start = input.transcripts[0]?.timestamp ?? 0;
  const transcript = input.transcripts
    .map((t) => {
      const at = t.timestamp ? Math.max(0, Math.round((t.timestamp - start) / 1000)) : 0;
      const who = t.sender === "candidate" ? input.candidateName : "Interviewer";
      return `[${at}s] ${who}: ${t.text}`;
    })
    .join("\n");

  const response = await bedrockClient.send(
    new ConverseCommand({
      modelId: EVALUATION_MODEL_ID,
      system: [{ text: buildPrompt(input) }],
      messages: [
        { role: "user", content: [{ text: `=== INTERVIEW TRANSCRIPT ===\n\n${transcript}` }] },
      ],
      inferenceConfig: { maxTokens: 8000, temperature: 0.2 },
    })
  );

  const text = response.output?.message?.content?.[0]?.text;
  if (!text) throw new Error("Evaluation returned an empty response.");

  const parsed = extractJson(text);

  return {
    ...parsed,
    candidateName: input.candidateName,
    role: input.bank.role,
    seniority: input.bank.seniority,
    axisScores: parsed.axisScores || [],
    evidenceMoments: parsed.evidenceMoments || [],
    gapMatrix: parsed.gapMatrix || [],
    r1Briefing: parsed.r1Briefing || { skip: [], probe: [], suggestedOpener: "" },
    orgGrounded: input.orgGrounded,
    durationSeconds: input.durationSeconds,
    evaluatedAt: new Date().toISOString(),
    evaluationMode: "realtime_llm",
    modelUsed: `${EVALUATION_MODEL_ID} (Amazon Bedrock, ${AWS_REGION})`,
  } as GroundedScorecard;
}

/**
 * Grades the same transcript against a generic senior-backend rubric, with no
 * org context at all.
 *
 * This exists to answer the obvious challenge — "is the org grounding doing real
 * work, or is it decoration?" Running both and showing the verdicts diverge is
 * the proof. If they never diverge, that is worth knowing too.
 */
export async function evaluateGeneric(input: {
  candidateName: string;
  role: string;
  transcripts: { sender: string; text: string }[];
}): Promise<{ verdict: string; overallScore: number; summary: string }> {
  const transcript = input.transcripts
    .map((t) => `${t.sender === "candidate" ? input.candidateName : "Interviewer"}: ${t.text}`)
    .join("\n");

  const response = await bedrockClient.send(
    new ConverseCommand({
      modelId: EVALUATION_MODEL_ID,
      system: [
        {
          text: `You are screening a ${input.role} candidate using a standard industry rubric: general technical competence, system design, coding fundamentals, and communication.

You have no information about the hiring company's stack, constraints, or engineering environment. Judge purely on general software engineering ability, as a generic screening tool would.

Return ONLY: { "verdict": "Strong Hire"|"Hire"|"Borderline"|"Reject", "overallScore": 0-100, "summary": "2-3 sentences" }`,
        },
      ],
      messages: [{ role: "user", content: [{ text: transcript }] }],
      inferenceConfig: { maxTokens: 1000, temperature: 0.2 },
    })
  );

  const text = response.output?.message?.content?.[0]?.text || "{}";
  return extractJson(text);
}
