"use client";

import React, { useEffect, useRef } from "react";
import { Sparkles, Bot, Mic, Radio } from "lucide-react";

interface AudioReactiveVisualizerProps {
  isAiSpeaking: boolean;
  isUserSpeaking: boolean;
  aiVolume: number; // 0 to 1
  userVolume: number; // 0 to 1
  connectionState: string;
}

export const AudioReactiveVisualizer: React.FC<AudioReactiveVisualizerProps> = ({
  isAiSpeaking,
  isUserSpeaking,
  aiVolume,
  userVolume,
  connectionState,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Dynamic canvas drawing for audio frequency waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let phase = 0;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // Determine active amplitude based on who is speaking
      const activeVolume = isAiSpeaking ? aiVolume : isUserSpeaking ? userVolume : 0.05;
      const isAI = isAiSpeaking;

      // Draw multi-layered sine waves
      const lines = 3;
      for (let i = 0; i < lines; i++) {
        ctx.beginPath();
        ctx.lineWidth = 2 + i;
        
        // Color gradient based on speaker
        if (isAI) {
          ctx.strokeStyle = `rgba(129, 140, 248, ${0.4 + i * 0.25})`; // Indigo/violet
        } else if (isUserSpeaking) {
          ctx.strokeStyle = `rgba(52, 211, 153, ${0.4 + i * 0.25})`; // Emerald
        } else {
          ctx.strokeStyle = `rgba(99, 102, 241, ${0.2 + i * 0.1})`; // Gentle standby purple
        }

        const waveHeight = (height / 6) * (1 + activeVolume * 3.5);
        const frequency = 0.015 + i * 0.005;
        const speed = 0.04 + i * 0.02;

        for (let x = 0; x < width; x += 2) {
          const y =
            height / 2 +
            Math.sin(x * frequency + phase * speed + i) *
              waveHeight *
              Math.sin((x / width) * Math.PI); // Pinched at edges
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      phase += 1;
      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [isAiSpeaking, isUserSpeaking, aiVolume, userVolume]);

  // Scaled pulse calculation
  const pulseScale = 1 + Math.min(aiVolume * 0.35, 0.35);
  const glowIntensity = Math.min(aiVolume * 50, 45);

  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center p-6 select-none">
      {/* Background ambient radial glow */}
      <div
        className="absolute inset-0 transition-opacity duration-700 pointer-events-none"
        style={{
          background: isAiSpeaking
            ? `radial-gradient(circle at center, rgba(99, 102, 241, 0.22) 0%, rgba(15, 23, 42, 0) 70%)`
            : isUserSpeaking
            ? `radial-gradient(circle at center, rgba(16, 185, 129, 0.18) 0%, rgba(15, 23, 42, 0) 70%)`
            : `radial-gradient(circle at center, rgba(30, 41, 59, 0.3) 0%, rgba(15, 23, 42, 0) 70%)`,
        }}
      />

      {/* Central Pulsing Sphere */}
      <div className="relative z-10 flex items-center justify-center mb-6">
        {/* Outer concentric pulsing aura rings */}
        <div
          className="absolute rounded-full border border-indigo-500/20 transition-all duration-150"
          style={{
            width: `${210 * pulseScale}px`,
            height: `${210 * pulseScale}px`,
            opacity: isAiSpeaking ? 0.8 : 0.2,
          }}
        />
        <div
          className="absolute rounded-full border border-indigo-400/30 transition-all duration-100"
          style={{
            width: `${170 * pulseScale}px`,
            height: `${170 * pulseScale}px`,
            opacity: isAiSpeaking ? 0.9 : 0.3,
          }}
        />

        {/* Inner Glowing Core */}
        <div
          className="relative w-28 h-28 rounded-full flex items-center justify-center transition-transform duration-75"
          style={{
            transform: `scale(${pulseScale})`,
            background: isAiSpeaking
              ? "linear-gradient(135deg, #6366f1 0%, #4f46e5 50%, #3b82f6 100%)"
              : isUserSpeaking
              ? "linear-gradient(135deg, #10b981 0%, #059669 100%)"
              : "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
            boxShadow: isAiSpeaking
              ? `0 0 ${25 + glowIntensity}px rgba(99, 102, 241, 0.8), inset 0 0 15px rgba(255, 255, 255, 0.4)`
              : isUserSpeaking
              ? `0 0 25px rgba(16, 185, 129, 0.6), inset 0 0 10px rgba(255, 255, 255, 0.3)`
              : "0 0 15px rgba(30, 41, 59, 0.5)",
            border: "2px solid rgba(255, 255, 255, 0.15)",
          }}
        >
          {isAiSpeaking ? (
            <Sparkles className="w-10 h-10 text-white animate-pulse" />
          ) : isUserSpeaking ? (
            <Mic className="w-10 h-10 text-emerald-100 animate-bounce" />
          ) : (
            <Bot className="w-10 h-10 text-slate-400" />
          )}
        </div>
      </div>

      {/* Waveform Canvas */}
      <div className="w-full max-w-xs h-16 relative z-10 flex items-center justify-center">
        <canvas ref={canvasRef} width={320} height={64} className="w-full h-full" />
      </div>

      {/* State & Speaker Badge */}
      <div className="mt-3 relative z-10 flex flex-col items-center">
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900/80 border border-slate-700/60 text-xs shadow-inner">
          <div
            className={`w-2 h-2 rounded-full ${
              isAiSpeaking
                ? "bg-indigo-400 animate-ping"
                : isUserSpeaking
                ? "bg-emerald-400 animate-pulse"
                : connectionState === "active"
                ? "bg-emerald-500"
                : "bg-amber-500 animate-pulse"
            }`}
          />
          <span className="font-medium text-slate-300">
            {connectionState !== "active"
              ? "Connecting…"
              : isAiSpeaking
              ? "Sarah Chen is speaking..."
              : isUserSpeaking
              ? "Listening to Candidate..."
              : "Ready & Listening"}
          </span>
        </div>

        <p className="text-[11px] text-slate-400 mt-1">
          Full-duplex audio • Low-latency server VAD • Live Whisper-1
        </p>
      </div>
    </div>
  );
};
