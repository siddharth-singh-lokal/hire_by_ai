"use client";

import React, { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  Clock,
  ShieldCheck,
  ShieldAlert,
  AlertCircle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useNovaSonicInterview } from "@/hooks/useNovaSonicInterview";
import { useProctoring } from "@/hooks/useProctoring";
import { useSessionRecorder } from "@/hooks/useSessionRecorder";
import {
  startSession,
  getSession as getEvidence,
  ESCALATABLE_FLAGS,
  RED_FLAG_WARNINGS,
  type RedFlag,
} from "@/lib/sessionStore";
import { completeInterview } from "@/lib/api";
import { AudioReactiveVisualizer } from "@/components/AudioReactiveVisualizer";

/**
 * Candidate-facing interview room.
 *
 * Deliberately sparse. The candidate sees themselves, the interviewer, a
 * transcript, and three controls. Everything else — the question bank, rubric,
 * proctoring detail, scoring — belongs to the admin and is not shown here.
 * Showing a candidate what they are being graded against changes their answers.
 */

/** Grace after a warning before it escalates. */
const STRIKE_GRACE_MS = 20000;

function formatTime(secs: number): string {
  const m = Math.floor(Math.max(0, secs) / 60);
  const s = Math.floor(Math.max(0, secs) % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function InterviewRoom() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId");
  const candidateName = searchParams.get("name") || "there";
  const durationMinutes = Number(searchParams.get("duration")) || 30;

  const {
    connectionState,
    error,
    transcripts,
    localStream,
    isMicMuted,
    isVideoMuted,
    isAiSpeaking,
    isUserSpeaking,
    aiVolume,
    userVolume,
    startInterview,
    endInterview,
    toggleMute,
    toggleVideo,
    sendControl,
    endRequested,
  } = useNovaSonicInterview(sessionId);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  const [hasStarted, setHasStarted] = useState(false);
  const [isFinalising, setIsFinalising] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [warningBanner, setWarningBanner] = useState<string | null>(null);

  const totalSeconds = durationMinutes * 60;
  const [secondsRemaining, setSecondsRemaining] = useState(totalSeconds);

  const isLive = connectionState === "active";
  const startedAtRef = useRef(0);
  const elapsedSeconds = totalSeconds - secondsRemaining;

  const getElapsedSeconds = useCallback(() => {
    if (!startedAtRef.current) return 0;
    return Math.round((Date.now() - startedAtRef.current) / 1000);
  }, []);

  const { start: startRecording, stop: stopRecording, isRecording } = useSessionRecorder();

  // --- integrity escalation -------------------------------------------------
  // Two strikes, high-confidence flags only. The interviewer raises it in her
  // own voice; a banner the candidate can ignore is not a warning.
  const strikesRef = useRef(0);
  const lastStrikeAtRef = useRef(0);
  const handledFlagsRef = useRef(new Set<string>());
  const endingRef = useRef(false);

  const finishInterview = useCallback(
    async (reason?: string) => {
      if (endingRef.current) return;
      endingRef.current = true;
      setIsFinalising(true);

      try {
        await stopRecording();
      } catch (e) {
        console.error("Recorder stop failed:", e);
      }

      endInterview();

      // Tell the server the interview is over and hand over the proctoring
      // flags, which only exist in this browser. The transcript is already
      // recorded server-side, so grading proceeds even if this call never
      // lands. Deliberately not awaited — the candidate should not wait.
      if (sessionId) {
        completeInterview(sessionId, {
          redFlags: getEvidence().redFlags.map((f) => ({
            type: f.type,
            description: f.description,
            timeInSeconds: f.timeInSeconds,
          })),
          durationSeconds: getElapsedSeconds(),
          terminationReason: reason,
        }).catch((e) => console.error("Failed to report completion:", e));
      }

      try {
        localStorage.setItem("interview_candidate_name", candidateName);
      } catch (e) {
        console.error("Storage error:", e);
      }

      router.push("/thank-you");
    },
    [stopRecording, endInterview, sessionId, getElapsedSeconds, candidateName, router]
  );

  const handleFlag = useCallback(
    (flag: RedFlag) => {
      if (handledFlagsRef.current.has(flag.id)) return;
      handledFlagsRef.current.add(flag.id);

      // Only sustained, high-confidence violations escalate. Tab switches and
      // brief absences are recorded for the recruiter but never end a call —
      // a false positive there would be indefensible.
      if (!ESCALATABLE_FLAGS.includes(flag.type)) return;

      const now = Date.now();
      const withinGrace = now - lastStrikeAtRef.current < STRIKE_GRACE_MS;

      // A repeat inside the grace window is the same incident continuing, not a
      // new one — that is what advances the strike count.
      if (strikesRef.current > 0 && !withinGrace) {
        strikesRef.current = 0;
      }

      strikesRef.current += 1;
      lastStrikeAtRef.current = now;

      if (strikesRef.current >= 3) {
        setWarningBanner("Ending the interview.");
        sendControl({ type: "terminate", reason: `integrity: ${flag.type}` });
        setTimeout(() => finishInterview(`integrity: ${flag.type}`), 9000);
        return;
      }

      setWarningBanner(
        strikesRef.current === 1
          ? "The interviewer has raised something about your setup."
          : "Final warning — the interview will end if this continues."
      );
      setTimeout(() => setWarningBanner(null), 12000);

      sendControl({
        type: "proctor_warning",
        strike: strikesRef.current,
        description: RED_FLAG_WARNINGS[flag.type],
      });
    },
    [sendControl, finishInterview]
  );

  const { faceCount, isReady: proctoringReady, phoneVisible } = useProctoring({
    videoRef,
    enabled: isLive,
    getElapsedSeconds,
    onFlag: handleFlag,
  });

  // The candidate asked to stop. There is no signal left to gather.
  useEffect(() => {
    if (!endRequested || endingRef.current) return;
    setWarningBanner("Wrapping up.");
    sendControl({ type: "terminate", reason: "candidate requested" });
    const t = setTimeout(() => finishInterview("candidate requested"), 9000);
    return () => clearTimeout(t);
  }, [endRequested, sendControl, finishInterview]);

  useEffect(() => {
    if (isLive && localStream && !isRecording) {
      startedAtRef.current = Date.now();
      startRecording(localStream);
    }
  }, [isLive, localStream, isRecording, startRecording]);

  useEffect(() => {
    if (videoRef.current && localStream) videoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (!isLive || secondsRemaining <= 0) return;
    const timer = setInterval(() => setSecondsRemaining((p) => Math.max(0, p - 1)), 1000);
    return () => clearInterval(timer);
  }, [isLive, secondsRemaining]);

  // Time is up — close it out rather than letting it run indefinitely.
  useEffect(() => {
    if (isLive && secondsRemaining === 0 && !endingRef.current) {
      sendControl({ type: "terminate", reason: "time elapsed" });
      const t = setTimeout(() => finishInterview("time elapsed"), 9000);
      return () => clearTimeout(t);
    }
  }, [isLive, secondsRemaining, sendControl, finishInterview]);

  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [transcripts]);

  const handleLaunch = async () => {
    setHasStarted(true);
    startSession();
    await startInterview();
  };

  // ---------------------------------------------------------------- lobby --
  if (!hasStarted || connectionState === "idle") {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center mx-auto mb-5">
            <Video className="w-6 h-6 text-indigo-400" />
          </div>
          <h1 className="text-xl font-bold">Hi {candidateName}</h1>
          <p className="text-sm text-slate-400 mt-2 leading-relaxed">
            This is a {durationMinutes}-minute conversation with an AI interviewer about
            your experience. It's a first-round chat, not a test — think out loud, and
            it's completely fine to say you're not sure.
          </p>

          <div className="mt-6 p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-left space-y-2">
            {[
              "Your camera and microphone stay on throughout",
              "The session is recorded for the hiring team",
              "You can ask to stop at any point",
            ].map((line) => (
              <p key={line} className="text-xs text-slate-400 flex gap-2">
                <span className="text-slate-600">•</span>
                {line}
              </p>
            ))}
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-300 text-left">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={handleLaunch}
            className="mt-6 w-full py-3 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 transition-colors shadow-lg shadow-indigo-600/20"
          >
            I'm ready — start
          </button>

          {!sessionId && (
            <p className="mt-3 text-[11px] text-amber-400/80">
              No interview session found. Please go back and sign in with your email.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------- interview --
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="h-14 border-b border-slate-800/80 bg-slate-900/50 px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-medium text-slate-300">Interview in progress</span>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs font-mono text-slate-400">
            <Clock className="w-3.5 h-3.5" />
            {formatTime(secondsRemaining)}
          </div>
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
              phoneVisible || faceCount > 1
                ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                : proctoringReady
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                : "bg-slate-800/60 border-slate-700 text-slate-400"
            }`}
          >
            {phoneVisible || faceCount > 1 ? (
              <ShieldAlert className="w-3 h-3" />
            ) : (
              <ShieldCheck className="w-3 h-3" />
            )}
            {phoneVisible ? "Device in frame" : faceCount > 1 ? "Multiple people" : "Secure"}
          </div>
        </div>
      </header>

      {warningBanner && (
        <div className="px-6 py-2.5 bg-amber-500/15 border-b border-amber-500/30 text-xs text-amber-200 flex items-center gap-2 shrink-0">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          {warningBanner}
        </div>
      )}

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] min-h-0">
        {/* Stage */}
        <div className="flex flex-col min-h-0 p-6 gap-4">
          <div className="flex-1 rounded-2xl bg-slate-900/40 border border-slate-800 flex items-center justify-center relative overflow-hidden min-h-[240px]">
            <AudioReactiveVisualizer
              aiVolume={aiVolume}
              userVolume={userVolume}
              isAiSpeaking={isAiSpeaking}
              isUserSpeaking={isUserSpeaking}
              connectionState={connectionState}
            />
            {connectionState === "connecting" && (
              <div className="absolute inset-0 bg-slate-950/70 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                <p className="text-xs text-slate-400">Connecting…</p>
              </div>
            )}
          </div>

          <div className="h-40 w-56 rounded-xl overflow-hidden border border-slate-800 bg-slate-900 relative shrink-0">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover -scale-x-100 ${
                isVideoMuted ? "opacity-0" : "opacity-100"
              }`}
            />
            {isVideoMuted && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                <VideoOff className="w-5 h-5" />
              </div>
            )}
            {isRecording && (
              <span className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-500/20 text-red-300 border border-red-500/40">
                <span className="w-1 h-1 rounded-full bg-red-400 animate-pulse" />
                REC
              </span>
            )}
          </div>
        </div>

        {/* Transcript */}
        <aside className="border-l border-slate-800/80 bg-slate-900/20 flex flex-col min-h-0">
          <div className="px-5 py-3 border-b border-slate-800/60 shrink-0">
            <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Transcript
            </span>
          </div>
          <div ref={transcriptScrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
            {transcripts.length === 0 ? (
              <p className="text-xs text-slate-600 text-center mt-8">
                The conversation will appear here.
              </p>
            ) : (
              transcripts.map((t) => (
                <div key={t.id}>
                  <p
                    className={`text-[10px] font-semibold mb-1 ${
                      t.sender === "candidate" ? "text-sky-400" : "text-violet-400"
                    }`}
                  >
                    {t.sender === "candidate" ? "You" : "Interviewer"}
                  </p>
                  <p className="text-xs text-slate-300 leading-relaxed">{t.text}</p>
                </div>
              ))
            )}
          </div>
        </aside>
      </main>

      {/* Controls */}
      <footer className="h-20 border-t border-slate-800/80 bg-slate-900/50 flex items-center justify-center gap-3 shrink-0">
        <button
          onClick={toggleMute}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isMicMuted
              ? "bg-red-500/20 text-red-300 border border-red-500/40"
              : "bg-slate-800 text-slate-300 hover:bg-slate-700"
          }`}
          title={isMicMuted ? "Unmute" : "Mute"}
        >
          {isMicMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>

        <button
          onClick={toggleVideo}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isVideoMuted
              ? "bg-red-500/20 text-red-300 border border-red-500/40"
              : "bg-slate-800 text-slate-300 hover:bg-slate-700"
          }`}
          title={isVideoMuted ? "Turn camera on" : "Turn camera off"}
        >
          {isVideoMuted ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
        </button>

        <button
          onClick={() => setShowEndModal(true)}
          disabled={isFinalising}
          className="h-12 px-5 rounded-full flex items-center gap-2 text-sm font-semibold bg-rose-600 hover:bg-rose-500 disabled:opacity-60 transition-colors"
        >
          {isFinalising ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <PhoneOff className="w-4 h-4" />
          )}
          {isFinalising ? "Finishing…" : "End"}
        </button>
      </footer>

      {showEndModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="max-w-sm w-full bg-slate-900 rounded-2xl border border-slate-700 p-6">
            <h3 className="text-sm font-bold">End the interview?</h3>
            <p className="mt-2 text-xs text-slate-400 leading-relaxed">
              Your conversation so far will be sent to the hiring team. You won't be able
              to resume.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setShowEndModal(false)}
                disabled={isFinalising}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white disabled:opacity-40"
              >
                Keep going
              </button>
              <button
                onClick={() => finishInterview("candidate ended")}
                disabled={isFinalising}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 disabled:opacity-60"
              >
                End interview
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function InterviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500 text-sm">
          Loading…
        </div>
      }
    >
      <InterviewRoom />
    </Suspense>
  );
}
