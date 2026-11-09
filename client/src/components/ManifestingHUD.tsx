import React from 'react';
import { Cpu, Sparkles, CheckCircle2, Clock, Activity, Zap, Layers, ShieldCheck } from 'lucide-react';

export interface LiveProgress {
  stage: 'QUEUED' | 'INITIALIZING' | 'DIFFUSION' | 'DECODING' | 'SAVING' | 'COMPLETED' | 'ERROR';
  stageLabel: string;
  detail: string;
  percent: number;
  step?: number;
  totalSteps?: number;
  elapsedSeconds: number;
  etaSeconds?: number;
  nodeType?: string;
  queuePosition?: number;
  jobId?: string;
}

interface ManifestingHUDProps {
  isOpen: boolean;
  mode: 'KEYFRAMES' | 'VIDEO';
  progress: LiveProgress | null;
  providerName?: string;
}

export const ManifestingHUD: React.FC<ManifestingHUDProps> = ({
  isOpen,
  mode,
  progress,
  providerName = 'ComfyUI (Wan 2.2 5B + EasyCache GPU)'
}) => {
  if (!isOpen) return null;

  const percent = Math.min(100, Math.max(0, progress?.percent ?? 0));
  const stage = progress?.stage || 'INITIALIZING';
  const stageLabel = progress?.stageLabel || (mode === 'VIDEO' ? 'Manifesting Dream Video' : 'Synthesizing Keyframe Anchors');
  const detail = progress?.detail || 'Connecting to local GPU pipeline...';
  const elapsedSec = progress?.elapsedSeconds ?? 0;
  const etaSec = progress?.etaSeconds;

  const formatTime = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const s = sec % 60;
    return `${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Pipeline stages for Video vs Keyframes
  const isVideo = mode === 'VIDEO';
  const stages = isVideo ? [
    { key: 'INIT', label: 'Scene Ingestion', active: percent >= 0, done: percent >= 15 },
    { key: 'DIFF', label: 'Wan 2.2 Diffusion', active: percent >= 15, done: percent >= 85, isStep: stage === 'DIFFUSION' },
    { key: 'VAE', label: 'VAE Latent Decode', active: percent >= 85, done: percent >= 95 },
    { key: 'SAVE', label: 'Spider-Verse Render', active: percent >= 95, done: percent >= 100 }
  ] : [
    { key: 'K1', label: 'Keyframe 1/3', active: percent >= 0, done: percent >= 35 },
    { key: 'K2', label: 'Keyframe 2/3', active: percent >= 35, done: percent >= 68 },
    { key: 'K3', label: 'Keyframe 3/3', active: percent >= 68, done: percent >= 95 },
    { key: 'DONE', label: 'Gallery Ready', active: percent >= 95, done: percent >= 100 }
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-xl animate-fadeIn">
      {/* Background ambient glow circles */}
      <div className="absolute w-[500px] h-[500px] bg-cyan-500/10 rounded-full blur-[120px] pointer-events-none -top-20 -left-20 animate-pulse" />
      <div className="absolute w-[500px] h-[500px] bg-purple-500/10 rounded-full blur-[120px] pointer-events-none -bottom-20 -right-20 animate-pulse delay-700" />

      {/* Futuristic HUD Card */}
      <div className="relative w-full max-w-lg glass-panel rounded-3xl p-6 sm:p-8 border border-cyan-500/30 shadow-[0_0_60px_rgba(6,182,212,0.2)] bg-[#070919]/90 text-white overflow-hidden">
        
        {/* Top Header */}
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-800/80">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Cpu className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-wider uppercase text-cyan-300 flex items-center gap-2">
                <span>Dream Manifestation Engine</span>
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              </h3>
              <p className="text-[11px] text-slate-400 font-mono">
                {providerName}
              </p>
            </div>
          </div>

          <div className="px-2.5 py-1 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-300 text-[11px] font-mono font-medium flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 animate-spin" />
            <span>LIVE GPU FEED</span>
          </div>
        </div>

        {/* Queue Position Banner if Waiting */}
        {Boolean(progress?.queuePosition && progress.queuePosition > 0) && (
          <div className="mb-4 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-mono flex items-center justify-between animate-pulse">
            <span className="flex items-center gap-1.5 font-bold">
              <Clock className="w-4 h-4 text-amber-400" />
              <span>GPU Kuyruk Sırası: #{progress?.queuePosition}</span>
            </span>
            <span className="text-[10px] text-amber-400/80 uppercase tracking-wider font-semibold">Concurrency: 1</span>
          </div>
        )}

        {/* Big Digital Percentage Callout */}
        <div className="text-center my-4">
          <div className="inline-flex items-baseline gap-1">
            <span className="text-6xl sm:text-7xl font-black font-mono tracking-tight bg-gradient-to-r from-cyan-300 via-purple-300 to-pink-300 bg-clip-text text-transparent">
              {percent}
            </span>
            <span className="text-2xl font-bold font-mono text-cyan-400">%</span>
          </div>

          {/* Active Stage & Detail */}
          <div className="mt-2 min-h-[50px]">
            <h4 className="text-base sm:text-lg font-bold text-white flex items-center justify-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400 animate-bounce" />
              <span>{stageLabel}</span>
            </h4>
            <p className="text-xs text-slate-300 font-mono mt-1 px-4 truncate">
              {detail}
            </p>
          </div>
        </div>

        {/* High-Tech Glowing Progress Bar */}
        <div className="relative my-6">
          <div className="w-full h-3.5 bg-slate-900/90 rounded-full p-0.5 border border-slate-700/60 overflow-hidden shadow-inner">
            <div 
              className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-purple-500 to-pink-500 transition-all duration-300 ease-out relative shadow-[0_0_20px_rgba(168,85,247,0.5)]"
              style={{ width: `${Math.max(4, percent)}%` }}
            >
              {/* Shimmer sweep effect */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-shimmer" />
            </div>
          </div>

          {/* Subtle percentage markers */}
          <div className="flex justify-between text-[10px] text-slate-400 font-mono mt-1.5 px-0.5">
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>

        {/* 4-Stage Horizontal Pipeline Tracker */}
        <div className="grid grid-cols-4 gap-1.5 mb-6 text-center">
          {stages.map((st, i) => (
            <div 
              key={st.key}
              className={`p-2 rounded-xl border transition-all duration-300 ${
                st.done 
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.1)]' 
                  : st.active 
                    ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-200 shadow-[0_0_15px_rgba(6,182,212,0.2)] animate-pulse'
                    : 'bg-slate-900/40 border-slate-800/80 text-slate-400'
              }`}
            >
              <div className="flex items-center justify-center mb-1">
                {st.done ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : st.active ? (
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                ) : (
                  <span className="text-[10px] font-mono text-slate-400">{i + 1}</span>
                )}
              </div>
              <span className="text-[10px] font-medium leading-tight block truncate">
                {st.label}
              </span>
            </div>
          ))}
        </div>

        {/* Real-Time Telemetry Stats Card */}
        <div className="grid grid-cols-3 gap-2.5 p-3 rounded-2xl bg-black/40 border border-slate-800/80 text-xs font-mono">
          <div className="text-center p-2 rounded-xl bg-slate-900/50">
            <span className="text-[10px] text-slate-400 flex items-center justify-center gap-1 mb-0.5">
              <Clock className="w-3 h-3 text-cyan-400" />
              <span>ELAPSED</span>
            </span>
            <span className="font-bold text-slate-200 text-sm">{formatTime(elapsedSec)}</span>
          </div>

          <div className="text-center p-2 rounded-xl bg-slate-900/50">
            <span className="text-[10px] text-slate-400 flex items-center justify-center gap-1 mb-0.5">
              <Zap className="w-3 h-3 text-purple-400" />
              <span>EST. LEFT</span>
            </span>
            <span className="font-bold text-purple-200 text-sm">
              {etaSec !== undefined && etaSec > 0 ? `~${etaSec}s` : 'Calculating...'}
            </span>
          </div>

          <div className="text-center p-2 rounded-xl bg-slate-900/50">
            <span className="text-[10px] text-slate-400 flex items-center justify-center gap-1 mb-0.5">
              <Layers className="w-3 h-3 text-pink-400" />
              <span>STEP</span>
            </span>
            <span className="font-bold text-pink-200 text-sm">
              {progress?.step !== undefined && progress?.totalSteps ? `${progress.step}/${progress.totalSteps}` : 'Syncing'}
            </span>
          </div>
        </div>

        {/* Footer Hint */}
        <div className="mt-4 text-center text-[11px] text-slate-400 flex items-center justify-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
          <span>VRAM-Protected Local Synthesis · Zero Cloud Latency</span>
        </div>
      </div>
    </div>
  );
};
