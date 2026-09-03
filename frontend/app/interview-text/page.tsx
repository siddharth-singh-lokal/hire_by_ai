"use client";

import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Send, Loader2, MessageSquare, AlertCircle, PhoneOff } from "lucide-react";
import { sendInterviewMessage, completeInterview } from "@/lib/api";

/**
 * Text interview — a stable, typed alternative to the Nova Sonic voice room.
 *
 * The candidate types; the interviewer runs on OpenRouter server-side against the
 * same question bank. The transcript is stored server-side (identical to the
 * voice path), so grading and the scorecard are unchanged.
 */

interface Msg {
  sender: "candidate" | "interviewer";
  text: string;
}

function TextInterview() {
  const router = useRouter();
  const params = useSearchParams();
  const sessionId = params.get("sessionId");
  const candidateName = params.get("name") || "there";
  const durationMinutes = Number(params.get("duration")) || 30;

  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAtRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, waiting]);

  const turn = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      setWaiting(true);
      setError(null);
      try {
        const { reply } = await sendInterviewMessage(sessionId, text);
        setMessages((prev) => [...prev, { sender: "interviewer", text: reply }]);
      } catch (e: any) {
        setError(e?.message || "The interviewer didn't respond. Try again.");
      } finally {
        setWaiting(false);
      }
    },
    [sessionId]
  );

  const start = useCallback(async () => {
    setStarted(true);
    startedAtRef.current = Date.now();
    await turn(""); // empty → opening line
  }, [turn]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || waiting) return;
    setInput("");
    setMessages((prev) => [...prev, { sender: "candidate", text }]);
    turn(text);
  }, [input, waiting, turn]);

  const end = useCallback(async () => {
    if (!sessionId || ending) return;
    setEnding(true);
    try {
      await completeInterview(sessionId, {
        redFlags: [],
        durationSeconds: Math.round((Date.now() - startedAtRef.current) / 1000),
        terminationReason: "text interview ended",
      });
    } catch {
      /* grading proceeds server-side regardless */
    }
    try {
      localStorage.setItem("interview_candidate_name", candidateName);
    } catch {}
    router.push("/thank-you");
  }, [sessionId, ending, candidateName, router]);

  // ---------------------------------------------------------------- lobby --
  if (!started) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center mx-auto mb-5">
            <MessageSquare className="w-6 h-6 text-indigo-400" />
          </div>
          <h1 className="text-xl font-bold">Hi {candidateName}</h1>
          <p className="text-sm text-slate-400 mt-2 leading-relaxed">
            This is a {durationMinutes}-minute typed conversation with an AI interviewer
            about your experience. It's a first-round chat, not a test — answer in your own
            words, and it's completely fine to say you're not sure.
          </p>
          {!sessionId && (
            <p className="mt-4 text-[11px] text-amber-400/80">
              No interview session found. Go back and sign in with your email.
            </p>
          )}
          <button
            onClick={start}
            disabled={!sessionId}
            className="mt-6 w-full py-3 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 transition-colors"
          >
            Start
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------- interview --
  return (
    <div className="h-[100dvh] bg-slate-950 text-slate-100 flex flex-col">
      <header className="h-14 border-b border-slate-800/80 bg-slate-900/50 px-4 sm:px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          Text interview
        </div>
        <button
          onClick={end}
          disabled={ending}
          className="h-9 px-4 rounded-full flex items-center gap-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 disabled:opacity-60"
        >
          {ending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneOff className="w-3.5 h-3.5" />}
          {ending ? "Finishing…" : "End"}
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
        <div className="max-w-2xl mx-auto space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={m.sender === "candidate" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  m.sender === "candidate"
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-900 border border-slate-800 text-slate-200"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          {waiting && (
            <div className="flex justify-start">
              <div className="rounded-2xl px-4 py-2.5 bg-slate-900 border border-slate-800 text-slate-500 text-sm flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Interviewer is typing…
              </div>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-slate-800/80 bg-slate-900/50 p-3 sm:p-4 shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-2xl mx-auto flex items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your answer…"
            autoFocus
            className="flex-1 rounded-full bg-slate-950/60 border border-slate-800 focus:border-slate-600 focus:outline-none px-4 py-2.5 text-sm placeholder:text-slate-600"
          />
          <button
            type="submit"
            disabled={!input.trim() || waiting}
            className="w-11 h-11 rounded-full flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 transition-colors shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </footer>
    </div>
  );
}

export default function TextInterviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500 text-sm">
          Loading…
        </div>
      }
    >
      <TextInterview />
    </Suspense>
  );
}
