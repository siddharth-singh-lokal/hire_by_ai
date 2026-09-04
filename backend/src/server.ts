// MUST be first: loads .env before any module reads process.env.
import "./env";
import express, { Request, Response } from "express";
import { createServer } from "http";
import cors from "cors";
import { EVALUATION_MODEL_ID, GENERATION_MODEL_ID, SONIC_MODEL_ID, AWS_REGION } from "./bedrock";
import { callJson } from "./llm";
import { attachNovaSonicRelay } from "./novaSonic";
import { generateQuestionBank, loadContextPack, InterviewDuration, QuestionBank } from "./questionBank";
import { resolveLanguage } from "./languages";
import { llmProviderStatus } from "./llm";
import * as fs from "fs";
import {
  createSession,
  getSession,
  getSessionByEmail,
  listSessions,
  updateSession,
  saveRecording,
  getRecording,
} from "./sessionStore";
import { gradeSession } from "./grading";


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
    textProvider: llmProviderStatus(),
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
    textProvider: llmProviderStatus(),
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

// 1a-ii. ATS match score. A fast résumé-vs-JD read the admin sees WHILE the full
// question bank generates (that takes ~a minute; this returns in a few seconds).
// One small LLM call — like an applicant-tracking system's keyword match, but
// aware of synonyms and seniority rather than literal string matching.
app.post("/api/ats-score", async (req: Request, res: Response) => {
  try {
    const { jdText, resumeText } = req.body || {};
    if (!jdText?.trim() || !resumeText?.trim()) {
      return res.status(400).json({
        error: "MISSING_INPUT",
        message: "Both a job description and a resume are required.",
      });
    }
    const { parsed } = await callJson({
      modelId: GENERATION_MODEL_ID,
      system: `You are a recruiter doing a first-pass résumé-vs-JD read — not a keyword-matching ATS. Every JD emphasises different things; candidates rarely mirror a posting line-for-line. Your job is to judge whether this person plausibly fits the ROLE and DOMAIN, using what they have actually done before.

MATCHING PHILOSOPHY — medium bar, not tight:
- Judge domain and transferable experience first, then specific tools. Someone who built high-traffic APIs in e-commerce partially evidences a fintech backend role even if the stack differs. Someone who led field teams partially evidences an ops role even if the industry differs.
- Synonyms and adjacent skills count: React ≈ ReactJS, Postgres ≈ PostgreSQL, "led a team" ≈ people management, mobile apps ≈ Android if the JD asks for mobile.
- Use "partial" generously when past work is in the same ballpark — different company, stack, or sub-domain is partial, not missing.
- Reserve "missing" for requirements with genuinely no adjacent signal on the résumé (not merely unstated keywords).
- Do NOT extract every bullet from the JD. Pick 5-8 material themes: domain/industry, seniority/scope, 2-4 core competencies, and anything explicitly day-one critical. Ignore boilerplate ("team player", "fast-paced environment").

SCORING 0-100 — calibrated leniently:
- 80-95: same domain or clearly transferable track, most core themes evidenced or partial
- 65-79: reasonable fit — strong in some themes, gaps in others, but past work suggests they could grow into it
- 45-64: partial overlap — worth a screen to probe gaps, not an auto-reject
- below 45: different domain/seniority with little transferable signal
When in doubt between two bands, score toward the higher one if their past projects suggest relevant reasoning.

For each requirement/theme, status:
- "evidenced": clearly demonstrated on the résumé (cite the line/claim)
- "partial": touched adjacently, different stack/domain but same kind of work, or seniority close but scope thinner
- "missing": no reasonable signal — not "keyword not found"

Return ONLY: {
  "atsScore": 0-100,
  "verdict": "one short phrase, e.g. 'Strong match' | 'Good fit, some gaps' | 'Worth screening' | 'Weak overlap'",
  "coverage": [{"requirement": "plain-words theme (domain-aware, not a JD bullet copy)", "status": "evidenced|partial|missing", "evidence": "the résumé claim that supports it, or why it is partial/missing with reference to their past work"}]
}`,
      user: `=== JOB DESCRIPTION ===\n${String(jdText).slice(0, 12000)}\n\n=== RÉSUMÉ ===\n${String(resumeText).slice(0, 12000)}`,
      maxTokens: 1200,
      temperature: 0.2,
      label: "ats-score",
    });

    const score = Math.max(0, Math.min(100, Math.round(Number(parsed?.atsScore) || 0)));
    const allowed = new Set(["evidenced", "partial", "missing"]);
    const coverage = (Array.isArray(parsed?.coverage) ? parsed.coverage : [])
      .map((c: any) => ({
        requirement: String(c?.requirement || "").trim(),
        status: allowed.has(c?.status) ? c.status : "partial",
        evidence: String(c?.evidence || "").trim(),
      }))
      .filter((c: any) => c.requirement)
      .slice(0, 12);
    return res.json({
      atsScore: score,
      verdict: String(parsed?.verdict || "").trim(),
      coverage,
    });
  } catch (error: any) {
    console.error("[ATS] Failed:", error?.message);
    return res.status(500).json({ error: "ATS_FAILED", message: error?.message || "Could not score." });
  }
});

// 1b. Interview Preparation: JD + resume -> question bank -> prepared session.
// This is the step that makes the interview role-aware and org-grounded.
app.post("/api/prepare", async (req: Request, res: Response) => {
  try {
    const { jdText, resumeText, candidateName, candidateEmail, durationMinutes, language } =
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

    // Name is spoken aloud by the interviewer and greets the candidate in the
    // UI, so it is required rather than defaulted to a literal "the candidate".
    if (!candidateName?.trim()) {
      return res.status(400).json({
        error: "MISSING_NAME",
        message: "A candidate name is required — the interviewer greets them by it.",
      });
    }

    const duration = ([1, 5, 15, 30, 45] as const).includes(durationMinutes)
      ? (durationMinutes as InterviewDuration)
      : 30;
    // Unsupported language codes fall back to English inside resolveLanguage.
    const langCode = resolveLanguage(language).code;

    const started = Date.now();
    const bank = await generateQuestionBank({ jdText, resumeText, duration });
    const session = createSession({
      candidateName: candidateName.trim(),
      candidateEmail,
      bank,
      language: langCode,
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
      language: session.language,
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
    language: session.language,
  });
});

// 1b-ii-b. Candidate session detail, looked up by opaque id — what the interview
// room needs to render (name, duration, language, status) without the bank ever
// reaching the browser. Deliberately 200 for every status so the lobby can show
// the right state (ready / rejoin / already done). serverNow lets the client
// cancel clock skew when deriving the timer from startedAt.
app.get("/api/candidate/session/:id", (req: Request, res: Response) => {
  const session = getSession(String(req.params.id));
  if (!session) {
    return res.status(404).json({
      error: "NOT_FOUND",
      message: "No interview found for this link. Please sign in again with your email.",
    });
  }
  return res.json({
    sessionId: session.id,
    candidateName: session.candidateName,
    role: session.bank.role,
    durationMinutes: session.bank.durationMinutes,
    language: session.language || "en",
    status: session.status,
    startedAt: session.startedAt ?? null,
    serverNow: Date.now(),
  });
});

// DEV ONLY: create a session directly from a bank fixture, skipping the ~50s
// generation, so the e2e harness can drive the relay repeatably. Guarded on
// NODE_ENV; neither `npm run dev` nor `npm start` sets it, so this is only
// closed off in a real deployment that does. Never exposes anything the normal
// prepare flow does not.
if (process.env.NODE_ENV !== "production") {
  app.post("/api/dev/prepare-from-bank", (req: Request, res: Response) => {
    const { bank: posted, fromSessionId, candidateName, candidateEmail, language } =
      req.body || {};
    const bank: QuestionBank | undefined =
      posted ?? (fromSessionId ? getSession(String(fromSessionId))?.bank : undefined);
    const ok =
      !!bank &&
      typeof bank.role === "string" &&
      [1, 5, 15, 30, 45].includes(bank.durationMinutes) &&
      Array.isArray(bank.rubric) &&
      bank.rubric.length > 0 &&
      Array.isArray(bank.questions) &&
      bank.questions.length > 0;
    if (!ok) {
      return res.status(400).json({
        error: "BAD_BANK",
        message: "Provide a valid `bank` object or a `fromSessionId` that has one.",
      });
    }
    const session = createSession({
      candidateName: String(candidateName || "E2E Candidate"),
      candidateEmail: String(candidateEmail || `e2e+${Date.now().toString(36)}@example.test`),
      bank: bank as QuestionBank,
      language: resolveLanguage(language).code,
    });
    return res.json({
      success: true,
      sessionId: session.id,
      role: session.bank.role,
      durationMinutes: session.bank.durationMinutes,
      rubricAxes: session.bank.rubric.length,
      questionCount: session.bank.questions.length,
      language: session.language,
    });
  });
  console.log("[Dev] POST /api/dev/prepare-from-bank enabled (NODE_ENV != production)");
}

// 1b-iii. Admin list of every prepared interview and its outcome.
app.get("/api/admin/sessions", (req: Request, res: Response) => {
  const includeTest = req.query.includeTest === "1";
  return res.json({
    sessions: listSessions()
      .filter((s) => includeTest || !isHarnessSession(s.candidateEmail))
      .map((s) => ({
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
      transcriptCount: s.transcripts.length,
      gradingError: s.gradingError,
      streamDrops: s.streamDrops || 0,
      screenQuality: s.scorecard?.screenQuality,
      rescreenRecommended: s.scorecard?.rescreenRecommended,
      language: s.language || "en",
    })),
  });
});

/**
 * Ranked shortlist per role — the recruiter's actual question.
 *
 * The flat session list answers "how did this one candidate do". An employer
 * with forty applicants asks a different question: "who should I call first,
 * and who has the things I said were mandatory". That is the whole point of
 * screening at volume, so it gets its own endpoint rather than being left as
 * something a human eyeballs down a list.
 *
 * Ordering is by advancement recommendation first, then confidence — never by
 * score alone, because a 62 that reads "Advance with focus" outranks a 68 that
 * reads "Needs discussion", and sorting on the number would invert them.
 */
/**
 * Sessions the e2e harness created. They are real interviews and worth keeping
 * for debugging, but a demo showing fourteen identically-named "E2E Candidate"
 * rows reads as broken. Matched on the exact address the dev route generates,
 * so nothing a human typed is ever hidden. `?includeTest=1` shows them.
 */
const isHarnessSession = (email: string) =>
  /^e2e\+[^@]*@example\.test$/i.test(email || "");

app.get("/api/admin/shortlist", (req: Request, res: Response) => {
  const includeTest = req.query.includeTest === "1";
  const VERDICT_RANK: Record<string, number> = {
    Advance: 0,
    "Advance with focus": 1,
    "Needs discussion": 2,
    "Do not advance": 3,
  };

  const byRole = new Map<string, any[]>();

  for (const s of listSessions()) {
    if (!includeTest && isHarnessSession(s.candidateEmail)) continue;
    const sc = s.scorecard;
    const row = {
      id: s.id,
      candidateName: s.candidateName,
      candidateEmail: s.candidateEmail,
      language: s.language || "en",
      status: s.status,
      durationSeconds: s.durationSeconds,
      verdict: sc?.verdict,
      summary: sc?.summary,
      // The one line a recruiter reads if they read nothing else.
      recommendationReason: sc?.recommendationReason,
      topStrength: sc?.keyStrengths?.[0]?.title,
      topConcern: sc?.redFlags?.[0]?.title,
      // Requirement-by-requirement, which is what "does he actually have a
      // bike and can he travel" looks like in the data.
      requirements: (sc?.gapMatrix || []).map((g) => ({
        requirement: g.requirement,
        status: g.status,
      })),
      evidenced: (sc?.gapMatrix || []).filter((g) => g.status === "evidenced").length,
      contradicted: (sc?.gapMatrix || []).filter((g) => g.status === "contradicted").length,
      requirementCount: (sc?.gapMatrix || []).length,
      screenQuality: sc?.screenQuality,
      rescreenRecommended: sc?.rescreenRecommended,
      graded: Boolean(sc),
      createdAt: s.createdAt,
    };
    const list = byRole.get(s.role) || [];
    list.push(row);
    byRole.set(s.role, list);
  }

  const roles = [...byRole.entries()]
    .map(([role, candidates]) => {
      candidates.sort((a, b) => {
        // Ungraded candidates sink to the bottom regardless of anything else.
        if (a.graded !== b.graded) return a.graded ? -1 : 1;
        const ra = VERDICT_RANK[a.verdict] ?? 9;
        const rb = VERDICT_RANK[b.verdict] ?? 9;
        if (ra !== rb) return ra - rb;
        return b.createdAt - a.createdAt;
      });
      return {
        role,
        total: candidates.length,
        graded: candidates.filter((c) => c.graded).length,
        advancing: candidates.filter(
          (c) => c.verdict === "Advance" || c.verdict === "Advance with focus"
        ).length,
        candidates,
      };
    })
    .sort((a, b) => b.total - a.total);

  return res.json({ roles });
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

// Full interview recording upload. Sent as raw binary (a recording is tens of
// megabytes — base64 in JSON would be ruinous), stored to disk out of the hot
// store. Its own body parser with a large cap, applied only to this route.
app.post(
  "/api/interview/:id/recording",
  express.raw({ type: () => true, limit: "300mb" }),
  (req: Request, res: Response) => {
    const session = getSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: "NOT_FOUND", message: "No such session." });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: "EMPTY", message: "No recording data received." });
    }
    const ok = saveRecording(
      session.id,
      body,
      String(req.headers["content-type"] || "video/webm")
    );
    if (!ok) return res.status(500).json({ error: "SAVE_FAILED", message: "Could not store recording." });
    console.log(`[Recording] ${session.id} — stored ${(body.length / 1e6).toFixed(1)}MB`);
    return res.json({ success: true });
  }
);

// Streams the stored interview recording back to the recruiter scorecard, with
// HTTP range support so the <video> element can seek.
app.get("/api/interview/:id/recording", (req: Request, res: Response) => {
  const rec = getRecording(String(req.params.id));
  if (!rec) return res.status(404).json({ error: "NOT_FOUND", message: "No recording for this session." });

  const stat = fs.statSync(rec.path);
  const range = req.headers.range;
  res.setHeader("Content-Type", rec.mime);
  res.setHeader("Accept-Ranges", "bytes");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size) {
      res.setHeader("Content-Range", `bytes */${stat.size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    return fs.createReadStream(rec.path, { start, end }).pipe(res);
  }

  res.setHeader("Content-Length", stat.size);
  return fs.createReadStream(rec.path).pipe(res);
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

  /**
   * A regrade in flight still holds the PREVIOUS scorecard. Reporting
   * "completed" then hands the recruiter stale data and makes the Re-grade
   * button look like it did nothing — the page re-renders the old card and
   * stops polling. Report the live state instead so it polls to the new one.
   */
  const regrading =
    !!session.scorecard && (session.status === "grading" || session.status === "in_progress");

  if (regrading) {
    return res.json({
      status: "grading",
      candidateName: session.candidateName,
      role: session.role,
      transcriptCount: session.transcripts.length,
    });
  }

  if (session.scorecard) {
    return res.json({
      status: "completed",
      // Set when a LATER grading attempt failed while this (older) scorecard
      // stands. Without it the recruiter sees a stale result and no hint that
      // the re-grade they just triggered errored.
      gradingError: session.gradingError,
      candidateName: session.candidateName,
      role: session.role,
      evaluation: session.scorecard,
      genericComparison: (session.scorecard as any).genericComparison || null,
      transcripts: session.transcripts,
      redFlags: session.redFlags,
      hasRecording: Boolean(session.recordingMime),
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
