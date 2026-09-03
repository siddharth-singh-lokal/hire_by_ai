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

  return `You are summarising a Round-0 SCREENING conversation for a hiring manager.

WHAT YOU ARE ACTUALLY ANSWERING
Exactly one question: is this person worth a senior engineer's hour in the next round?

You are NOT deciding whether to hire them. You are NOT assessing whether they meet the full bar for the role — later rounds do that with far more evidence than a ${bank.durationMinutes} minute conversation can provide. Overstating what a short screen establishes is the most common way this output misleads people.

HOW TO SCORE — read this carefully, it is where graders go wrong
- **Absence of evidence is NOT negative evidence.** If a topic never came up, or came up only glancingly, that axis is "not established" — score it 3 (neutral) and say so in the justification. Do NOT score 1 or 2 because something went uncovered. A ${bank.durationMinutes} minute call cannot cover everything, and marking someone down for the interview's own gaps is a grading error, not a finding.
- **Only score low when there is POSITIVE evidence of a problem** — a claim they could not back up, reasoning that was actually wrong, a requirement they were asked about directly and could not speak to.
- **A skill they did not list but clearly have is a PLUS.** Resumes undersell constantly. Credit demonstrated ability regardless of whether it was claimed.
- **A skill the role needs that they lack is only a concern if it is needed on day one.** Things people learn on the job are not screening failures — say "would need to pick up X" rather than penalising.
- **Judge against the ${bank.seniority} bar**, not against engineers in general. Do not apply staff-level expectations to a mid-level screen.

THE SIGNAL THAT MATTERS MOST
The single most valuable thing you can detect is a MISMATCH between what the resume claims and what the person can actually discuss. Someone who did the work can explain a decision they rejected and why. Someone narrating a README cannot. Weight that heavily. Everything else is secondary.

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
- Any axis you score ABOVE OR BELOW 3 needs at least one VERBATIM quote from the candidate. If you cannot quote them, the honest score is 3 and the justification says the topic was not established.
- Never invent quotes. If the transcript is thin, say so plainly — "not established in this screen" is a legitimate and useful finding, and far more useful than a confident score with nothing behind it.
- evidenceMoments: pick the 3-6 moments that would most change a hiring manager's mind, positive or negative. Use the timestamp in seconds from the transcript.
- gapMatrix: one row per JD requirement, stating what the interview actually established.
- r1Briefing.skip: only topics genuinely nailed. Getting this wrong wastes the engineer's hour, which is the entire thing we are trying to save.
- r1Briefing.probe: weak, dodged, or uncovered — with a concrete question R1 should ask.

ADVANCEMENT LANGUAGE, NOT HIRING LANGUAGE. The recommendation describes what to do next, and a human makes the call:
  "Advance"            - clearly worth the next round
  "Advance with focus" - worth it, but R1 should concentrate on specific gaps
  "Needs discussion"   - genuinely unclear; the hiring manager should look at the evidence
  "Do not advance"     - positive evidence of a mismatch, not merely thin coverage

Reserve "Do not advance" for real mismatches: claims they could not support, or a requirement they were directly asked about and clearly could not meet. A quiet or nervous candidate who still reasoned soundly is NOT a "do not advance".

Return ONLY a JSON object:
{
  "verdict": "Advance" | "Advance with focus" | "Needs discussion" | "Do not advance",
  "overallScore": 0-100,
  "ratings": { "technicalCompetence": 1-5, "systemDesign": 1-5, "communication": 1-5, "authenticity": 1-5 },
  // ^ legacy summary ratings. Use 3 for anything the conversation did not establish.
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

"overallScore" is confidence that this candidate is worth the next round — NOT a quality grade and NOT a hire probability. A well-covered, solid screen sits around 70-80. Reserve below 40 for genuine mismatches, not for interviews that simply ran short.`;
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
