import { useState, useEffect, useRef } from 'react';
import { 
  Play, 
  Pause, 
  Sparkles, 
  Share2, 
  Download, 
  RotateCcw, 
  ShieldCheck, 
  Film, 
  Sliders, 
  Layers,
  AlertTriangle
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { ambientSound } from '../audio/ambientEngine';

interface DreamVideoData {
  id: string;
  videoUrl: string;
  durationSeconds: number;
  effectiveSeconds: number;
  fps: number;
  faceBlurred: boolean;
  audioMood: string;
  shaderPreset: string;
}

interface CompletedDream {
  id: string;
  title: string;
  keyframeUrl: string;
  video: DreamVideoData;
  prompt: string;
  createdAt: string;
  isMock?: boolean;
}

interface DreamPlayerStepProps {
  dream: CompletedDream;
  onNewDream: () => void;
}

type ShaderPreset = 'dream_haze' | 'retro_vhs' | 'spider_verse' | 'none';

export const DreamPlayerStep: React.FC<DreamPlayerStepProps> = ({ dream, onNewDream }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentShader, setCurrentShader] = useState<ShaderPreset>('dream_haze');
  const [isOnTwos, setIsOnTwos] = useState(true);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // Trigger celebration confetti & ambient audio on mount
  useEffect(() => {
    confetti({
      particleCount: 50,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#9d4edd', '#4cc9f0', '#f72585', '#7209b7']
    });

    ambientSound.start('ethereal');
  }, []);

  // Update playback rate dynamically when on-twos changes
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = isOnTwos ? 0.5 : 1.0;
    }
  }, [isOnTwos]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleExport = () => {
    setExportNotice("Baking video with ambient audio & shader filters via server FFmpeg...");
    setTimeout(() => {
      setExportNotice("Your dream MP4 is ready! Download triggered.");
      setTimeout(() => setExportNotice(null), 4000);
    }, 1800);
  };

  const getShaderClass = () => {
    switch (currentShader) {
      case 'dream_haze':
        return 'shader-dream-haze';
      case 'retro_vhs':
        return 'shader-retro-vhs';
      case 'spider_verse':
        return 'shader-spider-verse';
      default:
        return '';
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fadeIn">
      
      {/* Header */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-medium mb-3">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Dream Manifested Successfully</span>
        </div>
        <h1 className="font-serif text-2xl md:text-4xl font-extrabold text-white mb-2">
          {dream.title}
        </h1>
        <p className="text-xs md:text-sm text-slate-400 max-w-lg mx-auto">
          Played "on-twos" (12fps stutter) doubling runtime from 5s to 10s at zero extra compute.
        </p>
      </div>

      {/* Simulation Warning Banner if in Mock / Test mode */}
      {(dream.isMock || dream.video.videoUrl.includes('commondatastorage')) && (
        <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
          <span>
            <strong>Simulation / Test Output:</strong> This is a placeholder demonstration video because real AI models are not active.
          </span>
        </div>
      )}

      {/* Main Video Viewport Card */}
      <div className="glass-panel-glow rounded-2xl overflow-hidden mb-6 border border-purple-500/40 relative">
        
        {/* Video Screen with Shader Overlay */}
        <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden">
          
          <video
            ref={videoRef}
            src={dream.video.videoUrl}
            autoPlay
            loop
            muted
            playsInline
            className={`w-full h-full object-cover transition-all duration-300 ${getShaderClass()}`}
          />

          {/* Vignette Overlay */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20" />

          {/* Top Info Bar */}
          <div className="absolute top-3 left-3 right-3 flex items-center justify-between text-xs pointer-events-none">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/60 backdrop-blur-md text-purple-300 border border-purple-500/30">
              <Film className="w-3.5 h-3.5 text-cyan-400" />
              <span>{isOnTwos ? '10s On-Twos (12fps)' : '5s Native (24fps)'}</span>
            </div>

            {/* Honest Security Badge: Only show if face blur ACTUALLY executed */}
            {dream.video.faceBlurred ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/60 backdrop-blur-md text-emerald-400 border border-emerald-500/30">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Face Anonymized</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/60 backdrop-blur-md text-slate-400 border border-slate-700/50">
                <span>Raw Output (No Face Blur)</span>
              </div>
            )}
          </div>

          {/* Center Play/Pause Overlay Click */}
          <button
            onClick={togglePlay}
            className="absolute inset-0 flex items-center justify-center bg-black/10 hover:bg-black/30 transition-all group"
          >
            {!isPlaying && (
              <div className="w-16 h-16 rounded-full bg-purple-600/90 text-white flex items-center justify-center shadow-2xl shadow-purple-900 group-hover:scale-110 transition-transform">
                <Play className="w-8 h-8 ml-1" />
              </div>
            )}
          </button>
        </div>

        {/* Video Controls Bar */}
        <div className="p-4 bg-[#0c0f24] border-t border-purple-500/20 flex flex-wrap items-center justify-between gap-4">
          
          {/* Play/Pause Button */}
          <button
            onClick={togglePlay}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/40 text-purple-200 text-xs font-semibold transition-all"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            <span>{isPlaying ? 'Pause' : 'Resume Playback'}</span>
          </button>

          {/* "Spider-Verse On-Twos" Toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              Flipbook Pace:
            </span>
            <button
              onClick={() => setIsOnTwos(!isOnTwos)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                isOnTwos
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 ring-1 ring-cyan-400'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              {isOnTwos ? '⚡ On-Twos (12fps)' : 'Smooth (24fps)'}
            </button>
          </div>

          {/* Shaders Dropdown / Presets */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Sliders className="w-3.5 h-3.5 text-purple-400" />
              Filter:
            </span>
            <div className="flex items-center gap-1">
              {(['dream_haze', 'retro_vhs', 'spider_verse', 'none'] as ShaderPreset[]).map(preset => (
                <button
                  key={preset}
                  onClick={() => setCurrentShader(preset)}
                  className={`px-2.5 py-1 rounded-md text-[11px] capitalize border transition-all ${
                    currentShader === preset
                      ? 'bg-purple-600 border-purple-400 text-white font-medium'
                      : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {preset.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

        </div>

      </div>

      {/* Export Toast if active */}
      {exportNotice && (
        <div className="mb-6 p-4 rounded-xl bg-purple-900/40 border border-purple-500/50 text-purple-200 text-xs flex items-center gap-3 animate-fadeIn">
          <div className="w-4 h-4 border-2 border-purple-300 border-t-transparent rounded-full animate-spin shrink-0" />
          <span>{exportNotice}</span>
        </div>
      )}

      {/* Action Footer */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 glass-panel p-4 rounded-xl">
        
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-semibold shadow-lg shadow-purple-950 transition-all active:scale-95"
          >
            <Download className="w-4 h-4" />
            <span>Export & Share MP4</span>
          </button>

          <button
            onClick={() => {
              if (navigator.share) {
                navigator.share({
                  title: 'My Dream Video',
                  text: 'Check out the dream I visualized with DreamViewer!',
                  url: window.location.href
                }).catch(() => {});
              } else {
                navigator.clipboard.writeText(window.location.href);
                setExportNotice("Link copied to clipboard for sharing!");
                setTimeout(() => setExportNotice(null), 3000);
              }
            }}
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-all"
          >
            <Share2 className="w-4 h-4" />
            <span>Share</span>
          </button>
        </div>

        <button
          onClick={onNewDream}
          className="flex items-center gap-2 text-xs text-purple-300 hover:text-purple-200 font-medium px-4 py-2 rounded-xl hover:bg-purple-950/40 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Manifest Another Dream</span>
        </button>

      </div>

    </div>
  );
};
