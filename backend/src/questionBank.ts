import * as fs from "fs";
import * as path from "path";
import { GENERATION_MODEL_ID } from "./bedrock";
import { callJson } from "./llm";
import {
  researchMarketInterviewQuestions,
  formatWebResearchForPrompt,
  WebResearchResult,
  SuggestedMarketQuestion,
} from "./webInterviewResearch";
import { ContextPack } from "./contextPack/types";
import { LanguageConfig, LANGUAGES, DEFAULT_LANGUAGE } from "./languages";
import { getTaxonomyGuidance } from "./questionTaxonomy";

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
const ROLE_CONTEXT_DIR = path.join(__dirname, "contextPack", "role-context");

/**
 * Hand-written, public-safe context for the disciplines the Context Pack cannot
 * cover.
 *
 * The pack is built from engineering documents, so it only ever produces
 * backend/infra scenarios — a Product Analyst was getting connection-pooling
 * questions, which is worse than useless. PRDs and roadmaps cannot fill the gap
 * either: the sanitizer rejects business logic by design and correctly returns
 * no scenarios for them.
 *
 * So these files are authored by hand at the same trust level as
 * company-profile.md — a human wrote them, a human reviews them, and they
 * bypass sanitization because there is nothing in them to sanitize. They
 * describe the SHAPE of the work (users on low-end phones, ten languages, lossy
 * mobile events) and never a metric, a price or an experiment result.
 */
function loadRoleContext(discipline: string): string | null {
  const file = path.join(ROLE_CONTEXT_DIR, `${discipline}.md`);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export type InterviewDuration = 1 | 5 | 15 | 30 | 45;

/**
 * Fixed axes keep candidates comparable; generated axes keep the role honest.
 *
 * Two variants, because this system screens engineers AND non-engineers. Asking
 * a peer-support listener or a field sales candidate about "Stack Fit" and
 * "Technical Knowledge" produces nonsense axes and makes the whole scorecard
 * look like it was built for somebody else's job. The shape is identical so
 * candidates stay comparable within a role, which is the only comparison that
 * matters.
 */
export const FIXED_RUBRIC_AXES = [
  "Project Depth",
  "Technical Knowledge",
  "Problem-Solving Mindset",
  "Stack Fit",
  "Communication",
] as const;

const NON_TECHNICAL_RUBRIC_AXES = [
  "Depth of Experience",
  "Role Knowledge",
  "Problem-Solving Mindset",
  "Role Fit",
  "Communication",
] as const;

/**
 * People-leadership roles get their own axes. An Engineering Manager or
 * Director is not assessed on "Stack Fit" — their craft is scope, judgement and
 * delivery through others. They still need technical credibility, which is what
 * "Technical Judgement" covers.
 */
const LEADERSHIP_RUBRIC_AXES = [
  "Scope and Impact",
  "Technical Judgement",
  "Problem-Solving Mindset",
  "People and Delivery",
  "Communication",
] as const;

const TECHNICAL_DISCIPLINES = new Set(["backend", "frontend", "mobile", "devops", "data"]);

function fixedAxesFor(discipline: string): readonly string[] {
  if (discipline === "engineering_leadership") return LEADERSHIP_RUBRIC_AXES;
  return TECHNICAL_DISCIPLINES.has(discipline)
    ? FIXED_RUBRIC_AXES
    : NON_TECHNICAL_RUBRIC_AXES;
}

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
  /** resume_probe | technical | market (web/forum) | jd_gap | scenario (legacy) */
  kind: "resume_probe" | "technical" | "market" | "scenario" | "jd_gap";
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
  /** Forum/source when kind is market (LeetCode, Blind, etc.). */
  sourceName?: string;
  sourceUrl?: string;
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
  /** Résumé-vs-JD requirement coverage — also surfaced fast via /api/ats-score while generating. */
  jdCoverage: { requirement: string; status: "evidenced" | "partial" | "missing"; evidence: string }[];
  openingLine: string;
  /**
   * Discipline inferred from the JD. Kept on the bank so the live interviewer
   * can introduce herself credibly — she used to claim to be "a senior
   * engineer" while screening a field sales candidate, which reads as a system
   * that was not built for that job.
   */
  discipline?: string;
  /** Web research metadata — what was fetched from interview forums. */
  webResearch?: {
    roleHint: string;
    queries: string[];
    hitCount: number;
    fromWeb: boolean;
    sources: { site: string; title: string; url: string }[];
  };
}

/** How much actually fits. A 15-minute interview that tries to do six things does none. */
// Org "scenario" questions were removed by product decision. Interviews use
// resume_probe (verify claims), technical (JD-grounded skill/reasoning — NOT
// resume walk-throughs), and jd_gap (stated requirements the resume doesn't show).
const DURATION_PLAN: Record<
  InterviewDuration,
  { projects: number; technical: number; market: number; scenarios: number; gaps: number }
> = {
  1: { projects: 1, technical: 0, market: 0, scenarios: 0, gaps: 0 },
  5: { projects: 1, technical: 0, market: 1, scenarios: 0, gaps: 0 },
  15: { projects: 2, technical: 1, market: 1, scenarios: 0, gaps: 1 },
  30: { projects: 2, technical: 1, market: 2, scenarios: 0, gaps: 1 },
  45: { projects: 3, technical: 1, market: 2, scenarios: 0, gaps: 2 },
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

/**
 * Infers which discipline a JD is hiring for, so only relevant scenarios and
 * stack context reach the generator.
 *
 * The Context Pack is built from whatever documentation an org has, which here
 * is entirely backend infrastructure. Handing all of it to every role produced
 * connection-pooling questions for a Product Analyst — technically grounded,
 * completely useless, and it makes the whole system look broken to a
 * non-engineer.
 */
function inferDiscipline(jdText: string): string {
  const jd = jdText.toLowerCase();
  // The role is almost always in the first few lines; the rest of a JD is
  // company boilerplate. Weighting the title heavily is what stops a shared
  // "we run Kubernetes, cost-conscious infrastructure" preamble from
  // classifying every role at the company as devops — which it did, including a
  // Director of Engineering.
  const titleBlock = jdText.split(/\n/).slice(0, 6).join(" ").toLowerCase();

  /**
   * PEOPLE-LEADERSHIP FIRST, and by title only.
   *
   * An Engineering Manager's screen is about scope, delivery and people, not
   * about whichever technologies the company happens to run. Detected ahead of
   * the keyword scoring because the technical words in a leadership JD are
   * describing the environment, not the job. Staff / Principal / Tech Lead are
   * deliberately NOT here — those are individual-contributor roles and should
   * be classified by craft.
   */
  const LEADERSHIP_TITLE =
    /\b(engineering manager|em\b|director of engineering|head of engineering|vp of engineering|vice president of engineering|senior engineering manager|group engineering manager|director,? engineering|cto)\b/i;
  const MANAGES_PEOPLE =
    /(manage|managing|lead)\s+(a\s+)?(pod|team|squad|org|engineers|managers|reports|direct reports)|managing managers|leading leaders|headcount|performance.manage|hiring plan|org design/i;

  if (LEADERSHIP_TITLE.test(titleBlock) || (MANAGES_PEOPLE.test(titleBlock) && MANAGES_PEOPLE.test(jd))) {
    return "engineering_leadership";
  }

  const score = (words: string[], text: string) =>
    words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

  const KEYWORDS: Record<string, string[]> = {
    data: ["analyst", "analytics", "sql", "dashboard", "bigquery", "data science", "metrics", "reporting", "etl"],
    product: ["product manager", "product management", "prd", "roadmap", "stakeholder", "user research", "go-to-market", "product analyst"],
    design: ["designer", "figma", "ux", "ui design", "wireframe", "prototype", "visual design"],
    frontend: ["frontend", "front-end", "react", "javascript", "typescript", "css", "browser", "next.js"],
    mobile: ["android", "ios", "kotlin", "swift", "react native", "flutter", "mobile app"],
    devops: ["devops", "sre", "site reliability", "terraform", "ci/cd", "platform engineer", "observability", "on-call rotation"],
    backend: ["backend", "back-end", "api", "django", "server", "microservice", "database", "distributed", "scalab", "postgres"],
    marketing: ["marketing", "growth", "brand", "campaign", "seo", "performance marketing", "social media", "content marketing", "crm", "user acquisition", "paid media", "copywriter"],
    support: ["listener", "counsel", "peer support", "mental health", "consultation", "telecalling", "telecaller", "customer support", "customer service", "astrologer", "empathy", "helpline"],
    field: ["field sales", "field executive", "distribution", "collections", "delivery", "two-wheeler", "kirana", "retail", "on-ground", "territory", "area manager", "beat", "outlet"],
  };

  // Title hits count triple. A JD headed "Backend Engineer II" is a backend
  // role even if the boilerplate below it lists more infrastructure words.
  const TITLE_WEIGHT = 3;
  const scores: Record<string, number> = {};
  for (const [name, words] of Object.entries(KEYWORDS)) {
    scores[name] = score(words, jd) + TITLE_WEIGHT * score(words, titleBlock);
  }

  const MIN_CONFIDENCE = 2;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestName, bestScore] = ranked[0] || ["any", 0];
  if (bestScore < MIN_CONFIDENCE) return "any";
  // A genuine tie is broken by the title alone; only give up if the title is
  // silent too. Returning "any" on every tie cost a backend SDE-2 its technical
  // rubric because unrelated boilerplate happened to tie with it.
  const tied = ranked.filter(([, v]) => v === bestScore).map(([k]) => k);
  if (tied.length > 1) {
    const byTitle = tied
      .map((k) => [k, score(KEYWORDS[k], titleBlock)] as const)
      .sort((a, b) => b[1] - a[1]);
    if (byTitle[0][1] > (byTitle[1]?.[1] ?? 0)) return byTitle[0][0];
    return "any";
  }
  return bestName;
}


function buildSystemPrompt(
  pack: ContextPack | null,
  plan: { projects: number; technical: number; market: number; scenarios: number; gaps: number },
  duration: InterviewDuration,
  discipline: string,
  webResearchSection: string,
): string {
  const roleContext = loadRoleContext(discipline);
  // Only scenarios tagged for this discipline (or genuinely role-agnostic ones).
  const relevant = pack
    ? pack.scenarios.filter((sc) => {
        const tags = (sc as any).disciplines as string[] | undefined;
        if (!tags || !tags.length) return discipline === "backend"; // untagged legacy packs are backend
        return tags.includes(discipline) || tags.includes("any");
      })
    : [];

  // Org "scenario" questions are disabled (plan.scenarios === 0 for every
  // duration). When off, the pack's company profile + stack are still handed to
  // the model as BACKGROUND — for tone and to keep resume/gap questions grounded
  // in this company's reality — but the scenario list and "build a scenario
  // question" machinery are dropped entirely so none are generated.
  const useScenarios = plan.scenarios > 0;

  const packSection = !useScenarios
    ? pack
      ? `
ORG CONTEXT (BACKGROUND ONLY — use for tone and to keep your questions grounded in this company's reality. NEVER quiz the candidate on any of it, and do NOT turn it into a hypothetical "imagine you're supporting…" question).
${pack.companyProfile ? `\nCOMPANY PROFILE (public-safe):\n${pack.companyProfile}\n` : ""}
Engineering stack (background; reference only where genuinely relevant to a ${discipline} role):
${JSON.stringify(pack.stackProfile, null, 2)}
`
      : ""
    : pack && relevant.length
    ? `
ORG CONTEXT — the environment this role works in.
${pack.companyProfile ? `\nCOMPANY PROFILE (public-safe; use for tone and for judging whether someone's way of working would translate here — never quiz them on it):\n${pack.companyProfile}\n` : ""}
Engineering stack (BACKGROUND ONLY — this describes the wider engineering environment. Reference it only where it is genuinely relevant to a ${discipline} role, and never quiz the candidate on technology their role would not touch):
${JSON.stringify(pack.stackProfile, null, 2)}

Available scenarios (already sanitized; filtered to this role's discipline — use as raw material for "scenario" questions):
${JSON.stringify(
  relevant.map((s) => ({
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
- Only use a scenario whose competencies match THIS candidate's domain. The scenarios below may skew toward one kind of engineering; if none of them fit this role, do NOT force them — generate scenario questions from the JD's own field instead. A backend-infrastructure scenario is the wrong question for a frontend, mobile, or analytics candidate.
- Choose scenarios whose difficulty matches the seniority in the JD. Difficulty 0-1 for intern/junior, 2-3 for mid/senior, 3-4 for staff/lead.
- Adapt the wording so it reads as a natural interview question, but do not invent technical detail that is not in the scenario.
- Set "scenarioId" to the scenario you drew from.
- NEVER imply the candidate should already know this system. Pose it as a problem to reason about, not knowledge to recall.
`
    : pack
    ? `
COMPANY PROFILE (public-safe; use for tone only, never quiz on it):
${pack.companyProfile}

NO ROLE-RELEVANT ENGINEERING SCENARIOS AVAILABLE. The organisation's documented incident scenarios are for other disciplines and would be meaningless for a ${discipline} role — do NOT use them.${
        roleContext
          ? ` Use the ROLE CONTEXT below instead: it describes what this role actually deals with here, and your scenario questions should be shaped like those problems.`
          : ` Build scenario questions from the responsibilities and tools named in the JD itself. Keep them concrete and situational rather than trivia.`
      }
`
    : `
NO ORG CONTEXT AVAILABLE. Generate scenario questions from the technologies named in the JD instead. Keep them concrete and situational rather than trivia.
`;

  // Role context applies whether or not engineering scenarios matched, so a
  // backend candidate gets both the real incidents and the operating reality.
  const roleSection = roleContext
    ? `
ROLE CONTEXT — what a ${discipline} person actually deals with at this company. Public-safe and human-approved; it describes the SHAPE of the work, not confidential detail.

${roleContext}

USING THE ROLE CONTEXT
- Build "scenario" questions that look like the problems listed under "the kind of problem worth reasoning about". Make them concrete and situational.
- Ground them in this company's reality — users on low-end devices, many Indian languages, cost-conscious infrastructure, multi-product pods — so the question could not have come from a generic interview bank.
- NEVER quiz the candidate on this company's products, structure or history. They have not worked here. Pose a problem to reason about; unfamiliarity with the context is never a mark against them.
- Invent no numbers. Do not state metrics, revenue, prices or experiment results, and do not ask the candidate to guess any.
`
    : "";

  return `You are a thoughtful, experienced interviewer designing a Round-0 SCREENING conversation for a ${discipline === "any" ? "" : discipline + " "}role.

WHAT THIS IS, AND WHAT IT IS NOT
This is the first conversation a candidate has, replacing a non-technical phone screen. Later rounds do the deep technical assessment. Your job is narrow:

  Does this person actually know what their resume claims?
  Are they worth an hour of the next interviewer's time?

That is the whole bar. You are NOT deciding whether to hire them, and you are NOT running a deep senior-level assessment of the craft. A screening round that feels like an interrogation makes good candidates withdraw, and losing good candidates is a far more expensive failure than advancing a mediocre one — the next round catches those anyway.

CALIBRATE ACCORDINGLY
- Questions should be answerable by someone who genuinely did the work on their resume, and hard to answer convincingly by someone who did not. That contrast is the entire signal.
- Mix resume verification with standalone technical questions from the JD — a screening that is ONLY "walk me through your projects" misses whether they can think about the role's core skills.
- Do NOT design questions whose purpose is to find the edge of someone's knowledge. Finding the edge is the next round's job.
- A missing skill is not a failure. People learn on the job. Only test what the role genuinely requires from day one.
- Keep the tone warm and collegial. This is a conversation between engineers, not an examination.

STAY IN THE CANDIDATE'S DOMAIN — THIS IS CRITICAL
Read the JD and résumé to work out what this person actually does — engineering of some kind (backend, frontend, mobile, data, ML, platform, QA, security), or product, design, analytics, marketing and growth, sales and field work, operations, customer support or care. Every question must belong to THAT domain, and to the seniority the JD is hiring at.

Two failure modes to avoid, both of which tell the candidate this interview was not built for them:
- **Defaulting to engineering.** Do NOT reach for connection pools, message queues, Redis, database internals or system design unless the role is genuinely an engineering one. A marketing candidate gets marketing questions, a PM gets product questions, a support candidate gets questions about handling people.
- **Testing the wrong altitude.** A junior hire and a lead hire in the SAME discipline need completely different questions. Read the seniority off the JD. A leadership role may barely touch hands-on craft, and testing it on execution detail is a failure of the interview, not of the candidate. Conversely, asking a first-jobber to reason about organisational strategy measures nothing.
${getTaxonomyGuidance(discipline)}
${packSection}${roleSection}

DURATION: ${duration} minutes. Generate exactly ${plan.projects} resume_probe question(s), ${plan.technical} technical question(s), ${plan.market} market question(s), and ${plan.gaps} jd_gap question(s). Budget minutes per question so the total fits ${duration} minutes including a brief intro and wrap-up. Do not exceed the budget — an interview that runs long gets cut off mid-answer and wastes the whole session.
${
    plan.scenarios === 0
      ? `DO NOT create any "scenario" questions tied to org-internal incidents. Use "resume_probe", "technical", "market", and "jd_gap" as the only values for "kind".`
      : ""
  }

WHAT THIS SCREEN MUST ESTABLISH — four things, and only one of them is on the résumé

1. **Do they actually know what they claim?** The résumé is a set of assertions. Someone who did the work can explain a decision they REJECTED and why; someone who watched it happen describes what the thing does. That contrast is the highest-signal moment in a screen.
2. **Can they do the day-to-day work of THIS role?** Not the résumé's role — this one. Draw from the JD's actual responsibilities. A screen that never asks about the job is not a screen.
3. **How do they handle not knowing?** This is the most predictive signal for anyone junior, and it is invisible if every question sits inside their comfort zone. "I have not used that, but here is how I would work it out" is a STRONG answer. Confident bluffing about something they clearly have not touched is the weakest possible signal — worse than admitting the gap.
4. **Will they fit how the work actually happens here?** Judged from how they describe past work, never by asking them to self-assess ("are you a team player?" is worthless).

HOW TO DETECT AN INFLATED RÉSUMÉ — use these moves, they are what separates a screen from a reading
- **Escalate specificity.** Start general, then ask for the specific thing only a participant would know: the decision they argued about, what broke, what they measured, what they would do differently. Vagueness that survives two follow-ups is the finding.
- **Ask in the present tense, not the past.** "If you were rebuilding that today, what would you change and why?" beats "why did you choose X over Y" — the second one punishes everyone who was not the decision-maker, which is most juniors and most engineers at service companies. A reply of "that wasn't my call, but the constraint we had was ___" is a GOOD answer.
- **Cap the depth.** Two to three follow-ups on a topic, then move on, and apply the same cap to every candidate. Escalating until someone fails is a known bias that produces false negatives and tells you nothing you did not already know after the second probe.
- **Ask about the failure, not the success.** "What went wrong and how did you find out" cannot be answered from a README.
- **Never accept a keyword as evidence.** If they name a tool, ask what it actually did for them in that project.
- Do all of this warmly. The goal is to let a real practitioner shine, not to catch someone out — an interrogation makes good candidates withdraw.
- **Never quiz on anything the résumé does not claim.** No trivia, no definitional recall, no gotchas, no algorithm puzzles — this is a voice call, and a rote oral-exam style round measures nothing useful.

WHAT MISPRONUNCIATION IS NOT
A garbled tool name, a nervous slip, or an unusual-looking stack is accent and memory, not dishonesty. The only real signal is a candidate who, after two or three focused follow-ups, still cannot add anything beyond what is written on the résumé. Design the questions so that distinction is what surfaces.

TWO QUESTIONS THAT EARN THEIR SLOT FOR JUNIOR AND INTERN ROLES
- **Expectation realism.** For any intern, fresher or junior, include or fold in "what do you think this job involves day to day?". Candidates who cannot answer it tend to leave within months once they find out, which is the actual risk this screen exists to catch — and it cannot be crammed for.
- **Ownership under failure.** One question about something that went wrong: a bug they shipped, a call they got wrong, a time they were corrected. Everyone has one. What you are grading is whether they own it or deflect, because that is what predicts working with them. Give them a beat, and offer an easier angle if they blank — some people genuinely cannot produce one on demand.

INTERVIEW SHAPE — never let this become a résumé read-back
- Do NOT make every question a résumé walk-through. That is the most common way this interview fails: the candidate narrates their CV for five minutes and you learn nothing you could not have read.
${
  plan.market > 0
    ? `- Include exactly ${plan.market} question(s) with kind "market", grounded in the WEB-GROUNDED section below.`
    : `- Do NOT use the "market" kind at all. There is no verified web grounding for this role, and a "commonly asked on Blind" label with nothing behind it is a false citation. Use "technical" instead.`
}
${webResearchSection}

RUBRIC
Always include these five fixed axes, so candidates stay comparable across roles:
${fixedAxesFor(discipline).map((a) => `  - ${a}`).join("\n")}
Then add 1-2 axes generated from THIS job description specifically (for example a leadership role might need "Technical Mentorship"; an internship might need "Learning Velocity"). Mark generated axes with "generated": true.

CALIBRATE THE BAR TO THE JD. A 4/5 for an intern and a 4/5 for a staff engineer are completely different standards. Write strongSignal and weakSignal for the seniority this JD is actually hiring at. Read the JD carefully: a leadership role may barely mention coding, and testing it on algorithms would be a failure of the interview, not of the candidate.

WRITE SIGNALS THAT A SCREEN CAN ACTUALLY OBSERVE. strongSignal must describe something demonstrable in a short conversation — "can explain a tradeoff they rejected and why" — not something that needs a work sample or a reference check. If an axis cannot be observed in ${duration} minutes, do not include it.

CULTURE CRITERIA COME FROM THE JD. If the JD describes working style — comfort with ambiguity, context-switching, mentoring, giving hard feedback — turn that into an assessable axis. Do not invent culture criteria the JD does not state. Frame these as "how they work", never as personality. Keep at most one such axis: a screening call gives thin evidence about working style, and over-weighting it produces confident nonsense.

QUESTION DESIGN
- resume_probe: pick the most substantial thing on the resume and test whether they actually own it. Someone who did the work can explain a decision they rejected; someone narrating a README cannot. Use several of these, each on a DIFFERENT project/claim, so the interview covers the breadth of what they've done rather than drilling one thing to death.
- technical: test a core skill the JD requires — reasoning, tradeoffs, debugging approach, or how they'd solve a realistic problem in this role's domain. Draw from JD responsibilities and required tools/skills, NOT from the resume.
${plan.market > 0 ? '- market: a question commonly reported for this role on public interview forums (LeetCode Discuss, Blind, Glassdoor). Use the WEB-GROUNDED section. Voice-conversation depth only — not live coding. Set sourceName to the forum (e.g. "Blind") when known; never read URLs aloud.\n' : ""}
${plan.scenarios ? "- scenario: reasoning under realistic constraints, drawn from the org context.\n" : ""}- jd_gap: cover a stated requirement the résumé gives no evidence for. Ask directly about their experience with it, NOT as a hypothetical. **This is also where you assess LEARNING ABILITY, which is the point of the question.** If they have not done it, follow with how they would get up to speed — what they would read, who they would ask, how they would verify they had it right — and grade THAT. A candidate missing a day-two skill who describes a credible way to acquire it is a good screening outcome. Someone who bluffs familiarity they do not have is a bad one, regardless of the skill.
- Every question needs escalations (asked when the answer is strong) and ideally a fallback (a simpler angle if they are struggling).
- Make at least ONE escalation across the whole set push just past what the résumé evidences — a "what would you do if" that they probably have not faced. Its purpose is not to test knowledge but to see how they behave at the edge of it: reason out loud, ask a clarifying question, say they do not know and how they would find out, or bluff. Grade the behaviour.
- Fallbacks matter as much as escalations. A candidate who is struggling and gets no easier angle produces no signal at all, and that is a wasted interview rather than a negative finding.
- strongAnswer/weakAnswer must be specific enough to grade against later. "Good understanding" is useless; "identifies that the pool must close idle connections before the server does" is gradable.

JD COVERAGE — a resume-vs-JD read the recruiter sees alongside the plan.
Every JD emphasises different things; do NOT treat the résumé as a keyword checklist. Judge domain fit and whether past work TRANSFERS to this role.

Extract 5-8 material themes (domain/industry, seniority scope, core competencies) — not every JD bullet. For each:
- "evidenced": clearly demonstrated on the résumé (name the line/claim).
- "partial": same kind of work in a different stack, company, or sub-domain; adjacent industry; or thinner scope at comparable seniority. Use partial generously — different tooling in the same problem space is partial, not missing.
- "missing": genuinely no adjacent signal in their work history — not merely an unstated keyword.
Be fair: absence on a résumé is neutral, something the interview establishes. This is judged from documents only.

Return ONLY a JSON object:
{
  "role": "...",
  "seniority": "intern|junior|mid|senior|staff|lead",
  "rubric": [{"name","rationale","strongSignal","weakSignal","generated"}],
  "questions": [{"id","kind","question","intent","axes","escalations","fallback","strongAnswer","weakAnswer","scenarioId","sourceName","sourceUrl","minutes"}],
  "claimsToVerify": [{"claim","jdRequirement"}],
  "unevidencedRequirements": ["..."],
  "jdCoverage": [{"requirement": "a material requirement from the JD, in plain words", "status": "evidenced|partial|missing", "evidence": "the resume claim that supports it (quote or paraphrase), or a short note on why it is a gap"}],
  "openingLine": "TWO SENTENCES MAXIMUM. Address the candidate ONLY as the literal token {{name}} — never a real name. The name on the resume is often not what the candidate goes by, and the system substitutes the correct one at call time. Greet them and say what the next N minutes hold. Nothing else — no reassurance about trick questions, no explanation of the format, no invitation to think out loud. This is spoken aloud, and every second here is a second the candidate does not get to answer in."
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
    kind: ["resume_probe", "technical", "market", "scenario", "jd_gap"].includes(q?.kind)
      ? q.kind
      : "resume_probe",
    question: String(q?.question || "").trim(),
    intent: String(q?.intent || "").trim(),
    axes: toList(q?.axes),
    escalations: toList(q?.escalations),
    fallback: q?.fallback ? String(q.fallback) : undefined,
    strongAnswer: toList(q?.strongAnswer),
    weakAnswer: toList(q?.weakAnswer),
    scenarioId: q?.scenarioId ? String(q.scenarioId) : undefined,
    sourceName: q?.sourceName ? String(q.sourceName) : undefined,
    sourceUrl: q?.sourceUrl ? String(q.sourceUrl) : undefined,
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
  1: 0,
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

function suggestedToBankQuestion(q: SuggestedMarketQuestion, index: number): BankQuestion {
  return {
    id: `market${index + 1}`,
    kind: "market",
    question: q.question,
    intent: q.intent,
    axes: ["Technical Knowledge", "Problem-Solving Mindset"],
    escalations: [],
    fallback: q.fallback,
    strongAnswer: q.strongAnswer,
    weakAnswer: q.weakAnswer,
    sourceName: q.source,
    sourceUrl: q.sourceUrl,
    minutes: 4,
  };
}

/** Ensures the bank includes market questions from web research. */
function mergeMarketQuestions(
  questions: BankQuestion[],
  research: WebResearchResult,
  targetCount: number
): BankQuestion[] {
  if (targetCount <= 0 || !research.suggested.length) return questions;

  const have = questions.filter((q) => q.kind === "market").length;
  if (have >= targetCount) return questions;

  const toAdd = research.suggested
    .slice(0, targetCount - have)
    .map((s, i) => suggestedToBankQuestion(s, have + i));

  if (!toAdd.length) return questions;

  // Insert market questions after the first resume probe when possible.
  const insertAt = Math.min(2, questions.length);
  return [...questions.slice(0, insertAt), ...toAdd, ...questions.slice(insertAt)];
}

export async function generateQuestionBank(opts: {
  jdText: string;
  resumeText: string;
  duration?: InterviewDuration;
}): Promise<QuestionBank> {
  const duration = opts.duration ?? 30;
  const plan = DURATION_PLAN[duration];
  const pack = loadContextPack();
  const discipline = inferDiscipline(opts.jdText);

  const webResearch = await researchMarketInterviewQuestions({
    jdText: opts.jdText,
    discipline,
    count: plan.market,
  });

  /**
   * Web research is best-effort, so the plan has to adapt to what it actually
   * found. If it produced no market questions, those slots become `technical`
   * ones rather than being demanded anyway — asking for a "commonly reported"
   * question with nothing to ground it in made the model fall back to the most
   * generic question in existence ("walk me through a project you built"),
   * duplicating the résumé probes and making the whole screen feel like a
   * résumé read-back.
   */
  const marketAvailable = Math.min(plan.market, webResearch.suggested.length);
  const effectivePlan = {
    ...plan,
    market: marketAvailable,
    technical: plan.technical + (plan.market - marketAvailable),
  };
  if (marketAvailable < plan.market) {
    console.log(
      `[questionBank] ${plan.market - marketAvailable} market slot(s) reallocated to technical ` +
        `(no usable web sources)`
    );
  }

  const relevantCount = pack
    ? pack.scenarios.filter((sc) => {
        const tags = (sc as any).disciplines as string[] | undefined;
        return !tags?.length ? discipline === "backend" : tags.includes(discipline) || tags.includes("any");
      }).length
    : 0;
  console.log(
    `[questionBank] discipline "${discipline}" — ${relevantCount} of ${pack?.scenarios.length ?? 0} scenarios relevant; ` +
      `web research ${webResearch.hits.length} hit(s), ${webResearch.suggested.length} market Q(s)`
  );

  const webSection = formatWebResearchForPrompt(webResearch);

  const { parsed } = await callJson({
    modelId: GENERATION_MODEL_ID,
    system: buildSystemPrompt(pack, effectivePlan, duration, discipline, webSection),
    user: `=== JOB DESCRIPTION ===\n${opts.jdText.slice(0, 20000)}\n\n=== CANDIDATE RESUME ===\n${opts.resumeText.slice(0, 20000)}`,
    maxTokens: 8000,
    temperature: 0.4,
    label: "question-bank",
  });
  let questions: BankQuestion[] = (parsed.questions || []).map(normaliseQuestion);
  questions = mergeMarketQuestions(questions, webResearch, effectivePlan.market);

  // The model sometimes emits a "market" question even when told not to. The
  // question itself is usually fine, but the LABEL claims a forum source that
  // does not exist and the scorecard renders it as "commonly asked on LeetCode /
  // Blind / Glassdoor". Relabel rather than discard: keep the question, drop the
  // false citation.
  // A "market" question is a CITATION: the scorecard renders it as "commonly
  // asked on LeetCode / Blind / Glassdoor". So it only keeps that label if it
  // can be traced back to a page the research actually retrieved. Checking
  // `suggested.length` alone was not enough — the model emits market-labelled
  // questions of its own invention, and search results vary run to run, so the
  // label survived on questions clearly written from the JD.
  const citedUrls = new Set(
    webResearch.suggested.map((sug) => sug.sourceUrl).filter(Boolean) as string[]
  );
  let relabelled = 0;
  questions = questions.map((q) => {
    if (q.kind !== "market") return q;
    if (q.sourceUrl && citedUrls.has(q.sourceUrl)) return q; // genuinely grounded
    relabelled++;
    return { ...q, kind: "technical" as const, sourceName: undefined, sourceUrl: undefined };
  });
  if (relabelled) {
    console.log(
      `[questionBank] relabelled ${relabelled} market question(s) as technical — no traceable source`
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    role: parsed.role || "Unknown Role",
    seniority: parsed.seniority || "unknown",
    durationMinutes: duration,
    rubric: (parsed.rubric || []).map(normaliseAxis),
    questions: fitBudget(questions, duration),
    claimsToVerify: Array.isArray(parsed.claimsToVerify) ? parsed.claimsToVerify : [],
    unevidencedRequirements: toList(parsed.unevidencedRequirements),
    jdCoverage: normaliseCoverage(parsed.jdCoverage),
    openingLine: parsed.openingLine || "",
    discipline,
    webResearch:
      plan.market > 0
        ? {
            roleHint: webResearch.roleHint,
            queries: webResearch.queries,
            hitCount: webResearch.hits.length,
            fromWeb: webResearch.fromWeb,
            sources: webResearch.hits.map((h) => ({
              site: h.site,
              title: h.title,
              url: h.url,
            })),
          }
        : undefined,
  };
}

/** Coerces the model's coverage rows into the typed shape, dropping junk. */
function normaliseCoverage(raw: unknown): QuestionBank["jdCoverage"] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(["evidenced", "partial", "missing"]);
  return raw
    .map((r: any) => ({
      requirement: String(r?.requirement || "").trim(),
      status: allowed.has(r?.status) ? (r.status as "evidenced" | "partial" | "missing") : "partial",
      evidence: String(r?.evidence || "").trim(),
    }))
    .filter((r) => r.requirement);
}

/**
 * How the interviewer describes herself, by discipline.
 *
 * "A senior engineer" is the right credential in front of an engineer and the
 * wrong one in front of a delivery rider or a field sales candidate — this
 * system screens both.
 */
function personaTitle(discipline?: string): string {
  switch (discipline) {
    case "backend":
    case "frontend":
    case "mobile":
    case "devops":
      return "a senior engineer";
    case "data":
      return "a senior analyst on the data team";
    case "product":
      return "a senior product manager";
    case "design":
      return "a senior designer";
    case "engineering_leadership":
      return "an engineering leader here";
    case "marketing":
      return "a senior marketing leader";
    case "support":
      return "a senior member of the care team";
    case "field":
      return "a senior member of the field team";
    default:
      return "a senior member of the hiring team";
  }
}

/**
 * Renders the bank into the instruction set the live voice agent runs on.
 *
 * The agent receives ONLY this. It has no retrieval tools and no connection to
 * Slack or Confluence — it cannot leak what it was never given.
 */
/**
 * Puts the candidate's actual name into the opening line.
 *
 * The generator writes `{{name}}`; older banks baked a name in, and it was
 * sometimes the wrong one — the generator read "Sai Kumar" off a resume whose
 * owner had signed up as "Venkata Sai Reddy", and the interviewer used the
 * wrong name for the whole call. The admin-entered name always wins.
 */
export function personaliseOpening(openingLine: string, candidateName: string): string {
  const line = String(openingLine || "");
  if (/\{\{\s*name\s*\}\}/i.test(line)) return line.replace(/\{\{\s*name\s*\}\}/gi, candidateName);
  // Legacy bank: swap whatever name follows the greeting for the real one.
  return line.replace(/^((?:hey|hi|hello)\s+)([^,—–\-!.]{1,40}?)(\s*[,—–\-!.])/i, `$1${candidateName}$3`);
}

export interface RenderOptions {
  /**
   * Set when a dropped call is being re-established. Replaces the opening
   * instructions with the resume note, so the agent continues instead of
   * greeting the candidate a second time.
   */
  resumeNote?: string;
  /** Interview language; decides the interviewer's name and a spoken directive. */
  language?: LanguageConfig;
}

/**
 * Renders the bank into the instruction set the live voice agent runs on.
 *
 * The agent receives ONLY this. It has no retrieval tools and no connection to
 * Slack or Confluence — it cannot leak what it was never given.
 */
export function renderInterviewerPrompt(
  bank: QuestionBank,
  candidateName = "the candidate",
  options: RenderOptions = {}
): string {
  // The live agent gets ONLY what it needs to hold the conversation: the
  // question, how to go deeper, and how to back off.
  //
  // It deliberately does NOT receive intent, strongAnswer or weakAnswer. In
  // testing, the agent read those aloud — it told a candidate "someone who did
  // the work would mention why ClickHouse over TimescaleDB", which is handing
  // over the answer key. The grader reads those fields straight off the bank
  // afterwards, so nothing is lost by withholding them here. Same principle as
  // the Slack connection: it cannot leak what it was never given.
  const kindTag: Record<string, string> = {
    resume_probe: "Resume — verify a claim",
    technical: "Technical — from the JD (not their CV)",
    market: "Market — commonly asked on LeetCode / Blind / Glassdoor",
    jd_gap: "JD gap — skill not evidenced on resume",
    scenario: "Scenario",
  };

  const questionBlock = bank.questions
    .map(
      (q, i) => `
${i + 1}. [${kindTag[q.kind] || q.kind}] (~${q.minutes} min) ${q.question}${
        q.escalations.length
          ? `\n   If they answer this well, follow up with: ${q.escalations.join(" / ")}`
          : ""
      }${q.fallback ? `\n   If they are struggling, try instead: ${q.fallback}` : ""}`
    )
    .join("\n");

  const language = options.language ?? LANGUAGES[DEFAULT_LANGUAGE];
  const interviewer = language.interviewerName;

  const openingSection = options.resumeNote
    ? `THIS IS A RESUMED CALL — READ THIS FIRST
${options.resumeNote}`
    : `HOW TO OPEN — YOU SPEAK FIRST (after a brief pause)
Wait up to 2 seconds for the candidate to say hello. If they stay silent, YOU start: deliver your opening greeting, then ask your first question. Do not wait longer than that — they are expecting you to begin.
${personaliseOpening(bank.openingLine, candidateName)}`;

  return `You are ${interviewer}, ${personaTitle(bank.discipline)} conducting a ${bank.durationMinutes}-minute Round-0 screening interview for a ${bank.role} position (${bank.seniority} level).

The candidate's name is ${candidateName}. ${
    options.resumeNote
      ? "Use their name sparingly — you have already greeted them."
      : "Greet them by name and use it naturally once or twice — not in every turn, which sounds robotic."
  }

${openingSection}

YOUR QUESTIONS — work through these in order. Ask them as written, in your own voice. Everything in this list is for you alone; never read the bracketed timings, type labels, or the follow-up notes aloud, and never tell the candidate what you are hoping to hear.
${questionBlock}

HOW TO CONDUCT THIS

MIX RESUME, TECHNICAL, AND MARKET — CRITICAL. Your list includes resume verification, JD technical questions, AND market questions (tagged "Market — commonly asked on LeetCode / Blind / Glassdoor"). Do NOT turn the whole interview into "tell me about every project on your CV". Ask every market question — these reflect what real companies ask for this role on public forums. Never read source URLs aloud; never say "I found this on Blind".

KEEP YOUR TURNS SHORT. This is the single most important instruction. Two or three sentences, then stop talking. You are on a voice call — a thirty-second monologue is unbearable to sit through and burns interview time the candidate needs for answering. Ask the question and stop. Do not preamble, do not restate the question a second way, do not explain why you are asking.

ACKNOWLEDGE SPECIFICALLY, NEVER GENERICALLY. This is what separates a real conversation from a bot working through a form. Before your next question, react to the ACTUAL CONTENT of what they just said in a few words — name the specific thing. "Swapping the custom SVGs is interesting, since accessibility was the reason you built them" lands; "Got it, that makes sense" is filler that proves you weren't listening. NEVER open a turn with an empty acknowledgement — banned openers include "Got it", "That makes sense", "Makes sense", "Great", "Good", "Interesting", "Thanks for sharing", "Perfect", "Nice". If you have nothing specific to reflect, just ask your next question directly. Vary how you start — do not begin every turn the same way.

PRESS VAGUE ANSWERS — DON'T ACCEPT PLAUSIBLE-SOUNDING FILLER. A generic, textbook, or buzzword answer ("optimize the scripts", "use best practices", "it depends on profiling", "improve caching") is NOT a real answer — it is what someone says when they haven't actually done the work. When you hear one, do not nod along and move to the next question. Ask for the concrete specifics ONCE: "specifically how — walk me through what you actually changed", "give me a real example from something you built", "what number did you see, and what did you do about it". Accept their second answer and move on. The single most valuable thing you can surface is the gap between someone who can name specifics and someone who only has the vocabulary.

WHEN THEY SAY "I DON'T KNOW", NEVER JUST MOVE ON. This is the most informative moment in the whole interview and it is easy to waste. Always ask the follow-up: "That's completely fine — how would you go about finding out?" Someone who names a first concrete step, a person they would ask, or how they would check they got it right has just told you they can pick things up, which for a junior matters more than what they already know. A bare "I don't know" you never followed up on is a wasted question, not a weak candidate — and many candidates do not realise they are allowed to answer that way, so prompt them.

IF A QUESTION IS PROBABLY BEYOND THEM, SAY SO BEFORE ASKING IT. Some questions sit just past someone's experience on purpose. Introduce those with "I don't expect you to know this — I just want to hear how you'd think about it." That turns a gotcha into an invitation. What you are listening for is whether they reason out loud, ask a clarifying question, or name the limit honestly — not whether they get it right. Someone throwing buzzwords at a topic they clearly have not touched is the weakest signal in this interview; someone saying "I haven't done that, but I'd start by..." is one of the strongest.

LET THEM SCOPE A CLAIM DOWN WITHOUT SHAME. If something on their résumé does not survive a follow-up, ask warmly: "how much of that was hands-on for you, and how much was the team?" Résumés are very often padded by recruiters or staffing firms without the candidate's involvement. Someone who honestly narrows their claim has told you something good about themselves — treat it as a fine answer and move on, never as being caught out.

NEVER TREAT A MANGLED NAME AS A PROBLEM. Mispronounced or half-remembered tool names, an odd-sounding stack, a nervous slip, a self-correction — these are accent and memory, not signs that someone is making things up. Do not correct them, do not query the pronunciation, and never let it change how you treat them. What actually matters is whether they can add detail beyond what is written down.

BUILD ON WHAT THEY SAY. This is a conversation, not a questionnaire. A good follow-up usually comes from THEIR last answer, not from your list — chase the interesting thread they opened before returning to the next scripted question. The list is a menu and a safety net, not a script to march through.

THE MOMENT THEY START SPEAKING, STOP. Mid-word if necessary. Never finish your sentence over them, never repeat what you were saying, and never say "as I was saying" or "let me finish". If you and the candidate start at the same time, yield — you can always ask again, and they may be about to say the thing you most need to hear. After they stop, respond to what they actually said rather than returning to your script.

LET SILENCE SIT. If they pause, wait at least 10 seconds before speaking. People think before they answer, especially in a second language, and a three-second gap is normal. Do not fill it, do not rephrase the question, and do not offer hints.

CONTINUITY AFTER SILENCE — CRITICAL. If they have been quiet a long time (15+ seconds), you may check in ONCE with a single brief line ("Take your time" / "Still there?") — but NEVER say hello or hey again, NEVER re-introduce yourself, and NEVER jump back to question 1 or repeat a topic they already answered in this call. Repeat ONLY your most recent unanswered question in one sentence, then listen. If they were mid-answer when they paused, let them finish — do not start a new topic.

NEVER RESTART THE INTERVIEW. Once a question has been answered in this call, it is done. Work forward through your list only. A silence check-in is not an opportunity to recap from the beginning.

LANGUAGE. ${
    language.directive
      ? language.directive
      : "Candidates may answer in English, Hindi, or a mix of the two — many people here think in Hindi and switch mid-sentence. That is completely fine and says nothing about their ability. Understand them either way, never comment on their English or ask them to switch, and reply in clear, simple English unless they clearly prefer Hindi, in which case mirror them."
  }

- You have ${bank.durationMinutes} minutes total. Watch your pacing. Spending several minutes on the intro and rushing the technical questions is the most common way this interview fails.
- Ask ONE question at a time, then stop and listen. Never stack multiple questions into one turn.
- Do not read the scenario setup verbatim if it is long — compress it to the essentials and let the candidate ask for detail.
- Adapt. If an answer is strong and specific, use the escalation and go deeper. If they are genuinely struggling (not just vague — actually stuck), use the fallback or move on gently; pressing a stuck candidate past the point of signal wastes time and is unpleasant. Note the difference from a vague-but-capable answer, which you SHOULD press once per the rule above.
- Stay conversational and warm — a friendly professional discussion between two people, not an interrogation and not a test. Specific reactions are welcome; empty filler and long monologues are not.
- Stay inside the candidate's field. The questions above are already scoped to their role; ask those, and if you improvise a follow-up keep it in their domain. Never drift into engineering, infrastructure or distributed-systems topics unless this is genuinely an engineering role — and if this is not a technical role at all, keep every follow-up practical and grounded in the day-to-day work.
- NEVER state what you are assessing, what a good answer contains, or what you were hoping they would say — not before, during, or after a question. If they ask how they did, say the team will follow up.
- If the candidate asks about internal systems, company specifics, or anything you were not given, say you cannot go into detail and return to the question. You genuinely do not have that information.
- If the candidate says something unrelated to the interview (a joke, a test, a request for something else), decline in one light sentence and return to your question. Do not lecture.
- Close by thanking them and telling them the team will follow up.

IMPORTANT: You are gathering evidence for a human hiring manager. You are not making a hire decision, and you must never tell the candidate how they did.`;
}

/** Significant words from a question stem for fuzzy matching against spoken lines. */
function questionKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !/^(walk|tell|describe|explain|share|talk|give|what|your|have|been|would|could|about|through|with|from|that|this|they|them|were|when|where|which)$/.test(w))
    .slice(0, 6);
}

/**
 * Best-effort index of the furthest bank question the interviewer has asked,
 * inferred by matching spoken lines against question stems.
 */
export function estimateFurthestQuestionIndex(
  bank: QuestionBank,
  transcripts: { sender: string; text: string }[]
): number {
  let highest = -1;
  const lines = transcripts
    .filter((t) => t.sender === "interviewer")
    .map((t) => t.text.toLowerCase());

  for (let i = 0; i < bank.questions.length; i++) {
    const keys = questionKeywords(bank.questions[i].question);
    if (!keys.length) continue;
    for (const line of lines) {
      const hits = keys.filter((k) => line.includes(k)).length;
      if (hits >= Math.min(2, keys.length)) highest = Math.max(highest, i);
    }
  }
  return highest;
}

/** True if a spoken line is the opening greeting rather than a real question. */
export function isOpeningLine(text: string, openingLine: string, candidateName: string): boolean {
  const spoken = text.trim().toLowerCase();
  const opening = personaliseOpening(openingLine, candidateName).trim().toLowerCase();
  if (!spoken || !opening) return false;
  if (spoken === opening) return true;
  // Opening is usually short and has no question mark.
  if (spoken.length < opening.length + 40 && opening.slice(0, 40) === spoken.slice(0, 40)) return true;
  return false;
}
