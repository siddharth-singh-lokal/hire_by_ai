"use client";

import React, { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Quote,
  Target,
  Scale,
  ClipboardList,
  RotateCcw,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { IntegrityAuditPanel } from "@/components/IntegrityAuditPanel";
import { fetchScorecard, regradeInterview, recordingUrl, BACKEND_URL } from "@/lib/api";
import { englishQuote } from "@/lib/englishQuote";
import type { RedFlag } from "@/lib/sessionStore";

const GAP_STYLE: Record<string, { icon: React.ReactNode; className: string }> = {
  evidenced: {
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    className: "text-emerald-400",
  },
  partial: { icon: <MinusCircle className="w-3.5 h-3.5" />, className: "text-amber-400" },
  unevidenced: { icon: <MinusCircle className="w-3.5 h-3.5" />, className: "text-slate-500" },
  contradicted: { icon: <XCircle className="w-3.5 h-3.5" />, className: "text-rose-400" },
};

const ACCURACY_STYLE: Record<
  string,
  { label: string; className: string; border: string }
> = {
  correct: {
    label: "Correct",
    className: "text-emerald-300 bg-emerald-500/10",
    border: "border-emerald-500/25",
  },
  mostly_correct: {
    label: "Mostly correct",
    className: "text-teal-300 bg-teal-500/10",
    border: "border-teal-500/25",
  },
  partial: {
    label: "Partial",
    className: "text-amber-300 bg-amber-500/10",
    border: "border-amber-500/25",
  },
  incorrect: {
    label: "Incorrect",
    className: "text-rose-300 bg-rose-500/10",
    border: "border-rose-500/25",
  },
  not_established: {
    label: "Not assessed",
    className: "text-slate-400 bg-slate-800/50",
    border: "border-slate-700",
  },
};

const KIND_LABEL: Record<string, string> = {
  resume_probe: "Resume",
  technical: "Technical",
  market: "Market (web)",
  jd_gap: "JD gap",
  scenario: "Scenario",
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function ScoreBar({ score }: { score: number }) {
  const pct = (Math.max(0, Math.min(5, score)) / 5) * 100;
  const tone =
    score >= 4 ? "bg-emerald-400" : score >= 3 ? "bg-amber-400" : "bg-rose-400";
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Scorecard() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId");

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [generic, setGeneric] = useState<any>(null);
  const [transcripts, setTranscripts] = useState<any[]>([]);
  const [flags, setFlags] = useState<RedFlag[]>([]);
  const [hasRecording, setHasRecording] = useState(false);
  const [tab, setTab] = useState<"answers" | "evidence" | "gaps" | "transcript">("answers");

  const run = useCallback(async () => {
    if (!sessionId) {
      setError("No interview selected. Open a scorecard from the admin console.");
      setLoading(false);
      return;
    }

    setError(null);
    try {
      const result = await fetchScorecard(sessionId);
      setStatus(result.status);

      if (result.status === "completed" && result.evaluation) {
        setEvaluation(result.evaluation);
        setGeneric(result.genericComparison || null);
        setTranscripts(result.transcripts || []);
        setHasRecording(Boolean(result.hasRecording));
        setFlags(
          (result.redFlags || []).map((f, i) => ({
            id: `flag_${i}`,
            type: f.type,
            description: f.description,
            timestamp: 0,
            timeInSeconds: f.timeInSeconds,
            snapshotUrl: f.snapshot ?? null,
            clipUrl: f.clip ?? null,
          })) as RedFlag[]
        );
        setLoading(false);
      } else if (result.status === "failed") {
        setError(result.message || "Grading failed for this interview.");
        setTranscripts(result.transcripts || []);
        setLoading(false);
      } else {
        // Still running or grading — grading takes about a minute, so poll.
        setLoading(true);
      }
    } catch (e: any) {
      setError(e?.message || "Could not load the scorecard.");
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    run();
  }, [run]);

  // Poll while the interview is still in progress or being graded.
  useEffect(() => {
    if (!loading || !sessionId) return;
    const t = setInterval(run, 5000);
    return () => clearInterval(t);
  }, [loading, sessionId, run]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-4 text-slate-400">
        <Loader2 className="w-7 h-7 animate-spin text-indigo-400" />
        <div className="text-center">
          <p className="text-sm font-medium text-slate-300">
            {status === "in_progress" || status === "ready"
              ? "Interview still in progress"
              : "Grading the interview"}
          </p>
          <p className="text-xs text-slate-500 mt-1 max-w-sm">
            {status === "in_progress" || status === "ready"
              ? "The scorecard appears here automatically once the candidate finishes."
              : "Scoring against the rubric this interview was designed around, and re-scoring with a generic rubric for comparison. Takes about a minute."}
          </p>
        </div>
      </div>
    );
  }

  if (error || !evaluation) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-4 p-6">
        <AlertCircle className="w-8 h-8 text-rose-400" />
        <p className="text-sm text-slate-300 max-w-md text-center">{error}</p>
        <div className="flex gap-3">
          {sessionId && (
            <button
              onClick={async () => {
                setError(null);
                setLoading(true);
                await regradeInterview(sessionId).catch(() => {});
                run();
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Re-grade
            </button>
          )}
          <Link
            href="/admin"
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500"
          >
            Back to admin
          </Link>
        </div>
      </div>
    );
  }

  const briefing = evaluation.r1Briefing || { skip: [], probe: [], suggestedOpener: "" };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800/80 bg-slate-900/40 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <Link href="/admin" className="text-slate-500 hover:text-white shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="min-w-0">
              <h1 className="text-sm font-bold truncate">
                {evaluation.candidateName || "Candidate"}
              </h1>
              <p className="text-[10px] text-slate-500 truncate">
                {evaluation.role || "Round-0 screen"}
                {evaluation.seniority ? ` · ${evaluation.seniority}` : ""} ·{" "}
                {formatTime(evaluation.durationSeconds || 0)}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-8 items-start">
        <div className="space-y-6 min-w-0">
          {/* Call quality — shown before anything else when the platform, not the
              candidate, shaped this transcript. A recruiter must never reject
              someone because the voice stream dropped four times. */}
          {(evaluation.rescreenRecommended ||
            (evaluation.screenQuality && evaluation.screenQuality !== "clean")) && (
            <section
              className={`p-4 rounded-2xl border flex gap-3 ${
                evaluation.screenQuality === "compromised"
                  ? "bg-rose-500/10 border-rose-500/40"
                  : "bg-amber-500/10 border-amber-500/40"
              }`}
            >
              <AlertCircle
                className={`w-5 h-5 shrink-0 mt-0.5 ${
                  evaluation.screenQuality === "compromised" ? "text-rose-300" : "text-amber-300"
                }`}
              />
              <div className="min-w-0">
                <p
                  className={`text-xs font-bold ${
                    evaluation.screenQuality === "compromised" ? "text-rose-200" : "text-amber-200"
                  }`}
                >
                  {evaluation.screenQuality === "compromised"
                    ? "This screen was compromised by connection problems"
                    : evaluation.screenQuality === "degraded"
                    ? "This screen had connection problems"
                    : "This screen did not gather enough to judge"}
                  {typeof evaluation.streamDrops === "number" && evaluation.streamDrops > 0
                    ? ` — the voice stream dropped ${evaluation.streamDrops} time${
                        evaluation.streamDrops === 1 ? "" : "s"
                      }`
                    : ""}
                  {evaluation.rescreenRecommended ? ". Re-screen recommended." : "."}
                </p>
                {evaluation.screenQualityNote && (
                  <p className="mt-1 text-[11px] text-slate-300 leading-relaxed">
                    {evaluation.screenQualityNote}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-slate-500 leading-relaxed">
                  Read the verdict as provisional. Fragmented answers, repeated questions and
                  "hello, can you hear me?" around the drops are the platform, not the candidate.
                </p>
              </div>
            </section>
          )}

          {/* Summary */}
          <section className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800">
            <h2 className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-2">
              What this interview established
            </h2>
            <p className="text-sm text-slate-200 leading-relaxed">{evaluation.summary}</p>
            {evaluation.recommendationReason && (
              <p className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-400 leading-relaxed">
                {evaluation.recommendationReason}
              </p>
            )}
          </section>

          {/* Rubric */}
          <section className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800">
            <h2 className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-4">
              Rubric — calibrated to {evaluation.seniority || "this"} level
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              {(evaluation.axisScores || []).map((axis: any) => (
                <div key={axis.axis}>
                  <div className="flex items-baseline justify-between gap-2 mb-1.5">
                    <span className="text-xs font-medium text-slate-200 truncate">
                      {axis.axis}
                    </span>
                    <span className="text-xs font-bold text-slate-400 shrink-0">
                      {axis.score}/5
                    </span>
                  </div>
                  <ScoreBar score={axis.score} />
                  <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed">
                    {axis.justification}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Tabs */}
          <section className="rounded-2xl bg-slate-900/50 border border-slate-800 overflow-hidden">
            <div className="flex border-b border-slate-800">
              {(
                [
                  ["answers", "Answer check"],
                  ["evidence", "Evidence"],
                  ["gaps", "JD coverage"],
                  ["transcript", "Transcript"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`px-5 py-3 text-xs font-semibold transition-colors ${
                    tab === key
                      ? "text-white border-b-2 border-indigo-500"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="p-5">
              {tab === "answers" && (
                <div className="space-y-4">
                  {(evaluation.questionReviews || []).length === 0 && (
                    <p className="text-xs text-slate-500">
                      No per-question validation yet — click Regrade on a completed interview to
                      generate it.
                    </p>
                  )}
                  {(evaluation.questionReviews || []).map((r: any, i: number) => {
                    const style = ACCURACY_STYLE[r.accuracy] || ACCURACY_STYLE.not_established;
                    return (
                      <div
                        key={r.questionId || i}
                        className={`p-4 rounded-xl border ${style.border} bg-slate-950/40`}
                      >
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <span
                            className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${style.className}`}
                          >
                            {style.label}
                          </span>
                          <span className="text-[10px] text-slate-600 uppercase tracking-wide">
                            {KIND_LABEL[r.kind] || r.kind}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed font-medium">
                          {r.question}
                        </p>
                        {r.summary && (
                          <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
                            {r.summary}
                          </p>
                        )}
                        {r.candidateQuote && (
                          <p className="mt-2 text-xs text-slate-200 italic leading-relaxed flex gap-2">
                            <Quote className="w-3 h-3 shrink-0 mt-0.5 text-slate-600" />
                            <span>{r.candidateQuote}</span>
                          </p>
                        )}
                        {r.whatTheyGotRight?.length > 0 && (
                          <ul className="mt-3 space-y-1">
                            {r.whatTheyGotRight.map((line: string, j: number) => (
                              <li
                                key={j}
                                className="text-[11px] text-emerald-400/90 flex gap-2 leading-relaxed"
                              >
                                <CheckCircle2 className="w-3 h-3 shrink-0 mt-0.5" />
                                {line}
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.gapsOrErrors?.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {r.gapsOrErrors.map((line: string, j: number) => (
                              <li
                                key={j}
                                className="text-[11px] text-rose-400/90 flex gap-2 leading-relaxed"
                              >
                                <XCircle className="w-3 h-3 shrink-0 mt-0.5" />
                                {line}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {tab === "evidence" && (
                <div className="space-y-3">
                  {(evaluation.evidenceMoments || []).length === 0 && (
                    <p className="text-xs text-slate-500">No evidence moments recorded.</p>
                  )}
                  {(evaluation.evidenceMoments || []).map((m: any, i: number) => {
                    const quoteEn = englishQuote(m.quote, transcripts, {
                      speaker: m.speaker,
                      timeInSeconds: m.timeInSeconds,
                    });
                    return (
                    <div
                      key={i}
                      className={`p-3 rounded-xl border ${
                        m.impact === "positive"
                          ? "bg-emerald-500/5 border-emerald-500/20"
                          : m.impact === "negative"
                          ? "bg-rose-500/5 border-rose-500/20"
                          : "bg-slate-950/40 border-slate-800"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[10px] font-mono text-slate-500">
                          {formatTime(m.timeInSeconds)}
                        </span>
                        <span className="text-[10px] text-slate-600 capitalize">{m.speaker}</span>
                      </div>
                      <p className="text-xs text-slate-200 leading-relaxed flex gap-2">
                        <Quote className="w-3 h-3 shrink-0 mt-1 text-slate-600" />
                        <span className="italic">{quoteEn}</span>
                      </p>
                      {quoteEn !== m.quote && (
                        <p className="mt-1.5 pl-5 text-[11px] text-slate-500 italic leading-relaxed">
                          {m.quote}
                        </p>
                      )}
                      <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                        {m.significance}
                      </p>
                    </div>
                    );
                  })}
                </div>
              )}

              {tab === "gaps" && (
                <div className="space-y-2">
                  {(evaluation.gapMatrix || []).map((row: any, i: number) => {
                    const style = GAP_STYLE[row.status] || GAP_STYLE.unevidenced;
                    return (
                      <div
                        key={i}
                        className="flex gap-3 p-3 rounded-xl bg-slate-950/40 border border-slate-800"
                      >
                        <span className={`shrink-0 mt-0.5 ${style.className}`}>{style.icon}</span>
                        <div className="min-w-0">
                          <p className="text-xs text-slate-200 leading-snug">{row.requirement}</p>
                          <p className="mt-1 text-[11px] text-slate-500 leading-relaxed">
                            <span className={`font-semibold ${style.className}`}>
                              {row.status}
                            </span>
                            {" — "}
                            {row.finding}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {tab === "transcript" && (
                <div className="space-y-3 max-h-[500px] overflow-y-auto">
                  {transcripts.map((t: any, i: number) => (
                    <div key={i} className="flex gap-3">
                      <span
                        className={`shrink-0 text-[10px] font-semibold w-20 pt-0.5 ${
                          t.sender === "candidate" ? "text-sky-400" : "text-violet-400"
                        }`}
                      >
                        {t.sender === "candidate" ? "Candidate" : "Interviewer"}
                      </span>
                      <div className="min-w-0">
                        {/* Show English when the interview was in another language;
                            keep the verbatim original beneath it for evidence. */}
                        <p className="text-xs text-slate-300 leading-relaxed">
                          {t.textEn || t.text}
                        </p>
                        {t.textEn && t.textEn !== t.text && (
                          <p className="text-[11px] text-slate-500 leading-relaxed mt-0.5 italic">
                            {t.text}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ------------- Right rail ------------- */}
        <aside className="space-y-6 lg:sticky lg:top-24">
          {/* R1 briefing — the thing that actually saves engineer time */}
          <section className="rounded-2xl border border-indigo-500/30 bg-indigo-500/5 overflow-hidden">
            <div className="px-5 py-4 border-b border-indigo-500/20">
              <h2 className="text-sm font-bold flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-indigo-400" />
                Round-1 briefing
              </h2>
              <p className="text-[11px] text-slate-400 mt-1">
                Hand this to whoever runs the human round.
              </p>
            </div>

            <div className="p-5 space-y-4">
              {briefing.skip?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase font-bold text-emerald-400 tracking-wider mb-2">
                    Already covered — don't re-ask
                  </p>
                  <ul className="space-y-1.5">
                    {briefing.skip.map((s: any, i: number) => (
                      <li key={i} className="text-[11px] text-slate-300 leading-relaxed">
                        <span className="font-medium">{s.topic}</span>
                        <span className="text-slate-500"> — {s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {briefing.probe?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase font-bold text-amber-400 tracking-wider mb-2">
                    Spend the hour here
                  </p>
                  <ul className="space-y-2.5">
                    {briefing.probe.map((p: any, i: number) => (
                      <li key={i} className="text-[11px] leading-relaxed">
                        <span className="font-medium text-slate-200">{p.topic}</span>
                        <span className="text-slate-500"> — {p.reason}</span>
                        {p.suggestedQuestion && (
                          <p className="mt-1 pl-2 border-l-2 border-slate-700 text-slate-400 italic">
                            "{p.suggestedQuestion}"
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {briefing.suggestedOpener && (
                <div className="pt-3 border-t border-indigo-500/20">
                  <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-1.5">
                    Suggested opener
                  </p>
                  <p className="text-[11px] text-slate-300 italic leading-relaxed">
                    "{briefing.suggestedOpener}"
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Counterfactual — deliberately a small footnote. The verdict in the
              header is the real one; this is only a baseline to show the org
              grounding is doing real work, and must never read as the decision. */}
          {generic && (
            <section className="rounded-xl border border-slate-800/70 bg-slate-900/30 p-4">
              <p className="text-[10px] uppercase font-bold text-slate-600 tracking-wider mb-1.5">
                Sanity-check baseline · not the decision
              </p>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                A generic rubric that knows nothing about this role would read this transcript
                as{" "}
                <span className="text-slate-400 font-medium">{generic.verdict}</span>. The
                verdict to trust is{" "}
                <span className="text-slate-300 font-medium">{evaluation.verdict}</span> — the
                one calibrated to this JD. The gap is the value the org grounding adds; it is not
                a second opinion to average in.
              </p>
            </section>
          )}

          <IntegrityAuditPanel
            flags={flags}
            recordingSrc={hasRecording && sessionId ? recordingUrl(sessionId) : null}
          />

          <p className="text-[10px] text-slate-600 leading-relaxed px-1">
            Evidence for a human decision — not a hiring decision. Assessed by{" "}
            {evaluation.modelUsed || "Amazon Bedrock"} against {BACKEND_URL.replace(/^https?:\/\//, "")}.
          </p>
        </aside>
      </main>
    </div>
  );
}


export default function ScorecardPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500 text-sm">
          Loading…
        </div>
      }
    >
      <Scorecard />
    </Suspense>
  );
}
