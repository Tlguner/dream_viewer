import React, { useState } from 'react';
import { CheckCircle2, Video, RefreshCw, Camera, Sparkles, ShieldCheck, Eye, ArrowLeft, Info } from 'lucide-react';

interface Keyframe {
  id: string;
  imageUrl: string;
  aspectRatio: string;
  seed: number;
  isMock?: boolean;
  isSelected?: boolean;
}

interface AnalysisData {
  refinedPrompt: string;
  keyframePrompt?: string;
  motionPrompt?: string;
  negativePrompt: string;
  cameraMotion: string;
  detectedMood: string;
  visualElements: {
    setting: string;
    surrealTwist: string;
    lighting: string;
  };
}

interface KeyframeReviewStepProps {
  analysis: AnalysisData;
  keyframes: Keyframe[];
  onSelectKeyframe: (keyframe: Keyframe) => void;
  onAnimate: (selectedKeyframe: Keyframe) => void;
  onBack: () => void;
  onRegenerate: () => void;
  isLoadingVideo: boolean;
  isRegenerating: boolean;
}

export const KeyframeReviewStep: React.FC<KeyframeReviewStepProps> = ({
  analysis,
  keyframes,
  onSelectKeyframe,
  onAnimate,
  onBack,
  onRegenerate,
  isLoadingVideo,
  isRegenerating
}) => {
  const [selectedId, setSelectedId] = useState<string>(keyframes[0]?.id || '');

  const handleSelect = (kf: Keyframe) => {
    setSelectedId(kf.id);
    onSelectKeyframe(kf);
  };

  const selectedKf = keyframes.find(k => k.id === selectedId) || keyframes[0];
  const hasMockKeyframes = keyframes.some(k => k.isMock);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fadeIn">
      
      {/* Top Navigation */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Edit Dream Memory</span>
        </button>

        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-medium">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Stage 2: Keyframe Selection</span>
        </div>
      </div>

      {/* Honest Mock/Anchor Notification Banner */}
      {hasMockKeyframes && (
        <div className="mb-6 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-center gap-2.5">
          <Info className="w-4 h-4 text-amber-400 shrink-0" />
          <span>
            <strong>Curated Composition Anchors:</strong> Preview keyframes are artistic anchors. When you approve a frame, its image will be directly uploaded to Wan 2.2 on your GPU for Image-to-Video synthesis.
          </span>
        </div>
      )}

      {/* Dream Architect Structured Breakdown Card */}
      <div className="glass-panel rounded-2xl p-5 mb-8 border border-purple-500/30">
        <div className="flex items-center gap-2 text-xs font-semibold text-purple-300 uppercase tracking-wider mb-3">
          <Camera className="w-4 h-4 text-cyan-400" />
          <span>Dream Architect Directives</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 text-xs">
          <div className="bg-[#0c0f24]/70 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block mb-1">Setting:</span>
            <span className="text-slate-200 font-medium">{analysis.visualElements.setting}</span>
          </div>
          <div className="bg-[#0c0f24]/70 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block mb-1">Surreal Twist:</span>
            <span className="text-slate-200 font-medium">{analysis.visualElements.surrealTwist}</span>
          </div>
          <div className="bg-[#0c0f24]/70 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block mb-1">Atmosphere:</span>
            <span className="text-slate-200 font-medium">{analysis.visualElements.lighting}</span>
          </div>
        </div>

        {/* Decoupled Directives: Keyframe Scene vs Video Animation */}
        <div className="space-y-2 text-xs">
          <div className="bg-[#090b1c] p-3 rounded-xl border border-cyan-500/20 text-slate-300 flex items-start gap-2">
            <Eye className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-cyan-200">Scene Directive (Keyframe): </span>
              <span className="text-slate-300">"{analysis.keyframePrompt || analysis.refinedPrompt}"</span>
            </div>
          </div>

          <div className="bg-[#090b1c] p-3 rounded-xl border border-purple-500/20 text-slate-300 flex items-start gap-2">
            <Video className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-purple-200">Animation Motion (I2V): </span>
              <span className="text-slate-300">"{analysis.motionPrompt || analysis.cameraMotion}"</span>
            </div>
          </div>
        </div>
      </div>

      {/* Keyframe Gallery Selection */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              Select Your Dream Anchor
            </h2>
            <p className="text-xs text-slate-400">
              Only the approved frame will be animated into video, ensuring maximum fidelity at minimum compute.
            </p>
          </div>

          <button
            onClick={onRegenerate}
            disabled={isRegenerating || isLoadingVideo}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
            <span>Regenerate (Free)</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {keyframes.map((kf, index) => {
            const isSelected = kf.id === selectedId;
            return (
              <div
                key={kf.id}
                onClick={() => handleSelect(kf)}
                className={`group relative rounded-2xl overflow-hidden border cursor-pointer transition-all duration-300 ${
                  isSelected
                    ? 'border-purple-500 shadow-xl shadow-purple-900/40 ring-2 ring-purple-400 scale-[1.02]'
                    : 'border-slate-800/80 hover:border-slate-600 opacity-75 hover:opacity-100'
                }`}
              >
                {/* Image */}
                <div className="aspect-video w-full bg-slate-900 overflow-hidden relative">
                  <img
                    src={kf.imageUrl}
                    alt={`Dream Keyframe ${index + 1}`}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />

                  {/* Honest Indicator if Mock / Simulated */}
                  {kf.isMock && (
                    <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md border border-amber-500/40 text-[10px] font-mono text-amber-300">
                      SIMULATED ANCHOR
                    </div>
                  )}
                </div>

                {/* Selection Badge */}
                {isSelected && (
                  <div className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded-full bg-purple-600/90 text-white text-[11px] font-semibold flex items-center gap-1 shadow-md backdrop-blur-sm">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Selected</span>
                  </div>
                )}

                {/* Card Footer info */}
                <div className="p-3 bg-[#0c0f24]/90 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Variation #{index + 1}</span>
                  <span className="font-mono text-[10px] text-slate-400">Seed: {kf.seed}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Real Safety Notice */}
      <div className="flex items-center gap-2 p-3 rounded-xl bg-purple-950/30 border border-purple-500/20 text-xs text-purple-300 mb-6">
        <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
        <span>
          <strong>Text Safety Verified:</strong> Prompt screened for PG compliance. Direction instructs models to frame silhouettes and avoid close-up facial features.
        </span>
      </div>

      {/* Action Button */}
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <button
          onClick={() => selectedKf && onAnimate(selectedKf)}
          disabled={isLoadingVideo || !selectedKf}
          className={`w-full py-4 px-6 rounded-xl font-medium flex items-center justify-center gap-3 transition-all duration-300 shadow-xl ${
            isLoadingVideo
              ? 'bg-purple-900/50 text-purple-200 border border-purple-700/50 cursor-wait'
              : 'bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-500 hover:from-purple-500 hover:to-cyan-400 text-white border border-purple-400/40 hover:shadow-purple-500/30 active:scale-[0.99]'
          }`}
        >
          {isLoadingVideo ? (
            <>
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>Manifesting Dream Video via Wan 2.2 I2V...</span>
            </>
          ) : (
            <>
              <Video className="w-5 h-5 text-cyan-200" />
              <span className="font-semibold tracking-wide">
                Manifest Dream Video (1 Credit)
              </span>
            </>
          )}
        </button>
      </div>

    </div>
  );
};
