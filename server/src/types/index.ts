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
  refinedPrompt: string;
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
  negativePrompt: string;
  cameraMotion: string;
  mood: MoodStyle;
  keyframes: KeyframeOption[];
  video?: DreamVideoResult;
  status: 'draft' | 'analyzed' | 'keyframes_ready' | 'generating' | 'completed' | 'failed';
  createdAt: string;
  expiresAt: number;
}

export interface IDreamProvider {
  name: string;
  isMock: boolean;
  analyzeDream(rawText: string, moodHint?: MoodStyle): Promise<DreamPromptAnalysis>;
  generateKeyframes(refinedPrompt: string, count?: number): Promise<KeyframeOption[]>;
  generateVideo(selectedKeyframe: KeyframeOption, prompt: string, cameraMotion: string): Promise<DreamVideoResult>;
}
