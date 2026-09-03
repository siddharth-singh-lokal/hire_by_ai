"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Upload,
  FileText,
  User,
  Mail,
  Clock,
  Sparkles,
  ShieldCheck,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Database,
  Plus,
  Users,
  Copy,
  Check,
  Languages,
} from "lucide-react";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import {
  prepareInterview,
  extractPdfText,
  fetchContextPack,
  listAdminSessions,
  type QuestionBank,
  type ContextPackSummary,
  type AdminSessionRow,
} from "@/lib/api";

type Duration = 1 | 5 | 15 | 30 | 45;

const DURATION_COPY: Record<Duration, string> = {
  1: "Smoke test — one quick question. For checking the flow end to end.",
  5: "Demo length. One claim to verify, one problem to reason about.",
  15: "1 project probe + 1 scenario + 1 gap probe. High-volume screening.",
  30: "2 project probes + 2 scenarios + a gap probe. Recommended.",
  45: "Adds a design and trade-off segment. Senior and lead roles.",
};

const KIND_STYLE: Record<string, { label: string; className: string }> = {
  resume_probe: { label: "Resume probe", className: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  scenario: { label: "Org scenario", className: "bg-violet-500/10 text-violet-300 border-violet-500/30" },
  jd_gap: { label: "JD gap", className: "bg-amber-500/10 text-amber-300 border-amber-500/30" },
};

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-slate-700/50 text-slate-300",
  in_progress: "bg-sky-500/15 text-sky-300",
  grading: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  terminated: "bg-rose-500/15 text-rose-300",
};

function DocumentInput({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (text: string) => void;
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
      onChange(await extractPdfText(file));
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
          <FileText className="w-3.5 h-3.5 text-slate-500" />
          {label}
          {value.trim() && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
        </label>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400 hover:text-white disabled:opacity-50"
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
        className="flex-1 min-h-[140px] w-full rounded-xl bg-slate-950/60 border border-slate-800 focus:border-slate-600 focus:outline-none p-3 text-[12px] leading-relaxed text-slate-200 placeholder:text-slate-600 resize-none font-mono"
      />
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
        <span>{fileName ? `From ${fileName}` : `${value.trim().length} characters`}</span>
        {error && <span className="text-red-400">{error}</span>}
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [tab, setTab] = useState<"new" | "interviews">("new");

  const [candidateName, setCandidateName] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [duration, setDuration] = useState<Duration>(15);
  const [language, setLanguage] = useState<string>("en");
  const [jdText, setJdText] = useState("");
  const [resumeText, setResumeText] = useState("");

  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bank, setBank] = useState<QuestionBank | null>(null);
  const [preparedEmail, setPreparedEmail] = useState<string | null>(null);
  const [grounded, setGrounded] = useState(false);
  const [copied, setCopied] = useState(false);

  const [pack, setPack] = useState<ContextPackSummary | null>(null);
  const [showPack, setShowPack] = useState(false);
  const [sessions, setSessions] = useState<AdminSessionRow[]>([]);

  useEffect(() => {
    fetchContextPack().then(setPack).catch(() => setPack(null));
  }, []);

  const refreshSessions = useCallback(() => {
    listAdminSessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    if (tab !== "interviews") return;
    refreshSessions();
    // Grading takes about a minute and finishes on its own, so keep the list
    // live rather than making the recruiter reload to find out.
    const t = setInterval(refreshSessions, 8000);
    return () => clearInterval(t);
  }, [tab, refreshSessions]);

  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidateEmail.trim());
  const canPrepare =
    jdText.trim().length > 50 &&
    resumeText.trim().length > 50 &&
    validEmail &&
    candidateName.trim().length > 0 &&
    !preparing;

  const handlePrepare = async () => {
    setPreparing(true);
    setError(null);
    setBank(null);
    try {
      const result = await prepareInterview({
        jdText,
        resumeText,
        candidateName: candidateName.trim(),
        candidateEmail: candidateEmail.trim(),
        durationMinutes: duration,
        language,
      });
      setBank(result.bank);
      setPreparedEmail(result.candidateEmail);
      setGrounded(result.grounded);
      refreshSessions();
    } catch (e: any) {
      setError(e?.message || "Could not prepare the interview.");
    } finally {
      setPreparing(false);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.origin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800/80 bg-slate-900/40 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div>
            <h1 className="text-sm font-bold">Round-0 · Admin</h1>
            <p className="text-[10px] text-slate-500">Prepare and review screening interviews</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowPack(true)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-medium border ${
                pack?.approved
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-slate-800/60 border-slate-700 text-slate-400"
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {pack?.approved ? `Context Pack · ${pack.scenarios.length}` : "No Context Pack"}
            </button>
            <Link href="/" className="text-[11px] text-slate-500 hover:text-slate-300">
              Candidate view →
            </Link>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1">
          {(
            [
              ["new", "New interview", <Plus key="p" className="w-3.5 h-3.5" />],
              ["interviews", "All interviews", <Users key="u" className="w-3.5 h-3.5" />],
            ] as const
          ).map(([key, label, icon]) => (
            <button
              key={key}
              onClick={() => setTab(key as "new" | "interviews")}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                tab === key
                  ? "text-white border-indigo-500"
                  : "text-slate-500 border-transparent hover:text-slate-300"
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {tab === "new" ? (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_440px] gap-8 items-start">
            <section className="space-y-5">
              <div>
                <h2 className="text-base font-bold">Prepare an interview</h2>
                <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
                  The JD sets what gets tested and at what level. The resume sets what gets
                  probed. Your engineering context decides what the scenarios are made of.
                  Generate it now so the candidate never waits.
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
                    placeholder="Priya Sharma"
                    className="w-full rounded-xl bg-slate-950/60 border border-slate-800 focus:border-slate-600 focus:outline-none px-3 py-2.5 text-sm placeholder:text-slate-600"
                  />
                </div>

                <div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-300 mb-2">
                    <Mail className="w-3.5 h-3.5 text-slate-500" />
                    Candidate email
                  </label>
                  <input
                    type="email"
                    value={candidateEmail}
                    onChange={(e) => setCandidateEmail(e.target.value)}
                    placeholder="priya@example.com"
                    className="w-full rounded-xl bg-slate-950/60 border border-slate-800 focus:border-slate-600 focus:outline-none px-3 py-2.5 text-sm placeholder:text-slate-600"
                  />
                  <p className="mt-1.5 text-[10px] text-slate-500">
                    How they sign in. Re-preparing replaces their existing interview.
                  </p>
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-300 mb-2">
                  <Clock className="w-3.5 h-3.5 text-slate-500" />
                  Interview length
                </label>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {([1, 5, 15, 30, 45] as Duration[]).map((d) => (
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

              {/* Interview language. Nova Sonic speaks Hindi and English natively;
                  the rest of Lokal's languages are shown but disabled until the
                  Sarvam AI path lands, rather than shipping a call that sounds
                  broken in Telugu. */}
              <div>
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-300 mb-2">
                  <Languages className="w-3.5 h-3.5 text-slate-500" />
                  Interview language
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {LANGUAGES.map((l) => (
                    <button
                      key={l.code}
                      onClick={() => l.available && setLanguage(l.code)}
                      disabled={!l.available}
                      title={
                        l.available
                          ? `Conduct the interview in ${l.label}`
                          : `${l.label} is not supported by the voice model yet — planned via Sarvam AI`
                      }
                      className={`py-2 px-2 rounded-xl border text-left transition-colors ${
                        !l.available
                          ? "bg-slate-950/40 border-slate-800/60 text-slate-600 cursor-not-allowed"
                          : language === l.code
                          ? "bg-indigo-500/15 border-indigo-500/50 text-indigo-200"
                          : "bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700"
                      }`}
                    >
                      <span className="block text-xs font-semibold truncate">{l.label}</span>
                      <span className="block text-[10px] opacity-70 truncate">
                        {l.available ? l.nativeLabel : "coming soon"}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[10px] text-slate-500">
                  Live now on Amazon Nova Sonic, which speaks Hindi and English with real
                  turn-taking and interruption. The remaining languages need a different
                  speech engine (Sarvam AI) and are next, not faked.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:h-[280px]">
                <DocumentInput
                  label="Job description"
                  hint="Paste the JD, or upload the PDF."
                  value={jdText}
                  onChange={setJdText}
                />
                <DocumentInput
                  label="Candidate resume"
                  hint="Paste the resume, or upload the PDF."
                  value={resumeText}
                  onChange={setResumeText}
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
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 transition-colors"
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
            </section>

            {/* Plan review */}
            <aside className="lg:sticky lg:top-8">
              {!bank ? (
                <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 p-8 text-center">
                  <h3 className="text-sm font-semibold text-slate-400">Plan appears here</h3>
                  <p className="text-[11px] text-slate-600 mt-2 leading-relaxed">
                    Every question is reviewable before the candidate joins. The interviewer
                    receives only what is approved — it has no live access to Slack or
                    Confluence.
                  </p>
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-bold truncate">{bank.role}</h3>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {bank.seniority} · {bank.durationMinutes} min ·{" "}
                        {bank.questions.length} questions · {languageLabel(language)}
                      </p>
                    </div>
                    {grounded && (
                      <span className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                        <ShieldCheck className="w-3 h-3" />
                        Grounded
                      </span>
                    )}
                  </div>

                  <div className="px-5 py-3 bg-emerald-500/5 border-b border-emerald-500/20">
                    <p className="text-[11px] text-emerald-300 font-medium">
                      Ready — {preparedEmail} can now sign in
                    </p>
                    <button
                      onClick={copyLink}
                      className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400 hover:text-white"
                    >
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copied ? "Copied" : "Copy candidate link"}
                    </button>
                  </div>

                  <div className="max-h-[48vh] overflow-y-auto">
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
                        ✦ generated from this JD · bars calibrated to {bank.seniority}
                      </p>
                    </div>

                    <div className="px-5 py-4 space-y-3">
                      <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                        Questions
                      </p>
                      {bank.questions.map((q, i) => {
                        const style = KIND_STYLE[q.kind] || KIND_STYLE.scenario;
                        return (
                          <div
                            key={q.id || i}
                            className="rounded-xl bg-slate-950/50 border border-slate-800 p-3"
                          >
                            <div className="flex items-center gap-2 mb-1.5">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${style.className}`}
                              >
                                {style.label}
                              </span>
                              <span className="text-[10px] text-slate-500">{q.minutes} min</span>
                            </div>
                            <p className="text-[11px] text-slate-200 leading-relaxed">
                              {q.question}
                            </p>
                            <p className="mt-1.5 text-[10px] text-slate-500 leading-relaxed">
                              <span className="text-slate-600">Looking for:</span> {q.intent}
                            </p>
                          </div>
                        );
                      })}
                    </div>

                    {bank.unevidencedRequirements.length > 0 && (
                      <div className="px-5 py-4 border-t border-slate-800/60">
                        <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-2">
                          Requirements with no resume evidence
                        </p>
                        <ul className="space-y-1.5">
                          {bank.unevidencedRequirements.map((r, i) => (
                            <li key={i} className="flex gap-2 text-[11px] text-slate-400">
                              <span className="text-amber-500/60 shrink-0">•</span>
                              {r}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </aside>
          </div>
        ) : (
          /* ------------------ interviews list ------------------ */
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold">All interviews</h2>
              <button
                onClick={refreshSessions}
                className="text-[11px] text-slate-500 hover:text-slate-300"
              >
                Refresh
              </button>
            </div>

            {sessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-800 p-10 text-center">
                <p className="text-sm text-slate-500">No interviews prepared yet.</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-800 overflow-hidden">
                {sessions.map((s, i) => (
                  <Link
                    key={s.id}
                    href={`/scorecard?sessionId=${s.id}`}
                    className={`flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-slate-800/50 ${
                      i % 2 ? "bg-slate-900/20" : "bg-slate-900/40"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-slate-200 truncate">
                        {s.candidateName}
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">{s.candidateEmail}</p>
                    </div>

                    <div className="hidden sm:block min-w-0 flex-1">
                      <p className="text-[11px] text-slate-300 truncate">{s.role}</p>
                      <p className="text-[10px] text-slate-500">
                        {s.seniority} · {s.durationMinutes} min
                        {s.language && s.language !== "en" ? ` · ${languageLabel(s.language)}` : ""}
                      </p>
                    </div>

                    <span
                      className={`shrink-0 px-2 py-1 rounded-full text-[10px] font-semibold ${
                        STATUS_STYLE[s.status] || STATUS_STYLE.ready
                      }`}
                    >
                      {s.status.replace("_", " ")}
                    </span>

                    <div className="shrink-0 w-44 text-right">
                      {s.verdict ? (
                        <>
                          <p className="text-[11px] font-semibold text-slate-200">{s.verdict}</p>
                          <p className="text-[10px] text-slate-500">
                            {s.overallScore}/100
                            {s.rescreenRecommended ? (
                              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 font-semibold">
                                re-screen
                              </span>
                            ) : s.screenQuality && s.screenQuality !== "clean" ? (
                              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold">
                                {s.streamDrops} drop{s.streamDrops === 1 ? "" : "s"}
                              </span>
                            ) : null}
                          </p>
                        </>
                      ) : s.gradingError ? (
                        <p className="text-[10px] text-rose-400">grading failed</p>
                      ) : s.status === "grading" ? (
                        <p className="text-[10px] text-amber-400">grading…</p>
                      ) : (
                        <p className="text-[10px] text-slate-600 truncate">
                          {s.terminationReason ||
                            (s.transcriptCount ? `${s.transcriptCount} turns` : "—")}
                        </p>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

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
                Sanitized engineering scenarios from internal documentation. Identifiers,
                incident fingerprints and business logic are stripped before anything reaches
                an interview. The live interviewer holds no connection to Slack or Confluence.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-2">
              {!pack?.approved ? (
                <p className="text-xs text-slate-500">
                  No approved pack. Run{" "}
                  <code className="text-slate-400">npm run pack:build -- --approve</code>.
                  Interviews still work; scenarios fall back to the JD's technologies.
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
          </div>
        </div>
      )}
    </div>
  );
}
