import "./env";
import { renderInterviewerPrompt, QuestionBank } from "./questionBank";
import { resolveLanguage } from "./languages";

/**
 * Offline interview simulator for iterating on the interviewer PROMPT.
 *
 * It renders the real `renderInterviewerPrompt`, then runs a full multi-turn
 * conversation where a model plays the candidate. Prints the transcript so the
 * interviewer's *communication* (acknowledgement, listening, concision, natural
 * flow) can be judged and the prompt tuned. Uses OpenRouter so it runs without
 * the voice stack or live AWS creds.
 *
 *   OPENROUTER_API_KEY=... npx ts-node src/simInterview.ts [candidatePersona]
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const INTERVIEWER_MODEL = process.env.SIM_INTERVIEWER_MODEL || "anthropic/claude-sonnet-4.6";
const CANDIDATE_MODEL = process.env.SIM_CANDIDATE_MODEL || "openai/gpt-4o-mini";
const TURNS = Number(process.env.SIM_TURNS || 7);

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function chat(model: string, messages: Msg[], maxTokens = 400): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.8, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

// A realistic frontend bank, so the interviewer has something concrete to work with.
const BANK: QuestionBank = {
  generatedAt: new Date().toISOString(),
  role: "Frontend Engineer",
  seniority: "mid",
  durationMinutes: 15,
  discipline: "frontend",
  rubric: [],
  claimsToVerify: [],
  unevidencedRequirements: [],
  jdCoverage: [],
  openingLine: "Hi {{name}}, thanks for making the time — I'd love to hear about the frontend work you've been doing lately.",
  questions: [
    {
      id: "q1",
      kind: "resume_probe",
      question: "Your resume mentions building a design system in React and TypeScript. Walk me through a component or API decision you made there that you'd defend, and one you'd change now.",
      intent: "Did they actually own design-system decisions, or just use one?",
      axes: ["Project Depth"],
      escalations: ["What made the API you'd change now the wrong call at the time?"],
      fallback: "Pick one reusable component you built — what was tricky about making it reusable?",
      strongAnswer: [], weakAnswer: [], minutes: 6,
    },
    {
      id: "q2",
      kind: "scenario",
      question: "A page on low-end Android phones takes 8 seconds to become interactive. How would you find out why, and what would you try first?",
      intent: "Performance debugging instinct under real constraints.",
      axes: ["Problem-Solving"],
      escalations: ["Say the JS bundle is fine but it's still slow — where next?"],
      fallback: "What does 'time to interactive' even mean to you?",
      strongAnswer: [], weakAnswer: [], minutes: 6,
    },
  ],
};

const CANDIDATE_PERSONAS: Record<string, string> = {
  solid:
    "You are a competent mid-level frontend engineer with 3 years' experience. You genuinely built a design system. Answer naturally and conversationally, sometimes a little rambly, sometimes pausing to think ('hmm', 'let me think'). Give real but imperfect answers. Occasionally give a slightly vague answer that needs a follow-up. Keep answers to 2-5 sentences, like real speech.",
  nervous:
    "You are a nervous junior frontend candidate. You give short, hesitant answers, sometimes say 'I'm not sure' or go quiet. You know the basics but undersell yourself. Answers are 1-3 sentences, sometimes just a few words.",
  rambler:
    "You are an over-confident candidate who talks too much and dodges specifics with buzzwords ('scalable', 'best practices', 'clean code') without concrete detail. Answers are long and vague.",
};

async function main() {
  if (!KEY) throw new Error("Set OPENROUTER_API_KEY.");
  const personaKey = process.argv[2] || "solid";
  const persona = CANDIDATE_PERSONAS[personaKey] || CANDIDATE_PERSONAS.solid;
  const language = resolveLanguage("en");

  const interviewerSystem = renderInterviewerPrompt(BANK, "Aditya", { language });

  console.log(`\n=== SIM: candidate="${personaKey}" | interviewer=${INTERVIEWER_MODEL} | candidate=${CANDIDATE_MODEL} ===\n`);

  // Two mirrored histories. The interviewer's "assistant" is the candidate's
  // "user" and vice-versa.
  const ivHistory: Msg[] = [{ role: "system", content: interviewerSystem }];
  const candSystem =
    persona +
    "\n\nYou are being interviewed by a voice AI for a Frontend Engineer role. Respond ONLY as the candidate would speak — no narration, no stage directions. This is a spoken call.";
  const candHistory: Msg[] = [{ role: "system", content: candSystem }];

  // Interviewer opens.
  ivHistory.push({ role: "user", content: "[The interview is starting now. Greet the candidate and ask your first question.]" });
  let ivLine = await chat(INTERVIEWER_MODEL, ivHistory);
  ivHistory.push({ role: "assistant", content: ivLine });
  console.log(`INTERVIEWER: ${ivLine}\n`);

  for (let t = 0; t < TURNS; t++) {
    candHistory.push({ role: "user", content: ivLine });
    const candLine = await chat(CANDIDATE_MODEL, candHistory, 220);
    candHistory.push({ role: "assistant", content: candLine });
    console.log(`CANDIDATE:   ${candLine}\n`);

    ivHistory.push({ role: "user", content: candLine });
    ivLine = await chat(INTERVIEWER_MODEL, ivHistory);
    ivHistory.push({ role: "assistant", content: ivLine });
    console.log(`INTERVIEWER: ${ivLine}\n`);
  }

  console.log("=== END SIM ===");
}

main().catch((e) => {
  console.error("SIM failed:", e?.message);
  process.exit(1);
});
