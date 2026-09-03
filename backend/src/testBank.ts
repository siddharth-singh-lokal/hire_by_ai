import * as fs from "fs";
import { generateQuestionBank, InterviewDuration } from "./questionBank";

/**
 * Manual harness for eyeballing bank quality against real JDs.
 *   npx ts-node src/testBank.ts <jd.txt> <resume.txt> [minutes]
 */
async function main() {
  const [jdPath, resumePath, mins] = process.argv.slice(2);
  if (!jdPath || !resumePath) {
    console.error("usage: ts-node src/testBank.ts <jd.txt> <resume.txt> [15|30|45]");
    process.exit(1);
  }

  const bank = await generateQuestionBank({
    jdText: fs.readFileSync(jdPath, "utf8"),
    resumeText: fs.readFileSync(resumePath, "utf8"),
    duration: (Number(mins) || 30) as InterviewDuration,
  });

  console.log(`\n${"=".repeat(70)}`);
  console.log(`ROLE: ${bank.role}   SENIORITY: ${bank.seniority}   ${bank.durationMinutes} min`);
  console.log("=".repeat(70));

  console.log("\nRUBRIC");
  for (const axis of bank.rubric) {
    console.log(`  ${axis.name}${axis.generated ? "  <-- generated from JD" : ""}`);
    console.log(`      strong: ${axis.strongSignal}`);
  }

  console.log("\nQUESTIONS");
  for (const q of bank.questions) {
    console.log(`\n  [${q.kind}, ${q.minutes}min]${q.scenarioId ? ` (scenario: ${q.scenarioId})` : ""}`);
    console.log(`  Q: ${q.question}`);
    console.log(`  intent: ${q.intent}`);
    console.log(`  escalate: ${q.escalations[0] || "-"}`);
    console.log(`  strong: ${q.strongAnswer[0] || "-"}`);
  }

  console.log("\nUNEVIDENCED JD REQUIREMENTS");
  bank.unevidencedRequirements.forEach((r) => console.log(`  - ${r}`));

  const total = bank.questions.reduce((s, q) => s + (q.minutes || 0), 0);
  console.log(`\nBudget: ${total} min of questions inside a ${bank.durationMinutes} min interview\n`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
