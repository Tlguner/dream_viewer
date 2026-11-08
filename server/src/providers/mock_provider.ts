import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { 
  IDreamProvider, 
  DreamPromptAnalysis, 
  KeyframeOption, 
  DreamVideoResult, 
  MoodStyle,
  DreamProgressEvent,
  ProgressCallback
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
    const detectedMood: MoodStyle = moodHint || 'ETHEREAL_LUCID';

    let keyframePrompt = '';
    let motionPrompt = '';
    let cameraMotion = '';
    let visualElements = {
      setting: '',
      surrealTwist: '',
      lighting: ''
    };

    switch (detectedMood) {
      case 'SURREAL_CYBERPUNK':
        keyframePrompt = `Wide aerial establishing shot of a futuristic cyberpunk megacity at night: ${cleanInput}. Dozens of towering dark skyscrapers stretching to the horizon, giant neon billboards on facades in vibrant cyan and magenta, small flying cars with glowing headlights between towers, clean wet reflective surfaces, sharp architectural geometry, photorealistic sharp detail.`;
        motionPrompt = 'Slow steady forward drone flight over the futuristic city. Flying vehicles glide slowly through the frame between skyscrapers, neon signs softly flicker, light rain drifts smoothly. Continuous 24fps motion.';
        cameraMotion = 'Slow forward aerial drone glide between skyscrapers';
        visualElements = {
          setting: 'Dense vertical megacity with towering brutalist skyscrapers and skybridges',
          surrealTwist: 'Holographic neon advertisements and airborne transit lanes',
          lighting: 'High-contrast cyan and magenta neon illumination with clean wet reflections'
        };
        break;

      case 'NOSTALGIC_FOG':
        keyframePrompt = `Vintage 35mm film still: ${cleanInput}. Muted color palette, nostalgic atmospheric dreamscape, soft rim light, clean focal composition, fine film grain, evocative cinema aesthetic.`;
        motionPrompt = 'Slow contemplative camera push forward. Soft atmospheric dust motes gently drifting, subtle ambient light shifting, smooth calm motion.';
        cameraMotion = 'Slow contemplative dolly tracking push';
        visualElements = {
          setting: 'Misty nostalgic landscape with vintage timeless architecture',
          surrealTwist: 'Dreamlike memories suspended in soft atmospheric light',
          lighting: 'Muted warm dawn glow with soft cinematic shadows'
        };
        break;

      case 'DEEP_OCEAN':
        keyframePrompt = `Deep oceanic abyss: ${cleanInput}. Underwater bioluminescent glow in azure and deep indigo, floating aquatic structures, shimmering caustic light patterns dancing across surfaces, cinematic wide angle, sharp detail.`;
        motionPrompt = 'Submerged underwater slow forward drift. Floating bioluminescent plankton swirling gently, flowing fluid currents, smooth underwater camera motion.';
        cameraMotion = 'Submerged fluid forward drift with gentle vertical sway';
        visualElements = {
          setting: 'Submerged oceanic abyss with colossal bioluminescent architecture',
          surrealTwist: 'Weightless aquatic dreamscape with floating luminescent elements',
          lighting: 'Deep indigo water with vibrant bioluminescent cyan caustics'
        };
        break;

      case 'FLOATING_SKY':
        keyframePrompt = `High altitude panoramic view: ${cleanInput}. Floating architectural monoliths above expansive golden clouds, brilliant daylight, vast infinite horizon, crisp architectural edges, cinematic scale.`;
        motionPrompt = 'Smooth aerial gliding flight above the cloud deck. Slow floating motion of architectural structures, drifting clouds, majestic wide camera glide.';
        cameraMotion = 'High altitude aerial forward glide with wide panoramic view';
        visualElements = {
          setting: 'Vast cloudscape horizon with colossal floating structures',
          surrealTwist: 'Gravity-defying architecture floating effortlessly above the clouds',
          lighting: 'Brilliant golden daylight casting sharp sunbeams across clouds'
        };
        break;

      case 'GOLDEN_DREAM':
        keyframePrompt = `Golden hour cinematic masterpiece: ${cleanInput}. Warm amber and gilded sunlight, rich rim lighting, long dramatic shadows, atmospheric warmth, crisp focal elements, photorealistic quality.`;
        motionPrompt = 'Slow golden hour camera push. Shifting golden light rays, soft floating dust particles in sunbeams, smooth majestic motion.';
        cameraMotion = 'Majestic slow forward dolly push into the golden light';
        visualElements = {
          setting: 'Luminous dream realm bathed in eternal sunset',
          surrealTwist: 'Gilded surreal structures radiating warm amber light',
          lighting: 'Rich golden hour rim lighting with deep amber warmth'
        };
        break;

      case 'ETHEREAL_LUCID':
      default:
        keyframePrompt = `Lucid dream vision: ${cleanInput}. Ethereal twilight illumination, clean surreal architectural composition, iridescent accents, crisp subject focus, magical realism, cinematic wide shot.`;
        motionPrompt = 'Smooth weightless forward drift. Gentle shimmering light particles, subtle environmental motion, hypnotic calm cinematic movement.';
        cameraMotion = 'Slow forward tracking push with gentle weightless float';
        visualElements = {
          setting: 'Luminous surreal horizon with dream architecture',
          surrealTwist: 'Weightless gravity-defying forms and iridescent light',
          lighting: 'Soft twilight radiance with clean atmospheric clarity'
        };
        break;
    }

    return {
      refinedPrompt: keyframePrompt,
      keyframePrompt,
      motionPrompt,
      negativePrompt: SafetyShield.getNegativePrompt(),
      cameraMotion,
      detectedMood,
      visualElements
    };
  }

  /**
   * Return self-hosted mock keyframes without touching external APIs or CDN
   */
  public async generateKeyframes(
    _keyframePrompt: string, 
    count: number = 3,
    onProgress?: ProgressCallback
  ): Promise<KeyframeOption[]> {
    onProgress?.({
      stage: 'INITIALIZING',
      stageLabel: 'Composition Engine',
      detail: `Synthesizing ${count} artistic anchors...`,
      percent: 25,
      elapsedSeconds: 0
    });

    await new Promise(r => setTimeout(r, 60));

    onProgress?.({
      stage: 'DIFFUSION',
      stageLabel: 'Rendering Keyframes',
      detail: 'Processing compositions...',
      percent: 75,
      elapsedSeconds: 0
    });

    await new Promise(r => setTimeout(r, 60));

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

    onProgress?.({
      stage: 'COMPLETED',
      stageLabel: 'Keyframes Ready',
      detail: `${keyframes.length} anchors loaded`,
      percent: 100,
      elapsedSeconds: 0
    });

    return keyframes;
  }

  /**
   * Return self-hosted mock video from local storage
   */
  public async generateVideo(
    _selectedKeyframe: KeyframeOption, 
    _motionPrompt: string, 
    _cameraMotion: string,
    onProgress?: ProgressCallback
  ): Promise<DreamVideoResult> {
    onProgress?.({
      stage: 'INITIALIZING',
      stageLabel: 'Initializing Video Pipeline',
      detail: 'Ingesting keyframe image...',
      percent: 15,
      elapsedSeconds: 0,
      etaSeconds: 2
    });

    await new Promise(r => setTimeout(r, 80));

    onProgress?.({
      stage: 'DIFFUSION',
      stageLabel: 'Neural Video Diffusion',
      detail: 'Sampling motion vectors (Step 8/15)...',
      percent: 55,
      step: 8,
      totalSteps: 15,
      elapsedSeconds: 0,
      etaSeconds: 1
    });

    await new Promise(r => setTimeout(r, 80));

    onProgress?.({
      stage: 'DECODING',
      stageLabel: 'VAE Decoding',
      detail: 'Synthesizing output frames...',
      percent: 88,
      elapsedSeconds: 0,
      etaSeconds: 0
    });

    await new Promise(r => setTimeout(r, 80));

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

    onProgress?.({
      stage: 'COMPLETED',
      stageLabel: 'Dream Manifested!',
      detail: 'Mock video ready for playback',
      percent: 100,
      elapsedSeconds: 0,
      etaSeconds: 0
    });

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
