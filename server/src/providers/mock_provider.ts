import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { 
  IDreamProvider, 
  DreamPromptAnalysis, 
  KeyframeOption, 
  DreamVideoResult, 
  MoodStyle 
} from '../types/index.js';
import { SafetyShield } from '../moderation/shield.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'fixtures');

export class MockDreamProvider implements IDreamProvider {
  public name = 'MockDreamProvider (Offline Simulation)';
  public isMock = true;
  private serverBaseUrl: string;
  private storageVideosDir: string;
  private storageKeyframesDir: string;
  private fixturesDir: string;

  constructor(
    serverBaseUrl = process.env.SERVER_BASE_URL || 'http://127.0.0.1:5000',
    storageVideosDir = path.resolve('storage', 'videos'),
    storageKeyframesDir = path.resolve('storage', 'keyframes'),
    fixturesDir = DEFAULT_FIXTURES_DIR
  ) {
    this.serverBaseUrl = serverBaseUrl.replace(/\/$/, '');
    this.storageVideosDir = storageVideosDir;
    this.storageKeyframesDir = storageKeyframesDir;
    this.fixturesDir = fixturesDir;

    fs.mkdirSync(this.storageVideosDir, { recursive: true });
    fs.mkdirSync(this.storageKeyframesDir, { recursive: true });
    this.ensureFixturesInStorage();
  }

  /**
   * Pre-seed storage with committed offline mock assets to ensure zero external network calls
   */
  private ensureFixturesInStorage() {
    try {
      if (!fs.existsSync(this.fixturesDir)) return;

      // Seed mock keyframes
      for (let i = 1; i <= 3; i++) {
        const kfFilename = `mock_kf_${i}.png`;
        const fixtureKf = path.join(this.fixturesDir, kfFilename);
        const targetKf = path.join(this.storageKeyframesDir, kfFilename);
        if (fs.existsSync(fixtureKf) && !fs.existsSync(targetKf)) {
          fs.copyFileSync(fixtureKf, targetKf);
        }
      }

      // Seed mock video
      const fixtureVid = path.join(this.fixturesDir, 'mock_video.mp4');
      const targetVid = path.join(this.storageVideosDir, 'mock_video.mp4');
      if (fs.existsSync(fixtureVid) && !fs.existsSync(targetVid)) {
        fs.copyFileSync(fixtureVid, targetVid);
      }
    } catch (err: any) {
      console.warn('Could not pre-seed fixtures in storage:', err.message);
    }
  }

  private sanitizeForPrompt(text: string): string {
    return text
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\\"{}[\]]/g, '')
      .replace(/\b(ignore previous|system prompt|jailbreak)\b/gi, '')
      .trim();
  }

  public async analyzeDream(rawText: string, moodHint?: MoodStyle): Promise<DreamPromptAnalysis> {
    await new Promise(r => setTimeout(r, 100));

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

  /**
   * Return self-hosted mock keyframes without touching external APIs or CDN
   */
  public async generateKeyframes(_refinedPrompt: string, count: number = 3): Promise<KeyframeOption[]> {
    await new Promise(r => setTimeout(r, 100));

    this.ensureFixturesInStorage();

    const keyframes: KeyframeOption[] = [];
    const total = Math.min(count, 3);

    for (let i = 1; i <= total; i++) {
      const filename = `mock_kf_${i}.png`;
      keyframes.push({
        id: `mock_kf_${Date.now()}_${i}`,
        imageUrl: `${this.serverBaseUrl}/api/media/keyframes/${filename}`,
        aspectRatio: '16:9',
        seed: Math.floor(Math.random() * 9999999),
        isMock: true,
        isSelected: i === 1
      });
    }

    return keyframes;
  }

  /**
   * Return self-hosted mock video from local storage
   */
  public async generateVideo(
    _selectedKeyframe: KeyframeOption, 
    _prompt: string, 
    _cameraMotion: string
  ): Promise<DreamVideoResult> {
    await new Promise(r => setTimeout(r, 300));

    this.ensureFixturesInStorage();

    const videoId = `mock_vid_${Date.now()}`;
    const filename = `${videoId}.mp4`;
    const localPath = path.join(this.storageVideosDir, filename);

    // Copy the local fixture to the target file
    const fixtureVid = path.join(this.fixturesDir, 'mock_video.mp4');
    if (fs.existsSync(fixtureVid) && !fs.existsSync(localPath)) {
      fs.copyFileSync(fixtureVid, localPath);
    }

    const videoUrl = `${this.serverBaseUrl}/api/media/videos/${filename}`;

    return {
      id: videoId,
      videoUrl,
      durationSeconds: 2,        // 2s native at 24fps
      effectiveSeconds: 4,       // 4s played on-twos (0.5x speed / 12fps)
      fps: 24,                   // native export 24fps
      playbackRate: 0.5,         // client plays at 0.5x for flipbook on-twos
      faceBlurred: false,        // Face blur did not run in mock mode
      audioMood: 'ethereal_lucid_pad',
      shaderPreset: 'dream_haze',
      isMock: true
    };
  }
}
