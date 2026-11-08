import { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { DreamInputStep } from './components/DreamInputStep';
import { KeyframeReviewStep } from './components/KeyframeReviewStep';
import { DreamPlayerStep } from './components/DreamPlayerStep';
import { ManifestingHUD, type LiveProgress } from './components/ManifestingHUD';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5000/api';

type Step = 'INPUT' | 'KEYFRAMES' | 'PLAYER';

export function App() {
  const [step, setStep] = useState<Step>('INPUT');
  const [credits, setCredits] = useState<number>(10);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live real-time progress HUD state
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);
  const [hudMode, setHudMode] = useState<'KEYFRAMES' | 'VIDEO'>('VIDEO');
  const [isHudOpen, setIsHudOpen] = useState<boolean>(false);

  // Initial provider info starts in honest mock/detecting state so it never falsely flashes GPU
  const [providerInfo, setProviderInfo] = useState<{ name: string; isMock: boolean }>({
    name: 'Detecting Provider...',
    isMock: true
  });

  // Stateful dream pipeline
  const [currentDreamId, setCurrentDreamId] = useState<string | null>(null);
  const [analysisData, setAnalysisData] = useState<any>(null);
  const [keyframes, setKeyframes] = useState<any[]>([]);
  const [, setSelectedKeyframe] = useState<any>(null);
  const [completedDream, setCompletedDream] = useState<any>(null);

  // Fetch initial profile & provider health
  useEffect(() => {
    fetch(`${API_BASE}/user/profile`)
      .then(res => res.json())
      .then(data => {
        if (data.credits !== undefined) setCredits(data.credits);
      })
      .catch(() => {
        setCredits(10);
      });

    fetch(`${API_BASE}/health`)
      .then(res => res.json())
      .then(data => {
        if (data.provider) {
          setProviderInfo({
            name: data.provider,
            isMock: Boolean(data.isMock)
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
      } catch {
        // ignore non-json
      }
    };

    eventSource.onerror = () => {
      // Keep EventSource alive or fallback gracefully
    };

    return eventSource;
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
      setAnalysisData(data.data);

      // Step 2: Trigger Keyframe generation with live SSE progress stream
      const sse = subscribeToProgress(dreamId, 'KEYFRAMES');
      try {
        const kfRes = await fetch(`${API_BASE}/dreams/keyframes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dreamId, count: 3 })
        });

        const kfData = await kfRes.json();
        if (!kfRes.ok) throw new Error(kfData.message || 'Failed to generate keyframes');

        setKeyframes(kfData.keyframes);
        setSelectedKeyframe(kfData.keyframes[0]);
        setStep('KEYFRAMES');
      } finally {
        sse.close();
        setIsHudOpen(false);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unexpected issue occurred while analyzing your dream.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Regenerate keyframes using server-side session with live progress
  const handleRegenerateKeyframes = async () => {
    if (!currentDreamId) return;
    setIsRegenerating(true);

    const sse = subscribeToProgress(currentDreamId, 'KEYFRAMES');
    try {
      const kfRes = await fetch(`${API_BASE}/dreams/keyframes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dreamId: currentDreamId, count: 3 })
      });

      const kfData = await kfRes.json();
      if (kfData.keyframes) {
        setKeyframes(kfData.keyframes);
        setSelectedKeyframe(kfData.keyframes[0]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      sse.close();
      setIsHudOpen(false);
      setIsRegenerating(false);
    }
  };

  // Step 3: Animate Approved Keyframe into Video via server-locked IDs with live SSE progress
  const handleAnimate = async (keyframe: any) => {
    if (!currentDreamId) return;
    setIsLoadingVideo(true);

    const sse = subscribeToProgress(currentDreamId, 'VIDEO');
    try {
      const res = await fetch(`${API_BASE}/dreams/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dreamId: currentDreamId,
          keyframeId: keyframe.id,
          dreamTitle: 'Lucid Vision'
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Video generation failed');

      if (data.remainingCredits !== undefined) {
        setCredits(data.remainingCredits);
      }

      const dreamResult = {
        ...data.dream,
        isMock: providerInfo.isMock
      };
      setCompletedDream(dreamResult);
      setStep('PLAYER');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to generate dream video.');
    } finally {
      sse.close();
      setIsHudOpen(false);
      setIsLoadingVideo(false);
    }
  };

  // Reset for a new dream
  const handleNewDream = () => {
    setStep('INPUT');
    setCurrentDreamId(null);
    setAnalysisData(null);
    setKeyframes([]);
    setSelectedKeyframe(null);
    setCompletedDream(null);
    setError(null);
    setIsHudOpen(false);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#060713] text-slate-100">
      
      {/* Navigation Bar with honest provider indicator */}
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

        {step === 'KEYFRAMES' && analysisData && (
          <KeyframeReviewStep
            analysis={analysisData}
            keyframes={keyframes}
            onSelectKeyframe={setSelectedKeyframe}
            onAnimate={handleAnimate}
            onBack={() => setStep('INPUT')}
            onRegenerate={handleRegenerateKeyframes}
            isLoadingVideo={isLoadingVideo}
            isRegenerating={isRegenerating}
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
      <footer className="w-full glass-panel border-t border-dream-border py-6 px-4 text-center text-xs text-slate-400">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <p>© 2026 DreamViewer. Built with 4-Layer Safety Shield & On-Twos Temporal Engine.</p>
          <div className="flex items-center gap-4 text-slate-400">
            <span className="hover:text-purple-300 cursor-pointer">Privacy & Face Blur</span>
            <span className="hover:text-purple-300 cursor-pointer">PG-Rated Safety</span>
            <span className="hover:text-purple-300 cursor-pointer">Terms of Vision</span>
          </div>
        </div>
      </footer>

    </div>
  );
}

export default App;
