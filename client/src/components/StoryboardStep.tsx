import React, { useState } from 'react';
import { 
  Sparkles, 
  Film, 
  Layers, 
  Split, 
  Combine, 
  Play, 
  RefreshCw, 
  ArrowLeft, 
  CheckCircle2, 
  AlertCircle, 
  Video, 
  Edit3, 
  Save, 
  Check
} from 'lucide-react';

export interface KeyframeOption {
  id: string;
  imageUrl: string;
  aspectRatio: string;
  seed: number;
  isMock?: boolean;
}

export interface DreamScene {
  sceneNumber: number;
  summary: string;
  mood: string;
  keyframePrompt: string;
  motionPrompt: string;
  cameraMotion: string;
  status?: 'pending' | 'keyframes_queued' | 'keyframes_ready' | 'video_queued' | 'rendering' | 'completed' | 'failed';
  keyframes?: KeyframeOption[];
  selectedKeyframeId?: string;
  video?: any;
  error?: string;
  activeJobId?: string;
}

interface StoryboardStepProps {
  dreamId: string;
  scenes: DreamScene[];
  sessionStatus?: string;
  sessionVideo?: any;
  sessionError?: string;
  userCredits: number;
  liveProgress?: any;
  onUpdateScenes: (updatedScenes: DreamScene[]) => Promise<void>;
  onGenerateKeyframesForScene: (sceneNumber: number) => Promise<void>;
  onGenerateAllKeyframes: () => Promise<void>;
  onSelectKeyframe: (sceneNumber: number, keyframeId: string) => void;
  onGenerateSingleSceneVideo: (sceneNumber: number) => Promise<void>;
  onGenerateAllMissingScenes: () => Promise<void>;
  onReStitch: () => Promise<void>;
  onWatchDream: (finalVideo: any) => void;
  onBack: () => void;
}

export const StoryboardStep: React.FC<StoryboardStepProps> = ({
  dreamId,
  scenes,
  sessionStatus,
  sessionVideo,
  sessionError,
  userCredits,
  liveProgress,
  onUpdateScenes,
  onGenerateKeyframesForScene,
  onGenerateAllKeyframes,
  onSelectKeyframe,
  onGenerateSingleSceneVideo,
  onGenerateAllMissingScenes,
  onReStitch,
  onWatchDream,
  onBack
}) => {
  const [activeSceneTab, setActiveSceneTab] = useState<number>(1);
  const [editingSceneNum, setEditingSceneNum] = useState<number | null>(null);
  const [editedPrompt, setEditedPrompt] = useState<{ keyframePrompt: string; motionPrompt: string }>({
    keyframePrompt: '',
    motionPrompt: ''
  });
  const [isGeneratingBatch, setIsGeneratingBatch] = useState(false);
  const [isGeneratingAllKf, setIsGeneratingAllKf] = useState(false);
  const [isReStitching, setIsReStitching] = useState(false);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);

  const totalScenes = scenes.length;
  const completedScenesCount = scenes.filter(s => s.status === 'completed').length;
  const allScenesCompleted = totalScenes > 0 && completedScenesCount === totalScenes;
  const isStitchingActive = sessionStatus === 'stitching_queued' || sessionStatus === 'stitching';
  const isStitchFailed = sessionStatus === 'stitch_failed';
  const isFinalDreamReady = (sessionStatus === 'completed' && sessionVideo) || (totalScenes === 1 && scenes[0]?.video);

  // Missing keyframes check
  const scenesWithoutKeyframes = scenes.filter(
    s => s.status !== 'completed' && !s.selectedKeyframeId && (!s.keyframes || s.keyframes.length === 0)
  );

  const startEditPrompt = (scene: DreamScene) => {
    setEditingSceneNum(scene.sceneNumber);
    setEditedPrompt({
      keyframePrompt: scene.keyframePrompt,
      motionPrompt: scene.motionPrompt
    });
  };

  const saveEditPrompt = async (sceneNumber: number) => {
    const updated = scenes.map(s => {
      if (s.sceneNumber === sceneNumber) {
        return {
          ...s,
          keyframePrompt: editedPrompt.keyframePrompt,
          motionPrompt: editedPrompt.motionPrompt
        };
      }
      return s;
    });
    setEditingSceneNum(null);
    await onUpdateScenes(updated);
  };

  // Storyboard Action: Split Scene into Two
  const handleSplitScene = async (sceneNumber: number) => {
    if (scenes.length >= 4) {
      alert('Maksimum 4 sahne oluşturulabilir.');
      return;
    }

    const targetScene = scenes.find(s => s.sceneNumber === sceneNumber);
    if (!targetScene) return;

    const newScene1: DreamScene = {
      ...targetScene,
      sceneNumber,
      summary: `${targetScene.summary} (Bölüm A)`,
      motionPrompt: `${targetScene.motionPrompt}, initial subtle motion`
    };

    const newScene2: DreamScene = {
      sceneNumber: sceneNumber + 1,
      summary: `${targetScene.summary} (Bölüm B)`,
      mood: targetScene.mood,
      keyframePrompt: `${targetScene.keyframePrompt}, shifted perspective, dream evolution`,
      motionPrompt: `${targetScene.motionPrompt}, continuous cinematic flow`,
      cameraMotion: 'smooth pan forward',
      status: 'pending'
    };

    const targetIndex = scenes.findIndex(s => s.sceneNumber === sceneNumber);
    const updated = [
      ...scenes.slice(0, targetIndex),
      newScene1,
      newScene2,
      ...scenes.slice(targetIndex + 1)
    ].map((s, idx) => ({ ...s, sceneNumber: idx + 1 }));

    await onUpdateScenes(updated);
    setActiveSceneTab(sceneNumber + 1);
  };

  // Storyboard Action: Merge Scene with Next Scene
  const handleMergeWithNext = async (sceneNumber: number) => {
    if (sceneNumber >= scenes.length) return;

    const s1 = scenes.find(s => s.sceneNumber === sceneNumber);
    const s2 = scenes.find(s => s.sceneNumber === sceneNumber + 1);
    if (!s1 || !s2) return;

    const mergedScene: DreamScene = {
      sceneNumber,
      summary: `${s1.summary} & ${s2.summary}`,
      mood: s1.mood,
      keyframePrompt: `${s1.keyframePrompt}, seamlessly blending into ${s2.keyframePrompt}`,
      motionPrompt: `${s1.motionPrompt}, transitioning into ${s2.motionPrompt}`,
      cameraMotion: s1.cameraMotion || 'smooth slow pan',
      status: s1.status === 'completed' && s2.status === 'completed' ? 'completed' : 'pending',
      keyframes: s1.keyframes || s2.keyframes,
      selectedKeyframeId: s1.selectedKeyframeId || s2.selectedKeyframeId,
      video: s1.video
    };

    const targetIndex = scenes.findIndex(s => s.sceneNumber === sceneNumber);
    const updated = [
      ...scenes.slice(0, targetIndex),
      mergedScene,
      ...scenes.slice(targetIndex + 2)
    ].map((s, idx) => ({ ...s, sceneNumber: idx + 1 }));

    await onUpdateScenes(updated);
    setActiveSceneTab(Math.min(sceneNumber, updated.length));
  };

  // Batch Trigger: Generate All Keyframes
  const handleBatchKeyframes = async () => {
    setIsGeneratingAllKf(true);
    try {
      await onGenerateAllKeyframes();
    } finally {
      setIsGeneratingAllKf(false);
    }
  };

  // Batch Trigger: Generate Missing Scenes
  const handleBatchGenerate = async () => {
    setValidationWarning(null);

    if (scenesWithoutKeyframes.length > 0) {
      setValidationWarning(
        `Lütfen önce tüm sahneler için birer keyframe üretin ve seçin. Eksik sahneler: [${scenesWithoutKeyframes.map(s => `Sahne #${s.sceneNumber}`).join(', ')}]`
      );
      return;
    }

    setIsGeneratingBatch(true);
    try {
      await onGenerateAllMissingScenes();
    } catch (err: any) {
      setValidationWarning(err.message || 'Sahneler kuyruğa alınamadı.');
    } finally {
      setIsGeneratingBatch(false);
    }
  };

  // Trigger Re-Stitch
  const handleReStitchClick = async () => {
    setIsReStitching(true);
    try {
      await onReStitch();
    } finally {
      setIsReStitching(false);
    }
  };

  const activeScene = scenes.find(s => s.sceneNumber === activeSceneTab) || scenes[0];

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 animate-fadeIn text-slate-100">
      
      {/* Top Storyboard Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Rüya Metnine Dön</span>
          </button>

          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2.5">
            <Film className="w-6 h-6 text-cyan-400" />
            <span>Sinematik Rüya Storyboard'u</span>
          </h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5">
            Çok sahneli kompozisyon planlayıcısı • Wan 2.2 ve FFmpeg Crossfade Motoru • Oturum: {dreamId}
          </p>
        </div>

        {/* Global Action Badges & Credits */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="px-3 py-1.5 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-300 text-xs font-mono font-medium flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-purple-400" />
            <span>{totalScenes} Sahne ({totalScenes * 5}s)</span>
          </div>

          <div className="px-3 py-1.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-mono font-medium flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <span>Bakiye: {userCredits} Kredi</span>
          </div>
        </div>
      </div>

      {/* Session Error Alert */}
      {sessionError && (
        <div className="mb-6 p-4 rounded-2xl bg-red-500/10 border border-red-500/40 text-red-200 text-xs flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-red-300">Birleştirme / İşlem Uyarısı</p>
            <p className="mt-0.5 font-mono">{sessionError}</p>
          </div>
        </div>
      )}

      {/* Validation Warning Notice */}
      {validationWarning && (
        <div className="mb-6 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/40 text-amber-200 text-xs flex items-start gap-3 animate-shake">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-amber-300">İşlem Başlatılamadı</p>
            <p className="mt-0.5 leading-relaxed">{validationWarning}</p>
          </div>
          <button onClick={() => setValidationWarning(null)} className="text-amber-400 hover:text-amber-200 text-xs font-mono">
            Kapat
          </button>
        </div>
      )}

      {/* Multi-Scene Timeline Navigation Tabs */}
      <div className="glass-panel rounded-2xl p-2 mb-6 border border-slate-800 flex items-center gap-2 overflow-x-auto">
        {scenes.map((scene) => {
          const isCurrent = scene.sceneNumber === activeSceneTab;
          const isDone = scene.status === 'completed';
          const isRendering = scene.status === 'rendering' || scene.status === 'video_queued';
          const hasKf = Boolean(scene.selectedKeyframeId || (scene.keyframes && scene.keyframes.length > 0));

          return (
            <button
              key={scene.sceneNumber}
              onClick={() => setActiveSceneTab(scene.sceneNumber)}
              className={`flex-1 min-w-[160px] p-3 rounded-xl text-left transition-all relative ${
                isCurrent
                  ? 'bg-gradient-to-r from-purple-900/60 to-indigo-900/60 border border-cyan-400/50 shadow-lg text-white'
                  : 'bg-slate-900/40 hover:bg-slate-800/40 border border-slate-800/80 text-slate-400'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold font-mono tracking-wide">Sahne #{scene.sceneNumber}</span>
                {isDone ? (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-semibold bg-emerald-500/10 px-1.5 py-0.5 rounded-full border border-emerald-500/30">
                    <Check className="w-3 h-3" /> Klip Hazır
                  </span>
                ) : isRendering ? (
                  <span className="flex items-center gap-1 text-[10px] text-cyan-400 font-semibold bg-cyan-500/10 px-1.5 py-0.5 rounded-full border border-cyan-500/30 animate-pulse">
                    <RefreshCw className="w-3 h-3 animate-spin" /> Üretiliyor
                  </span>
                ) : hasKf ? (
                  <span className="text-[10px] text-purple-300 font-medium bg-purple-500/10 px-1.5 py-0.5 rounded-full border border-purple-500/30">
                    Keyframe Seçildi
                  </span>
                ) : (
                  <span className="text-[10px] text-amber-400 font-medium bg-amber-500/10 px-1.5 py-0.5 rounded-full border border-amber-500/30">
                    Keyframe Bekliyor
                  </span>
                )}
              </div>
              <p className="text-[11px] line-clamp-1 font-sans">{scene.summary}</p>
            </button>
          );
        })}
      </div>

      {/* Active Scene Editor & Keyframe Selector */}
      {activeScene && (
        <div className="glass-panel rounded-3xl p-6 sm:p-8 border border-slate-800/80 mb-6 bg-slate-950/60 shadow-2xl">
          
          {/* Scene Header & Split/Merge Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 flex items-center justify-center font-bold font-mono text-sm">
                #{activeScene.sceneNumber}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-white">{activeScene.summary}</h3>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-purple-300 border border-purple-500/30 font-mono">
                    {activeScene.mood}
                  </span>
                </div>
                <p className="text-xs text-slate-400 font-mono mt-0.5">Kamera Hareketi: {activeScene.cameraMotion}</p>
              </div>
            </div>

            {/* Split and Merge Action Buttons */}
            <div className="flex items-center gap-2">
              {editingSceneNum === activeScene.sceneNumber ? (
                <button
                  onClick={() => saveEditPrompt(activeScene.sceneNumber)}
                  className="px-3 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-semibold flex items-center gap-1.5 transition-all"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Kaydet</span>
                </button>
              ) : (
                <button
                  onClick={() => startEditPrompt(activeScene)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700 text-slate-300 text-xs font-medium flex items-center gap-1.5 transition-all"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Prompt Düzenle</span>
                </button>
              )}

              <button
                onClick={() => handleSplitScene(activeScene.sceneNumber)}
                className="px-3 py-1.5 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-300 text-xs font-medium flex items-center gap-1.5 transition-all"
                title="Bu sahneyi iki bağımsız alt sahneye böler"
              >
                <Split className="w-3.5 h-3.5" />
                <span>Sahneyi Böl</span>
              </button>

              {activeScene.sceneNumber < totalScenes && (
                <button
                  onClick={() => handleMergeWithNext(activeScene.sceneNumber)}
                  className="px-3 py-1.5 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-xs font-medium flex items-center gap-1.5 transition-all"
                  title="Bu sahneyi sonraki sahneyle birleştirir"
                >
                  <Combine className="w-3.5 h-3.5" />
                  <span>Sonrakiyle Birleştir</span>
                </button>
              )}
            </div>
          </div>

          {/* Prompt Editor (if active) */}
          {editingSceneNum === activeScene.sceneNumber && (
            <div className="mt-4 p-4 rounded-2xl bg-slate-900/80 border border-cyan-500/30 space-y-3 animate-fadeIn">
              <div>
                <label className="text-[11px] font-mono text-cyan-300 uppercase tracking-wider block mb-1">
                  Keyframe Kompozisyon Prompt'u
                </label>
                <textarea
                  value={editedPrompt.keyframePrompt}
                  onChange={(e) => setEditedPrompt({ ...editedPrompt, keyframePrompt: e.target.value })}
                  className="w-full h-16 p-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="text-[11px] font-mono text-purple-300 uppercase tracking-wider block mb-1">
                  Video Hareket (Motion) Prompt'u
                </label>
                <textarea
                  value={editedPrompt.motionPrompt}
                  onChange={(e) => setEditedPrompt({ ...editedPrompt, motionPrompt: e.target.value })}
                  className="w-full h-16 p-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-purple-400"
                />
              </div>
            </div>
          )}

          {/* Keyframe Gallery for this Scene */}
          <div className="mt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <span>Sahne #{activeScene.sceneNumber} Anahtar Görseli (Keyframe)</span>
                  <span className="text-[10px] text-slate-500 font-normal">
                    (Wan 2.2 Image-to-Video için başlangıç karesi)
                  </span>
                </h4>
              </div>

              {activeScene.keyframes && activeScene.keyframes.length > 0 && (
                <button
                  onClick={() => onGenerateKeyframesForScene(activeScene.sceneNumber)}
                  className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-mono transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Yeniden Üret</span>
                </button>
              )}
            </div>

            {/* If keyframes exist for this scene, show gallery */}
            {activeScene.keyframes && activeScene.keyframes.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {activeScene.keyframes.map((kf) => {
                  const isSelected = (activeScene.selectedKeyframeId || activeScene.keyframes![0].id) === kf.id;

                  return (
                    <div
                      key={kf.id}
                      onClick={() => onSelectKeyframe(activeScene.sceneNumber, kf.id)}
                      className={`group relative rounded-2xl overflow-hidden cursor-pointer border-2 transition-all duration-300 ${
                        isSelected
                          ? 'border-cyan-400 shadow-[0_0_30px_rgba(6,182,212,0.35)] scale-[1.02]'
                          : 'border-slate-800 hover:border-slate-600 opacity-80 hover:opacity-100'
                      }`}
                    >
                      <div className="aspect-video w-full bg-slate-900 relative">
                        <img
                          src={kf.imageUrl}
                          alt={`Keyframe ${kf.id}`}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />

                        {isSelected && (
                          <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full bg-cyan-500 text-slate-950 font-bold text-[10px] flex items-center gap-1 shadow-md">
                            <Check className="w-3 h-3 stroke-[3]" /> Seçildi
                          </div>
                        )}

                        <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between text-[10px] font-mono text-slate-300">
                          <span>Seed: {kf.seed}</span>
                          {kf.isMock && <span className="text-amber-400">Mock Anchor</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              // Empty State: Generate Keyframe Button for this Scene
              <div className="p-8 rounded-2xl border-2 border-dashed border-slate-800 hover:border-slate-700 bg-slate-900/30 text-center flex flex-col items-center justify-center">
                <div className="w-12 h-12 rounded-2xl bg-purple-500/10 border border-purple-500/30 text-purple-400 flex items-center justify-center mb-3">
                  <Sparkles className="w-6 h-6 animate-pulse" />
                </div>
                <h4 className="text-sm font-semibold text-slate-200">Bu Sahne İçin Keyframe Üretilmedi</h4>
                <p className="text-xs text-slate-400 max-w-sm mt-1 mb-4 font-sans">
                  GPU üzerinde bu sahnenin kompozisyonunu oluşturan 3 farklı sanatsal anahtar kare üretin.
                </p>
                <button
                  onClick={() => onGenerateKeyframesForScene(activeScene.sceneNumber)}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-600 hover:from-cyan-400 hover:to-purple-500 text-white font-semibold text-xs shadow-lg transition-all flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Sahne #{activeScene.sceneNumber} İçin Keyframe Üret</span>
                </button>
              </div>
            )}
          </div>

          {/* Video Status or Single-Scene Generate Button */}
          <div className="mt-8 pt-6 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <span className="text-xs text-slate-400 block font-mono">
                Sahne Durumu: <strong className="text-white capitalize">{activeScene.status || 'pending'}</strong>
              </span>
              {activeScene.video && (
                <span className="text-xs text-emerald-400 flex items-center gap-1.5 mt-0.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Video Klip Hazır ({activeScene.video.durationSeconds}s)</span>
                </span>
              )}
            </div>

            {/* Action for single scene */}
            {activeScene.status !== 'completed' && activeScene.status !== 'video_queued' && activeScene.status !== 'rendering' && (
              <button
                onClick={() => onGenerateSingleSceneVideo(activeScene.sceneNumber)}
                disabled={!activeScene.selectedKeyframeId && (!activeScene.keyframes || activeScene.keyframes.length === 0)}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-xs shadow-lg flex items-center gap-2 transition-all"
              >
                <Video className="w-4 h-4" />
                <span>Sadece Bu Sahneyi Üret (1 Kredi)</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Global Storyboard Actions & Stitching Section */}
      <div className="glass-panel-glow rounded-3xl p-6 sm:p-8 border border-purple-500/30 bg-[#0d0f26]/90 shadow-2xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Film className="w-5 h-5 text-cyan-400" />
              <span>Tüm Sahneleri Birleştir ve Rüyayı Tamamla</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1 max-w-xl font-sans">
              Her sahne tek tek GPU Wan 2.2 modelinde üretilir. Tüm sahneler bittiğinde FFmpeg 0.3 saniyelik sinematik crossfade ile sahneleri kusursuzca birleştirir.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Generate all keyframes button */}
            {scenes.some(s => !s.keyframes || s.keyframes.length === 0) && (
              <button
                onClick={handleBatchKeyframes}
                disabled={isGeneratingAllKf}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 flex items-center gap-2 transition-all disabled:opacity-50"
              >
                {isGeneratingAllKf ? (
                  <RefreshCw className="w-4 h-4 animate-spin text-purple-400" />
                ) : (
                  <Sparkles className="w-4 h-4 text-purple-400" />
                )}
                <span>Tüm Keyframe'leri Çıkar</span>
              </button>
            )}

            {/* Generate all missing scenes button */}
            {!allScenesCompleted && (
              <button
                onClick={handleBatchGenerate}
                disabled={isGeneratingBatch || scenesWithoutKeyframes.length > 0}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-600 hover:from-cyan-400 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs shadow-xl flex items-center gap-2 transition-all"
              >
                {isGeneratingBatch ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Video className="w-4 h-4" />
                )}
                <span>Eksik Sahneleri Üret ({scenes.filter(s => s.status !== 'completed').length} Kredi)</span>
              </button>
            )}

            {/* Stitching in Progress Banner */}
            {isStitchingActive && (
              <div className="px-4 py-2 rounded-xl bg-purple-500/20 border border-purple-500/40 text-purple-300 text-xs font-mono flex items-center gap-2 animate-pulse">
                <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
                <span>FFmpeg Sahneleri Birleştiriyor (Crossfade 0.3s){liveProgress?.stageLabel ? ` • ${liveProgress.stageLabel}` : ''}</span>
              </div>
            )}

            {/* Stitching Failed Recovery: Free Re-Stitch Button */}
            {isStitchFailed && (
              <button
                onClick={handleReStitchClick}
                disabled={isReStitching}
                className="px-4 py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-200 font-bold text-xs flex items-center gap-2 transition-all"
              >
                <RefreshCw className={`w-4 h-4 ${isReStitching ? 'animate-spin' : ''}`} />
                <span>Tekrar Birleştir (Ücretsiz)</span>
              </button>
            )}

            {/* Final Dream Ready Watch Button */}
            {isFinalDreamReady && (
              <button
                onClick={() => onWatchDream(sessionVideo || scenes[0]?.video)}
                className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-extrabold text-xs shadow-[0_0_25px_rgba(16,185,129,0.35)] flex items-center gap-2 transition-all transform hover:scale-105"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Rüyayı İzle (Player)</span>
              </button>
            )}
          </div>
        </div>
      </div>

    </div>
  );
};
