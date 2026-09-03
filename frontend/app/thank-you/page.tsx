"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

/**
 * Where the candidate lands when the interview ends.
 *
 * Deliberately says nothing about how it went. The candidate must never see a
 * score, a verdict, or a hint of one — that is the hiring manager's to read,
 * and telling someone they did badly at the moment they finish is both unkind
 * and, given this is a first-round screen, frequently wrong.
 */
export default function ThankYouPage() {
  const [name, setName] = useState("");

  useEffect(() => {
    setName(localStorage.getItem("interview_candidate_name") || "");
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-sm w-full text-center">
        <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 className="w-6 h-6 text-emerald-400" />
        </div>

        <h1 className="text-lg font-bold">
          Thanks{name && name !== "there" ? `, ${name}` : ""}
        </h1>
        <p className="mt-2 text-sm text-slate-400 leading-relaxed">
          Your interview has been submitted to the hiring team. Someone will be in touch
          about next steps.
        </p>

        <p className="mt-6 text-[11px] text-slate-600">You can close this window.</p>
      </div>
    </div>
  );
}
