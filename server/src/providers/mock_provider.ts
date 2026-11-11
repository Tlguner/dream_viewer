import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
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
import { IDreamArchitect, MockDreamArchitect } from '../architect/index.js';

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
  private architect: IDreamArchitect;

  constructor(
    serverBaseUrl = process.env.SERVER_BASE_URL || 'http://127.0.0.1:5000',
    storageVideosDir = path.resolve('storage', 'videos'),
    storageKeyframesDir = path.resolve('storage', 'keyframes'),
    fixturesDir = DEFAULT_FIXTURES_DIR,
    architect?: IDreamArchitect
  ) {
    this.serverBaseUrl = serverBaseUrl.replace(/\/$/, '');
    this.storageVideosDir = storageVideosDir;
    this.storageKeyframesDir = storageKeyframesDir;
    this.fixturesDir = fixturesDir;
    this.architect = architect || new MockDreamArchitect();

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
    const cleanInput = this.sanitizeForPrompt(rawText);

    // 1. Layer 1: Regex Hard-Block (Pre-LLM)
    const preAudit = SafetyShield.auditPrompt(cleanInput);
    if (!preAudit.passed) {
      const err: any = new Error(preAudit.reason || 'Prompt rejected by safety filter.');
      err.code = 'MODERATION_REJECTED';
      err.categories = preAudit.flaggedCategories;
      throw err;
    }

    // 2. Layer 2: LLM Architect analysis
    const architectResult = await this.architect.analyzeDream(cleanInput, moodHint);

    // 3. Layer 3: Safety decision
    if (!architectResult.safety?.allowed) {
      const err: any = new Error(`Dream prompt rejected: ${architectResult.safety?.category || 'Content policy violation'}`);
      err.code = 'MODERATION_REJECTED';
      err.categories = [architectResult.safety?.category || 'LLM_SAFETY_VIOLATION'];
      throw err;
    }

    if (!architectResult.scenes || architectResult.scenes.length === 0) {
      throw new Error('Dream Architect returned 0 scenes.');
    }

    // 4. Layer 4: Post-LLM prompt audit
    for (const scene of architectResult.scenes) {
      const kfAudit = SafetyShield.auditPrompt(scene.keyframePrompt);
      if (!kfAudit.passed) {
        const err: any = new Error(`Generated scene ${scene.sceneNumber} keyframe prompt violated safety policy: ${kfAudit.reason}`);
        err.code = 'MODERATION_REJECTED';
        err.categories = kfAudit.flaggedCategories;
        throw err;
      }
    }

    // Server-side duration calculation (approx 10s per scene on-twos)
    const effectiveSecondsPerScene = 10;
    const totalEstimatedSeconds = architectResult.scenes.length * effectiveSecondsPerScene;

    const primaryScene = architectResult.scenes[0];

    return {
      refinedPrompt: primaryScene.keyframePrompt,
      keyframePrompt: primaryScene.keyframePrompt,
      motionPrompt: primaryScene.motionPrompt,
      negativePrompt: SafetyShield.getNegativePrompt(),
      cameraMotion: primaryScene.cameraMotion,
      detectedMood: primaryScene.mood,
      scenes: architectResult.scenes,
      totalEstimatedSeconds,
      visualElements: {
        setting: primaryScene.summary,
        surrealTwist: `${architectResult.scenes.length} scene(s) structured by Dream Architect`,
        lighting: `${primaryScene.mood} dreamscape illumination`
      }
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
    // Failure simulation trigger for multi-scene partial failure & credit refund testing
    if (
      _motionPrompt?.toLowerCase().includes('fail_scene') || 
      _motionPrompt?.toLowerCase().includes('error_trigger') ||
      _selectedKeyframe?.id?.toLowerCase().includes('fail_scene')
    ) {
      throw new Error('Simulated GPU synthesis failure on scene');
    }

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

    const videoId = `mock_vid_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
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
