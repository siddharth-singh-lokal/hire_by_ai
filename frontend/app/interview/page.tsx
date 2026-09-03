"use client";

import React, { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  PanelRight,
  Clock,
  Sparkles,
  ShieldCheck,
  AlertCircle,
  FileText,
  Key,
  Volume2,
  ChevronRight,
  Info,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { useNovaSonicInterview } from "@/hooks/useNovaSonicInterview";
import { useProctoring } from "@/hooks/useProctoring";
import { useSessionRecorder } from "@/hooks/useSessionRecorder";
import { startSession, RED_FLAG_LABELS } from "@/lib/sessionStore";
import { AudioReactiveVisualizer } from "@/components/AudioReactiveVisualizer";
import { CANDIDATE_RESUME } from "@/lib/resumeData";

function InterviewRoom() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Set by the setup page. Identifies the prepared question bank server-side.
  const sessionId = searchParams.get("sessionId");

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
    cancelAiResponse,
  } = useNovaSonicInterview(sessionId);

  // Video element ref for candidate camera stream
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  // UI state
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [customApiKey, setCustomApiKey] = useState("");
  const [showEndModal, setShowEndModal] = useState(false);
  const [hasStartedOnce, setHasStartedOnce] = useState(false);
  const [isFinalising, setIsFinalising] = useState(false);

  // 40:00 Countdown Timer (2400 seconds)
  const TOTAL_INTERVIEW_SECONDS = 40 * 60;
  const [secondsRemaining, setSecondsRemaining] = useState(TOTAL_INTERVIEW_SECONDS);

  // --- Proctoring & recording ---------------------------------------------
  const isLive = connectionState === "active";
  const interviewStartedAtRef = useRef<number>(0);

  // Elapsed seconds into the recording, used to timestamp red flags so the
  // recruiter can jump straight to the moment in the video.
  const getElapsedSeconds = useCallback(() => {
    if (!interviewStartedAtRef.current) return 0;
    return Math.round((Date.now() - interviewStartedAtRef.current) / 1000);
  }, []);

  const {
    start: startRecording,
    stop: stopRecording,
    isRecording,
  } = useSessionRecorder();

  const {
    flags: redFlags,
    faceCount,
    isReady: proctoringReady,
    error: proctoringError,
  } = useProctoring({ videoRef, enabled: isLive, getElapsedSeconds });

  // Start the recorder once the stream is live.
  useEffect(() => {
    if (isLive && localStream && !isRecording) {
      interviewStartedAtRef.current = Date.now();
      startRecording(localStream);
    }
  }, [isLive, localStream, isRecording, startRecording]);

  // Attach local stream to candidate video element
  useEffect(() => {
    if (videoRef.current && localStream) {
      videoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Handle countdown timer when active
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (connectionState === "active" && secondsRemaining > 0) {
      timer = setInterval(() => {
        setSecondsRemaining((prev) => Math.max(0, prev - 1));
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [connectionState, secondsRemaining]);

  // Auto-scroll transcripts to bottom when new messages arrive
  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [transcripts]);

  // Determine active interview stage based on elapsed time
  const elapsedSeconds = TOTAL_INTERVIEW_SECONDS - secondsRemaining;
  const getActiveStage = () => {
    if (elapsedSeconds < 300) {
      return {
        id: 1,
        title: "Stage 1: System Intro & Overview",
        range: "00:00 - 05:00",
        description: "Candidate introduction and high-level architecture overview.",
      };
    }
    if (elapsedSeconds < 1800) {
      return {
        id: 2,
        title: "Stage 2: Technical Deep Dive & Failure Modes",
        range: "05:00 - 30:00",
        description: "Drilling into concurrency, Redis internals, and PostgreSQL locks.",
      };
    }
    if (elapsedSeconds < 2100) {
      return {
        id: 3,
        title: "Stage 3: Candidate Q&A & Trade-offs",
        range: "30:00 - 35:00",
        description: "Architectural trade-offs and candidate inquiries.",
      };
    }
    return {
      id: 4,
      title: "Stage 4: Wrap-up & Evaluation",
      range: "35:00 - 40:00",
      description: "Final remarks and interview conclusion.",
    };
  };

  const activeStage = getActiveStage();

  // Compute matched keyword tags from transcript
  const allTranscriptText = transcripts.map((t) => t.text.toLowerCase()).join(" ");
  const activeKeywordSet = new Set<string>();
  CANDIDATE_RESUME.keywordTags.forEach((k) => {
    const rawTag = k.tag.toLowerCase();
    const words = rawTag.split(/[\s-]+/);
    if (allTranscriptText.includes(rawTag) || words.some((w) => w.length > 4 && allTranscriptText.includes(w))) {
      activeKeywordSet.add(k.tag);
    }
  });

  // Handle Start
  const handleLaunch = async (keyToUse?: string) => {
    setHasStartedOnce(true);
    startSession();
    await startInterview(keyToUse || customApiKey || undefined);
  };

  // Handle End Interview and proceed to scorecard
  const handleConfirmEnd = async () => {
    setIsFinalising(true);

    // Order matters: flush the recording into the session store before tearing
    // down the stream, otherwise the tracks are already dead when it stops.
    try {
      await stopRecording();
    } catch (e) {
      console.error("Recorder stop failed:", e);
    }

    endInterview();

    // Transcripts and flags hand off to the scorecard. Flags also live in the
    // session store (with their snapshots); localStorage carries the plain
    // metadata so the evaluation request survives independently of the blobs.
    try {
      localStorage.setItem("interview_session_id", sessionId || "");
      localStorage.setItem("interview_transcripts", JSON.stringify(transcripts));
      localStorage.setItem("interview_duration", String(elapsedSeconds));
      localStorage.setItem(
        "interview_red_flags",
        JSON.stringify(
          redFlags.map((f) => ({
            type: f.type,
            description: f.description,
            timeInSeconds: f.timeInSeconds,
          }))
        )
      );
    } catch (e) {
      console.error("Storage error:", e);
    }

    router.push("/scorecard");
  };

  // Format seconds to mm:ss
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col overflow-hidden select-none">
      {/* Top Navigation Bar */}
      <header className="h-16 border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md px-6 flex items-center justify-between z-30 shrink-0">
        {/* Left: Branding & Candidate Badge */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-500/20">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-semibold text-sm tracking-tight text-white">Round-0 AI Interview</h1>
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  WebRTC Direct
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Candidate: <span className="text-slate-200 font-medium">{CANDIDATE_RESUME.name}</span> (Senior Backend)
              </p>
            </div>
          </div>
        </div>

        {/* Center: Stage & Countdown Timer */}
        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-3 px-4 py-1.5 rounded-full bg-slate-900/80 border border-slate-800">
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <Clock className="w-3.5 h-3.5 text-indigo-400" />
              <span>{activeStage.title}</span>
            </div>
            <div className="h-3 w-px bg-slate-800" />
            <span
              className={`font-mono font-bold text-sm tracking-wide ${
                secondsRemaining < 300 ? "text-rose-400 animate-pulse" : "text-emerald-400"
              }`}
            >
              {formatTime(secondsRemaining)}
            </span>
          </div>
        </div>

        {/* Right: Actions & Sidebar Toggle */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setApiKeyModalOpen(true)}
            title="Configure OpenAI API Key"
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1.5 transition-colors"
          >
            <Key className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">API Key</span>
          </button>

          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className={`p-2 rounded-lg text-xs font-medium border transition-colors ${
              isSidebarOpen
                ? "bg-indigo-600/20 border-indigo-500/30 text-indigo-300"
                : "bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200"
            }`}
            title="Toggle Telemetry & Transcript Sidebar"
          >
            <PanelRight className="w-4 h-4" />
          </button>

          {connectionState === "active" && (
            <button
              onClick={() => setShowEndModal(true)}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/20 transition-all flex items-center gap-1.5"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>End Interview</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Workspace Body */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left / Main Video Stage */}
        <main
          className={`flex-1 flex flex-col p-4 md:p-6 transition-all duration-300 overflow-hidden ${
            isSidebarOpen ? "mr-0 lg:mr-96" : "mr-0"
          }`}
        >
          {/* Main Stage Grid: AI Panel (Top/Left) & Candidate Webcam (Bottom/Right) */}
          <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 h-full max-h-[calc(100vh-160px)]">
            {/* Panel 1: AI Lead Architect (Sarah Chen) */}
            <div className="relative rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md overflow-hidden flex flex-col shadow-2xl">
              {/* Header Badge */}
              <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
                <div className="px-3 py-1 rounded-full bg-slate-900/90 border border-slate-700/60 backdrop-blur text-xs flex items-center gap-2 shadow-md">
                  <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                  <span className="font-semibold text-white">Sarah Chen</span>
                  <span className="text-[10px] text-indigo-400 border-l border-slate-700 pl-2">Lead Architect</span>
                </div>
              </div>

              {/* Interrupt / Yield Button (When AI is speaking) */}
              {isAiSpeaking && (
                <div className="absolute top-4 right-4 z-20">
                  <button
                    onClick={cancelAiResponse}
                    className="px-2.5 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-medium flex items-center gap-1.5 transition-colors"
                  >
                    <span>Interrupt / Yield</span>
                  </button>
                </div>
              )}

              {/* Audio Reactive Visualizer Stage */}
              <div className="flex-1 flex items-center justify-center relative">
                <AudioReactiveVisualizer
                  isAiSpeaking={isAiSpeaking}
                  isUserSpeaking={isUserSpeaking}
                  aiVolume={aiVolume}
                  userVolume={userVolume}
                  connectionState={connectionState}
                />
              </div>

              {/* Bottom Telemetry Bar on AI Tile */}
              <div className="h-10 border-t border-slate-800/60 bg-slate-950/40 px-4 flex items-center justify-between text-[11px] text-slate-400">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-slate-500">ENGINE:</span>
                  <span className="text-slate-300">gpt-4o-realtime-preview</span>
                </div>
                <div className="flex items-center gap-2">
                  <Volume2 className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Sub-second Direct WebRTC</span>
                </div>
              </div>
            </div>

            {/* Panel 2: Candidate Live Webcam Feed */}
            <div className="relative rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md overflow-hidden flex flex-col shadow-2xl">
              {/* Header Badge */}
              <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
                <div className="px-3 py-1 rounded-full bg-slate-900/90 border border-slate-700/60 backdrop-blur text-xs flex items-center gap-2 shadow-md">
                  <div className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="font-semibold text-white">Alex Doe</span>
                  <span className="text-[10px] text-slate-400 border-l border-slate-700 pl-2">Candidate</span>
                </div>
              </div>

              {/* User Mic Volume meter */}
              <div className="absolute top-4 right-4 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700 text-xs">
                <Mic className={`w-3.5 h-3.5 ${isUserSpeaking ? "text-emerald-400" : "text-slate-400"}`} />
                <div className="w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-400 transition-all duration-75"
                    style={{ width: `${Math.min(100, userVolume * 100)}%` }}
                  />
                </div>
              </div>

              {/* Candidate Video Viewport */}
              <div className="flex-1 bg-slate-950 flex items-center justify-center relative overflow-hidden">
                {connectionState !== "idle" && (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover transform -scale-x-100 ${
                      isVideoMuted ? "opacity-0" : "opacity-100"
                    } transition-opacity duration-200`}
                  />
                )}

                {/* Proctoring status overlay */}
                {isLive && (
                  <div className="absolute top-3 left-3 flex flex-col gap-2 items-start z-10">
                    <div
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium backdrop-blur-md border ${
                        redFlags.length > 0
                          ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                          : proctoringReady
                          ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                          : "bg-slate-700/40 border-slate-600/50 text-slate-300"
                      }`}
                    >
                      {redFlags.length > 0 ? (
                        <>
                          <AlertCircle className="w-3 h-3" />
                          {redFlags.length} Integrity{" "}
                          {redFlags.length === 1 ? "Flag" : "Flags"}
                        </>
                      ) : proctoringReady ? (
                        <>
                          <ShieldCheck className="w-3 h-3" />
                          Secure
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          Starting proctor…
                        </>
                      )}
                    </div>

                    {isRecording && (
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-red-500/15 border border-red-500/40 text-red-300 backdrop-blur-md">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                        Recording
                      </div>
                    )}

                    {proctoringReady && faceCount > 1 && (
                      <div className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-red-500/20 border border-red-500/50 text-red-200 backdrop-blur-md">
                        {faceCount} faces in frame
                      </div>
                    )}
                  </div>
                )}

                {/* Camera Off / Standby Placeholder */}
                {(isVideoMuted || connectionState === "idle") && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 text-slate-400">
                    <div className="w-20 h-20 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center mb-3">
                      <span className="font-bold text-2xl text-slate-300">AD</span>
                    </div>
                    <p className="text-sm font-medium text-slate-300">
                      {connectionState === "idle" ? "Camera Standby" : "Camera Paused"}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {connectionState === "idle"
                        ? "Click 'Enter Interview Room' to start"
                        : "Click video button below to resume camera"}
                    </p>
                  </div>
                )}
              </div>

              {/* Bottom Info Bar on Candidate Tile */}
              <div className="h-10 border-t border-slate-800/60 bg-slate-950/40 px-4 flex items-center justify-between text-[11px] text-slate-400">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-slate-500">ROLE:</span>
                  <span className="text-slate-300">Senior Backend Engineer</span>
                </div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Mic & Video Verified</span>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Floating Control Bar */}
          <div className="h-20 flex items-center justify-center shrink-0 mt-4">
            <div className="px-6 py-2.5 rounded-2xl bg-slate-900/90 border border-slate-800 backdrop-blur-lg flex items-center gap-4 shadow-xl">
              {/* If Not Connected Yet */}
              {connectionState === "idle" || connectionState === "error" || connectionState === "disconnected" ? (
                <button
                  onClick={() => handleLaunch()}
                  className="px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white font-semibold text-sm shadow-lg shadow-indigo-600/30 flex items-center gap-2.5 transition-all transform hover:scale-[1.02]"
                >
                  <Sparkles className="w-4 h-4 text-indigo-200" />
                  <span>
                    {connectionState === "error"
                      ? "Retry Connection"
                      : connectionState === "disconnected"
                      ? "Re-enter Interview"
                      : "Enter Interview Room"}
                  </span>
                </button>
              ) : connectionState === "requesting_permission" || connectionState === "connecting" ? (
                <div className="flex items-center gap-3 px-4 py-2">
                  <RefreshCw className="w-4 h-4 text-indigo-400 animate-spin" />
                  <span className="text-xs font-medium text-slate-300">
                    {connectionState === "requesting_permission"
                      ? "Requesting Mic & Camera Access..."
                      : "Negotiating WebRTC PeerConnection..."}
                  </span>
                </div>
              ) : (
                /* In Call Controls */
                <>
                  <button
                    onClick={toggleMute}
                    className={`p-3 rounded-xl border transition-all ${
                      isMicMuted
                        ? "bg-rose-500/20 border-rose-500/40 text-rose-400 hover:bg-rose-500/30"
                        : "bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700"
                    }`}
                    title={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
                  >
                    {isMicMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                  </button>

                  <button
                    onClick={toggleVideo}
                    className={`p-3 rounded-xl border transition-all ${
                      isVideoMuted
                        ? "bg-rose-500/20 border-rose-500/40 text-rose-400 hover:bg-rose-500/30"
                        : "bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700"
                    }`}
                    title={isVideoMuted ? "Turn Video On" : "Turn Video Off"}
                  >
                    {isVideoMuted ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                  </button>

                  <div className="h-6 w-px bg-slate-800 mx-1" />

                  <button
                    onClick={() => setShowEndModal(true)}
                    className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs shadow-lg shadow-rose-600/30 flex items-center gap-2 transition-all"
                  >
                    <PhoneOff className="w-4 h-4" />
                    <span>End & Generate Scorecard</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </main>

        {/* Right / Telemetry Sidebar */}
        <aside
          className={`fixed top-16 right-0 bottom-0 w-96 border-l border-slate-800/80 bg-slate-900/95 backdrop-blur-xl z-20 flex flex-col transition-transform duration-300 shadow-2xl ${
            isSidebarOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {/* Telemetry Header */}
          <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">Live Telemetry & Signals</h2>
              <p className="text-[11px] text-slate-500">Realtime WebRTC DataChannel Events</p>
            </div>
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          </div>

          {/* Active Interview Stage Card */}
          <div className="p-4 border-b border-slate-800/80 bg-slate-950/40 shrink-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase font-bold text-indigo-400 tracking-wider">
                Active Interview Stage
              </span>
              <span className="text-[10px] font-mono text-slate-400">{activeStage.range}</span>
            </div>
            <p className="text-xs font-semibold text-slate-200">{activeStage.title}</p>
            <p className="text-[11px] text-slate-400 mt-0.5">{activeStage.description}</p>
          </div>

          {/* Resume Covered Keyword Radar */}
          <div className="p-4 border-b border-slate-800/80 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                Resume Focus Areas ({activeKeywordSet.size}/{CANDIDATE_RESUME.keywordTags.length})
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              {CANDIDATE_RESUME.keywordTags.map((k) => {
                const isHit = activeKeywordSet.has(k.tag);
                return (
                  <span
                    key={k.tag}
                    title={k.description}
                    className={`text-[10px] px-2 py-0.5 rounded-md border font-medium transition-all ${
                      isHit
                        ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 shadow-sm"
                        : "bg-slate-800/50 border-slate-800 text-slate-500"
                    }`}
                  >
                    {isHit && "✓ "}
                    {k.tag}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Live Red Flag Ticker */}
          <div className="border-b border-slate-800/60">
            <div className="px-4 py-2 bg-slate-950/60 border-b border-slate-800/60 flex items-center justify-between">
              <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                Integrity Flags ({redFlags.length})
              </span>
              <span
                className={`text-[10px] font-mono ${
                  proctoringError
                    ? "text-red-400"
                    : proctoringReady
                    ? "text-emerald-400"
                    : "text-slate-500"
                }`}
              >
                {proctoringError ? "Proctor Error" : proctoringReady ? "Monitoring" : "Idle"}
              </span>
            </div>

            <div className="max-h-40 overflow-y-auto p-3 space-y-2">
              {proctoringError ? (
                <p className="text-[11px] text-red-400/80 px-1">{proctoringError}</p>
              ) : redFlags.length === 0 ? (
                <p className="text-[11px] text-slate-500 px-1">
                  {proctoringReady
                    ? "No violations detected."
                    : "Proctoring starts when the interview begins."}
                </p>
              ) : (
                [...redFlags].reverse().map((flag) => (
                  <div
                    key={flag.id}
                    className="flex items-center gap-2 p-2 rounded-lg bg-amber-500/5 border border-amber-500/20"
                  >
                    {flag.snapshotUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={flag.snapshotUrl}
                        alt={RED_FLAG_LABELS[flag.type]}
                        className="w-12 h-9 object-cover rounded border border-amber-500/30 shrink-0"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold text-amber-300 truncate">
                        {RED_FLAG_LABELS[flag.type]}
                      </p>
                      <p className="text-[10px] text-slate-400 font-mono">
                        {formatTime(flag.timeInSeconds)}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Real-Time Rolling Transcript */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-2 bg-slate-950/60 border-b border-slate-800/60 flex items-center justify-between">
              <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                Rolling Transcript ({transcripts.length})
              </span>
              <span className="text-[10px] text-slate-500 font-mono">Nova Sonic ASR</span>
            </div>

            <div ref={transcriptScrollRef} className="flex-1 p-4 overflow-y-auto space-y-3">
              {transcripts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
                  <FileText className="w-8 h-8 mb-2 opacity-30" />
                  <p className="text-xs font-medium">No transcript items yet</p>
                  <p className="text-[11px] mt-1 text-slate-600">
                    Speech transcribed via OpenAI Realtime DataChannel will stream here in real-time.
                  </p>
                </div>
              ) : (
                transcripts.map((item) => {
                  const isCandidate = item.sender === "candidate";
                  return (
                    <div
                      key={item.id}
                      className={`p-3 rounded-xl text-xs ${
                        isCandidate
                          ? "bg-emerald-950/30 border border-emerald-800/40 text-emerald-100 ml-4"
                          : "bg-indigo-950/30 border border-indigo-800/40 text-indigo-100 mr-4"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className={`font-bold text-[10px] ${isCandidate ? "text-emerald-400" : "text-indigo-400"}`}>
                          {isCandidate ? "Alex Doe (Candidate)" : "Sarah Chen (Interviewer)"}
                        </span>
                        <span className="text-[9px] text-slate-500 font-mono">
                          {new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                      </div>
                      <p className="leading-relaxed whitespace-pre-wrap">{item.text}</p>
                      {!item.isFinal && <span className="inline-block w-1.5 h-3 bg-indigo-400 animate-pulse ml-1" />}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Error Alert Toast */}
      {error && (
        <div className="fixed bottom-6 left-6 max-w-md p-4 rounded-xl bg-rose-950/90 border border-rose-600 text-rose-200 z-50 shadow-2xl flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="flex-1 text-xs">
            <h4 className="font-bold text-rose-300">Connection Notice</h4>
            <p className="mt-0.5 text-rose-200/90">{error}</p>
            {error.includes("API key") && (
              <button
                onClick={() => setApiKeyModalOpen(true)}
                className="mt-2 px-3 py-1 rounded bg-rose-600 text-white font-medium hover:bg-rose-500 transition-colors"
              >
                Enter OpenAI Key
              </button>
            )}
          </div>
        </div>
      )}

      {/* API Key Configuration Modal */}
      {apiKeyModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
                <Key className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">OpenAI Realtime API Key</h3>
                <p className="text-xs text-slate-400">Used for client session token generation</p>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              If <code className="px-1 py-0.5 bg-slate-800 rounded text-amber-300">OPENAI_API_KEY</code> is not set in
              your server environment, you can supply it here directly for hackathon testing:
            </p>

            <input
              type="password"
              placeholder="sk-proj-..."
              value={customApiKey}
              onChange={(e) => setCustomApiKey(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono mb-4"
            />

            <div className="flex items-center justify-end gap-2.5">
              <button
                onClick={() => setApiKeyModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white"
              >
                Close
              </button>
              <button
                onClick={() => {
                  setApiKeyModalOpen(false);
                  if (connectionState === "idle" || connectionState === "error") {
                    handleLaunch(customApiKey);
                  }
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30"
              >
                Save & Connect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal to End Interview */}
      {showEndModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl">
            <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center mb-3">
              <PhoneOff className="w-5 h-5 text-rose-400" />
            </div>
            <h3 className="text-base font-semibold text-white">End Interview & Generate Scorecard?</h3>
            <p className="text-xs text-slate-300 mt-2 leading-relaxed">
              This will conclude the WebRTC live session with Sarah Chen. The recorded rolling transcript and technical signals
              will be immediately submitted to the automated hiring bar raiser to produce your Round-0 technical evaluation scorecard.
            </p>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                onClick={() => setShowEndModal(false)}
                disabled={isFinalising}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white disabled:opacity-40"
              >
                Resume Interview
              </button>
              <button
                onClick={handleConfirmEnd}
                disabled={isFinalising}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/30 disabled:opacity-60 flex items-center gap-2"
              >
                {isFinalising && <RefreshCw className="w-3 h-3 animate-spin" />}
                {isFinalising ? "Finalising Recording…" : "Conclude & View Scorecard"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * useSearchParams requires a Suspense boundary or the App Router refuses to
 * prerender this route.
 */
export default function InterviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500 text-sm">
          Loading interview room…
        </div>
      }
    >
      <InterviewRoom />
    </Suspense>
  );
}
