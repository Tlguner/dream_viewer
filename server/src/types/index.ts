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
  isSelected?: boolean;
}

export interface DreamVideoResult {
  id: string;
  videoUrl: string;
  durationSeconds: number;      // Actual API duration (e.g. 5s)
  effectiveSeconds: number;     // Played duration "on-twos" (e.g. 10s)
  fps: number;                  // 12fps
  faceBlurred: boolean;
  audioMood: string;
  shaderPreset: 'dream_haze' | 'retro_vhs' | 'lucid_glow' | 'spider_verse_halftone';
}

export interface IDreamProvider {
  name: string;
  analyzeDream(rawText: string, moodHint?: MoodStyle): Promise<DreamPromptAnalysis>;
  generateKeyframes(refinedPrompt: string, count?: number): Promise<KeyframeOption[]>;
  generateVideo(selectedKeyframeUrl: string, prompt: string, cameraMotion: string): Promise<DreamVideoResult>;
}
