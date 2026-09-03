import { evaluateInterview, evaluateGeneric } from "./evaluate";
import { loadContextPack } from "./questionBank";
import { getSession, updateSession } from "./sessionStore";

/**
 * Grades a finished interview, server-side and unprompted.
 *
 * Why this exists: grading used to be kicked off by the candidate's browser
 * loading the scorecard page. Once candidates were redirected to a thank-you
 * page instead — which is correct, they must never see their own score —
 * nothing triggered evaluation at all. Interviews completed, sat at
 * "in_progress" forever, and the transcript was stranded in the candidate's
 * localStorage where a closed tab destroyed it.
 *
 * Now the relay records the transcript as it streams and this runs when the
 * stream ends, so a result exists whether or not the browser cooperates.
 */

/** Sessions currently being graded, so a double disconnect can't double-charge. */
const inFlight = new Set<string>();

/** Below this there is nothing meaningful to grade. */
const MIN_CANDIDATE_TURNS = 1;

export async function gradeSession(sessionId: string, reason?: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;

  if (inFlight.has(sessionId)) return;
  if (session.status === "completed" || session.status === "grading") return;

  const candidateTurns = session.transcripts.filter((t) => t.sender === "candidate");
  if (candidateTurns.length < MIN_CANDIDATE_TURNS) {
    // The candidate never actually said anything. Marking this "completed" with
    // a fabricated scorecard would be worse than admitting nothing happened.
    updateSession(sessionId, {
      status: "terminated",
      completedAt: Date.now(),
      terminationReason: reason || "no candidate response recorded",
    });
    console.log(`[Grading] ${sessionId} — nothing to grade (0 candidate turns)`);
    return;
  }

  inFlight.add(sessionId);
  updateSession(sessionId, { status: "grading" });
  const started = Date.now();

  try {
    const evaluation = await evaluateInterview({
      bank: session.bank,
      candidateName: session.candidateName,
      transcripts: session.transcripts,
      durationSeconds:
        session.durationSeconds ||
        Math.round(((session.completedAt || Date.now()) - (session.startedAt || Date.now())) / 1000),
      redFlags: session.redFlags,
      orgGrounded: loadContextPack() !== null,
    });

    // The counterfactual runs alongside but must never block the real result.
    let generic = null;
    try {
      generic = await evaluateGeneric({
        candidateName: session.candidateName,
        role: session.bank.role,
        transcripts: session.transcripts,
      });
    } catch (err: any) {
      console.error(`[Grading] ${sessionId} — generic comparison failed:`, err?.message);
    }

    (evaluation as any).genericComparison = generic;

    updateSession(sessionId, {
      status: "completed",
      completedAt: Date.now(),
      scorecard: evaluation,
      terminationReason: reason,
      gradingError: undefined,
    });

    console.log(
      `[Grading] ${sessionId} — ${evaluation.verdict} ${evaluation.overallScore} ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        (generic ? ` | generic: ${generic.verdict} ${generic.overallScore}` : "")
    );
  } catch (err: any) {
    // Leave the failure visible rather than silently stuck — an admin looking at
    // this needs to know grading was attempted and why it did not produce one.
    updateSession(sessionId, {
      status: "completed",
      completedAt: Date.now(),
      gradingError: err?.message || "Grading failed.",
    });
    console.error(`[Grading] ${sessionId} — FAILED:`, err?.message);
  } finally {
    inFlight.delete(sessionId);
  }
}
