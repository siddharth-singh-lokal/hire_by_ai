import express, { Request, Response } from "express";
import { createServer } from "http";
import cors from "cors";
import dotenv from "dotenv";
import { EVALUATION_MODEL_ID, SONIC_MODEL_ID, AWS_REGION } from "./bedrock";
import { attachNovaSonicRelay } from "./novaSonic";
import { generateQuestionBank, loadContextPack, InterviewDuration } from "./questionBank";
import {
  createSession,
  getSession,
  getSessionByEmail,
  listSessions,
  updateSession,
} from "./sessionStore";
import { gradeSession } from "./grading";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Enable CORS for frontend requests
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));

// Health Check Endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "round0-ai-backend",
    region: AWS_REGION,
    evaluationModel: EVALUATION_MODEL_ID,
    voiceModel: SONIC_MODEL_ID,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "round0-ai-backend",
    region: AWS_REGION,
    evaluationModel: EVALUATION_MODEL_ID,
    voiceModel: SONIC_MODEL_ID,
    timestamp: new Date().toISOString(),
  });
});

// 1a. PDF text extraction, so real JD and resume PDFs can be dropped straight in
// rather than copy-pasted. Accepts a base64 payload from the browser.
app.post("/api/extract-text", async (req: Request, res: Response) => {
  try {
    const { fileBase64 } = req.body || {};
    if (!fileBase64) {
      return res.status(400).json({ error: "MISSING_FILE", message: "No file supplied." });
    }

    // Required lazily: pdf-parse pulls in a large PDF.js bundle, and the server
    // should not pay that cost on every boot just to serve health checks.
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({
      data: new Uint8Array(Buffer.from(fileBase64.split(",").pop(), "base64")),
    });
    const result = await parser.getText();
    await parser.destroy();

    return res.json({ success: true, text: result.text });
  } catch (error: any) {
    console.error("[ExtractText] Failed:", error?.message);
    return res.status(500).json({
      error: "EXTRACT_FAILED",
      message: "Could not read that PDF. Paste the text instead.",
    });
  }
});

// 1b. Interview Preparation: JD + resume -> question bank -> prepared session.
// This is the step that makes the interview role-aware and org-grounded.
app.post("/api/prepare", async (req: Request, res: Response) => {
  try {
    const { jdText, resumeText, candidateName, candidateEmail, durationMinutes } =
      req.body || {};

    if (!jdText?.trim() || !resumeText?.trim()) {
      return res.status(400).json({
        error: "MISSING_INPUT",
        message: "Both a job description and a resume are required to prepare an interview.",
      });
    }

    // Email is the candidate's only lookup key, so it is mandatory.
    if (!candidateEmail?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidateEmail.trim())) {
      return res.status(400).json({
        error: "MISSING_EMAIL",
        message: "A valid candidate email is required — it is how they sign in.",
      });
    }

    const duration = ([5, 15, 30, 45] as const).includes(durationMinutes)
      ? (durationMinutes as InterviewDuration)
      : 30;

    const started = Date.now();
    const bank = await generateQuestionBank({ jdText, resumeText, duration });
    const session = createSession({
      candidateName: candidateName?.trim() || "the candidate",
      candidateEmail,
      bank,
    });

    console.log(
      `[Prepare] ${session.id} — ${bank.role} (${bank.seniority}), ` +
        `${bank.questions.length} questions, ${duration}min, ${Date.now() - started}ms`
    );

    // The bank itself is returned so the recruiter can review what will be asked
    // before the candidate joins — the auditability half of the design. The
    // candidate's client only ever receives the sessionId.
    return res.json({
      success: true,
      sessionId: session.id,
      candidateName: session.candidateName,
      candidateEmail: session.candidateEmail,
      bank,
      grounded: loadContextPack() !== null,
    });
  } catch (error: any) {
    console.error("[Prepare] Failed:", error);
    return res.status(500).json({
      error: "PREPARE_FAILED",
      message: error?.message || "Could not prepare the interview.",
    });
  }
});

// 1b-ii. Candidate sign-in. Email only — the interview was prepared in advance,
// so this is a lookup, not a generation. Returns nothing that reveals what will
// be asked.
app.post("/api/candidate/signin", (req: Request, res: Response) => {
  const session = getSessionByEmail(req.body?.email || "");

  if (!session) {
    return res.status(404).json({
      error: "NOT_FOUND",
      message: "No interview found for that email. Check with your recruiter.",
    });
  }

  if (session.status === "completed" || session.status === "terminated") {
    return res.status(409).json({
      error: "ALREADY_DONE",
      message: "This interview has already been completed.",
    });
  }

  return res.json({
    success: true,
    sessionId: session.id,
    candidateName: session.candidateName,
    role: session.bank.role,
    durationMinutes: session.bank.durationMinutes,
    questionCount: session.bank.questions.length,
  });
});

// 1b-iii. Admin list of every prepared interview and its outcome.
app.get("/api/admin/sessions", (_req: Request, res: Response) => {
  return res.json({
    sessions: listSessions().map((s) => ({
      id: s.id,
      candidateName: s.candidateName,
      candidateEmail: s.candidateEmail,
      role: s.role,
      seniority: s.bank.seniority,
      durationMinutes: s.bank.durationMinutes,
      questionCount: s.bank.questions.length,
      status: s.status,
      createdAt: s.createdAt,
      terminationReason: s.terminationReason,
      verdict: s.scorecard?.verdict,
      overallScore: s.scorecard?.overallScore,
      transcriptCount: s.transcripts.length,
      gradingError: s.gradingError,
    })),
  });
});

// Full detail for one session — the admin view of everything the candidate
// never sees: the bank, the rubric, and the scorecard once it exists.
app.get("/api/admin/sessions/:id", (req: Request, res: Response) => {
  const session = getSession(String(req.params.id));
  if (!session) {
    return res.status(404).json({ error: "NOT_FOUND", message: "No such session." });
  }
  return res.json({ session });
});

// 1b-iv. Interview completion. Proctoring runs in the browser, so the flags and
// the real elapsed time are posted here. The transcript is NOT taken from the
// client — the relay already recorded it server-side, which is what makes the
// result survive a candidate closing the tab.
app.post("/api/interview/:id/complete", (req: Request, res: Response) => {
  const session = getSession(String(req.params.id));
  if (!session) {
    return res.status(404).json({ error: "NOT_FOUND", message: "No such session." });
  }

  const { redFlags = [], durationSeconds = 0, terminationReason } = req.body || {};

  updateSession(session.id, {
    redFlags: Array.isArray(redFlags) ? redFlags : [],
    durationSeconds: Number(durationSeconds) || 0,
    terminationReason,
  });

  // Fire and forget: the candidate's browser is on its way to a thank-you page
  // and must not sit waiting on a minute of grading.
  gradeSession(session.id, terminationReason).catch(() => {});

  return res.json({ success: true });
});

// 1c. Context pack inspection — powers the "what will be asked, and is it safe"
// panel. Returns scenarios only; provenance stays server-side.
app.get("/api/context-pack", (_req: Request, res: Response) => {
  const pack = loadContextPack();
  if (!pack) {
    return res.json({ approved: false, scenarios: [], stackProfile: null });
  }
  return res.json({
    approved: pack.approved,
    generatedAt: pack.generatedAt,
    stackProfile: pack.stackProfile,
    sourceSummary: pack.sourceSummary,
    scenarios: pack.scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      stack: s.stack,
      constraints: s.constraints,
      difficulty: s.difficulty,
      competencies: s.competencies,
    })),
  });
});

// 2. Scorecard retrieval. Grading happens automatically when the interview ends
// (see grading.ts), so this only reads the result.
app.get("/api/scorecard/:id", (req: Request, res: Response) => {
  const session = getSession(String(req.params.id));
  if (!session) {
    return res.status(404).json({ error: "NOT_FOUND", message: "No such interview." });
  }

  if (session.scorecard) {
    return res.json({
      status: "completed",
      candidateName: session.candidateName,
      role: session.role,
      evaluation: session.scorecard,
      genericComparison: (session.scorecard as any).genericComparison || null,
      transcripts: session.transcripts,
      terminationReason: session.terminationReason,
    });
  }

  if (session.gradingError) {
    return res.status(500).json({
      status: "failed",
      message: session.gradingError,
      transcripts: session.transcripts,
    });
  }

  // Still running or still grading — the client polls.
  return res.json({
    status: session.status,
    candidateName: session.candidateName,
    role: session.role,
    transcriptCount: session.transcripts.length,
  });
});

// Manual re-grade, for a session that ended without one.
app.post("/api/scorecard/:id/regrade", async (req: Request, res: Response) => {
  const session = getSession(String(req.params.id));
  if (!session) {
    return res.status(404).json({ error: "NOT_FOUND", message: "No such interview." });
  }

  updateSession(session.id, { status: "in_progress", gradingError: undefined });
  gradeSession(session.id, "manual regrade").catch(() => {});
  return res.json({ success: true, status: "grading" });
});

const httpServer = createServer(app);

// Nova Sonic speech-to-speech relay shares the HTTP port at /ws/interview.
attachNovaSonicRelay(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[Round-0 Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Round-0 Backend] Voice relay at ws://localhost:${PORT}/ws/interview`);
  console.log(`[Round-0 Backend] Region ${AWS_REGION} | Voice ${SONIC_MODEL_ID}`);
});
