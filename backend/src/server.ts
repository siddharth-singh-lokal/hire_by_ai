import express, { Request, Response } from "express";
import { createServer } from "http";
import cors from "cors";
import dotenv from "dotenv";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { CANDIDATE_RESUME, generateInterviewerSystemPrompt } from "./resumeData";
import { ScorecardEvaluation } from "./scorecardTypes";
import { bedrockClient, EVALUATION_MODEL_ID, SONIC_MODEL_ID, AWS_REGION, extractJson } from "./bedrock";
import { attachNovaSonicRelay } from "./novaSonic";

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

// 1. Session Broker: Mints ephemeral token from OpenAI Realtime API
app.post("/api/session", async (req: Request, res: Response) => {
  try {
    let apiKey = process.env.OPENAI_API_KEY?.trim();

    if (!apiKey) {
      const headerKey = req.headers["x-openai-api-key"];
      if (typeof headerKey === "string" && headerKey.trim()) {
        apiKey = headerKey.trim();
      }
    }

    if (!apiKey && req.body?.apiKey) {
      apiKey = String(req.body.apiKey).trim();
    }

    if (!apiKey) {
      return res.status(401).json({
        error: "OPENAI_API_KEY_MISSING",
        message:
          "OpenAI API key not found. Please configure OPENAI_API_KEY in backend .env or provide it via client request headers/modal.",
      });
    }

    const instructions = generateInterviewerSystemPrompt();

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "ash",
        modalities: ["audio", "text"],
        instructions: instructions,
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        },
        temperature: 0.7,
        max_response_output_tokens: 800,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Session Broker Error] OpenAI responded with:", response.status, errorText);
      return res.status(response.status).json({
        error: "OPENAI_SESSION_FAILED",
        status: response.status,
        message: `Failed to create OpenAI Realtime session: ${response.statusText}`,
        details: errorText,
      });
    }

    const sessionData = (await response.json()) as any;

    return res.json({
      success: true,
      sessionId: sessionData.id,
      model: sessionData.model,
      voice: sessionData.voice,
      client_secret: sessionData.client_secret,
    });
  } catch (error: any) {
    console.error("[Session Broker Exception]:", error);
    return res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
      message: error?.message || "An unexpected error occurred while negotiating session token.",
    });
  }
});

// 2. Evaluation Engine: Produces candidate scorecard using gpt-4o-mini
app.post("/api/evaluate", async (req: Request, res: Response) => {
  try {
    const { transcripts = [], durationSeconds = 0, redFlags = [] } = req.body;

    const formattedTranscript = transcripts
      .map(
        (t: any) =>
          `[${t.sender === "candidate" ? CANDIDATE_RESUME.name : "Interviewer (Sarah)"}]: ${t.text}`
      )
      .join("\n\n");

    const candidateLines = transcripts.filter((t: any) => t.sender === "candidate");

    // Fallback if interview was aborted very early
    if (transcripts.length === 0 || candidateLines.length === 0) {
      const fallbackEvaluation: ScorecardEvaluation = {
        verdict: "Borderline",
        overallScore: 68,
        ratings: {
          technicalCompetence: 3.5,
          systemDesign: 3.5,
          communication: 3.0,
          authenticity: 4.0,
        },
        summary:
          "The interview concluded before an extensive technical dialogue could be recorded. Based on initial greeting and resume verification for Alex Doe, the candidate shows solid senior-level pedigree in distributed systems, but required deeper probing into live Redis cluster partition failovers.",
        recommendationReason:
          "Recommend a follow-up 30-minute deep-dive focusing on PostgreSQL lock contention and Redis Lua script latency.",
        keyStrengths: [
          {
            title: "Distributed Scheduling Knowledge",
            explanation:
              "Clear theoretical command of Redis Sorted Sets (ZADD/ZREMRANGEBYSCORE) for O(log N) delayed execution over message queues.",
            evidenceQuote: "Discussed delayed task queues using Redis sorted sets and epoch scoring.",
          },
          {
            title: "Concurrency Primitives",
            explanation:
              "Understands PostgreSQL advisory locks for non-blocking worker partition coordination.",
          },
        ],
        redFlags: [
          {
            title: "Short Dialogue Sample",
            explanation:
              "Interview concluded early. Full live architectural trade-off verification was truncated.",
          },
        ],
        directQuotes: [
          {
            competency: "Architecture & Systems Design",
            quote:
              "Delayed scheduling with Redis sorted sets avoids Kafka head-of-line blocking for arbitrary delays.",
            analysis:
              "Accurate characterization of Kafka partition limitations for arbitrary timestamp scheduling.",
            impact: "positive",
          },
        ],
        projectAssessments: [
          {
            projectName: "High-Throughput Job Scheduler",
            rating: 4,
            strengthsObserved: [
              "Proper application of PostgreSQL transaction advisory locks",
              "Sub-10ms trigger delay design with Redis O(log N) lookups",
            ],
            unresolvedConcerns: ["Worker failure reclamation under uncommitted job crash"],
          },
          {
            projectName: "Distributed Rate Limiter",
            rating: 3,
            strengthsObserved: ["Understanding of sliding window log vs token bucket"],
            unresolvedConcerns: ["Multi-shard Redis cluster cross-slot Lua constraints"],
          },
        ],
        durationSeconds: durationSeconds || 180,
        evaluatedAt: new Date().toISOString(),
        evaluationMode: "offline_simulation",
        modelUsed: "Simulation Mode (No Candidate Transcript Recorded)",
      };

      return res.json({ success: true, evaluation: fallbackEvaluation });
    }

    // Evaluate with Claude on Bedrock. Credentials come from the AWS provider
    // chain, so there is no key to check before attempting the call.
    {
      const systemPrompt = `You are a Principal Technical Recruiting Bar Raiser and Lead Architect evaluating a Round-0 interview transcript for a candidate:
Candidate: ${CANDIDATE_RESUME.name}
Role: ${CANDIDATE_RESUME.title} (${CANDIDATE_RESUME.experienceYears} Years Experience)

Evaluation Rubric:
${JSON.stringify(CANDIDATE_RESUME.rubric, null, 2)}

Hardcoded Projects to assess:
${JSON.stringify(
  CANDIDATE_RESUME.projects.map((p) => ({
    name: p.name,
    keyArchitecture: p.keyArchitecture,
    failureModes: p.failureModesToExplore,
  })),
  null,
  2
)}

Strictly output a valid JSON object matching this schema:
{
  "verdict": "Strong Hire" | "Hire" | "Borderline" | "Reject",
  "overallScore": number (0 to 100),
  "ratings": {
    "technicalCompetence": number (1.0 to 5.0),
    "systemDesign": number (1.0 to 5.0),
    "communication": number (1.0 to 5.0),
    "authenticity": number (1.0 to 5.0)
  },
  "summary": string (comprehensive executive summary for hiring committee),
  "recommendationReason": string (1-2 sentences rationale for final hiring decision),
  "keyStrengths": [
    {
      "title": string,
      "explanation": string,
      "evidenceQuote": string (quote candidate directly if available)
    }
  ],
  "redFlags": [
    {
      "title": string,
      "explanation": string,
      "evidenceQuote": string (quote candidate directly if available)
    }
  ],
  "directQuotes": [
    {
      "competency": string,
      "quote": string,
      "analysis": string,
      "impact": "positive" | "negative" | "neutral"
    }
  ],
  "projectAssessments": [
    {
      "projectName": string,
      "rating": number (1.0 to 5.0),
      "strengthsObserved": string[],
      "unresolvedConcerns": string[]
    }
  ]
}

Ensure your evaluation is rigorous, objective, and quotes the candidate directly.
Respond with the JSON object only — no prose, no markdown fences.`;

      // Proctoring incidents are advisory context for the authenticity rating.
      // They are integrity signals, not evidence about technical ability, so the
      // model is told not to let them drive the technical scores.
      const proctoringContext = redFlags.length
        ? `\n\nProctoring incidents recorded during this session (integrity signal only — ` +
          `factor these into the "authenticity" rating and mention them in redFlags where ` +
          `warranted, but do NOT let them lower the technical or system-design scores):\n` +
          redFlags
            .map((f: any) => `- [${f.type}] at ${f.timeInSeconds}s: ${f.description}`)
            .join("\n")
        : "";

      try {
        const command = new ConverseCommand({
          modelId: EVALUATION_MODEL_ID,
          system: [{ text: systemPrompt }],
          messages: [
            {
              role: "user",
              content: [
                {
                  text: `Here is the full recorded transcript of the interview session:\n\n${formattedTranscript}${proctoringContext}`,
                },
              ],
            },
          ],
          inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
        });

        const aiData = await bedrockClient.send(command);
        const content = aiData.output?.message?.content?.[0]?.text;

        if (!content) {
          throw new Error("Bedrock returned an empty evaluation response.");
        }

        const parsedEvaluation: ScorecardEvaluation = extractJson(content);
        parsedEvaluation.durationSeconds = durationSeconds;
        parsedEvaluation.evaluatedAt = new Date().toISOString();
        parsedEvaluation.evaluationMode = "realtime_llm";
        parsedEvaluation.modelUsed = `${EVALUATION_MODEL_ID} (Amazon Bedrock, ${AWS_REGION})`;

        return res.json({
          success: true,
          evaluation: parsedEvaluation,
        });
      } catch (bedrockError: any) {
        // Expired workshop credentials are the most likely cause here. Rather
        // than 500 mid-demo, drop through to the deterministic rubric matcher.
        console.error(
          "[Evaluate] Bedrock call failed, falling back to deterministic matcher:",
          bedrockError?.name,
          bedrockError?.message
        );
      }
    }

    // Deterministic Fallback if Bedrock is unreachable
    const fullText = transcripts.map((t: any) => t.text).join(" ").toLowerCase();
    const mentionsRedis = fullText.includes("redis");
    const mentionsPostgres = fullText.includes("postgres") || fullText.includes("advisory") || fullText.includes("lock");
    const mentionsKafka = fullText.includes("kafka");
    const mentionsRateLimit = fullText.includes("rate") || fullText.includes("token") || fullText.includes("sliding");

    let score = 75;
    if (mentionsRedis) score += 6;
    if (mentionsPostgres) score += 6;
    if (mentionsKafka) score += 5;
    if (mentionsRateLimit) score += 5;
    score = Math.min(94, score);

    const verdict = score >= 85 ? "Strong Hire" : score >= 75 ? "Hire" : "Borderline";

    const deterministicEvaluation: ScorecardEvaluation = {
      verdict,
      overallScore: score,
      ratings: {
        technicalCompetence: (score / 20).toFixed(1) as unknown as number,
        systemDesign: ((score - 2) / 20).toFixed(1) as unknown as number,
        communication: 4.2,
        authenticity: 4.5,
      },
      summary: `Alex Doe demonstrated strong technical depth during the Round-0 evaluation. The candidate articulated the architectural merits of combining Redis sorted sets for delayed task scheduling with PostgreSQL advisory locks for distributed worker leasing, successfully handling race conditions.`,
      recommendationReason: `Strong recommendation to proceed to onsite System Design round. Technical foundations and distributed systems instincts are rock solid.`,
      keyStrengths: [
        {
          title: "Precision in Distributed Coordination",
          explanation:
            "Distinguished between session-level and transaction-level advisory locks in PostgreSQL, demonstrating practical production debugging experience.",
          evidenceQuote:
            candidateLines[0]?.text || "Addressed distributed worker coordination and concurrency locks.",
        },
        {
          title: "Architectural Pragmatism",
          explanation:
            "Clearly articulated why message brokers like Kafka are suboptimal for arbitrary delayed scheduling due to head-of-line blocking.",
        },
      ],
      redFlags: [
        {
          title: "Cluster Partition Edge Cases",
          explanation:
            "Would benefit from a deeper dive into network partition split-brain behavior on Redis Cluster with master failovers.",
        },
      ],
      directQuotes: candidateLines.slice(0, 3).map((line: any) => ({
        competency: "Technical Knowledge",
        quote: line.text,
        analysis: "Direct response reflecting hands-on implementation experience.",
        impact: "positive" as const,
      })),
      projectAssessments: [
        {
          projectName: "High-Throughput Job Scheduler",
          rating: 4.5,
          strengthsObserved: [
            "O(log N) delayed execution queue design",
            "PostgreSQL advisory locking preventing duplicate worker executions",
          ],
          unresolvedConcerns: ["Reclaim strategy on sudden node SIGKILL before ACK"],
        },
        {
          projectName: "Distributed Rate Limiter",
          rating: 4.0,
          strengthsObserved: ["Multi-tenant sliding window log and token bucket failover"],
          unresolvedConcerns: ["Cross-slot Lua script execution limits on Redis Cluster"],
        },
      ],
      durationSeconds: durationSeconds || 240,
      evaluatedAt: new Date().toISOString(),
      evaluationMode: "offline_simulation",
      modelUsed: "Deterministic Rubric Matcher (Bedrock Unreachable)",
    };

    return res.json({ success: true, evaluation: deterministicEvaluation });
  } catch (error: any) {
    console.error("Evaluation Route Error:", error);
    return res.status(500).json({
      error: "EVALUATION_FAILED",
      message: error?.message || "Failed to generate evaluation scorecard.",
    });
  }
});

const httpServer = createServer(app);

// Nova Sonic speech-to-speech relay shares the HTTP port at /ws/interview.
attachNovaSonicRelay(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[Round-0 Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Round-0 Backend] Voice relay at ws://localhost:${PORT}/ws/interview`);
  console.log(`[Round-0 Backend] Region ${AWS_REGION} | Voice ${SONIC_MODEL_ID}`);
});
