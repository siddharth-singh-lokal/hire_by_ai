"use client";

import React, { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
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
  attachClip,
  PROBEABLE_FLAGS,
  RED_FLAG_WARNINGS,
  type RedFlag,
} from "@/lib/sessionStore";
import { completeInterview, uploadRecording, fetchCandidateSession, type CandidateSessionDetail } from "@/lib/api";
import { languagePhrase } from "@/lib/languages";
import { AudioReactiveVisualizer } from "@/components/AudioReactiveVisualizer";

/**
 * Candidate-facing interview room.
 *
 * Deliberately sparse. The candidate sees themselves, the interviewer, a
 * transcript, and three controls. Everything else — the question bank, rubric,
 * proctoring detail, scoring — belongs to the admin and is not shown here.
 * Showing a candidate what they are being graded against changes their answers.
 */

/** Per-violation-type cooldown so the interviewer doesn't nag about the same thing. */
const PROBE_COOLDOWN_MS = 25000;
/** After time runs out, how long to let the candidate keep going before wrapping up. */
const TIME_GRACE_MS = 3 * 60 * 1000;
/** A lull this long (nobody speaking) after time is up is a safe moment to close. */
const SETTLE_AFTER_SPEECH_MS = 4000;
/** Length of the evidence clip recorded around each proctoring violation. */
const CLIP_MS = 6000;

function formatTime(secs: number): string {
  const m = Math.floor(Math.max(0, secs) / 60);
  const s = Math.floor(Math.max(0, secs) % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function InterviewRoom() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId");
  // Testing aid, off unless explicitly asked for: ?debug=1
  const debugMode = searchParams.get("debug") === "1";

  /**
   * Everything about the interview is looked up server-side from the opaque
   * session id. It used to travel in the URL, which meant a candidate could
   * edit their own name and timer, and a missing param silently produced a
   * 30-minute interview regardless of what was prepared.
   */
  const [session, setSession] = useState<CandidateSessionDetail | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) {
      setSessionError("No interview session found. Please go back and sign in with your email.");
      setSessionLoading(false);
      return;
    }
    let cancelled = false;
    fetchCandidateSession(sessionId)
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setSessionLoading(false);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setSessionError(e?.message || "Could not load this interview.");
        setSessionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const candidateName = session?.candidateName ?? "";
  const durationMinutes = session?.durationMinutes ?? 0;
  const isRejoin = session?.status === "in_progress";
  const isAlreadyDone =
    session?.status === "completed" || session?.status === "grading";
  const wasInterrupted = session?.status === "terminated";

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
    sendTextMessage,
    endRequested,
    concluded,
    reconnecting,
  } = useNovaSonicInterview(sessionId);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  const [hasStarted, setHasStarted] = useState(false);
  const [isFinalising, setIsFinalising] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [warningBanner, setWarningBanner] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [timeUp, setTimeUp] = useState(false);

  const totalSeconds = durationMinutes * 60;
  const [secondsRemaining, setSecondsRemaining] = useState(0);


  const isLive = connectionState === "active";
  const startedAtRef = useRef(0);
  const elapsedSeconds = totalSeconds - secondsRemaining;

  // Seed the clock from the SERVER's start time so a mid-interview refresh
  // resumes the real remaining time instead of restarting from full.
  useEffect(() => {
    if (!session) return;
    const total = session.durationMinutes * 60;
    if (session.status === "in_progress" && session.startedAt) {
      const skew = Date.now() - session.serverNow;
      const startedAtLocal = session.startedAt + skew;
      startedAtRef.current = startedAtLocal;
      const elapsed = Math.floor((Date.now() - startedAtLocal) / 1000);
      setSecondsRemaining(Math.max(0, total - elapsed));
    } else {
      setSecondsRemaining(total);
    }
  }, [session]);

  const getElapsedSeconds = useCallback(() => {
    if (!startedAtRef.current) return 0;
    return Math.round((Date.now() - startedAtRef.current) / 1000);
  }, []);

  const { start: startRecording, stop: stopRecording, isRecording } = useSessionRecorder();

  // --- integrity probing ----------------------------------------------------
  // High-confidence flags never end the call — the interviewer just works a
  // natural question about them into the conversation and keeps going.
  const probedAtRef = useRef<Record<string, number>>({});
  const handledFlagsRef = useRef(new Set<string>());
  const endingRef = useRef(false);
  const terminatingRef = useRef(false);
  const isUserSpeakingRef = useRef(false);
  const isAiSpeakingRef = useRef(false);
  const lastVoiceAtRef = useRef(0);
  const localStreamRef = useRef<MediaStream | null>(null);
  const clipBusyRef = useRef(false);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const finishInterview = useCallback(
    async (reason?: string) => {
      if (endingRef.current) return;
      endingRef.current = true;
      setIsFinalising(true);

      let recordingBlob: Blob | null = null;
      try {
        recordingBlob = await stopRecording();
      } catch (e) {
        console.error("Recorder stop failed:", e);
      }

      endInterview();

      // Upload the full recording to the backend so the recruiter can watch it
      // on the scorecard from their own machine. Awaited before navigating —
      // a large upload aborts if the tab moves on — which is why the candidate
      // sees "Finishing…" for a moment.
      if (sessionId && recordingBlob && recordingBlob.size > 0) {
        try {
          await uploadRecording(sessionId, recordingBlob);
        } catch (e) {
          console.error("Recording upload failed:", e);
        }
      }

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
            // Base64 frame + short clip captured when the flag fired, so the
            // recruiter can re-verify it later from their own machine.
            snapshot: f.snapshotUrl,
            clip: f.clipUrl,
          })),
          durationSeconds: getElapsedSeconds(),
          terminationReason: reason,
        }).catch((e) => console.error("Failed to report completion:", e));
      }

      try {
        if (candidateName) localStorage.setItem("interview_candidate_name", candidateName);
        else localStorage.removeItem("interview_candidate_name");
      } catch (e) {
        console.error("Storage error:", e);
      }

      router.push("/thank-you");
    },
    [stopRecording, endInterview, sessionId, getElapsedSeconds, candidateName, router]
  );

  // One shared termination path so a goodbye is only ever spoken once — a
  // candidate request and time running out can't stack up and make the
  // interviewer say goodbye two or three times.
  const requestTermination = useCallback(
    (reason: string, wrapUp = false) => {
      if (terminatingRef.current || endingRef.current) return;
      terminatingRef.current = true;
      setWarningBanner(
        wrapUp ? "We're over time — please wrap up your final point." : "Wrapping up."
      );
      sendControl({ type: "terminate", reason, wrapUp });
      // When we've asked the candidate to wrap up, give them (and the goodbye)
      // longer before the client tears the call down, so nobody is cut off.
      setTimeout(() => finishInterview(reason), wrapUp ? 16000 : 9000);
    },
    [sendControl, finishInterview]
  );

  // Records a short clip from the moment a violation fires, so the recruiter can
  // watch what actually happened rather than trust a single frame. One at a time
  // (the per-type cooldown already spaces flags out); a clip still recording when
  // the interview ends is simply dropped.
  const captureClip = useCallback((flag: RedFlag) => {
    const stream = localStreamRef.current;
    if (!stream || clipBusyRef.current || typeof MediaRecorder === "undefined") return;

    const mimeType = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) =>
      MediaRecorder.isTypeSupported(t)
    );
    if (!mimeType) return;

    try {
      clipBusyRef.current = true;
      const rec = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        clipBusyRef.current = false;
        const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
        const reader = new FileReader();
        reader.onload = () => attachClip(flag.id, String(reader.result));
        reader.readAsDataURL(blob);
      };
      rec.start();
      setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, CLIP_MS);
    } catch (e) {
      clipBusyRef.current = false;
      console.error("Clip capture failed:", e);
    }
  }, []);

  const handleFlag = useCallback(
    (flag: RedFlag) => {
      if (handledFlagsRef.current.has(flag.id)) return;
      handledFlagsRef.current.add(flag.id);

      // Every flag gets a short evidence clip, whatever its type.
      captureClip(flag);

      // Tab switches and brief absences are recorded for the recruiter but never
      // interrupt the conversation. The rest prompt the interviewer to ask about
      // it in her own voice — she never ends the interview over a proctoring
      // signal. Cooldown per type so she doesn't nag about the same thing.
      if (!PROBEABLE_FLAGS.includes(flag.type)) return;

      const now = Date.now();
      if (now - (probedAtRef.current[flag.type] || 0) < PROBE_COOLDOWN_MS) return;
      probedAtRef.current[flag.type] = now;

      sendControl({ type: "proctor_probe", description: RED_FLAG_WARNINGS[flag.type] });
    },
    [sendControl, captureClip]
  );

  const { faceCount, isReady: proctoringReady, phoneVisible } = useProctoring({
    videoRef,
    enabled: isLive,
    getElapsedSeconds,
    onFlag: handleFlag,
  });

  // The candidate asked to stop. There is no signal left to gather.
  useEffect(() => {
    if (!endRequested) return;
    requestTermination("candidate requested");
  }, [endRequested, requestTermination]);

  // The interviewer said her closing line, so the interview is genuinely over.
  // She already delivered the goodbye herself — give her audio a moment to finish
  // playing, then close out. Deliberately not requestTermination: that would
  // inject a second goodbye on top of the one she just said.
  useEffect(() => {
    if (!concluded || endingRef.current || terminatingRef.current) return;
    terminatingRef.current = true;
    setWarningBanner("Wrapping up.");
    const t = setTimeout(() => finishInterview("interview concluded"), 8000);
    return () => clearTimeout(t);
  }, [concluded, finishInterview]);

  useEffect(() => {
    if (isLive && localStream && !isRecording) {
      // Only set it if the rejoin effect has not already seeded it from the
      // server, so elapsed time (and every proctoring flag timestamp) stays on
      // the real interview timeline.
      if (!startedAtRef.current) startedAtRef.current = Date.now();
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

  // Track who is speaking so the time-up grace logic can tell a genuine lull from
  // the candidate still being mid-answer.
  useEffect(() => {
    isUserSpeakingRef.current = isUserSpeaking;
    isAiSpeakingRef.current = isAiSpeaking;
    if (isUserSpeaking || isAiSpeaking) lastVoiceAtRef.current = Date.now();
  }, [isUserSpeaking, isAiSpeaking]);

  // Time is up — but never cut the candidate off mid-sentence. Tell the
  // interviewer to stop starting new topics and wind down, and let the candidate
  // keep going.
  useEffect(() => {
    if (isLive && secondsRemaining === 0 && !timeUp && !terminatingRef.current) {
      setTimeUp(true);
      setWarningBanner("We're at time — go ahead and finish your thought.");
      sendControl({ type: "wind_down" });
    }
  }, [isLive, secondsRemaining, timeUp, sendControl]);

  // During the grace period, only actually close on a genuine lull. If the
  // candidate is still going when the grace cap is reached, ask them to wrap up
  // their final point, then end.
  useEffect(() => {
    if (!timeUp) return;
    const graceStart = Date.now();
    const check = setInterval(() => {
      if (terminatingRef.current) {
        clearInterval(check);
        return;
      }
      const now = Date.now();
      if (now - graceStart >= TIME_GRACE_MS) {
        requestTermination("time elapsed (grace expired)", true);
        clearInterval(check);
      } else if (
        !isUserSpeakingRef.current &&
        !isAiSpeakingRef.current &&
        now - lastVoiceAtRef.current >= SETTLE_AFTER_SPEECH_MS
      ) {
        requestTermination("time elapsed");
        clearInterval(check);
      }
    }, 1000);
    return () => clearInterval(check);
  }, [timeUp, requestTermination]);

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
    const langPhrase = languagePhrase(session?.language);
    const blocked = sessionLoading || !session || isAlreadyDone;

    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center mx-auto mb-5">
            <Video className="w-6 h-6 text-indigo-400" />
          </div>

          {sessionLoading ? (
            <>
              <h1 className="text-xl font-bold">Getting your interview ready</h1>
              <p className="text-sm text-slate-400 mt-2">One moment.</p>
            </>
          ) : sessionError ? (
            <>
              <h1 className="text-xl font-bold">We couldn&apos;t find your interview</h1>
              <p className="text-sm text-slate-400 mt-2 leading-relaxed">{sessionError}</p>
              <Link
                href="/"
                className="mt-6 inline-block w-full py-3 rounded-xl text-sm font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700"
              >
                Back to sign in
              </Link>
            </>
          ) : isAlreadyDone ? (
            <>
              <h1 className="text-xl font-bold">This interview is already complete</h1>
              <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                Thanks, {candidateName} — your conversation has been sent to the hiring
                team. There is nothing more to do here.
              </p>
            </>
          ) : isRejoin ? (
            <>
              <h1 className="text-xl font-bold">Your interview is in progress</h1>
              <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                You were disconnected. Rejoin and the interviewer will pick up where you
                left off — you have {formatTime(secondsRemaining)} remaining.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold">Hi {candidateName}</h1>
              <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                This is a {durationMinutes}-minute conversation with an AI interviewer
                about your experience
                {langPhrase ? `, ${langPhrase}` : ""}. It&apos;s a first-round chat, not a
                test — think out loud, and it&apos;s completely fine to say you&apos;re
                not sure.
              </p>
            </>
          )}

          {session && !isAlreadyDone && (
            <div className="mt-6 p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-left space-y-2">
              {[
                "Your camera and microphone stay on throughout",
                "The session is recorded for the hiring team",
                "You can ask to stop at any point",
                ...(wasInterrupted
                  ? ["Your earlier conversation was saved and will be included"]
                  : []),
              ].map((line) => (
                <p key={line} className="text-xs text-slate-400 flex gap-2">
                  <span className="text-slate-600">•</span>
                  {line}
                </p>
              ))}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-300 text-left">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!sessionError && !isAlreadyDone && (
            <button
              onClick={handleLaunch}
              disabled={blocked}
              className="mt-6 w-full py-3 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 transition-colors shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2"
            >
              {sessionLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              {sessionLoading ? "Loading…" : isRejoin ? "Rejoin interview" : "I'm ready — start"}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------- interview --
  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-950 text-slate-100 flex flex-col">
      <header className="h-14 border-b border-slate-800/80 bg-slate-900/50 px-4 sm:px-6 flex items-center justify-between shrink-0 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="text-xs font-medium text-slate-300 truncate hidden sm:inline">
            Interview in progress
          </span>
        </div>

        <div className="flex items-center gap-3 sm:gap-4 shrink-0">
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
            <span className="hidden sm:inline">
              {phoneVisible ? "Device in frame" : faceCount > 1 ? "Multiple people" : "Secure"}
            </span>
          </div>
        </div>
      </header>

      {warningBanner && (
        <div className="px-4 sm:px-6 py-2.5 bg-amber-500/15 border-b border-amber-500/30 text-xs text-amber-200 flex items-center gap-2 shrink-0">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span className="truncate">{warningBanner}</span>
        </div>
      )}

      <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Stage */}
        <div className="flex-1 min-h-0 flex flex-col p-4 sm:p-6 gap-4 overflow-hidden">
          <div className="flex-1 min-h-0 rounded-2xl bg-slate-900/40 border border-slate-800 flex items-center justify-center relative overflow-hidden">
            <AudioReactiveVisualizer
              aiVolume={aiVolume}
              userVolume={userVolume}
              isAiSpeaking={isAiSpeaking}
              isUserSpeaking={isUserSpeaking}
              connectionState={connectionState}
            />
            {(connectionState === "connecting" || reconnecting) && (
              <div className="absolute inset-0 bg-slate-950/70 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                <p className="text-xs text-slate-400">
                  {reconnecting ? "Connection dropped — reconnecting…" : "Connecting…"}
                </p>
              </div>
            )}

            {/* Reconnect gave up, or a non-recoverable error — let the candidate
                rejoin or submit. The transcript is saved server-side and graded,
                and a rejoin resumes from where it left off. */}
            {connectionState === "error" && !reconnecting && (
              <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center gap-4 p-6 text-center">
                <AlertCircle className="w-8 h-8 text-rose-400" />
                <div>
                  <p className="text-sm font-semibold text-rose-300">Connection lost</p>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto leading-relaxed">
                    {error || "The interview stream stopped unexpectedly."}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-2">
                    Your conversation so far has been saved.
                  </p>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => startInterview()}
                    className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500"
                  >
                    Rejoin
                  </button>
                  <button
                    onClick={() => finishInterview("connection lost")}
                    className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700"
                  >
                    End &amp; submit
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="h-28 w-44 sm:h-40 sm:w-56 rounded-xl overflow-hidden border border-slate-800 bg-slate-900 relative shrink-0">
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
        <aside className="h-[36dvh] lg:h-auto lg:w-[360px] shrink-0 flex flex-col min-h-0 overflow-hidden border-t lg:border-t-0 lg:border-l border-slate-800/80 bg-slate-900/20">
          <div className="px-5 py-3 border-b border-slate-800/60 shrink-0 flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Transcript
            </span>
            {transcripts.length > 0 && (
              <span className="text-[10px] text-slate-600">{transcripts.length}</span>
            )}
          </div>
          <div
            ref={transcriptScrollRef}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4"
          >
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
                  <p className="text-xs text-slate-300 leading-relaxed break-words">
                    {t.text}
                  </p>
                </div>
              ))
            )}
          </div>
        </aside>
      </main>

      {/* Controls */}
      <footer className="border-t border-slate-800/80 bg-slate-900/50 flex flex-col items-center justify-center gap-3 shrink-0 py-3 px-4">
        {debugMode && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!typed.trim()) return;
            sendTextMessage(typed);
            setTyped("");
          }}
          className="w-full max-w-xl flex items-center gap-2"
        >
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type a reply instead of speaking…"
            className="flex-1 rounded-full bg-slate-950/60 border border-slate-800 focus:border-slate-600 focus:outline-none px-4 py-2 text-xs placeholder:text-slate-600"
          />
          <button
            type="submit"
            disabled={!typed.trim()}
            className="px-4 py-2 rounded-full text-xs font-semibold bg-slate-800 hover:bg-slate-700 disabled:opacity-40"
          >
            Send
          </button>
        </form>
        )}

        <div className="flex items-center justify-center gap-3">
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
        </div>
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
