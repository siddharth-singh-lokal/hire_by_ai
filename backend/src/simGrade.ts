import "./env";
import { evaluateInterview } from "./evaluate";
import { QuestionBank } from "./questionBank";

/**
 * Diagnoses the GRADER. Runs a known-good transcript and a known-thin transcript
 * through the real `evaluateInterview` and prints verdict + score, so we can tell
 * whether a low score ("Do not advance · 12") is the grader being harsh on a good
 * candidate, or simply a thin/broken transcript. Runs on OpenRouter (LLM_PROVIDER
 * =openrouter) so it works without live AWS creds.
 */

const BANK: QuestionBank = {
  generatedAt: new Date().toISOString(),
  role: "Frontend Engineer",
  seniority: "mid",
  durationMinutes: 15,
  discipline: "frontend",
  rubric: [
    { name: "Project Depth", rationale: "", strongSignal: "Explains a real decision and a tradeoff they rejected.", weakSignal: "Narrates features with no decisions.", generated: false },
    { name: "Problem-Solving", rationale: "", strongSignal: "Structured debugging, names what to check first.", weakSignal: "Buzzwords, no concrete steps.", generated: false },
    { name: "Communication", rationale: "", strongSignal: "Ideas come through and build on each other.", weakSignal: "Rambles or cannot explain.", generated: false },
  ],
  questions: [
    { id: "q1", kind: "resume_probe", question: "Walk me through a design-system component/API decision you'd defend and one you'd change.", intent: "Ownership of design decisions.", axes: ["Project Depth"], escalations: [], strongAnswer: ["names a concrete decision + tradeoff"], weakAnswer: ["vague"], minutes: 6 },
    { id: "q2", kind: "scenario", question: "A page is slow (8s to interactive) on low-end Android. How do you diagnose it?", intent: "Perf debugging.", axes: ["Problem-Solving"], escalations: [], strongAnswer: ["profiles, names long tasks, bundle, network"], weakAnswer: ["generic"], minutes: 6 },
  ],
  claimsToVerify: [],
  unevidencedRequirements: [],
  jdCoverage: [],
  openingLine: "Hi {{name}}.",
};

const T0 = 1_700_000_000_000;
const mk = (lines: [string, string][]) =>
  lines.map(([sender, text], i) => ({ sender, text, timestamp: T0 + i * 20000 }));

const GOOD = mk([
  ["interviewer", "Walk me through a design-system decision you'd defend and one you'd change."],
  ["candidate", "I'd defend our prop-driven Button — variant and size as typed props kept it consistent across the app. What I'd change is theming: we used React Context and hit re-render cascades when many components subscribed, so I'd move to CSS variables now."],
  ["interviewer", "What specifically made the Context approach expensive?"],
  ["candidate", "Every theme change re-rendered the whole subtree subscribed to the context. We tried splitting contexts and memoizing but it was band-aids. CSS variables change at the browser level without re-rendering React, so it's cheaper and simpler."],
  ["interviewer", "A page takes 8 seconds to become interactive on low-end Android. How do you diagnose it?"],
  ["candidate", "First I'd profile in DevTools on a throttled CPU, look at the main thread for long tasks over 50ms. If the JS bundle is the problem I'd code-split and defer non-critical scripts. If the bundle's fine I'd check network — asset sizes, compression, and whether we're blocking on render. On low-end Android the CPU cost of hydration is usually the real killer."],
  ["candidate", "I'd also check if we're shipping unused polyfills — those hurt cheap devices most."],
]);

const THIN = mk([
  ["interviewer", "Hi Aditya, tell me about a design-system decision you'd defend."],
  ["candidate", "um"],
  ["interviewer", "Take your time — a component or API choice you made."],
  ["candidate", "hello? can you hear me"],
  ["interviewer", "Yes, I can hear you. Go ahead whenever you're ready."],
  ["candidate", "sorry the audio"],
]);

async function grade(label: string, transcripts: any[], drops = 0) {
  const res = await evaluateInterview({
    bank: BANK,
    candidateName: "Aditya",
    transcripts,
    durationSeconds: 300,
    redFlags: [],
    orgGrounded: true,
    streamDrops: drops,
  });
  const candWords = transcripts.filter((t) => t.sender === "candidate").reduce((n, t) => n + t.text.split(/\s+/).length, 0);
  console.log(`\n### ${label}  (candidate words: ${candWords}, drops: ${drops})`);
  console.log(`  verdict:        ${res.verdict}`);
  console.log(`  overallScore:   ${res.overallScore}`);
  console.log(`  screenQuality:  ${res.screenQuality}  rescreen: ${res.rescreenRecommended}`);
  console.log(`  ratings:        ${JSON.stringify(res.ratings)}`);
  console.log(`  reason:         ${res.recommendationReason}`);
}

async function main() {
  await grade("GOOD candidate (full answers)", GOOD, 0);
  await grade("THIN / broken call (near silence)", THIN, 2);
}

main().catch((e) => { console.error("simGrade failed:", e?.message); process.exit(1); });
