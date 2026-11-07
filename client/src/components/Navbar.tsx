import React, { useState } from 'react';
import { Moon, Volume2, VolumeX, ShieldCheck, Coins, AlertTriangle, Cpu } from 'lucide-react';
import { ambientSound } from '../audio/ambientEngine';

interface NavbarProps {
  credits: number;
  providerInfo?: {
    name: string;
    isMock: boolean;
  };
}

export const Navbar: React.FC<NavbarProps> = ({ credits, providerInfo }) => {
  const [isAudioActive, setIsAudioActive] = useState(false);

  const toggleSound = () => {
    const active = ambientSound.toggle();
    setIsAudioActive(active);
  };

  const isMock = providerInfo?.isMock ?? true;

  return (
    <header className="sticky top-0 z-50 w-full glass-panel border-b border-dream-border px-6 py-4 transition-all">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        
        {/* Brand Logo */}
        <div className="flex items-center gap-3 cursor-pointer group">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-purple-600 via-indigo-600 to-cyan-400 p-[1px] shadow-lg shadow-purple-900/30">
            <div className="w-full h-full bg-[#0c0f24] rounded-[11px] flex items-center justify-center">
              <Moon className="w-5 h-5 text-purple-400 group-hover:rotate-12 transition-transform duration-300" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-serif font-bold text-xl tracking-wide bg-gradient-to-r from-purple-200 via-indigo-200 to-cyan-200 bg-clip-text text-transparent">
                DreamViewer
              </span>
              {/* Provider Badge - Honest & Transparent */}
              {isMock ? (
                <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  MOCK MODE
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 flex items-center gap-1">
                  <Cpu className="w-2.5 h-2.5" />
                  RTX 5070 GPU
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">Subconscious Visualizer</p>
          </div>
        </div>

        {/* Right Status Actions */}
        <div className="flex items-center gap-3 md:gap-5">
          
          {/* Real Text Moderation Status */}
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Text Safety Guard Active</span>
          </div>

          {/* Web Audio Ambient Generator Toggle */}
          <button
            onClick={toggleSound}
            title={isAudioActive ? "Mute Ambient Soundscape" : "Play Ambient Soundscape (Web Audio $0)"}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-300 border ${
              isAudioActive
                ? 'bg-purple-600/20 border-purple-500/40 text-purple-300 shadow-md shadow-purple-900/30'
                : 'bg-slate-800/60 border-slate-700/60 text-slate-400 hover:text-slate-200 hover:border-slate-600'
            }`}
          >
            {isAudioActive ? (
              <>
                <Volume2 className="w-4 h-4 text-cyan-400" />
                <div className="flex items-end gap-[2px] h-3">
                  <span className="w-[3px] bg-cyan-400 rounded-full audio-bar-1"></span>
                  <span className="w-[3px] bg-purple-400 rounded-full audio-bar-2"></span>
                  <span className="w-[3px] bg-cyan-400 rounded-full audio-bar-3"></span>
                  <span className="w-[3px] bg-purple-400 rounded-full audio-bar-4"></span>
                </div>
                <span className="hidden md:inline">Ambient Audio</span>
              </>
            ) : (
              <>
                <VolumeX className="w-4 h-4" />
                <span className="hidden md:inline">Soundscape Off</span>
              </>
            )}
          </button>

          {/* Credits Counter Badge */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gradient-to-r from-purple-950/60 to-indigo-950/60 border border-purple-500/30 shadow-inner">
            <Coins className="w-4 h-4 text-amber-400 animate-pulse" />
            <div className="text-right leading-none">
              <span className="text-sm font-bold text-amber-300">{credits}</span>
              <span className="text-[10px] text-slate-400 ml-1">Credits</span>
            </div>
          </div>

        </div>

      </div>
    </header>
  );
};
