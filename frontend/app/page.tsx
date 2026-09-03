"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileText,
  User,
  Clock,
  Sparkles,
  ShieldCheck,
  ChevronRight,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Database,
  Eye,
  Target,
} from "lucide-react";
import {
  prepareInterview,
  extractPdfText,
  fetchContextPack,
  type QuestionBank,
  type ContextPackSummary,
} from "@/lib/api";

type Duration = 15 | 30 | 45;

const DURATION_COPY: Record<Duration, string> = {
  15: "1 project probe + 1 scenario. High-volume screening.",
  30: "2 project probes + 2 scenarios + a gap probe. Recommended.",
  45: "Adds a design & trade-off segment. Senior and staff roles.",
};

const KIND_STYLE: Record<string, { label: string; className: string }> = {
  resume_probe: {
    label: "Resume probe",
    className: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  },
  scenario: {
    label: "Org scenario",
    className: "bg-violet-500/10 text-violet-300 border-violet-500/30",
  },
  jd_gap: {
    label: "JD gap",
    className: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  },
};

/** Paste-or-upload input. Upload runs through the backend PDF extractor. */
function DocumentInput({
  label,
  hint,
  value,
  onChange,
  icon,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (text: string) => void;
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const text = await extractPdfText(file);
      onChange(text);
      setFileName(file.name);
    } catch (e: any) {
      setError(e?.message || "Could not read that file.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-2">
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          {icon}
          {label}
          {value.trim() && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
        </label>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400 hover:text-white transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          {busy ? "Reading…" : "Upload PDF"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        spellCheck={false}
        className="flex-1 min-h-[150px] w-full rounded-xl bg-slate-950/60 border border-slate-800 focus:border-slate-600 focus:outline-none p-3 text-[12px] leading-relaxed text-slate-200 placeholder:text-slate-600 resize-none font-mono"
      />

      <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
        <span>{fileName ? `From ${fileName}` : `${value.trim().length} characters`}</span>
        {error && <span className="text-red-400">{error}</span>}
      </div>
    </div>
  );
}

export default function SetupPage() {
  const router = useRouter();

  const [candidateName, setCandidateName] = useState("");
  const [duration, setDuration] = useState<Duration>(30);
  const [jdText, setJdText] = useState("");
  const [resumeText, setResumeText] = useState("");

  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bank, setBank] = useState<QuestionBank | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [grounded, setGrounded] = useState(false);
  const [pack, setPack] = useState<ContextPackSummary | null>(null);
  const [showPack, setShowPack] = useState(false);

  useEffect(() => {
    fetchContextPack()
      .then(setPack)
      .catch(() => setPack(null));
  }, []);

  const canPrepare = jdText.trim().length > 50 && resumeText.trim().length > 50 && !preparing;

  const handlePrepare = useCallback(async () => {
    setPreparing(true);
    setError(null);
    setBank(null);
    try {
      const result = await prepareInterview({
        jdText,
        resumeText,
        candidateName: candidateName.trim() || "the candidate",
        durationMinutes: duration,
      });
      setBank(result.bank);
      setSessionId(result.sessionId);
      setGrounded(result.grounded);
    } catch (e: any) {
      setError(e?.message || "Could not prepare the interview.");
    } finally {
      setPreparing(false);
    }
  }, [jdText, resumeText, candidateName, duration]);

  const startInterview = () => {
    if (!sessionId) return;
    router.push(`/interview?sessionId=${sessionId}`);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/40 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
              <Target className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight">Round-0 Screening</h1>
              <p className="text-[10px] text-slate-500">
                Org-grounded technical screening · Amazon Bedrock
              </p>
            </div>
          </div>

          <button
            onClick={() => setShowPack(true)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-medium border transition-colors ${
              pack?.approved
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20"
                : "bg-slate-800/60 border-slate-700 text-slate-400 hover:bg-slate-800"
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            {pack?.approved
              ? `Context Pack · ${pack.scenarios.length} scenarios`
              : "No Context Pack"}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[1fr_460px] gap-8 items-start">
        {/* ---------------- Setup ---------------- */}
        <section className="space-y-6">
          <div>
            <h2 className="text-lg font-bold">Prepare an interview</h2>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl">
              The job description sets what gets tested and the bar. The resume sets what gets
              probed. Your engineering context decides what the scenarios are made of. Nothing is
              hardcoded — change the JD and the entire interview changes.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-300 mb-2">
                <User className="w-3.5 h-3.5 text-slate-500" />
                Candidate name
              </label>
              <input
                value={candidateName}
                onChange={(e) => setCandidateName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                className="w-full rounded-xl bg-slate-950/60 border border-slate-800 focus:border-slate-600 focus:outline-none px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600"
              />
              <p className="mt-1.5 text-[10px] text-slate-500">
                Used by the interviewer to greet them by name.
              </p>
            </div>

            <div>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-300 mb-2">
                <Clock className="w-3.5 h-3.5 text-slate-500" />
                Interview length
              </label>
              <div className="grid grid-cols-3 gap-2">
                {([15, 30, 45] as Duration[]).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    className={`py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                      duration === d
                        ? "bg-indigo-500/15 border-indigo-500/50 text-indigo-300"
                        : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    {d} min
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-slate-500">{DURATION_COPY[duration]}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-[300px]">
            <DocumentInput
              label="Job description"
              hint="Paste the JD, or upload the PDF. This decides which competencies are tested and at what level."
              value={jdText}
              onChange={setJdText}
              icon={<FileText className="w-3.5 h-3.5 text-slate-500" />}
            />
            <DocumentInput
              label="Candidate resume"
              hint="Paste the resume, or upload the PDF. Claims here become things the interview verifies."
              value={resumeText}
              onChange={setResumeText}
              icon={<FileText className="w-3.5 h-3.5 text-slate-500" />}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={handlePrepare}
            disabled={!canPrepare}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 transition-colors shadow-lg shadow-indigo-600/20 disabled:shadow-none"
          >
            {preparing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Designing the interview…
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Generate interview plan
              </>
            )}
          </button>

          {preparing && (
            <p className="text-center text-[11px] text-slate-500">
              Reading the JD, mapping resume claims against requirements, and selecting grounded
              scenarios. Takes around a minute.
            </p>
          )}
        </section>

        {/* ---------------- Review ---------------- */}
        <aside className="lg:sticky lg:top-8">
          {!bank ? (
            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 p-8 text-center">
              <Eye className="w-8 h-8 mx-auto text-slate-700 mb-3" />
              <h3 className="text-sm font-semibold text-slate-400">Interview plan appears here</h3>
              <p className="text-[11px] text-slate-600 mt-2 max-w-xs mx-auto leading-relaxed">
                Every question is reviewable before the candidate ever joins. The interviewer
                receives only what you approve — it has no live access to Slack or Confluence.
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold truncate">{bank.role}</h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {bank.seniority} level · {bank.durationMinutes} min ·{" "}
                      {bank.questions.length} questions
                    </p>
                  </div>
                  {grounded && (
                    <span className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                      <ShieldCheck className="w-3 h-3" />
                      Grounded
                    </span>
                  )}
                </div>
              </div>

              <div className="max-h-[52vh] overflow-y-auto">
                {/* Rubric */}
                <div className="px-5 py-4 border-b border-slate-800/60">
                  <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-2">
                    Rubric
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {bank.rubric.map((axis) => (
                      <span
                        key={axis.name}
                        title={axis.strongSignal}
                        className={`px-2 py-1 rounded-lg text-[10px] font-medium border cursor-help ${
                          axis.generated
                            ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
                            : "bg-slate-800/60 text-slate-300 border-slate-700"
                        }`}
                      >
                        {axis.name}
                        {axis.generated && " ✦"}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-slate-600">
                    ✦ generated from this JD · bars calibrated to {bank.seniority} level
                  </p>
                </div>

                {/* Questions */}
                <div className="px-5 py-4 space-y-3 border-b border-slate-800/60">
                  <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                    Questions
                  </p>
                  {bank.questions.map((q, i) => {
                    const style = KIND_STYLE[q.kind] || KIND_STYLE.scenario;
                    return (
                      <div key={q.id || i} className="rounded-xl bg-slate-950/50 border border-slate-800 p-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${style.className}`}>
                            {style.label}
                          </span>
                          <span className="text-[10px] text-slate-500">{q.minutes} min</span>
                          {q.scenarioId && (
                            <span className="text-[9px] text-slate-600 font-mono truncate">
                              {q.scenarioId}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-200 leading-relaxed">{q.question}</p>
                        <p className="mt-1.5 text-[10px] text-slate-500 leading-relaxed">
                          <span className="text-slate-600">Looking for:</span> {q.intent}
                        </p>
                      </div>
                    );
                  })}
                </div>

                {/* Gaps */}
                {bank.unevidencedRequirements.length > 0 && (
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-2">
                      Requirements with no resume evidence
                    </p>
                    <ul className="space-y-1.5">
                      {bank.unevidencedRequirements.map((r, i) => (
                        <li key={i} className="flex gap-2 text-[11px] text-slate-400 leading-relaxed">
                          <span className="text-amber-500/60 shrink-0">•</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="px-5 py-4 border-t border-slate-800 bg-slate-950/40">
                <button
                  onClick={startInterview}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 transition-colors shadow-lg shadow-emerald-600/20"
                >
                  Start interview
                  <ChevronRight className="w-4 h-4" />
                </button>
                <p className="mt-2 text-center text-[10px] text-slate-500">
                  Camera and microphone are requested on the next screen.
                </p>
              </div>
            </div>
          )}
        </aside>
      </main>

      {/* Context pack inspector */}
      {showPack && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setShowPack(false)}
        >
          <div
            className="max-w-2xl w-full max-h-[80vh] bg-slate-900 rounded-2xl border border-slate-700 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-800">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Database className="w-4 h-4 text-slate-400" />
                Context Pack
              </h3>
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                Sanitized engineering scenarios derived from internal documentation. Identifiers,
                incident fingerprints and business logic are stripped before anything reaches an
                interview. The live interviewer holds no connection to Slack or Confluence — it
                cannot leak what it was never given.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-2">
              {!pack?.approved ? (
                <p className="text-xs text-slate-500">
                  No approved pack. Run{" "}
                  <code className="text-slate-400">npm run pack:build -- --approve</code> in the
                  backend. Interviews still work; scenarios fall back to the JD's technologies.
                </p>
              ) : (
                pack.scenarios.map((s) => (
                  <div key={s.id} className="rounded-xl bg-slate-950/50 border border-slate-800 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold text-slate-200">{s.title}</p>
                      <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                        d{s.difficulty}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] text-slate-500">
                      {s.stack.join(" · ")} — {s.constraints.join(", ")}
                    </p>
                  </div>
                ))
              )}
            </div>

            {pack?.approved && (
              <div className="px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500">
                {pack.sourceSummary?.map((s) => `${s.documentCount} ${s.source}`).join(" · ")} ·
                built {pack.generatedAt ? new Date(pack.generatedAt).toLocaleString() : "—"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
