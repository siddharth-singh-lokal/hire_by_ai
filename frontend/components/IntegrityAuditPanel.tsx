"use client";

import React, { useEffect, useRef, useState } from "react";
import { ShieldCheck, AlertTriangle, Play, X, VideoOff } from "lucide-react";
import { RedFlag, RED_FLAG_LABELS, getSession } from "@/lib/sessionStore";

/**
 * Recruiter-facing integrity audit: the session recording alongside a timeline of
 * proctoring incidents. Clicking a flag seeks the video to that moment; clicking
 * its thumbnail opens the captured frame full-size for verification.
 */

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export const IntegrityAuditPanel: React.FC<{ flags?: RedFlag[]; recordingSrc?: string | null }> = ({
  flags: flagsProp,
  recordingSrc,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [flags, setFlags] = useState<RedFlag[]>([]);
  const [zoomed, setZoomed] = useState<RedFlag | null>(null);
  const [activeFlagId, setActiveFlagId] = useState<string | null>(null);

  // The store is module-level and only populated on the client, so read it after
  // mount rather than during render.
  useEffect(() => {
    const session = getSession();
    // Prefer the server-hosted recording (what the recruiter sees on their own
    // machine); fall back to the in-memory blob URL for a same-tab demo.
    setRecordingUrl(recordingSrc ?? session.recordingUrl);
    // Prefer flags handed in from the graded session — that is what the recruiter
    // sees on their own machine, where the local store is empty. Fall back to the
    // in-memory store for a same-tab demo.
    setFlags(flagsProp ?? session.redFlags);
  }, [flagsProp, recordingSrc]);

  const jumpTo = (flag: RedFlag) => {
    setActiveFlagId(flag.id);
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = flag.timeInSeconds;
    video.play().catch(() => {
      /* autoplay policies — the recruiter can hit play themselves */
    });
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-slate-400" />
          <h2 className="text-sm font-bold text-slate-200">Integrity &amp; Proctoring Audit</h2>
        </div>
        <span
          className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${
            flags.length === 0
              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
              : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
          }`}
        >
          {flags.length === 0 ? "Clean Session" : `${flags.length} Flagged`}
        </span>
      </div>

      {/* Session recording */}
      <div className="p-5 border-b border-slate-800">
        <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-2">
          Session Recording
        </p>
        {recordingUrl ? (
          <video
            ref={videoRef}
            src={recordingUrl}
            controls
            className="w-full rounded-xl bg-black aspect-video"
          />
        ) : (
          <div className="w-full aspect-video rounded-xl bg-slate-950 border border-slate-800 flex flex-col items-center justify-center text-slate-500 gap-2">
            <VideoOff className="w-8 h-8" />
            <p className="text-xs font-medium">No recording in this session</p>
            <p className="text-[11px] text-slate-600 max-w-xs text-center px-4">
              Recordings are held in memory for the prototype, so they do not
              survive a page refresh or a new tab. Run an interview to populate this.
            </p>
          </div>
        )}
      </div>

      {/* Flag timeline */}
      <div className="p-5">
        <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-3">
          Flagged Incidents
        </p>

        {flags.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-slate-500 py-4">
            <ShieldCheck className="w-4 h-4 text-emerald-500/60" />
            No integrity violations were detected during this interview.
          </div>
        ) : (
          <div className="space-y-2">
            {flags.map((flag) => (
              <div
                key={flag.id}
                className={`flex items-center gap-3 p-2.5 rounded-xl border transition-colors ${
                  activeFlagId === flag.id
                    ? "bg-amber-500/10 border-amber-500/40"
                    : "bg-slate-950/40 border-slate-800 hover:border-slate-700"
                }`}
              >
                {flag.snapshotUrl ? (
                  <button
                    onClick={() => setZoomed(flag)}
                    className="shrink-0 group relative"
                    title={flag.clipUrl ? "Play evidence clip" : "View captured frame"}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={flag.snapshotUrl}
                      alt={RED_FLAG_LABELS[flag.type]}
                      className="w-16 h-12 object-cover rounded-lg border border-slate-700 group-hover:border-amber-500/60"
                    />
                    {flag.clipUrl && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
                        <Play className="w-4 h-4 text-white drop-shadow" />
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="w-16 h-12 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
                    <AlertTriangle className="w-4 h-4 text-slate-600" />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-amber-300">
                    <span className="font-mono text-slate-400">
                      {formatTimestamp(flag.timeInSeconds)}
                    </span>{" "}
                    — {RED_FLAG_LABELS[flag.type]}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">{flag.description}</p>
                </div>

                <button
                  onClick={() => jumpTo(flag)}
                  disabled={!recordingUrl}
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                  title={recordingUrl ? "Jump to this moment" : "No recording available"}
                >
                  <Play className="w-3 h-3" />
                  Jump
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Snapshot lightbox */}
      {zoomed && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setZoomed(null)}
        >
          <div
            className="max-w-3xl w-full bg-slate-900 rounded-2xl border border-slate-700 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-amber-300">
                  {RED_FLAG_LABELS[zoomed.type]}
                </p>
                <p className="text-[11px] text-slate-500 font-mono">
                  {zoomed.clipUrl ? "Clip" : "Captured"} at {formatTimestamp(zoomed.timeInSeconds)}
                </p>
              </div>
              <button
                onClick={() => setZoomed(null)}
                className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {zoomed.clipUrl ? (
              <video
                src={zoomed.clipUrl}
                poster={zoomed.snapshotUrl || undefined}
                controls
                autoPlay
                className="w-full max-h-[70vh] object-contain bg-black"
              />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={zoomed.snapshotUrl!}
                alt={RED_FLAG_LABELS[zoomed.type]}
                className="w-full max-h-[70vh] object-contain bg-black"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
