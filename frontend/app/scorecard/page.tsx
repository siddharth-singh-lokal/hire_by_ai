"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { IntegrityAuditPanel } from "@/components/IntegrityAuditPanel";

/** Proctoring metadata written by the interview page when the session ends. */
function readStoredRedFlags(): any[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem("interview_red_flags") || "[]");
  } catch {
    return [];
  }
}

import {
  Award,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Quote,
  Layers,
  ArrowLeft,
  RotateCcw,
  Sparkles,
  Download,
  Share2,
  Clock,
  Briefcase,
  Cpu,
  ShieldCheck,
  TrendingUp,
  Key,
  Play,
  RefreshCw,
  Sliders,
} from "lucide-react";
import { ScorecardEvaluation, VerdictType } from "@/lib/scorecardTypes";
import { CANDIDATE_RESUME } from "@/lib/resumeData";

// Pre-configured real-world transcript scenarios for testing live dynamic scoring
const PRESET_SCENARIOS = {
  strong: {
    name: "Senior Distributed Architect (Strong Hire)",
    duration: 380,
    transcripts: [
      {
        sender: "interviewer",
        text: "Hello Alex, welcome to the Round-0 technical interview. Let's dive into your High-Throughput Job Scheduler. Can you walk me through how you orchestrate delayed execution and multi-worker deduplication?",
      },
      {
        sender: "candidate",
        text: "Hi Sarah. In our scheduler, delayed execution relies on Redis Sorted Sets with ZADD where the score is the epoch millisecond of when the task should fire. We poll via ZRANGEBYSCORE with LIMIT using atomic Lua scripts. For multi-node coordinator deduplication without table lock contention, we use PostgreSQL advisory locks (pg_try_advisory_xact_lock) so only the elected partition leader drains that partition.",
      },
      {
        sender: "interviewer",
        text: "What happens if a worker pulls a task from Redis and crashes before completing it or writing the result to PostgreSQL?",
      },
      {
        sender: "candidate",
        text: "That is a critical at-least-once failure mode. We implement a two-phase claim using a secondary processing sorted set. When a task is popped, its score is updated to (now + 30s visibility timeout). If the worker crashes, a watchdog process reclaims expired tasks back to the active queue. Furthermore, downstream job execution must be idempotent to prevent duplicate side effects.",
      },
      {
        sender: "interviewer",
        text: "In your distributed rate limiter, how do you handle sliding window counters when Redis cluster shards keys across multiple nodes?",
      },
      {
        sender: "candidate",
        text: "Redis Cluster prevents cross-slot Lua scripts unless keys share the same hash tag. We enforce single-hash-slot locality by wrapping tenant keys with braces like {tenant_42}:ratelimit. For endpoints with extreme throughput where sliding-window memory overhead is prohibitive, we automatically fallback to token buckets stored in Redis hashes.",
      },
    ],
  },
  borderline: {
    name: "Underprepared Candidate (Vague / Missing Concurrency)",
    duration: 210,
    transcripts: [
      {
        sender: "interviewer",
        text: "Hello Alex, welcome to the Round-0 technical interview. Let's dive into your High-Throughput Job Scheduler. Can you walk me through your architecture?",
      },
      {
        sender: "candidate",
        text: "Yeah, so we put jobs into Redis and then workers take them out and run them. We use PostgreSQL to save the user data.",
      },
      {
        sender: "interviewer",
        text: "How do you coordinate multiple workers so two workers don't execute the same job concurrently?",
      },
      {
        sender: "candidate",
        text: "We just query Redis and then delete it immediately. If two workers query at the same time, usually Redis is fast enough that it won't conflict.",
      },
      {
        sender: "interviewer",
        text: "What happens if Redis dies mid-execution, or a worker crashes while processing a job?",
      },
      {
        sender: "candidate",
        text: "We haven't had Redis crash in production yet, but if a worker dies, the client frontend just retries the request.",
      },
    ],
  },
};

export default function ScorecardPage() {
  const [evaluation, setEvaluation] = useState<ScorecardEvaluation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "projects" | "evidence" | "transcript">("overview");

  // Dynamic API Key & Scenario controls
  const [apiKey, setApiKey] = useState("");
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<"recorded" | "strong" | "borderline">("recorded");
  const [isReevaluating, setIsReevaluating] = useState(false);

  // Trigger evaluation request to backend
  const evaluateTranscripts = useCallback(
    async (transcriptsToEval: any[], duration: number, keyToUse?: string) => {
      try {
        setIsReevaluating(true);
        setError(null);

        const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
        const key = keyToUse || apiKey;

        const res = await fetch(`${backendUrl}/api/evaluate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "x-openai-api-key": key } : {}),
          },
          body: JSON.stringify({
            transcripts: transcriptsToEval,
            durationSeconds: duration,
            // Proctoring incidents inform the authenticity rating server-side.
            redFlags: readStoredRedFlags(),
            apiKey: key,
          }),
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.message || "Failed to compute evaluation scorecard.");
        }

        const data = await res.json();
        setEvaluation(data.evaluation);
        setTranscripts(transcriptsToEval);
      } catch (err: any) {
        console.error("Evaluation loading error:", err);
        setError(err.message || "An error occurred while generating the scorecard.");
      } finally {
        setIsReevaluating(false);
        setLoading(false);
      }
    },
    [apiKey]
  );

  // Initial load: check localStorage for recorded interview transcripts
  useEffect(() => {
    let savedTranscripts: any[] = [];
    let durationSeconds = 240;
    let savedKey = "";

    if (typeof window !== "undefined") {
      const raw = localStorage.getItem("interview_transcripts");
      if (raw) {
        try {
          savedTranscripts = JSON.parse(raw);
        } catch (e) {
          console.error("Failed to parse stored transcripts", e);
        }
      }
      const rawDur = localStorage.getItem("interview_duration");
      if (rawDur) {
        durationSeconds = parseInt(rawDur, 10) || 240;
      }
      const rawKey = localStorage.getItem("openai_api_key");
      if (rawKey) {
        savedKey = rawKey;
        setApiKey(savedKey);
      }
    }

    // If recorded transcripts exist, evaluate them. Otherwise, default to the Strong scenario preview
    if (savedTranscripts.length > 0) {
      setSelectedScenario("recorded");
      evaluateTranscripts(savedTranscripts, durationSeconds, savedKey);
    } else {
      setSelectedScenario("strong");
      evaluateTranscripts(PRESET_SCENARIOS.strong.transcripts, PRESET_SCENARIOS.strong.duration, savedKey);
    }
  }, [evaluateTranscripts]);

  // Handle Scenario Switch
  const handleSelectScenario = (scenarioKey: "recorded" | "strong" | "borderline") => {
    setSelectedScenario(scenarioKey);
    if (scenarioKey === "strong") {
      evaluateTranscripts(PRESET_SCENARIOS.strong.transcripts, PRESET_SCENARIOS.strong.duration);
    } else if (scenarioKey === "borderline") {
      evaluateTranscripts(PRESET_SCENARIOS.borderline.transcripts, PRESET_SCENARIOS.borderline.duration);
    } else {
      // Reload recorded from localStorage
      let recorded: any[] = [];
      let dur = 180;
      if (typeof window !== "undefined") {
        const raw = localStorage.getItem("interview_transcripts");
        if (raw) {
          try {
            recorded = JSON.parse(raw);
          } catch {}
        }
        dur = parseInt(localStorage.getItem("interview_duration") || "180", 10);
      }
      evaluateTranscripts(recorded, dur);
    }
  };

  const getVerdictStyles = (verdict?: VerdictType) => {
    switch (verdict) {
      case "Strong Hire":
        return {
          badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
          glow: "border-emerald-500/30 shadow-emerald-500/10",
          accent: "text-emerald-400",
        };
      case "Hire":
        return {
          badge: "bg-blue-500/20 text-blue-400 border-blue-500/30",
          glow: "border-blue-500/30 shadow-blue-500/10",
          accent: "text-blue-400",
        };
      case "Borderline":
        return {
          badge: "bg-amber-500/20 text-amber-400 border-amber-500/30",
          glow: "border-amber-500/30 shadow-amber-500/10",
          accent: "text-amber-400",
        };
      default:
        return {
          badge: "bg-rose-500/20 text-rose-400 border-rose-500/30",
          glow: "border-rose-500/30 shadow-rose-500/10",
          accent: "text-rose-400",
        };
    }
  };

  const styles = getVerdictStyles(evaluation?.verdict);

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins}m ${s}s`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6">
        <div className="w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center mb-6 relative">
          <Sparkles className="w-8 h-8 text-indigo-400 animate-spin" />
          <div className="absolute inset-0 rounded-2xl border border-indigo-400/40 animate-ping opacity-30" />
        </div>
        <h2 className="text-xl font-bold tracking-tight text-white mb-2">Synthesizing Technical Scorecard</h2>
        <p className="text-xs text-slate-400 max-w-sm text-center leading-relaxed mb-6">
          Principal AI Bar Raiser is evaluating technical competency, architecture trade-offs, and failure modes...
        </p>

        <div className="w-64 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 animate-pulse w-3/4 rounded-full" />
        </div>
      </div>
    );
  }

  if (error || !evaluation) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6">
        <div className="w-12 h-12 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center mb-4">
          <AlertTriangle className="w-6 h-6 text-rose-400" />
        </div>
        <h2 className="text-lg font-bold text-white mb-2">Scorecard Generation Failed</h2>
        <p className="text-xs text-slate-400 max-w-md text-center mb-6">{error || "No evaluation data available."}</p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleSelectScenario("strong")}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow-lg flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Load Sample Scorecard</span>
          </button>
          <Link
            href="/interview"
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 border border-slate-700 flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Return to Interview</span>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header Bar */}
      <header className="h-16 border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-4">
          <Link
            href="/interview"
            className="p-2 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            title="Back to Room"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-sm font-semibold text-white tracking-tight flex items-center gap-2">
              <span>Recruiter Evaluation Scorecard</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                Round-0 Technical
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Candidate: <span className="text-slate-200 font-medium">{CANDIDATE_RESUME.name}</span> • Senior Backend
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Evaluation Mode Indicator */}
          <div
            className={`hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${
              evaluation.evaluationMode === "realtime_llm"
                ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
                : "bg-amber-500/10 text-amber-300 border-amber-500/30"
            }`}
          >
            {evaluation.evaluationMode === "realtime_llm" ? (
              <>
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span>Live AI Evaluated ({evaluation.modelUsed || "gpt-4o-mini"})</span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>Offline Simulation (Add API Key for live AI)</span>
              </>
            )}
          </div>

          <button
            onClick={() => setIsKeyModalOpen(true)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1.5 transition-colors"
          >
            <Key className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">Set API Key</span>
          </button>

          <button
            onClick={() => window.print()}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1.5 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export / Print</span>
          </button>

          <Link
            href="/interview"
            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30 flex items-center gap-1.5 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Retake Interview</span>
          </Link>
        </div>
      </header>

      {/* Dynamic Scenario Bar */}
      <div className="bg-slate-900/40 border-b border-slate-800/80 px-6 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Sliders className="w-3.5 h-3.5 text-indigo-400" />
          <span className="font-semibold text-slate-300">Transcript Evaluation Studio:</span>
          <span className="text-slate-500">Test how different candidate responses produce different scores:</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleSelectScenario("recorded")}
            disabled={isReevaluating}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              selectedScenario === "recorded"
                ? "bg-indigo-600 text-white shadow"
                : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700"
            }`}
          >
            🎙️ Live Recorded Interview
          </button>
          <button
            onClick={() => handleSelectScenario("strong")}
            disabled={isReevaluating}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              selectedScenario === "strong"
                ? "bg-emerald-600 text-white shadow"
                : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700"
            }`}
          >
            ⭐ Strong Senior Candidate
          </button>
          <button
            onClick={() => handleSelectScenario("borderline")}
            disabled={isReevaluating}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              selectedScenario === "borderline"
                ? "bg-amber-600 text-white shadow"
                : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700"
            }`}
          >
            ⚠️ Borderline / Vague Candidate
          </button>
        </div>
      </div>

      {/* Main Container */}
      <div className="max-w-6xl w-full mx-auto p-6 flex-1 space-y-6">
        {/* Re-evaluating Overlay Banner */}
        {isReevaluating && (
          <div className="p-3 rounded-xl bg-indigo-950/60 border border-indigo-500/40 text-indigo-200 text-xs flex items-center gap-2.5 animate-pulse">
            <RefreshCw className="w-4 h-4 text-indigo-400 animate-spin" />
            <span>Re-evaluating transcript with backend bar-raiser model...</span>
          </div>
        )}

        {/* Executive Verdict Hero Banner */}
        <div
          className={`p-6 md:p-8 rounded-3xl bg-slate-900/80 border ${styles.glow} backdrop-blur-xl shadow-2xl relative overflow-hidden`}
        >
          <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />

          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative z-10">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className={`text-xs uppercase font-extrabold px-3 py-1 rounded-full border ${styles.badge}`}>
                  {evaluation.verdict}
                </span>
                <span className="text-xs text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-slate-500" />
                  Duration: {formatDuration(evaluation.durationSeconds)}
                </span>
                <span className="text-xs text-slate-400 flex items-center gap-1.5">
                  <Briefcase className="w-3.5 h-3.5 text-slate-500" />
                  Lead Architect: Sarah Chen
                </span>
              </div>

              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white mt-1">
                Candidate Evaluation: {CANDIDATE_RESUME.name}
              </h2>
              <p className="text-xs md:text-sm text-slate-300 mt-2 max-w-2xl leading-relaxed">
                {evaluation.recommendationReason}
              </p>
            </div>

            {/* Overall Score Dial */}
            <div className="shrink-0 flex flex-col items-center justify-center p-4 rounded-2xl bg-slate-950/80 border border-slate-800 shadow-inner w-36 text-center">
              <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Overall Rating</span>
              <div className="text-4xl font-extrabold tracking-tight mt-1 text-white flex items-baseline">
                {evaluation.overallScore}
                <span className="text-xs font-medium text-slate-500 ml-1">/100</span>
              </div>
              <div className="w-full bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400"
                  style={{ width: `${evaluation.overallScore}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Quantitative Competency Ratings Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-400 font-medium">Technical Depth</span>
              <Cpu className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="text-2xl font-bold text-white mt-1 flex items-baseline gap-1">
              {evaluation.ratings.technicalCompetence}
              <span className="text-xs font-normal text-slate-500">/ 5.0</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Locks, Concurrency & DB MVCC</p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-400 font-medium">System Design</span>
              <Layers className="w-4 h-4 text-blue-400" />
            </div>
            <div className="text-2xl font-bold text-white mt-1 flex items-baseline gap-1">
              {evaluation.ratings.systemDesign}
              <span className="text-xs font-normal text-slate-500">/ 5.0</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Redis vs Kafka, Cluster Shards</p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-400 font-medium">Communication</span>
              <TrendingUp className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold text-white mt-1 flex items-baseline gap-1">
              {evaluation.ratings.communication}
              <span className="text-xs font-normal text-slate-500">/ 5.0</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Conciseness & Active Listening</p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-400 font-medium">Authenticity</span>
              <ShieldCheck className="w-4 h-4 text-purple-400" />
            </div>
            <div className="text-2xl font-bold text-white mt-1 flex items-baseline gap-1">
              {evaluation.ratings.authenticity}
              <span className="text-xs font-normal text-slate-500">/ 5.0</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Production Nuance & Integrity</p>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
              activeTab === "overview"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            Executive Summary
          </button>
          <button
            onClick={() => setActiveTab("projects")}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
              activeTab === "projects"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            Project Deep Dive
          </button>
          <button
            onClick={() => setActiveTab("evidence")}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
              activeTab === "evidence"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            Transcript Evidence ({evaluation.directQuotes.length})
          </button>
          <button
            onClick={() => setActiveTab("transcript")}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
              activeTab === "transcript"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            Full Dialogue Log ({transcripts.length})
          </button>
        </div>

        {/* TAB 1: EXECUTIVE SUMMARY */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Proctoring audit: recording + incident timeline */}
            <IntegrityAuditPanel />

            {/* Committee Summary */}
            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                <span>Hiring Committee Summary</span>
              </h3>
              <p className="text-xs md:text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                {evaluation.summary}
              </p>
            </div>

            {/* Strengths & Red Flags Two-Column */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Key Strengths */}
              <div className="p-6 rounded-2xl bg-slate-900/60 border border-emerald-900/30 space-y-4">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Key Strengths Observed</span>
                </div>
                <div className="space-y-3">
                  {evaluation.keyStrengths.map((s, idx) => (
                    <div key={idx} className="p-3.5 rounded-xl bg-slate-950/60 border border-emerald-500/20">
                      <h4 className="text-xs font-semibold text-emerald-300">{s.title}</h4>
                      <p className="text-xs text-slate-300 mt-1 leading-relaxed">{s.explanation}</p>
                      {s.evidenceQuote && (
                        <div className="mt-2 text-[11px] italic text-emerald-400/80 border-l-2 border-emerald-500/40 pl-2">
                          "{s.evidenceQuote}"
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Red Flags & Areas for Improvement */}
              <div className="p-6 rounded-2xl bg-slate-900/60 border border-amber-900/30 space-y-4">
                <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Flags & Areas for Probing</span>
                </div>
                <div className="space-y-3">
                  {evaluation.redFlags.map((rf, idx) => (
                    <div key={idx} className="p-3.5 rounded-xl bg-slate-950/60 border border-amber-500/20">
                      <h4 className="text-xs font-semibold text-amber-300">{rf.title}</h4>
                      <p className="text-xs text-slate-300 mt-1 leading-relaxed">{rf.explanation}</p>
                      {rf.evidenceQuote && (
                        <div className="mt-2 text-[11px] italic text-amber-400/80 border-l-2 border-amber-500/40 pl-2">
                          "{rf.evidenceQuote}"
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: PROJECT DEEP DIVE */}
        {activeTab === "projects" && (
          <div className="space-y-4">
            {evaluation.projectAssessments.map((proj, idx) => (
              <div key={idx} className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-base font-bold text-white">{proj.projectName}</h3>
                    <p className="text-xs text-slate-400">Project Specific Deep Dive Assessment</p>
                  </div>
                  <div className="px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 text-xs font-bold">
                    Rating: {proj.rating} / 5.0
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                  <div className="p-4 rounded-xl bg-slate-950/50 border border-slate-800">
                    <h4 className="text-xs font-semibold text-emerald-400 mb-2">Strengths Confirmed</h4>
                    <ul className="space-y-1.5 text-xs text-slate-300">
                      {proj.strengthsObserved.map((s, sIdx) => (
                        <li key={sIdx} className="flex items-start gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-950/50 border border-slate-800">
                    <h4 className="text-xs font-semibold text-amber-400 mb-2">Unresolved Architectural Concerns</h4>
                    <ul className="space-y-1.5 text-xs text-slate-300">
                      {proj.unresolvedConcerns.map((c, cIdx) => (
                        <li key={cIdx} className="flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* TAB 3: TRANSCRIPT EVIDENCE */}
        {activeTab === "evidence" && (
          <div className="space-y-4">
            {evaluation.directQuotes.map((q, idx) => (
              <div key={idx} className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-start gap-4">
                <div className="w-8 h-8 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Quote className="w-4 h-4 text-indigo-400" />
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-indigo-300">{q.competency}</span>
                    <span
                      className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                        q.impact === "positive"
                          ? "bg-emerald-500/20 text-emerald-400"
                          : q.impact === "negative"
                          ? "bg-rose-500/20 text-rose-400"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {q.impact} Signal
                    </span>
                  </div>
                  <blockquote className="text-xs text-slate-200 italic border-l-2 border-slate-700 pl-3">
                    "{q.quote}"
                  </blockquote>
                  <p className="text-xs text-slate-400">{q.analysis}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* TAB 4: FULL TRANSCRIPT */}
        {activeTab === "transcript" && (
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
              Complete Conversational Audit Log
            </h3>
            {transcripts.length === 0 ? (
              <p className="text-xs text-slate-500">No transcripts recorded for this session.</p>
            ) : (
              transcripts.map((item, idx) => {
                const isCandidate = item.sender === "candidate";
                return (
                  <div
                    key={idx}
                    className={`p-3 rounded-xl text-xs ${
                      isCandidate
                        ? "bg-emerald-950/20 border border-emerald-900/40 text-emerald-200 ml-6"
                        : "bg-indigo-950/20 border border-indigo-900/40 text-indigo-200 mr-6"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1 font-bold text-[10px]">
                      <span className={isCandidate ? "text-emerald-400" : "text-indigo-400"}>
                        {isCandidate ? "Alex Doe (Candidate)" : "Sarah Chen (Interviewer)"}
                      </span>
                      <span className="text-slate-500 font-mono text-[9px]">
                        {item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : `Turn #${idx + 1}`}
                      </span>
                    </div>
                    <p className="leading-relaxed whitespace-pre-wrap">{item.text}</p>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* API Key Modal */}
      {isKeyModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
                <Key className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">OpenAI API Key for Real-Time Scoring</h3>
                <p className="text-xs text-slate-400">Uses gpt-4o-mini with structured JSON bar-raising</p>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              Enter your key to dynamically score the current candidate transcript using live LLM reasoning:
            </p>

            <input
              type="password"
              placeholder="sk-proj-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono mb-4"
            />

            <div className="flex items-center justify-end gap-2.5">
              <button
                onClick={() => setIsKeyModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setIsKeyModalOpen(false);
                  if (typeof window !== "undefined" && apiKey) {
                    localStorage.setItem("openai_api_key", apiKey);
                  }
                  evaluateTranscripts(transcripts, evaluation.durationSeconds, apiKey);
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30"
              >
                Save & Run Live AI Evaluation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
