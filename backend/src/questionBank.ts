import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import * as fs from "fs";
import * as path from "path";
import { bedrockClient, GENERATION_MODEL_ID, extractJson } from "./bedrock";
import { ContextPack } from "./contextPack/types";

/**
 * Question bank generation.
 *
 * The division of responsibility, which is the whole design:
 *
 *   JD           -> which competencies to test, the seniority bar, culture criteria
 *   Resume       -> which claims to verify, which projects to drill into
 *   Context Pack -> what the scenarios testing those competencies are MADE OF
 *   Duration     -> how many probes actually fit
 *
 * The pack is the setting, never the syllabus. A candidate is never asked to
 * recall something internal — they are asked to reason about a problem shaped
 * like the ones this org actually has. That is what a generic interviewer
 * cannot do, and it is also what keeps the interview fair.
 */

const PACK_PATH = path.join(__dirname, "contextPack", "context-pack.json");

export type InterviewDuration = 5 | 15 | 30 | 45;

/** Fixed axes keep candidates comparable; generated axes keep the role honest. */
export const FIXED_RUBRIC_AXES = [
  "Project Depth",
  "Technical Knowledge",
  "Problem-Solving Mindset",
  "Stack Fit",
  "Communication",
] as const;

export interface RubricAxis {
  name: string;
  /** Why this axis matters for THIS role. */
  rationale: string;
  /** JD-relative: what a 4/5 looks like for an intern differs from a staff hire. */
  strongSignal: string;
  weakSignal: string;
  generated: boolean;
}

export interface BankQuestion {
  id: string;
  /** resume_probe verifies a claim; scenario tests reasoning; jd_gap covers a stated requirement. */
  kind: "resume_probe" | "scenario" | "jd_gap";
  question: string;
  /** What this question is actually trying to find out. */
  intent: string;
  /** Rubric axes this question feeds. */
  axes: string[];
  /** Asked only if the first answer is strong. */
  escalations: string[];
  /** Asked if the candidate is struggling — keeps the interview humane. */
  fallback?: string;
  strongAnswer: string[];
  weakAnswer: string[];
  /** Scenario id from the Context Pack, when this question came from one. */
  scenarioId?: string;
  /** Budgeted minutes, so the interviewer can pace itself. */
  minutes: number;
}

export interface QuestionBank {
  generatedAt: string;
  role: string;
  seniority: string;
  durationMinutes: InterviewDuration;
  rubric: RubricAxis[];
  questions: BankQuestion[];
  /** Claims on the resume that the JD cares about — drives the gap matrix. */
  claimsToVerify: { claim: string; jdRequirement: string }[];
  /** Requirements with no supporting resume evidence — the interview must probe these. */
  unevidencedRequirements: string[];
  openingLine: string;
}

/** How much actually fits. A 15-minute interview that tries to do six things does none. */
const DURATION_PLAN: Record<InterviewDuration, { projects: number; scenarios: number; gaps: number }> = {
  // 5 is a demo/taster length: one claim to verify, one problem to reason about.
  5: { projects: 1, scenarios: 1, gaps: 0 },
  15: { projects: 1, scenarios: 1, gaps: 1 },
  30: { projects: 2, scenarios: 2, gaps: 1 },
  45: { projects: 2, scenarios: 3, gaps: 2 },
};

export function loadContextPack(): ContextPack | null {
  if (!fs.existsSync(PACK_PATH)) return null;

  const pack: ContextPack = JSON.parse(fs.readFileSync(PACK_PATH, "utf8"));

  // An unapproved pack is treated as absent. Sanitization passing is not the
  // same as a human having looked at it, and only the human decides.
  if (!pack.approved) {
    console.warn(
      "[questionBank] Context pack exists but is not approved — generating without org grounding. " +
        "Run `npm run pack:build -- --approve` after reviewing it."
    );
    return null;
  }

  return pack;
}

function buildSystemPrompt(pack: ContextPack | null, plan: { projects: number; scenarios: number; gaps: number }, duration: InterviewDuration): string {
  const packSection = pack
    ? `
ORG CONTEXT — the environment this role works in.
${pack.companyProfile ? `\nCOMPANY PROFILE (public-safe; use for tone and for judging whether someone's way of working would translate here — never quiz them on it):\n${pack.companyProfile}\n` : ""}
Technical profile:
${JSON.stringify(pack.stackProfile, null, 2)}

Available scenarios (already sanitized; use these as the raw material for "scenario" questions):
${JSON.stringify(
  pack.scenarios.map((s) => ({
    id: s.id,
    title: s.title,
    stack: s.stack,
    constraints: s.constraints,
    prompt: s.prompt,
    probes: s.probes,
    strongAnswer: s.strongAnswer,
    weakAnswer: s.weakAnswer,
    difficulty: s.difficulty,
  })),
  null,
  2
)}

USING THE SCENARIOS
- Choose scenarios whose difficulty matches the seniority in the JD. Difficulty 0-1 for intern/junior, 2-3 for mid/senior, 3-4 for staff/lead.
- Adapt the wording so it reads as a natural interview question, but do not invent technical detail that is not in the scenario.
- Set "scenarioId" to the scenario you drew from.
- NEVER imply the candidate should already know this system. Pose it as a problem to reason about, not knowledge to recall.
`
    : `
NO ORG CONTEXT AVAILABLE. Generate scenario questions from the technologies named in the JD instead. Keep them concrete and situational rather than trivia.
`;

  return `You are a thoughtful engineer designing a Round-0 SCREENING conversation.

WHAT THIS IS, AND WHAT IT IS NOT
This is the first conversation a candidate has, replacing a non-technical phone screen. Later rounds do the deep technical assessment. Your job is narrow:

  Does this person actually know what their resume claims?
  Are they worth an engineer's hour in the next round?

That is the whole bar. You are NOT deciding whether to hire them, and you are NOT running a senior-level technical gauntlet. A screening round that feels like an interrogation makes good candidates withdraw, and losing good candidates is a far more expensive failure than advancing a mediocre one — the next round catches those anyway.

CALIBRATE ACCORDINGLY
- Questions should be answerable by someone who genuinely did the work on their resume, and hard to answer convincingly by someone who did not. That contrast is the entire signal.
- Ask about what they claim, not about everything the role could conceivably touch.
- Do NOT design questions whose purpose is to find the edge of someone's knowledge. Finding the edge is the next round's job.
- A missing skill is not a failure. People learn on the job. Only test what the role genuinely requires from day one.
- Keep the tone warm and collegial. This is a conversation between engineers, not an examination.
${packSection}

DURATION: ${duration} minutes. Generate exactly ${plan.projects} resume_probe question(s), ${plan.scenarios} scenario question(s), and ${plan.gaps} jd_gap question(s). Budget minutes per question so the total fits ${duration} minutes including a brief intro and wrap-up. Do not exceed the budget — an interview that runs long gets cut off mid-answer and wastes the whole session.

RUBRIC
Always include these five fixed axes, so candidates stay comparable across roles:
${FIXED_RUBRIC_AXES.map((a) => `  - ${a}`).join("\n")}
Then add 1-2 axes generated from THIS job description specifically (for example a leadership role might need "Technical Mentorship"; an internship might need "Learning Velocity"). Mark generated axes with "generated": true.

CALIBRATE THE BAR TO THE JD. A 4/5 for an intern and a 4/5 for a staff engineer are completely different standards. Write strongSignal and weakSignal for the seniority this JD is actually hiring at. Read the JD carefully: a leadership role may barely mention coding, and testing it on algorithms would be a failure of the interview, not of the candidate.

WRITE SIGNALS THAT A SCREEN CAN ACTUALLY OBSERVE. strongSignal must describe something demonstrable in a short conversation — "can explain a tradeoff they rejected and why" — not something that needs a work sample or a reference check. If an axis cannot be observed in ${duration} minutes, do not include it.

CULTURE CRITERIA COME FROM THE JD. If the JD describes working style — comfort with ambiguity, context-switching, mentoring, giving hard feedback — turn that into an assessable axis. Do not invent culture criteria the JD does not state. Frame these as "how they work", never as personality. Keep at most one such axis: a screening call gives thin evidence about working style, and over-weighting it produces confident nonsense.

QUESTION DESIGN
- resume_probe: pick the most substantial thing on the resume and test whether they actually own it. Someone who did the work can explain a decision they rejected; someone narrating a README cannot.
- scenario: reasoning under realistic constraints, drawn from the org context.
- jd_gap: cover a stated requirement the resume gives no evidence for.
- Every question needs escalations (asked when the answer is strong) and ideally a fallback (a simpler angle if they are struggling).
- strongAnswer/weakAnswer must be specific enough to grade against later. "Good understanding" is useless; "identifies that the pool must close idle connections before the server does" is gradable.

Return ONLY a JSON object:
{
  "role": "...",
  "seniority": "intern|junior|mid|senior|staff|lead",
  "rubric": [{"name","rationale","strongSignal","weakSignal","generated"}],
  "questions": [{"id","kind","question","intent","axes","escalations","fallback","strongAnswer","weakAnswer","scenarioId","minutes"}],
  "claimsToVerify": [{"claim","jdRequirement"}],
  "unevidencedRequirements": ["..."],
  "openingLine": "TWO SENTENCES MAXIMUM. Greet them and say what the next N minutes hold. Nothing else — no reassurance about trick questions, no explanation of the format, no invitation to think out loud. This is spoken aloud, and every second here is a second the candidate does not get to answer in."
}`;
}

/**
 * Coerces a field that should be a list into one.
 *
 * Models are inconsistent about list-shaped fields: sometimes an array,
 * sometimes a single string, sometimes a newline- or semicolon-delimited blob.
 * Every consumer downstream calls .join() or .map(), so normalising once here
 * beats defensive checks scattered across the evaluator and the renderer.
 */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/\n|;/)
      .map((s) => s.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function normaliseQuestion(q: any, index: number): BankQuestion {
  return {
    id: q?.id || `q${index + 1}`,
    kind: ["resume_probe", "scenario", "jd_gap"].includes(q?.kind) ? q.kind : "scenario",
    question: String(q?.question || "").trim(),
    intent: String(q?.intent || "").trim(),
    axes: toList(q?.axes),
    escalations: toList(q?.escalations),
    fallback: q?.fallback ? String(q.fallback) : undefined,
    strongAnswer: toList(q?.strongAnswer),
    weakAnswer: toList(q?.weakAnswer),
    scenarioId: q?.scenarioId ? String(q.scenarioId) : undefined,
    minutes: Number(q?.minutes) || 5,
  };
}

function normaliseAxis(a: any): RubricAxis {
  return {
    name: String(a?.name || "Unnamed"),
    rationale: String(a?.rationale || ""),
    strongSignal: toList(a?.strongSignal).join(" ") || String(a?.strongSignal || ""),
    weakSignal: toList(a?.weakSignal).join(" ") || String(a?.weakSignal || ""),
    generated: Boolean(a?.generated),
  };
}

/** Intro plus wrap-up. Real minutes the questions never get. */
const OVERHEAD_MINUTES_BY_DURATION: Record<InterviewDuration, number> = {
  5: 1,
  15: 3,
  30: 4,
  45: 5,
};

/**
 * Keeps the interview inside its slot.
 *
 * The model reliably over-allocates — it asked for 35 minutes of questions in a
 * 30 minute interview on the first real run. Rather than reject the bank, scale
 * the per-question budgets down proportionally. Running over doesn't produce a
 * longer interview, it produces one that gets cut off mid-answer, which wastes
 * the most valuable question in the set.
 */
function fitBudget(questions: BankQuestion[], duration: InterviewDuration): BankQuestion[] {
  const available = duration - OVERHEAD_MINUTES_BY_DURATION[duration];
  const requested = questions.reduce((sum, q) => sum + (q.minutes || 0), 0);
  if (requested <= available || requested === 0) return questions;

  const scale = available / requested;
  console.warn(
    `[questionBank] Trimming ${requested} min of questions to fit ${available} min ` +
      `(${duration} min interview minus ${OVERHEAD_MINUTES_BY_DURATION[duration]} min overhead).`
  );

  return questions.map((q) => ({
    ...q,
    // Never scale below 2 minutes — anything shorter cannot be asked and
    // answered, and a question you can't answer is worse than one you didn't ask.
    minutes: Math.max(2, Math.round((q.minutes || 0) * scale)),
  }));
}

export async function generateQuestionBank(opts: {
  jdText: string;
  resumeText: string;
  duration?: InterviewDuration;
}): Promise<QuestionBank> {
  const duration = opts.duration ?? 30;
  const plan = DURATION_PLAN[duration];
  const pack = loadContextPack();

  const response = await bedrockClient.send(
    new ConverseCommand({
      modelId: GENERATION_MODEL_ID,
      system: [{ text: buildSystemPrompt(pack, plan, duration) }],
      messages: [
        {
          role: "user",
          content: [
            {
              text: `=== JOB DESCRIPTION ===\n${opts.jdText.slice(0, 20000)}\n\n=== CANDIDATE RESUME ===\n${opts.resumeText.slice(0, 20000)}`,
            },
          ],
        },
      ],
      inferenceConfig: { maxTokens: 8000, temperature: 0.4 },
    })
  );

  const text = response.output?.message?.content?.[0]?.text;
  if (!text) throw new Error("Question bank generation returned an empty response.");

  const parsed = extractJson(text);
  const questions: BankQuestion[] = (parsed.questions || []).map(normaliseQuestion);

  return {
    generatedAt: new Date().toISOString(),
    role: parsed.role || "Unknown Role",
    seniority: parsed.seniority || "unknown",
    durationMinutes: duration,
    rubric: (parsed.rubric || []).map(normaliseAxis),
    questions: fitBudget(questions, duration),
    claimsToVerify: Array.isArray(parsed.claimsToVerify) ? parsed.claimsToVerify : [],
    unevidencedRequirements: toList(parsed.unevidencedRequirements),
    openingLine: parsed.openingLine || "",
  };
}

/**
 * Renders the bank into the instruction set the live voice agent runs on.
 *
 * The agent receives ONLY this. It has no retrieval tools and no connection to
 * Slack or Confluence — it cannot leak what it was never given.
 */
export function renderInterviewerPrompt(bank: QuestionBank, candidateName = "the candidate"): string {
  // The live agent gets ONLY what it needs to hold the conversation: the
  // question, how to go deeper, and how to back off.
  //
  // It deliberately does NOT receive intent, strongAnswer or weakAnswer. In
  // testing, the agent read those aloud — it told a candidate "someone who did
  // the work would mention why ClickHouse over TimescaleDB", which is handing
  // over the answer key. The grader reads those fields straight off the bank
  // afterwards, so nothing is lost by withholding them here. Same principle as
  // the Slack connection: it cannot leak what it was never given.
  const questionBlock = bank.questions
    .map(
      (q, i) => `
${i + 1}. [~${q.minutes} min] ${q.question}${
        q.escalations.length
          ? `\n   If they answer this well, follow up with: ${q.escalations.join(" / ")}`
          : ""
      }${q.fallback ? `\n   If they are struggling, try instead: ${q.fallback}` : ""}`
    )
    .join("\n");

  return `You are Sarah Chen, a senior engineer conducting a ${bank.durationMinutes}-minute Round-0 screening interview for a ${bank.role} position (${bank.seniority} level).

The candidate's name is ${candidateName}. Greet them by name and use it naturally once or twice — not in every turn, which sounds robotic.

HOW TO OPEN
${bank.openingLine}

YOUR QUESTIONS — work through these in order. Ask them as written, in your own voice. Everything in this list is for you alone; never read the bracketed timings or the follow-up notes aloud, and never tell the candidate what you are hoping to hear.
${questionBlock}

HOW TO CONDUCT THIS

KEEP YOUR TURNS SHORT. This is the single most important instruction. Two or three sentences, then stop talking. You are on a voice call — a thirty-second monologue is unbearable to sit through and burns interview time the candidate needs for answering. Ask the question and stop. Do not preamble, do not restate the question a second way, do not explain why you are asking.

- You have ${bank.durationMinutes} minutes total. Watch your pacing. Spending several minutes on the intro and rushing the technical questions is the most common way this interview fails.
- Ask ONE question at a time, then stop and listen. Never stack multiple questions into one turn.
- Do not read the scenario setup verbatim if it is long — compress it to the essentials and let the candidate ask for detail.
- Adapt. If an answer is strong, use the escalation and go deeper. If they are floundering, use the fallback or move on — grinding someone down produces no signal and is unpleasant.
- Probe vague answers once: "can you be more specific about how you did that?" Accept the second answer and move on.
- Stay conversational. This is a discussion between engineers, not an interrogation. Brief acknowledgements are fine; long monologues are not.
- NEVER state what you are assessing, what a good answer contains, or what you were hoping they would say — not before, during, or after a question. If they ask how they did, say the team will follow up.
- If the candidate asks about internal systems, company specifics, or anything you were not given, say you cannot go into detail and return to the question. You genuinely do not have that information.
- Close by thanking them and telling them the team will follow up.

IMPORTANT: You are gathering evidence for a human hiring manager. You are not making a hire decision, and you must never tell the candidate how they did.`;
}
