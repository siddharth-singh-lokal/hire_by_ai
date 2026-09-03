"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Mail, Loader2, AlertCircle, ArrowRight, Clock, Briefcase } from "lucide-react";
import { candidateSignIn, type CandidateSession } from "@/lib/api";

/**
 * Candidate sign-in.
 *
 * Email is the only credential. The interview was already prepared by an admin,
 * so this is a lookup — nothing is generated here and the candidate never waits
 * on a model call. That separation is the entire point of splitting the flows.
 */
export default function CandidateSignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<CandidateSession | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setSession(await candidateSignIn(email));
    } catch (err: any) {
      setError(err?.message || "Could not find your interview.");
    } finally {
      setLoading(false);
    }
  };

  const enter = () => {
    if (!session) return;
    const params = new URLSearchParams({
      sessionId: session.sessionId,
      name: session.candidateName,
      duration: String(session.durationMinutes),
    });
    router.push(`/interview?${params}`);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <h1 className="text-lg font-bold">Interview sign-in</h1>
          <p className="text-xs text-slate-500 mt-1.5">
            Enter the email address you applied with.
          </p>
        </div>

        {!session ? (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-300 mb-2">
                <Mail className="w-3.5 h-3.5 text-slate-500" />
                Email address
              </label>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-xl bg-slate-900/60 border border-slate-800 focus:border-indigo-600 focus:outline-none px-3 py-2.5 text-sm placeholder:text-slate-600"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 transition-colors"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {loading ? "Looking up…" : "Continue"}
            </button>
          </form>
        ) : (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-center">
            <p className="text-sm font-semibold">Welcome, {session.candidateName}</p>

            <div className="mt-4 space-y-2 text-left">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Briefcase className="w-3.5 h-3.5 text-slate-600" />
                {session.role}
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Clock className="w-3.5 h-3.5 text-slate-600" />
                {session.durationMinutes} minutes
              </div>
            </div>

            <p className="mt-4 text-[11px] text-slate-500 leading-relaxed">
              Find a quiet spot with a working camera and microphone. Once you begin, the
              conversation runs straight through.
            </p>

            <button
              onClick={enter}
              className="mt-5 w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 transition-colors"
            >
              Continue to interview
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}

        <p className="mt-8 text-center text-[10px] text-slate-700">
          Hiring team?{" "}
          <Link href="/admin" className="text-slate-500 hover:text-slate-300 underline">
            Admin console
          </Link>
        </p>
      </div>
    </div>
  );
}
