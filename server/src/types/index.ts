export type MoodStyle = 
  | 'ETHEREAL_LUCID'
  | 'NOSTALGIC_FOG'
  | 'SURREAL_CYBERPUNK'
  | 'DEEP_OCEAN'
  | 'FLOATING_SKY'
  | 'GOLDEN_DREAM';

export interface ModerationResult {
  passed: boolean;
  flaggedCategories: string[];
  reason?: string;
  sanitizedPrompt?: string;
}

export interface DreamScenePlan {
  sceneNumber: number;
  summary: string;
  mood: MoodStyle;
  keyframePrompt: string;
  motionPrompt: string;
  cameraMotion: string;
}

export interface DreamArchitectResponse {
  safety: {
    allowed: boolean;
    category: string | null;
  };
  scenes: DreamScenePlan[];
}

export interface DreamPromptAnalysis {
  refinedPrompt: string;       // Legacy / unified prompt (mapped to scenes[0].keyframePrompt)
  keyframePrompt: string;      // Primary scene composition prompt (scenes[0].keyframePrompt)
  motionPrompt: string;        // Primary scene motion prompt (scenes[0].motionPrompt)
  negativePrompt: string;
  cameraMotion: string;
  detectedMood: MoodStyle;
  scenes: DreamScenePlan[];    // Multi-scene storyboard decomposition (1-3 scenes)
  totalEstimatedSeconds: number; // Server-calculated duration
  visualElements: {
    setting: string;
    surrealTwist: string;
    lighting: string;
  };
}

export interface KeyframeOption {
  id: string;
  imageUrl: string;
  aspectRatio: string;
  seed: number;
  isMock: boolean;
  isSelected?: boolean;
}

export interface DreamVideoResult {
  id: string;
  videoUrl: string;
  durationSeconds: number;      // e.g. 5s
  effectiveSeconds: number;     // e.g. 10s if played on-twos
  fps: number;                  // e.g. 24 or 12
  playbackRate: number;         // e.g. 0.5 for on-twos or 1.0 for native
  faceBlurred: boolean;
  audioMood: string;
  shaderPreset: 'dream_haze' | 'retro_vhs' | 'lucid_glow' | 'spider_verse_halftone';
  isMock: boolean;
}

export interface DreamSession {
  dreamId: string;
  userId: string;
  rawText: string;
  refinedPrompt: string;
  keyframePrompt: string;
  motionPrompt: string;
  negativePrompt: string;
  cameraMotion: string;
  mood: MoodStyle;
  scenes: DreamScenePlan[];
  totalEstimatedSeconds: number;
  keyframes: KeyframeOption[];
  video?: DreamVideoResult;
  status: 'draft' | 'analyzed' | 'keyframes_ready' | 'queued' | 'generating' | 'completed' | 'failed';
  activeJobId?: string;
  createdAt: string;
  expiresAt: number;
}

export interface DreamProgressEvent {
  stage: 'QUEUED' | 'INITIALIZING' | 'DIFFUSION' | 'DECODING' | 'SAVING' | 'COMPLETED' | 'ERROR';
  stageLabel: string;
  detail: string;
  percent: number;           // 0 to 100
  step?: number;
  totalSteps?: number;
  elapsedSeconds: number;
  etaSeconds?: number;
  nodeType?: string;
  jobId?: string;
  queuePosition?: number;
  currentScene?: number;
  totalScenes?: number;
  result?: DreamVideoResult;
}

export type ProgressCallback = (progress: DreamProgressEvent) => void;

export type QueueDriverType = 'bullmq' | 'memory';

export type GpuJobType = 'KEYFRAMES' | 'VIDEO';

export interface KeyframeJobData {
  jobType: 'KEYFRAMES';
  jobId: string;
  dreamId: string;
  prompt: string;
  count: number;
  enqueuedAt: number;
}

export interface VideoJobData {
  jobType: 'VIDEO';
  jobId: string;
  dreamId: string;
  userId: string;
  keyframeId: string;
  dreamTitle?: string;
  reservedCredits: number;
  enqueuedAt: number;
}

export type GpuJobData = KeyframeJobData | VideoJobData;

export interface GpuJobStatusResponse {
  jobId: string;
  dreamId: string;
  jobType: GpuJobType;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  queuePosition: number;
  progress: number;
  currentScene: number;
  totalScenes: number;
  stageLabel: string;
  videoUrl?: string;
  keyframes?: KeyframeOption[];
  result?: DreamVideoResult | KeyframeOption[];
  error?: string;
}

export type VideoJobStatusResponse = GpuJobStatusResponse;

export interface IDreamProvider {
  name: string;
  isMock: boolean;
  analyzeDream(rawText: string, moodHint?: MoodStyle): Promise<DreamPromptAnalysis>;
  generateKeyframes(keyframePrompt: string, count?: number, onProgress?: ProgressCallback): Promise<KeyframeOption[]>;
  generateVideo(selectedKeyframe: KeyframeOption, motionPrompt: string, cameraMotion: string, onProgress?: ProgressCallback): Promise<DreamVideoResult>;
}
