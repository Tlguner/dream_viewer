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
  Check,
  X
} from 'lucide-react';

export interface KeyframeOption {
  id: string;
  imageUrl: string;
  aspectRatio: string;
  seed: number;
  isMock?: boolean;
}

export interface DreamScene {
  sceneId?: string;
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
  onSplitScene: (sceneId: string, newSceneText: string) => Promise<void>;
  onMergeScene: (sceneId: string, targetSceneId: string, strategy: 'keep_current' | 'keep_target' | 'reanalyze') => Promise<void>;
  onPatchPrompt: (sceneId: string, prompts: { summary?: string; keyframePrompt?: string; motionPrompt?: string }) => Promise<void>;
  onGenerateKeyframesForScene: (sceneNumber: number, sceneId?: string) => Promise<void>;
  onGenerateAllKeyframes: () => Promise<void>;
  onSelectKeyframe: (sceneNumber: number, keyframeId: string) => void;
  onGenerateSingleSceneVideo: (sceneNumber: number, sceneId?: string) => Promise<void>;
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
  onSplitScene,
  onMergeScene,
  onPatchPrompt,
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
  const [isPatching, setIsPatching] = useState(false);

  // Split Modal State
  const [isSplitModalOpen, setIsSplitModalOpen] = useState(false);
  const [newSceneDescription, setNewSceneDescription] = useState('');
  const [isSplitting, setIsSplitting] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);

  // Merge Modal State
  const [isMergeModalOpen, setIsMergeModalOpen] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<'keep_current' | 'keep_target' | 'reanalyze'>('reanalyze');
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Batch actions state
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

  const activeScene = scenes.find(s => s.sceneNumber === activeSceneTab) || scenes[0];
  const nextScene = scenes.find(s => s.sceneNumber === activeScene?.sceneNumber + 1);

  // Prompt Editing Handlers
  const startEditPrompt = (scene: DreamScene) => {
    setEditingSceneNum(scene.sceneNumber);
    setEditedPrompt({
      keyframePrompt: scene.keyframePrompt,
      motionPrompt: scene.motionPrompt
    });
  };

  const saveEditPrompt = async (scene: DreamScene) => {
    const targetId = scene.sceneId || String(scene.sceneNumber);
    setIsPatching(true);
    try {
      await onPatchPrompt(targetId, {
        keyframePrompt: editedPrompt.keyframePrompt,
        motionPrompt: editedPrompt.motionPrompt
      });
      setEditingSceneNum(null);
    } catch (err: any) {
      setValidationWarning(err.message || 'Prompt güncellenemedi.');
    } finally {
      setIsPatching(false);
    }
  };

  // Open Split Dialog
  const handleOpenSplitModal = () => {
    if (scenes.length >= 3) {
      setValidationWarning('Rüya en fazla 3 sahneye bölünebilir.');
      return;
    }
    setNewSceneDescription('');
    setSplitError(null);
    setIsSplitModalOpen(true);
  };

  // Confirm Split Action via Dream Architect
  const handleConfirmSplit = async () => {
    if (!newSceneDescription.trim() || newSceneDescription.trim().length < 3) {
      setSplitError('Lütfen yeni sahne için en az 3 karakterlik bir açıklama yazın.');
      return;
    }
    if (!activeScene) return;

    setIsSplitting(true);
    setSplitError(null);
    try {
      const targetId = activeScene.sceneId || String(activeScene.sceneNumber);
      await onSplitScene(targetId, newSceneDescription.trim());
      setIsSplitModalOpen(false);
      setActiveSceneTab(activeScene.sceneNumber + 1);
    } catch (err: any) {
      setSplitError(err.message || 'Sahne bölme işlemi başarısız oldu.');
    } finally {
      setIsSplitting(false);
    }
  };

  // Open Merge Dialog
  const handleOpenMergeModal = () => {
    if (scenes.length <= 1) {
      setValidationWarning('Rüya en az 1 sahne içermelidir.');
      return;
    }
    setMergeStrategy('reanalyze');
    setMergeError(null);
    setIsMergeModalOpen(true);
  };

  // Confirm Merge Action
  const handleConfirmMerge = async () => {
    if (!activeScene || !nextScene) return;

    setIsMerging(true);
    setMergeError(null);
    try {
      const currentId = activeScene.sceneId || String(activeScene.sceneNumber);
      const targetId = nextScene.sceneId || String(nextScene.sceneNumber);
      await onMergeScene(currentId, targetId, mergeStrategy);
      setIsMergeModalOpen(false);
      setActiveSceneTab(Math.min(activeScene.sceneNumber, totalScenes - 1));
    } catch (err: any) {
      setMergeError(err.message || 'Sahneleri birleştirme işlemi başarısız oldu.');
    } finally {
      setIsMerging(false);
    }
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
              key={scene.sceneId || scene.sceneNumber}
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
                  <span className="text-[10px] text-slate-500 font-mono">Bekliyor</span>
                )}
              </div>
              <p className="text-xs font-medium text-slate-200 line-clamp-1">{scene.summary || `Sahne #${scene.sceneNumber}`}</p>
            </button>
          );
        })}
      </div>

      {/* Active Scene Detailed Card */}
      {activeScene && (
        <div className="glass-panel rounded-3xl p-6 sm:p-8 mb-8 border border-slate-800/80 shadow-2xl relative">
          
          {/* Header of Active Scene */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-800/80">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-mono text-[11px] font-semibold">
                  Sahne {activeScene.sceneNumber} / {totalScenes}
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-300 font-mono text-[11px]">
                  {activeScene.mood}
                </span>
              </div>
              <h3 className="text-lg font-bold text-white">{activeScene.summary}</h3>
            </div>

            {/* Actions for this Scene: Edit, Split, Merge */}
            <div className="flex flex-wrap items-center gap-2">
              {editingSceneNum === activeScene.sceneNumber ? (
                <button
                  onClick={() => saveEditPrompt(activeScene)}
                  disabled={isPatching}
                  className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-all shadow-md disabled:opacity-50"
                >
                  {isPatching ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>Kaydet</span>
                </button>
              ) : (
                <button
                  onClick={() => startEditPrompt(activeScene)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium flex items-center gap-1.5 border border-slate-700 transition-all"
                  title="Prompt metinlerini düzenle"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Prompt Düzenle</span>
                </button>
              )}

              <button
                onClick={handleOpenSplitModal}
                disabled={totalScenes >= 3}
                className="px-3 py-1.5 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 disabled:opacity-40 disabled:cursor-not-allowed border border-purple-500/30 text-purple-300 text-xs font-medium flex items-center gap-1.5 transition-all"
                title="Yeni bir mekân ekleyerek sahneyi böl"
              >
                <Split className="w-3.5 h-3.5" />
                <span>Sahneyi Böl</span>
              </button>

              {nextScene && (
                <button
                  onClick={handleOpenMergeModal}
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
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>Prompt değiştirildiğinde bu sahnenin üretilmiş keyframe'leri ve videosu sıfırlanır.</span>
              </div>
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
                  onClick={() => onGenerateKeyframesForScene(activeScene.sceneNumber, activeScene.sceneId)}
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
                  onClick={() => onGenerateKeyframesForScene(activeScene.sceneNumber, activeScene.sceneId)}
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
                onClick={() => onGenerateSingleSceneVideo(activeScene.sceneNumber, activeScene.sceneId)}
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

      {/* MODAL 1: Split Scene Dialog */}
      {isSplitModalOpen && activeScene && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
          <div className="glass-panel w-full max-w-lg p-6 rounded-3xl border border-cyan-500/40 bg-slate-950 shadow-2xl relative">
            <button
              onClick={() => setIsSplitModalOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2.5 mb-2 text-cyan-400">
              <Split className="w-5 h-5" />
              <h3 className="text-base font-bold text-white">Sahne #{activeScene.sceneNumber} Bölme (Dream Architect)</h3>
            </div>
            <p className="text-xs text-slate-400 mb-4 leading-relaxed font-sans">
              Mevcut sahnenin hemen ardına eklenecek yeni sahnenin mekânını veya olayını yazın. Dream Architect yapay zekâsı bu metni analiz ederek sinematik prompt'ları oluşturacaktır.
            </p>

            {splitError && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{splitError}</span>
              </div>
            )}

            <div className="space-y-3 mb-6">
              <label className="text-[11px] font-mono text-cyan-300 uppercase tracking-wider block">
                Yeni Sahne Konsepti / Mekânı
              </label>
              <textarea
                value={newSceneDescription}
                onChange={(e) => setNewSceneDescription(e.target.value)}
                placeholder="Örn: kendimi mor bir lavanta tarlasında koşarken buldum"
                className="w-full h-24 p-3 rounded-2xl bg-slate-900 border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-400 leading-relaxed"
              />
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setIsSplitModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-white"
              >
                İptal
              </button>
              <button
                onClick={handleConfirmSplit}
                disabled={isSplitting}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-600 hover:from-cyan-400 hover:to-purple-500 text-white font-bold text-xs shadow-lg flex items-center gap-2 transition-all disabled:opacity-50"
              >
                {isSplitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                <span>{isSplitting ? 'Architect Analiz Ediyor...' : 'Böl ve Prompt Üret'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Merge Scenes Dialog */}
      {isMergeModalOpen && activeScene && nextScene && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
          <div className="glass-panel w-full max-w-lg p-6 rounded-3xl border border-indigo-500/40 bg-slate-950 shadow-2xl relative">
            <button
              onClick={() => setIsMergeModalOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2.5 mb-2 text-indigo-400">
              <Combine className="w-5 h-5" />
              <h3 className="text-base font-bold text-white">
                Sahne #{activeScene.sceneNumber} ve #{nextScene.sceneNumber} Birleştirme
              </h3>
            </div>
            <p className="text-xs text-slate-400 mb-4 leading-relaxed font-sans">
              İki sahneyi nasıl birleştirmek istediğinizi seçin. Birleştirme tamamlandığında video ve keyframe'ler sıfırlanacaktır.
            </p>

            {mergeError && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{mergeError}</span>
              </div>
            )}

            <div className="space-y-3 mb-6">
              <label
                onClick={() => setMergeStrategy('reanalyze')}
                className={`p-3.5 rounded-2xl border cursor-pointer block transition-all ${
                  mergeStrategy === 'reanalyze'
                    ? 'bg-purple-900/30 border-purple-400 text-white shadow-md'
                    : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-xs text-purple-300">
                  <input
                    type="radio"
                    name="strategy"
                    checked={mergeStrategy === 'reanalyze'}
                    onChange={() => setMergeStrategy('reanalyze')}
                    className="accent-purple-400"
                  />
                  <span>Dream Architect İle Yeniden Sentezle (Önerilen)</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1 pl-5">
                  Her iki sahnenin metinlerini birleştirip tek bir tutarlı sinematik prompt üretir.
                </p>
              </label>

              <label
                onClick={() => setMergeStrategy('keep_current')}
                className={`p-3.5 rounded-2xl border cursor-pointer block transition-all ${
                  mergeStrategy === 'keep_current'
                    ? 'bg-indigo-900/30 border-indigo-400 text-white shadow-md'
                    : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-xs text-indigo-300">
                  <input
                    type="radio"
                    name="strategy"
                    checked={mergeStrategy === 'keep_current'}
                    onChange={() => setMergeStrategy('keep_current')}
                    className="accent-indigo-400"
                  />
                  <span>Sadece Sahne #{activeScene.sceneNumber} Promptunu Koru</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1 pl-5">
                  İlk sahnenin kompozisyonunu korur, Sahne #{nextScene.sceneNumber}'yi kaldırır.
                </p>
              </label>

              <label
                onClick={() => setMergeStrategy('keep_target')}
                className={`p-3.5 rounded-2xl border cursor-pointer block transition-all ${
                  mergeStrategy === 'keep_target'
                    ? 'bg-cyan-900/30 border-cyan-400 text-white shadow-md'
                    : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-xs text-cyan-300">
                  <input
                    type="radio"
                    name="strategy"
                    checked={mergeStrategy === 'keep_target'}
                    onChange={() => setMergeStrategy('keep_target')}
                    className="accent-cyan-400"
                  />
                  <span>Sadece Sahne #{nextScene.sceneNumber} Promptunu Koru</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1 pl-5">
                  İkinci sahnenin kompozisyonunu korur, Sahne #{activeScene.sceneNumber}'yi kaldırır.
                </p>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setIsMergeModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-white"
              >
                İptal
              </button>
              <button
                onClick={handleConfirmMerge}
                disabled={isMerging}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white font-bold text-xs shadow-lg flex items-center gap-2 transition-all disabled:opacity-50"
              >
                {isMerging ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Combine className="w-4 h-4" />}
                <span>{isMerging ? 'Birleştiriliyor...' : 'Sahneleri Birleştir'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
