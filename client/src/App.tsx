import { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { DreamInputStep } from './components/DreamInputStep';
import { StoryboardStep, type DreamScene } from './components/StoryboardStep';
import { DreamPlayerStep } from './components/DreamPlayerStep';
import { ManifestingHUD, type LiveProgress } from './components/ManifestingHUD';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5000/api';

type Step = 'INPUT' | 'STORYBOARD' | 'PLAYER';

export function App() {
  const [step, setStep] = useState<Step>('INPUT');
  const [credits, setCredits] = useState<number>(10);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live real-time progress HUD state
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);
  const [hudMode, setHudMode] = useState<'KEYFRAMES' | 'VIDEO'>('VIDEO');
  const [isHudOpen, setIsHudOpen] = useState<boolean>(false);

  // Initial provider info starts in honest mock/detecting state
  const [providerInfo, setProviderInfo] = useState<{
    name: string;
    isMock: boolean;
    architect?: { provider: string; model: string | null; isMock: boolean } | null;
  }>({
    name: 'Detecting Provider...',
    isMock: true,
    architect: null
  });

  // Stateful dream pipeline
  const [currentDreamId, setCurrentDreamId] = useState<string | null>(null);
  const [scenes, setScenes] = useState<DreamScene[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string>('analyzed');
  const [sessionVideo, setSessionVideo] = useState<any>(null);
  const [sessionError, setSessionError] = useState<string | undefined>(undefined);
  const [completedDream, setCompletedDream] = useState<any>(null);

  // Fetch initial profile & provider health
  const refreshUserProfile = () => {
    fetch(`${API_BASE}/user/profile`)
      .then(res => res.json())
      .then(data => {
        if (data.availableCredits !== undefined) {
          setCredits(data.availableCredits);
        } else if (data.credits !== undefined) {
          setCredits(data.credits);
        }
      })
      .catch(() => {
        setCredits(10);
      });
  };

  useEffect(() => {
    refreshUserProfile();

    fetch(`${API_BASE}/health`)
      .then(res => res.json())
      .then(data => {
        if (data.provider) {
          setProviderInfo({
            name: data.provider,
            isMock: Boolean(data.isMock),
            architect: data.architect
              ? {
                  provider: String(data.architect.provider || ''),
                  model: data.architect.model ?? null,
                  isMock: Boolean(data.architect.isMock)
                }
              : null
          });
        }
      })
      .catch(() => {});
  }, []);

  // Helper to open live SSE progress stream
  const subscribeToProgress = (dreamId: string, mode: 'KEYFRAMES' | 'VIDEO') => {
    setHudMode(mode);
    setLiveProgress({
      stage: 'INITIALIZING',
      stageLabel: mode === 'VIDEO' ? 'Preparing Video Pipeline' : 'Initializing Keyframe Pipeline',
      detail: 'Connecting to GPU live stream...',
      percent: 0,
      elapsedSeconds: 0
    });
    setIsHudOpen(true);

    const eventSource = new EventSource(`${API_BASE}/dreams/progress/${dreamId}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLiveProgress(data);

        // Update active scene rendering status if matching scene progress
        if (data.currentScene) {
          setScenes(prev => prev.map(s => {
            if (s.sceneNumber === data.currentScene) {
              return {
                ...s,
                status: data.stage === 'COMPLETED' ? 'completed' : 'rendering'
              };
            }
            return s;
          }));
        }

        // If stitching stage received
        if (data.stage === 'STITCHING') {
          setSessionStatus('stitching');
        } else if (data.stage === 'COMPLETED' && data.result?.videoUrl) {
          setSessionStatus('completed');
          setSessionVideo(data.result);
        }
      } catch {
        // ignore non-json
      }
    };

    eventSource.onerror = () => {
      // Keep EventSource alive or fallback gracefully
    };

    return eventSource;
  };

  // Helper to poll asynchronous GPU keyframe jobs (202 Accepted pattern)
  const pollJobForKeyframes = async (jobId: string): Promise<any[]> => {
    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE}/dreams/jobs/${jobId}`);
          if (res.ok) {
            const data = await res.json();
            const readyKeyframes = data.keyframes || data.job?.keyframes;
            if (data.job?.status === 'completed' && readyKeyframes && readyKeyframes.length > 0) {
              clearInterval(timer);
              resolve(readyKeyframes);
            } else if (data.job?.status === 'failed') {
              clearInterval(timer);
              reject(new Error(data.job.error || 'Keyframe generation failed in queue'));
            }
          }
        } catch {
          // Ignore transient polling blips
        }
      }, 1500);

      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('Keyframe generation timed out after 5 minutes.'));
      }, 300000);
    });
  };

  // Helper to fetch latest session state
  const refreshSession = async (dreamId: string) => {
    try {
      const res = await fetch(`${API_BASE}/dreams/session/${dreamId}`);
      if (res.ok) {
        const data = await res.json();
        const s = data.session;
        if (s) {
          if (s.scenes) setScenes(s.scenes);
          if (s.status) setSessionStatus(s.status);
          if (s.video) setSessionVideo(s.video);
          if (s.error) setSessionError(s.error);
        }
      }
    } catch (err) {
      console.error('Failed to refresh session:', err);
    }
  };

  // Step 1: Analyze Dream with Dream Architect & Moderation Shield
  const handleAnalyze = async (rawText: string, moodHint: string) => {
    setIsAnalyzing(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/dreams/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawDreamText: rawText, moodHint })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Dream moderation check failed.');
      }

      const dreamId = data.dreamId;
      setCurrentDreamId(dreamId);
      const initialScenes: DreamScene[] = (data.data.scenes || []).map((s: any, idx: number) => ({
        ...s,
        sceneId: s.sceneId || `scene_${Date.now()}_${idx + 1}`,
        sceneNumber: idx + 1,
        status: 'pending'
      }));
      setScenes(initialScenes);
      setSessionStatus('analyzed');

      // Auto-generate keyframes for Scene 1
      const sse = subscribeToProgress(dreamId, 'KEYFRAMES');
      try {
        const kfRes = await fetch(`${API_BASE}/dreams/keyframes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dreamId, sceneNumber: 1, count: 3 })
        });

        const kfData = await kfRes.json();
        if (kfRes.ok) {
          let readyKeyframes: any[] = [];
          if (kfRes.status === 202 || kfData.status === 'queued') {
            readyKeyframes = await pollJobForKeyframes(kfData.jobId);
          } else {
            readyKeyframes = kfData.keyframes;
          }

          if (readyKeyframes && readyKeyframes.length > 0) {
            setScenes(prev => prev.map(s => {
              if (s.sceneNumber === 1) {
                return {
                  ...s,
                  keyframes: readyKeyframes,
                  selectedKeyframeId: readyKeyframes[0].id,
                  status: 'keyframes_ready'
                };
              }
              return s;
            }));
          }
        }
      } finally {
        sse.close();
        setIsHudOpen(false);
      }

      setStep('STORYBOARD');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unexpected issue occurred while analyzing your dream.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Storyboard Handler: Split Scene into Two via Architect
  const handleSplitScene = async (sceneId: string, newSceneText: string) => {
    if (!currentDreamId) return;
    const res = await fetch(`${API_BASE}/dreams/session/${currentDreamId}/scenes/${sceneId}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newSceneText })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Sahne bölme işlemi başarısız oldu.');
    }
    if (data.scenes) setScenes(data.scenes);
  };

  // Storyboard Handler: Merge Adjacent Scenes
  const handleMergeScene = async (sceneId: string, targetSceneId: string, strategy: 'keep_current' | 'keep_target' | 'reanalyze') => {
    if (!currentDreamId) return;
    const res = await fetch(`${API_BASE}/dreams/session/${currentDreamId}/scenes/${sceneId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSceneId, strategy })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Sahneleri birleştirme işlemi başarısız oldu.');
    }
    if (data.scenes) setScenes(data.scenes);
  };

  // Storyboard Handler: Patch Scene Prompt (Isolated & Audited)
  const handlePatchPrompt = async (sceneId: string, prompts: { summary?: string; keyframePrompt?: string; motionPrompt?: string }) => {
    if (!currentDreamId) return;
    const res = await fetch(`${API_BASE}/dreams/session/${currentDreamId}/scenes/${sceneId}/prompt`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompts)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Prompt güncellenemedi.');
    }
    if (data.scene) {
      setScenes(prev => prev.map(s => (s.sceneId === sceneId || String(s.sceneNumber) === sceneId) ? { ...s, ...data.scene } : s));
    }
  };

  // Storyboard Handler: Generate Keyframes for a Single Scene
  const handleGenerateKeyframesForScene = async (sceneNumber: number, sceneId?: string) => {
    if (!currentDreamId) return;

    setScenes(prev => prev.map(s => {
      if ((sceneId && s.sceneId === sceneId) || s.sceneNumber === sceneNumber) return { ...s, status: 'keyframes_queued' };
      return s;
    }));

    const sse = subscribeToProgress(currentDreamId, 'KEYFRAMES');
    try {
      const kfRes = await fetch(`${API_BASE}/dreams/keyframes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dreamId: currentDreamId, sceneId, sceneNumber, count: 3 })
      });
      const kfData = await kfRes.json();
      if (!kfRes.ok) throw new Error(kfData.message || 'Keyframe generation failed');

      let readyKeyframes: any[] = [];
      if (kfRes.status === 202 || kfData.status === 'queued') {
        readyKeyframes = await pollJobForKeyframes(kfData.jobId);
      } else {
        readyKeyframes = kfData.keyframes;
      }

      if (readyKeyframes && readyKeyframes.length > 0) {
        setScenes(prev => prev.map(s => {
          if ((sceneId && s.sceneId === sceneId) || s.sceneNumber === sceneNumber) {
            return {
              ...s,
              keyframes: readyKeyframes,
              selectedKeyframeId: readyKeyframes[0].id,
              status: 'keyframes_ready'
            };
          }
          return s;
        }));
      }
    } catch (err: any) {
      console.error(err);
      setScenes(prev => prev.map(s => {
        if ((sceneId && s.sceneId === sceneId) || s.sceneNumber === sceneNumber) return { ...s, status: 'failed', error: err.message };
        return s;
      }));
    } finally {
      sse.close();
      setIsHudOpen(false);
    }
  };

  // Storyboard Handler: Generate All Missing Keyframes
  const handleGenerateAllKeyframes = async () => {
    const pendingScenes = scenes.filter(s => !s.keyframes || s.keyframes.length === 0);
    for (const sc of pendingScenes) {
      await handleGenerateKeyframesForScene(sc.sceneNumber);
    }
  };

  // Storyboard Handler: Select Keyframe for Scene
  const handleSelectKeyframe = (sceneNumber: number, keyframeId: string) => {
    setScenes(prev => prev.map(s => {
      if (s.sceneNumber === sceneNumber) {
        return {
          ...s,
          selectedKeyframeId: keyframeId,
          status: 'keyframes_ready'
        };
      }
      return s;
    }));
  };

  // Storyboard Handler: Generate Video for a Single Scene
  const handleGenerateSingleSceneVideo = async (sceneNumber: number, sceneId?: string) => {
    if (!currentDreamId) return;

    const targetScene = sceneId ? scenes.find(s => s.sceneId === sceneId) : scenes.find(s => s.sceneNumber === sceneNumber);
    const keyframeId = targetScene?.selectedKeyframeId || targetScene?.keyframes?.[0]?.id;
    if (!keyframeId) {
      alert(`Lütfen önce Sahne #${sceneNumber} için bir keyframe seçin.`);
      return;
    }

    setScenes(prev => prev.map(s => {
      if ((sceneId && s.sceneId === sceneId) || s.sceneNumber === sceneNumber) return { ...s, status: 'video_queued' };
      return s;
    }));

    const sse = subscribeToProgress(currentDreamId, 'VIDEO');
    try {
      const res = await fetch(`${API_BASE}/dreams/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dreamId: currentDreamId,
          sceneId: targetScene?.sceneId,
          sceneNumber,
          keyframeId,
          dreamTitle: `Scene #${sceneNumber}`
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Video generation failed');

      refreshUserProfile();

      // Poll until video job finishes
      if (data.jobId) {
        await new Promise<void>((resolve, reject) => {
          const pollTimer = setInterval(async () => {
            try {
              const jobRes = await fetch(`${API_BASE}/dreams/jobs/${data.jobId}`);
              if (jobRes.ok) {
                const jobPayload = await jobRes.json();
                if (jobPayload.job.status === 'completed') {
                  clearInterval(pollTimer);
                  await refreshSession(currentDreamId);
                  resolve();
                } else if (jobPayload.job.status === 'failed') {
                  clearInterval(pollTimer);
                  reject(new Error(jobPayload.job.error || 'Video synthesis failed in queue'));
                }
              }
            } catch {}
          }, 2000);

          setTimeout(() => {
            clearInterval(pollTimer);
            reject(new Error('Job timed out'));
          }, 600000);
        });
      }
    } catch (err: any) {
      console.error(err);
      setScenes(prev => prev.map(s => {
        if (s.sceneNumber === sceneNumber) return { ...s, status: 'failed', error: err.message };
        return s;
      }));
    } finally {
      sse.close();
      setIsHudOpen(false);
      refreshUserProfile();
    }
  };

  // Storyboard Handler: Generate All Missing Scenes (Batch Queue)
  const handleGenerateAllMissingScenes = async () => {
    if (!currentDreamId) return;

    setScenes(prev => prev.map(s => {
      if (s.status !== 'completed') return { ...s, status: 'video_queued' };
      return s;
    }));

    const sse = subscribeToProgress(currentDreamId, 'VIDEO');
    try {
      const res = await fetch(`${API_BASE}/dreams/generate-scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dreamId: currentDreamId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Batch generation failed');

      refreshUserProfile();

      // Poll session periodically until all scenes are completed and stitched
      await new Promise<void>((resolve, reject) => {
        const sessionTimer = setInterval(async () => {
          try {
            const sRes = await fetch(`${API_BASE}/dreams/session/${currentDreamId}`);
            if (sRes.ok) {
              const sData = await sRes.json();
              const currentSession = sData.session;
              if (currentSession) {
                if (currentSession.scenes) setScenes(currentSession.scenes);
                if (currentSession.status) setSessionStatus(currentSession.status);
                if (currentSession.video) setSessionVideo(currentSession.video);

                if (currentSession.status === 'completed' || currentSession.status === 'stitch_failed') {
                  clearInterval(sessionTimer);
                  resolve();
                }
              }
            }
          } catch {}
        }, 2500);

        setTimeout(() => {
          clearInterval(sessionTimer);
          reject(new Error('Multi-scene generation timed out'));
        }, 900000);
      });
    } catch (err: any) {
      console.error(err);
      await refreshSession(currentDreamId);
      throw err;
    } finally {
      sse.close();
      setIsHudOpen(false);
      refreshUserProfile();
    }
  };

  // Storyboard Handler: Free Re-Stitch
  const handleReStitch = async () => {
    if (!currentDreamId) return;
    setSessionStatus('stitching_queued');

    try {
      const res = await fetch(`${API_BASE}/dreams/stitch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dreamId: currentDreamId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Re-stitching failed');

      // Poll stitch job
      if (data.jobId) {
        await new Promise<void>((resolve, reject) => {
          const pollTimer = setInterval(async () => {
            try {
              const jobRes = await fetch(`${API_BASE}/dreams/jobs/${data.jobId}`);
              if (jobRes.ok) {
                const jobPayload = await jobRes.json();
                if (jobPayload.job.status === 'completed') {
                  clearInterval(pollTimer);
                  await refreshSession(currentDreamId);
                  resolve();
                } else if (jobPayload.job.status === 'failed') {
                  clearInterval(pollTimer);
                  reject(new Error(jobPayload.job.error || 'Stitching failed'));
                }
              }
            } catch {}
          }, 2000);

          setTimeout(() => {
            clearInterval(pollTimer);
            reject(new Error('Stitching timed out'));
          }, 180000);
        });
      }
    } catch (err: any) {
      console.error(err);
      setSessionStatus('stitch_failed');
      setSessionError(err.message);
    }
  };

  // Transition to Player Step
  const handleWatchDream = (finalVideo: any) => {
    const dreamResult = {
      id: currentDreamId || 'dream_view',
      title: 'Cinematic Dream Vision',
      keyframeUrl: scenes[0]?.keyframes?.[0]?.imageUrl || '',
      video: finalVideo,
      prompt: scenes.map(s => s.summary).join(' • '),
      createdAt: new Date().toISOString(),
      isMock: providerInfo.isMock
    };
    setCompletedDream(dreamResult);
    setStep('PLAYER');
  };

  // Reset for a new dream
  const handleNewDream = () => {
    setStep('INPUT');
    setCurrentDreamId(null);
    setScenes([]);
    setSessionStatus('analyzed');
    setSessionVideo(null);
    setSessionError(undefined);
    setCompletedDream(null);
    setError(null);
    setIsHudOpen(false);
    refreshUserProfile();
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#060713] text-slate-100 font-sans">
      
      {/* Navigation Bar */}
      <Navbar credits={credits} providerInfo={providerInfo} />

      {/* Main Flow Content */}
      <main className="flex-1 flex flex-col justify-center py-6">
        {step === 'INPUT' && (
          <DreamInputStep 
            onAnalyze={handleAnalyze} 
            isLoading={isAnalyzing} 
            error={error} 
          />
        )}

        {step === 'STORYBOARD' && currentDreamId && (
          <StoryboardStep
            dreamId={currentDreamId}
            scenes={scenes}
            sessionStatus={sessionStatus}
            sessionVideo={sessionVideo}
            sessionError={sessionError}
            userCredits={credits}
            liveProgress={liveProgress}
            onSplitScene={handleSplitScene}
            onMergeScene={handleMergeScene}
            onPatchPrompt={handlePatchPrompt}
            onGenerateKeyframesForScene={handleGenerateKeyframesForScene}
            onGenerateAllKeyframes={handleGenerateAllKeyframes}
            onSelectKeyframe={handleSelectKeyframe}
            onGenerateSingleSceneVideo={handleGenerateSingleSceneVideo}
            onGenerateAllMissingScenes={handleGenerateAllMissingScenes}
            onReStitch={handleReStitch}
            onWatchDream={handleWatchDream}
            onBack={() => setStep('INPUT')}
          />
        )}

        {step === 'PLAYER' && completedDream && (
          <DreamPlayerStep 
            dream={completedDream} 
            onNewDream={handleNewDream} 
          />
        )}
      </main>

      {/* Live Real-Time GPU Progress HUD */}
      <ManifestingHUD
        isOpen={isHudOpen}
        mode={hudMode}
        progress={liveProgress}
        providerName={providerInfo.name}
      />

      {/* Global Ethereal Footer */}
      <footer className="w-full glass-panel border-t border-slate-800/80 py-6 px-4 text-center text-xs text-slate-400 mt-auto">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 font-mono">
          <p>© 2026 DreamViewer. Phase 5 Multi-Scene Storyboard & FFmpeg Crossfade Engine.</p>
          <div className="flex items-center gap-4 text-slate-400 text-[11px]">
            <span className="hover:text-purple-300 cursor-pointer">Privacy & Face Blur</span>
            <span className="hover:text-purple-300 cursor-pointer">PG-Rated Moderation Shield</span>
            <span className="hover:text-purple-300 cursor-pointer">Terms of Vision</span>
          </div>
        </div>
      </footer>

    </div>
  );
}

export default App;
