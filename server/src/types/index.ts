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

export interface DreamPromptAnalysis {
  refinedPrompt: string;       // Legacy / unified prompt
  keyframePrompt: string;      // Dedicated scene composition & sharp visual subject prompt
  motionPrompt: string;        // Dedicated temporal animation & camera motion prompt
  negativePrompt: string;
  cameraMotion: string;
  detectedMood: MoodStyle;
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
  keyframes: KeyframeOption[];
  video?: DreamVideoResult;
  status: 'draft' | 'analyzed' | 'keyframes_ready' | 'generating' | 'completed' | 'failed';
  createdAt: string;
  expiresAt: number;
}

export interface DreamProgressEvent {
  stage: 'INITIALIZING' | 'DIFFUSION' | 'DECODING' | 'SAVING' | 'COMPLETED' | 'ERROR';
  stageLabel: string;
  detail: string;
  percent: number;           // 0 to 100
  step?: number;
  totalSteps?: number;
  elapsedSeconds: number;
  etaSeconds?: number;
  nodeType?: string;
}

export type ProgressCallback = (progress: DreamProgressEvent) => void;

export interface IDreamProvider {
  name: string;
  isMock: boolean;
  analyzeDream(rawText: string, moodHint?: MoodStyle): Promise<DreamPromptAnalysis>;
  generateKeyframes(keyframePrompt: string, count?: number, onProgress?: ProgressCallback): Promise<KeyframeOption[]>;
  generateVideo(selectedKeyframe: KeyframeOption, motionPrompt: string, cameraMotion: string, onProgress?: ProgressCallback): Promise<DreamVideoResult>;
}
