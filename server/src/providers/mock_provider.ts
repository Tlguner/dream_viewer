import path from 'path';
import fs from 'fs';
import { 
  IDreamProvider, 
  DreamPromptAnalysis, 
  KeyframeOption, 
  DreamVideoResult, 
  MoodStyle 
} from '../types/index.js';
import { SafetyShield } from '../moderation/shield.js';

export class MockDreamProvider implements IDreamProvider {
  public name = 'MockDreamProvider (Simulation)';
  public isMock = true;
  private serverBaseUrl: string;
  private storageVideosDir: string;

  private mockKeyframes: Record<MoodStyle, string[]> = {
    ETHEREAL_LUCID: [
      'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1464802686167-b939a6910659?auto=format&fit=crop&w=1200&q=80'
    ],
    NOSTALGIC_FOG: [
      'https://images.unsplash.com/photo-1511497584788-87676104235f?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1476820865390-c52aeebb9891?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1200&q=80'
    ],
    SURREAL_CYBERPUNK: [
      'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80'
    ],
    DEEP_OCEAN: [
      'https://images.unsplash.com/photo-1682687220063-4742bd7fd538?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1544551763-46a013bb70d5?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=1200&q=80'
    ],
    FLOATING_SKY: [
      'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1499346030926-9a72daac6c63?auto=format&fit=crop&w=1200&q=80'
    ],
    GOLDEN_DREAM: [
      'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1470240731273-7821a6eeb6bd?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1200&q=80'
    ]
  };

  private mockVideos: string[] = [
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'
  ];

  constructor(
    serverBaseUrl = process.env.SERVER_BASE_URL || 'http://127.0.0.1:5000',
    storageVideosDir = path.resolve('storage', 'videos')
  ) {
    this.serverBaseUrl = serverBaseUrl.replace(/\/$/, '');
    this.storageVideosDir = storageVideosDir;
    fs.mkdirSync(this.storageVideosDir, { recursive: true });
  }

  private sanitizeForPrompt(text: string): string {
    return text
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\\"{}[\]]/g, '')
      .replace(/\b(ignore previous|system prompt|jailbreak)\b/gi, '')
      .trim();
  }

  public async analyzeDream(rawText: string, moodHint?: MoodStyle): Promise<DreamPromptAnalysis> {
    await new Promise(r => setTimeout(r, 600));

    const cleanInput = this.sanitizeForPrompt(rawText);
    const detectedMood = moodHint || 'ETHEREAL_LUCID';

    const refinedPrompt = `Surreal ethereal dreamscape: ${cleanInput}. Volumetric fog, chromatic light scattering, anamorphic lens flare, deep cosmic haze, solitary silhouette seen strictly from behind in shadows, no visible human face, magical realism, 35mm film grain, 8k cinematic masterpiece.`;
    
    const cameraMotion = 'Slow forward dolly tracking push with hypnotic subtle rotational tilt and floating weightlessness';

    return {
      refinedPrompt,
      negativePrompt: SafetyShield.getNegativePrompt(),
      cameraMotion,
      detectedMood,
      visualElements: {
        setting: 'Floating architectural horizon enveloped in luminous twilight mist',
        surrealTwist: 'Gravity-defying elements rippling with iridescent light particles',
        lighting: 'Volumetric bioluminescent beams and deep indigo atmospheric shadows'
      }
    };
  }

  public async generateKeyframes(refinedPrompt: string, count: number = 3): Promise<KeyframeOption[]> {
    await new Promise(r => setTimeout(r, 800));

    let mood: MoodStyle = 'ETHEREAL_LUCID';
    const lower = refinedPrompt.toLowerCase();
    if (lower.includes('cyber') || lower.includes('neon') || lower.includes('city')) mood = 'SURREAL_CYBERPUNK';
    else if (lower.includes('water') || lower.includes('ocean') || lower.includes('fish') || lower.includes('sea')) mood = 'DEEP_OCEAN';
    else if (lower.includes('sky') || lower.includes('fly') || lower.includes('cloud')) mood = 'FLOATING_SKY';
    else if (lower.includes('fog') || lower.includes('forest') || lower.includes('nostalg')) mood = 'NOSTALGIC_FOG';
    else if (lower.includes('gold') || lower.includes('sun') || lower.includes('warm')) mood = 'GOLDEN_DREAM';

    const images = this.mockKeyframes[mood] || this.mockKeyframes.ETHEREAL_LUCID;

    return images.slice(0, count).map((url, index) => ({
      id: `mock_kf_${Date.now()}_${index + 1}`,
      imageUrl: url,
      aspectRatio: '16:9',
      seed: Math.floor(Math.random() * 9999999),
      isMock: true,
      isSelected: index === 0
    }));
  }

  public async generateVideo(
    _selectedKeyframe: KeyframeOption, 
    _prompt: string, 
    _cameraMotion: string
  ): Promise<DreamVideoResult> {
    await new Promise(r => setTimeout(r, 1200));

    const videoId = `mock_vid_${Date.now()}`;
    const filename = `${videoId}.mp4`;
    const localPath = path.join(this.storageVideosDir, filename);

    // Provide a self-hosted URL; create a minimal placeholder file if not exists
    let videoUrl = `${this.serverBaseUrl}/api/media/videos/${filename}`;
    try {
      if (!fs.existsSync(localPath)) {
        // Attempt to fetch sample and cache locally
        const sampleRes = await fetch(this.mockVideos[0]);
        if (sampleRes.ok) {
          const buf = Buffer.from(await sampleRes.arrayBuffer());
          await fs.promises.writeFile(localPath, buf);
        } else {
          videoUrl = this.mockVideos[0];
        }
      }
    } catch {
      videoUrl = this.mockVideos[0];
    }

    return {
      id: videoId,
      videoUrl,
      durationSeconds: 5,        // 5 seconds native at 24fps
      effectiveSeconds: 10,      // 10 seconds played on-twos (0.5x speed / 12fps)
      fps: 24,                   // native export 24fps
      playbackRate: 0.5,         // client plays at 0.5x for flipbook on-twos
      faceBlurred: false,        // Face blur did not run in mock mode
      audioMood: 'ethereal_lucid_pad',
      shaderPreset: 'dream_haze',
      isMock: true
    };
  }
}
