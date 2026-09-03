"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

/**
 * Where every candidate lands when the interview ends.
 *
 * They never see a score — the scorecard is admin-only. The name is read from
 * the interview room's own handoff and then cleared, so a shared machine does
 * not greet the next candidate by the previous one's name.
 */
export default function ThankYouPage() {
  const [name, setName] = useState("");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("interview_candidate_name");
      if (stored) setName(stored);
      localStorage.removeItem("interview_candidate_name");
    } catch {
      /* private mode / storage blocked — the greeting is optional */
    }
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 className="w-7 h-7 text-emerald-400" />
        </div>

        <h1 className="text-2xl font-bold tracking-tight">
          Thanks{name ? `, ${name}` : ""}
        </h1>

        <p className="text-sm text-slate-400 mt-3 leading-relaxed">
          Your interview has been submitted. The hiring team will review the
          conversation and follow up with you about next steps.
        </p>

        <p className="text-xs text-slate-500 mt-6">
          You can close this window now.
        </p>

        <Link
          href="/"
          className="mt-6 inline-block text-[11px] text-slate-500 hover:text-slate-300 underline"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
