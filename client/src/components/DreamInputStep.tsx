import React, { useState } from 'react';
import { Sparkles, Wand2, ShieldAlert, CloudMoon, Compass, Palette } from 'lucide-react';

interface DreamInputStepProps {
  onAnalyze: (rawText: string, moodHint: string) => void;
  isLoading: boolean;
  error: string | null;
}

const PRESET_DREAMS = [
  {
    title: "Floating Cathedral Library",
    text: "A grand ancient library floating among violet clouds. Glowing leather-bound books flutter their pages and glide like glowing birds through gothic archways, with aurora lights outside the stained glass.",
    mood: "ETHEREAL_LUCID"
  },
  {
    title: "Midnight Bioluminescent Ocean",
    text: "Standing on a submerged mirror-like platform in a midnight sea. Massive glowing jellyfish drift through the sky above like living constellations, while the water reflects distant celestial nebulae.",
    mood: "DEEP_OCEAN"
  },
  {
    title: "Nostalgic Foggy Train",
    text: "Looking out the window of a vintage steam train gliding across a calm endless misty lake at dusk. Street lamps float gently on the water surface casting warm amber reflections through the haze.",
    mood: "NOSTALGIC_FOG"
  },
  {
    title: "Neon Rain Metropolis",
    text: "A tranquil rain-slicked city from a high terrace. Towering geometric skyscrapers with holographic pink and cyan glyphs reflect on puddle surfaces, completely peaceful with zero people.",
    mood: "SURREAL_CYBERPUNK"
  }
];

const MOODS = [
  { id: 'ETHEREAL_LUCID', label: 'Ethereal Lucid', icon: '✨', desc: 'Weightless, glowing, mystical mist' },
  { id: 'NOSTALGIC_FOG', label: 'Nostalgic Fog', icon: '🌫️', desc: 'Warm vintage, misty memories' },
  { id: 'SURREAL_CYBERPUNK', label: 'Surreal Neon', icon: '⚡', desc: 'Rain-slicked cyan & magenta' },
  { id: 'DEEP_OCEAN', label: 'Abyssal Calm', icon: '🌊', desc: 'Bioluminescent deep waters' },
  { id: 'FLOATING_SKY', label: 'Skyward Ascent', icon: '☁️', desc: 'Gravity-defying horizons' },
  { id: 'GOLDEN_DREAM', label: 'Golden Hour', icon: '🌅', desc: 'Amber warmth, timeless dusk' },
];

export const DreamInputStep: React.FC<DreamInputStepProps> = ({ onAnalyze, isLoading, error }) => {
  const [dreamText, setDreamText] = useState('');
  const [selectedMood, setSelectedMood] = useState('ETHEREAL_LUCID');
  const [localWarning, setLocalWarning] = useState<string | null>(null);

  // Client-side quick filter check
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setDreamText(val);

    // Quick regex scan for prohibited topics to give instant gentle warning
    const forbidden = /\b(nude|naked|nsfw|porn|porno|erotic|sex|blood|gore|kill|murder|çıplak|seks|cinayet)\b/i;
    if (forbidden.test(val)) {
      setLocalWarning("Friendly reminder: DreamViewer is a PG safe-space. Content involving +18, nudity, or graphic violence will be rejected by our 4-layer shield.");
    } else {
      setLocalWarning(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dreamText.trim() || isLoading) return;
    onAnalyze(dreamText, selectedMood);
  };

  const applyPreset = (preset: typeof PRESET_DREAMS[0]) => {
    setDreamText(preset.text);
    setSelectedMood(preset.mood);
    setLocalWarning(null);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 animate-fadeIn">
      
      {/* Hero Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-300 text-xs font-medium mb-3">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Stage 1: Dream Architect</span>
        </div>
        <h1 className="font-serif text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-3">
          What did your mind witness?
        </h1>
        <p className="text-sm md:text-base text-slate-400 max-w-xl mx-auto">
          Describe the feeling, setting, or impossible imagery of your dream. Our AI Architect will structure it into a cinematic visual sequence before rendering.
        </p>
      </div>

      {/* Main Glassmorphism Form Card */}
      <form onSubmit={handleSubmit} className="glass-panel-glow rounded-2xl p-6 md:p-8 space-y-6">
        
        {/* Dream Text Area */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <CloudMoon className="w-4 h-4 text-purple-400" />
              Your Dream Memory
            </label>
            <span className="text-xs text-slate-400">
              {dreamText.length} characters
            </span>
          </div>

          <textarea
            value={dreamText}
            onChange={handleTextChange}
            placeholder="I was standing on an obsidian bridge over a violet ocean. Giant glowing clock towers floated in the sky, and every time the bells rang, the stars shifted like sand..."
            rows={5}
            className="w-full bg-[#0c0f24]/90 border border-purple-500/30 rounded-xl p-4 text-slate-100 placeholder-slate-500 text-sm md:text-base focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-400 transition-all resize-none shadow-inner"
          />

          {/* Local Content Warning if triggered */}
          {localWarning && (
            <div className="mt-2 flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{localWarning}</span>
            </div>
          )}

          {/* Server Error Alert */}
          {error && (
            <div className="mt-2 flex items-start gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Atmosphere & Mood Selection */}
        <div>
          <label className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
            <Palette className="w-4 h-4 text-cyan-400" />
            Atmosphere & Palette
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {MOODS.map(m => (
              <button
                type="button"
                key={m.id}
                onClick={() => setSelectedMood(m.id)}
                className={`p-3 rounded-xl border text-left transition-all duration-200 flex flex-col justify-between ${
                  selectedMood === m.id
                    ? 'bg-purple-600/20 border-purple-500 text-white shadow-md shadow-purple-900/40 ring-1 ring-purple-400'
                    : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">{m.icon}</span>
                  <span className="text-xs font-semibold">{m.label}</span>
                </div>
                <span className="text-[10px] text-slate-400">{m.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Quick Inspiration Presets */}
        <div>
          <div className="flex items-center gap-2 mb-2 text-xs font-medium text-slate-400">
            <Compass className="w-3.5 h-3.5 text-indigo-400" />
            <span>Need inspiration? Try a sample lucid vision:</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESET_DREAMS.map((p, idx) => (
              <button
                type="button"
                key={idx}
                onClick={() => applyPreset(p)}
                className="text-xs px-3 py-1.5 rounded-lg bg-purple-950/40 hover:bg-purple-900/60 border border-purple-500/20 hover:border-purple-400/50 text-purple-200 transition-all"
              >
                {p.title}
              </button>
            ))}
          </div>
        </div>

        {/* Submit Action */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={!dreamText.trim() || isLoading}
            className={`w-full py-4 px-6 rounded-xl font-medium flex items-center justify-center gap-3 transition-all duration-300 shadow-xl ${
              !dreamText.trim() || isLoading
                ? 'bg-slate-800/80 text-slate-500 border border-slate-700/50 cursor-not-allowed'
                : 'bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-500 hover:from-purple-500 hover:to-cyan-400 text-white border border-purple-400/40 hover:shadow-purple-500/25 active:scale-[0.99]'
            }`}
          >
            {isLoading ? (
              <>
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Dream Architect is analyzing vision & safety...</span>
              </>
            ) : (
              <>
                <Wand2 className="w-5 h-5 text-cyan-200" />
                <span className="font-semibold tracking-wide">Consult Dream Architect</span>
              </>
            )}
          </button>
        </div>

      </form>

    </div>
  );
};
