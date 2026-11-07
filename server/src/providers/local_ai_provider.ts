import { 
  IDreamProvider, 
  DreamPromptAnalysis, 
  KeyframeOption, 
  DreamVideoResult, 
  MoodStyle 
} from '../types/index.js';
import { SafetyShield } from '../moderation/shield.js';

export class LocalAiDreamProvider implements IDreamProvider {
  public name = 'LocalAiDreamProvider (Open-Source GPU)';
  private aiServiceUrl: string;

  constructor(aiServiceUrl = 'http://localhost:8000') {
    this.aiServiceUrl = aiServiceUrl;
  }

  public async analyzeDream(rawText: string, moodHint?: MoodStyle): Promise<DreamPromptAnalysis> {
    const detectedMood = moodHint || 'ETHEREAL_LUCID';

    // Cinematic prompt optimization tailored for open-source diffusion video models
    const refinedPrompt = `Surreal ethereal dreamscape: ${rawText}. Volumetric fog, chromatic lighting, anamorphic lens flare, deep cosmic haze, solitary silhouette seen strictly from behind in shadows, no human face, magical realism, 35mm film grain, 8k cinematic masterpiece.`;
    
    const cameraMotion = 'Slow forward dolly tracking push with hypnotic subtle rotational tilt and floating weightlessness';

    return {
      refinedPrompt,
      negativePrompt: SafetyShield.getNegativePrompt(),
      cameraMotion,
      detectedMood,
      visualElements: {
        setting: 'Floating architectural horizon enveloped in luminous twilight mist',
        surrealTwist: 'Gravity-defying elements rippling with iridescent light particles',
        lighting: 'Volumetric bioluminescent beams and deep atmospheric shadows'
      }
    };
  }

  public async generateKeyframes(refinedPrompt: string, count: number = 3): Promise<KeyframeOption[]> {
    // Generate 3 preview anchors
    const sampleImages = [
      'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1200&q=80'
    ];

    return sampleImages.slice(0, count).map((url, index) => ({
      id: `local_kf_${Date.now()}_${index + 1}`,
      imageUrl: url,
      aspectRatio: '16:9',
      seed: Math.floor(Math.random() * 9999999),
      isSelected: index === 0
    }));
  }

  public async generateVideo(
    _selectedKeyframeUrl: string, 
    prompt: string, 
    _cameraMotion: string
  ): Promise<DreamVideoResult> {
    console.log(`📡 [LocalAiDreamProvider] Calling local Python video engine at ${this.aiServiceUrl}...`);
    
    try {
      const response = await fetch(`${this.aiServiceUrl}/api/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          negative_prompt: SafetyShield.getNegativePrompt(),
          num_frames: 25,
          fps: 12,
          width: 704,
          height: 480
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        let detail = errorText;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.detail) detail = parsed.detail;
        } catch (e) {}
        throw new Error(detail);
      }

      const data = (await response.json()) as any;
      console.log(`✅ [LocalAiDreamProvider] Video received from local GPU:`, data.video_url);

      return {
        id: `local_vid_${Date.now()}`,
        videoUrl: data.video_url,
        durationSeconds: data.duration_seconds || 5,
        effectiveSeconds: (data.duration_seconds || 5) * 2, // Played "on-twos" (10s)
        fps: data.fps || 12,
        faceBlurred: Boolean(data.face_blurred),
        audioMood: 'ethereal_lucid_pad',
        shaderPreset: 'dream_haze'
      };
    } catch (err: any) {
      console.error(`⚠️ Local AI service error:`, err.message);
      throw new Error(err.message);
    }
  }
}
