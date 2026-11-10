import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { SafetyShield } from './moderation/shield.js';
import { MockDreamProvider } from './providers/mock_provider.js';
import { ComfyDreamProvider } from './providers/comfy_provider.js';
import { IDreamArchitect, OpenAICompatibleArchitect, MockDreamArchitect } from './architect/index.js';
import { 
  MoodStyle, 
  IDreamProvider, 
  DreamSession, 
  DreamProgressEvent, 
  GpuJobData, 
  KeyframeJobData, 
  VideoJobData, 
  StitchJobData,
  DreamVideoResult, 
  KeyframeOption 
} from './types/index.js';
import { createDreamQueue, IDreamQueue, MemoryDreamQueue, BullMQDreamQueue } from './queue/dream_queue.js';
import { stitchSceneVideos, getVideoDuration } from './media/stitcher.js';
import { CreditLedger, InsufficientCreditsError } from './billing/credit_ledger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '..');

// Load environment configuration
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });
dotenv.config({ path: path.join(SERVER_ROOT, '..', '.env') });

export interface AppOptions {
  dreamProvider?: IDreamProvider;
  dreamArchitect?: IDreamArchitect;
  creditLedger?: CreditLedger;
  dreamQueue?: IDreamQueue;
  queueDriver?: 'memory' | 'bullmq';
  transitionSeconds?: number;
}

export function createApp(options?: AppOptions) {
  const app = express();
  const PORT = process.env.PORT || 5000;
  const HOST = process.env.HOST || '127.0.0.1';
  const SERVER_BASE_URL = process.env.SERVER_BASE_URL || `http://${HOST}:${PORT}`;
  const WAN_TRANSITION_SECONDS = options?.transitionSeconds ?? parseFloat(process.env.WAN_TRANSITION_SECONDS || '0.3');

  // Media storage directories
  const STORAGE_DIR = process.env.STORAGE_DIR 
    ? path.resolve(process.env.STORAGE_DIR) 
    : path.join(SERVER_ROOT, 'storage');
  const STORAGE_VIDEOS_DIR = path.join(STORAGE_DIR, 'videos');
  const STORAGE_KEYFRAMES_DIR = path.join(STORAGE_DIR, 'keyframes');
  fs.mkdirSync(STORAGE_VIDEOS_DIR, { recursive: true });
  fs.mkdirSync(STORAGE_KEYFRAMES_DIR, { recursive: true });

  // CORS configuration
  const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        origin === CLIENT_URL ||
        /^http:\/\/(localhost|127\.0\.0\.1):(517[3-9]|3000)$/.test(origin)
      ) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range']
  }));

  app.use(express.json({ limit: '100kb' }));

  // Architect resolution
  let dreamArchitect: IDreamArchitect;
  if (options?.dreamArchitect) {
    dreamArchitect = options.dreamArchitect;
  } else {
    const architectType = (process.env.ARCHITECT_PROVIDER || (process.env.DREAM_PROVIDER === 'mock' ? 'mock' : 'openai_compat')).toLowerCase().trim();
    if (architectType === 'openai_compat') {
      dreamArchitect = new OpenAICompatibleArchitect(
        process.env.ARCHITECT_BASE_URL,
        process.env.ARCHITECT_MODEL,
        process.env.ARCHITECT_API_KEY,
        parseInt(process.env.ARCHITECT_TIMEOUT_MS || '60000', 10)
      );
    } else if (architectType === 'mock') {
      dreamArchitect = new MockDreamArchitect();
    } else {
      throw new Error(`[CRITICAL STARTUP ERROR] Unknown ARCHITECT_PROVIDER="${architectType}".`);
    }
  }

  // Provider resolution
  let dreamProvider: IDreamProvider;
  if (options?.dreamProvider) {
    dreamProvider = options.dreamProvider;
  } else {
    const providerType = (process.env.DREAM_PROVIDER || 'comfy').toLowerCase().trim();
    const FIXTURES_DIR = path.join(SERVER_ROOT, 'fixtures');
    if (providerType === 'comfy') {
      const comfyHost = process.env.COMFYUI_HOST || 'http://127.0.0.1:8188';
      dreamProvider = new ComfyDreamProvider(comfyHost, SERVER_BASE_URL, STORAGE_VIDEOS_DIR, STORAGE_KEYFRAMES_DIR, dreamArchitect);
    } else if (providerType === 'mock') {
      dreamProvider = new MockDreamProvider(SERVER_BASE_URL, STORAGE_VIDEOS_DIR, STORAGE_KEYFRAMES_DIR, FIXTURES_DIR, dreamArchitect);
    } else {
      throw new Error(`[CRITICAL STARTUP ERROR] Unknown DREAM_PROVIDER="${providerType}".`);
    }
  }

  // User state & Credit Ledger
  const demoUser = {
    id: 'usr_demo_101',
    username: 'DreamExplorer',
    tier: 'Free Explorer'
  };

  const creditLedger = options?.creditLedger || new CreditLedger({
    [demoUser.id]: { credits: 10, reservedCredits: 0 }
  });

  // Stateful sessions & live progress
  const dreamSessions = new Map<string, DreamSession>();
  const progressEvents = new Map<string, DreamProgressEvent>();
  const progressClients = new Map<string, Set<express.Response>>();
  const recentDreams: Array<{
    id: string;
    title: string;
    keyframeUrl: string;
    video: DreamVideoResult;
    prompt: string;
    createdAt: string;
  }> = [];

  function emitDreamProgress(dreamId: string, event: DreamProgressEvent) {
    progressEvents.set(dreamId, event);
    const clients = progressClients.get(dreamId);
    if (clients && clients.size > 0) {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) {
        try {
          client.write(payload);
        } catch (err) {
          clients.delete(client);
        }
      }
    }
  }

  // Session TTL: 2 hours
  const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of dreamSessions.entries()) {
      if (session.expiresAt < now) {
        dreamSessions.delete(id);
        progressEvents.delete(id);
      }
    }
  }, 10 * 60 * 1000).unref();

  // Zod schemas
  const AnalyzeSchema = z.object({
    rawDreamText: z.string().min(5, 'Dream description must be at least 5 characters').max(1500, 'Dream description exceeds 1500 characters'),
    moodHint: z.enum(['ETHEREAL_LUCID', 'NOSTALGIC_FOG', 'SURREAL_CYBERPUNK', 'DEEP_OCEAN', 'FLOATING_SKY', 'GOLDEN_DREAM']).optional()
  });

  const KeyframesSchema = z.object({
    dreamId: z.string().min(1, 'dreamId is required'),
    sceneNumber: z.number().int().min(1).max(3).optional().default(1),
    count: z.number().int().min(1).max(4).optional().default(3)
  });

  const GenerateVideoSchema = z.object({
    dreamId: z.string().min(1, 'dreamId is required'),
    sceneNumber: z.number().int().min(1).max(3).optional().default(1),
    keyframeId: z.string().min(1, 'keyframeId is required'),
    dreamTitle: z.string().max(80).optional()
  });

  const GenerateScenesSchema = z.object({
    dreamId: z.string().min(1, 'dreamId is required'),
    dreamTitle: z.string().max(80).optional()
  });

  const StitchSchema = z.object({
    dreamId: z.string().min(1, 'dreamId is required')
  });

  // Worker: Keyframes Processing (Concurrency: 1 on GPU)
  async function processKeyframesJob(jobData: KeyframeJobData, updateJobProgress: (prog: DreamProgressEvent) => void): Promise<KeyframeOption[]> {
    const session = dreamSessions.get(jobData.dreamId);
    if (!session) {
      throw new Error(`Dream session ${jobData.dreamId} expired or not found.`);
    }

    const targetScene = session.scenes.find(s => s.sceneNumber === jobData.sceneNumber);
    if (!targetScene) {
      throw new Error(`Scene #${jobData.sceneNumber} not found in dream session.`);
    }

    targetScene.status = 'rendering';

    try {
      const keyframes = await dreamProvider.generateKeyframes(
        jobData.prompt,
        jobData.count,
        (prog) => {
          const enrichedProg: DreamProgressEvent = {
            ...prog,
            jobId: jobData.jobId,
            queuePosition: 0,
            currentScene: targetScene.sceneNumber,
            totalScenes: session.scenes.length
          };
          emitDreamProgress(session.dreamId, enrichedProg);
          updateJobProgress(enrichedProg);
        }
      );

      targetScene.keyframes = keyframes;
      targetScene.status = 'keyframes_ready';
      targetScene.selectedKeyframeId = keyframes[0]?.id;
      session.expiresAt = Date.now() + SESSION_TTL_MS;

      if (targetScene.sceneNumber === 1) {
        session.keyframes = keyframes;
        session.status = 'keyframes_ready';
      }

      emitDreamProgress(session.dreamId, {
        stage: 'COMPLETED',
        stageLabel: `Keyframes Ready for Scene #${targetScene.sceneNumber}`,
        detail: `${keyframes.length} anchor visions loaded`,
        percent: 100,
        elapsedSeconds: 0,
        jobId: jobData.jobId,
        queuePosition: 0,
        currentScene: targetScene.sceneNumber,
        totalScenes: session.scenes.length,
        result: keyframes
      });

      return keyframes;
    } catch (err: any) {
      targetScene.status = 'failed';
      targetScene.error = err.message;
      emitDreamProgress(session.dreamId, {
        stage: 'ERROR',
        stageLabel: `Keyframe Synthesis Failed for Scene #${targetScene.sceneNumber}`,
        detail: err.message,
        percent: 0,
        elapsedSeconds: 0,
        jobId: jobData.jobId,
        currentScene: targetScene.sceneNumber,
        totalScenes: session.scenes.length
      });
      throw err;
    }
  }

  // Worker: Video Processing (Concurrency: 1 on GPU)
  async function processVideoJob(jobData: VideoJobData, updateJobProgress: (prog: DreamProgressEvent) => void): Promise<DreamVideoResult> {
    const session = dreamSessions.get(jobData.dreamId);
    if (!session) {
      if (jobData.reservationId) {
        try { creditLedger.release(jobData.reservationId); } catch {}
      }
      throw new Error(`Dream session ${jobData.dreamId} expired or not found.`);
    }

    const targetScene = session.scenes.find(s => s.sceneNumber === jobData.sceneNumber);
    if (!targetScene) {
      if (jobData.reservationId) {
        try { creditLedger.release(jobData.reservationId); } catch {}
      }
      throw new Error(`Scene #${jobData.sceneNumber} not found in this dream session.`);
    }

    const approvedKeyframe = targetScene.keyframes?.find(k => k.id === jobData.keyframeId);
    if (!approvedKeyframe) {
      if (jobData.reservationId) {
        try { creditLedger.release(jobData.reservationId); } catch {}
      }
      throw new Error(`Approved keyframe ${jobData.keyframeId} not found in Scene #${targetScene.sceneNumber}.`);
    }

    targetScene.status = 'rendering';

    try {
      const video = await dreamProvider.generateVideo(
        approvedKeyframe,
        targetScene.motionPrompt || session.refinedPrompt,
        targetScene.cameraMotion,
        (prog) => {
          const enrichedProg: DreamProgressEvent = {
            ...prog,
            jobId: jobData.jobId,
            queuePosition: 0,
            currentScene: targetScene.sceneNumber,
            totalScenes: session.scenes.length
          };
          emitDreamProgress(session.dreamId, enrichedProg);
          updateJobProgress(enrichedProg);
        }
      );

      // Finalize credit deduction in ledger upon verified successful video synthesis of this scene
      if (jobData.reservationId) {
        creditLedger.commit(jobData.reservationId);
      }

      targetScene.video = video;
      targetScene.status = 'completed';
      session.expiresAt = Date.now() + SESSION_TTL_MS;

      console.log(`🎬 [SceneWorker] Scene #${targetScene.sceneNumber} synthesized successfully for dream ${session.dreamId}`);

      const totalScenes = session.scenes.length;
      if (totalScenes === 1) {
        // Single scene: No stitching needed
        session.video = video;
        session.status = 'completed';

        recentDreams.unshift({
          id: session.dreamId,
          title: jobData.dreamTitle || 'Untitled Vision',
          keyframeUrl: approvedKeyframe.imageUrl,
          video,
          prompt: session.refinedPrompt,
          createdAt: new Date().toISOString()
        });

        emitDreamProgress(session.dreamId, {
          stage: 'COMPLETED',
          stageLabel: 'Dream Manifestation Complete',
          detail: 'Video generated successfully',
          percent: 100,
          elapsedSeconds: video.durationSeconds,
          jobId: jobData.jobId,
          queuePosition: 0,
          currentScene: 1,
          totalScenes: 1,
          result: video
        });
      } else {
        // Multi-scene: Check if all scenes are finished
        const allCompleted = session.scenes.every(s => s.status === 'completed');
        if (allCompleted) {
          // Asynchronous Phase 3: Enqueue Stitching as an independent job!
          // Stitching does NOT touch scene statuses or credit ledger.
          console.log(`🎬 [SceneWorker] All ${totalScenes} scenes completed for dream ${session.dreamId}. Enqueueing separate STITCH job...`);
          const stitchJobId = `stitch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
          session.status = 'stitching_queued';
          session.stitchJobId = stitchJobId;

          emitDreamProgress(session.dreamId, {
            stage: 'STITCHING',
            stageLabel: 'Multi-Scene Stitching Queued',
            detail: 'All scene videos ready. Merging scenes with crossfade transition...',
            percent: 90,
            elapsedSeconds: 0,
            jobId: stitchJobId,
            queuePosition: 1,
            currentScene: totalScenes,
            totalScenes
          });

          await dreamQueue.addJob({
            jobType: 'STITCH',
            jobId: stitchJobId,
            dreamId: session.dreamId,
            userId: session.userId || demoUser.id,
            dreamTitle: jobData.dreamTitle || 'Multi-Scene Vision',
            enqueuedAt: Date.now()
          });
        } else {
          const completedCount = session.scenes.filter(s => s.status === 'completed').length;
          emitDreamProgress(session.dreamId, {
            stage: 'SAVING',
            stageLabel: `Scene #${targetScene.sceneNumber} Complete (${completedCount}/${totalScenes})`,
            detail: 'Awaiting completion of remaining scenes...',
            percent: Math.round((completedCount / totalScenes) * 100),
            elapsedSeconds: video.durationSeconds,
            jobId: jobData.jobId,
            queuePosition: 0,
            currentScene: targetScene.sceneNumber,
            totalScenes
          });
        }
      }

      return video;
    } catch (err: any) {
      targetScene.status = 'failed';
      targetScene.error = err.message;

      // Atomic release of ONLY this scene's credit reservation
      if (jobData.reservationId) {
        try {
          creditLedger.release(jobData.reservationId);
        } catch (releaseErr) {
          console.error(`[CreditLedger] Warning during release of ${jobData.reservationId}:`, releaseErr);
        }
      }

      emitDreamProgress(session.dreamId, {
        stage: 'ERROR',
        stageLabel: `Synthesis Failed for Scene #${targetScene.sceneNumber}`,
        detail: err.message,
        percent: 0,
        elapsedSeconds: 0,
        jobId: jobData.jobId,
        currentScene: targetScene.sceneNumber,
        totalScenes: session.scenes.length
      });
      throw err;
    }
  }

  // Worker: Stitching Processing (Completely Decoupled, Free Step)
  async function processStitchJob(jobData: StitchJobData, updateJobProgress: (prog: DreamProgressEvent) => void): Promise<DreamVideoResult> {
    const session = dreamSessions.get(jobData.dreamId);
    if (!session) {
      throw new Error(`Dream session ${jobData.dreamId} not found for stitching.`);
    }

    session.status = 'stitching';
    const totalScenes = session.scenes.length;

    emitDreamProgress(session.dreamId, {
      stage: 'STITCHING',
      stageLabel: 'Stitching Scenes with Crossfade',
      detail: `Executing FFmpeg xfade filtergraph (${WAN_TRANSITION_SECONDS}s transition)...`,
      percent: 92,
      elapsedSeconds: 0,
      jobId: jobData.jobId,
      queuePosition: 0,
      currentScene: totalScenes,
      totalScenes
    });

    try {
      const sortedScenes = [...session.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
      const inputPaths: string[] = [];
      for (const sc of sortedScenes) {
        if (!sc.video) {
          throw new Error(`Missing video clip for Scene #${sc.sceneNumber}`);
        }
        const filename = path.basename(sc.video.videoUrl);
        inputPaths.push(path.join(STORAGE_VIDEOS_DIR, filename));
      }

      const stitchedFilename = `stitched_${session.dreamId}.mp4`;
      const stitchedPath = path.join(STORAGE_VIDEOS_DIR, stitchedFilename);

      const stitchResult = await stitchSceneVideos(inputPaths, stitchedPath, WAN_TRANSITION_SECONDS);

      const finalVideo: DreamVideoResult = {
        id: `stitched_${session.dreamId}`,
        videoUrl: `${SERVER_BASE_URL}/api/media/videos/${stitchedFilename}`,
        durationSeconds: stitchResult.durationSeconds,
        effectiveSeconds: stitchResult.durationSeconds * 2,
        fps: 24,
        playbackRate: 0.5,
        faceBlurred: false,
        audioMood: session.scenes[0]?.mood ? String(session.scenes[0].mood).toLowerCase() : 'ethereal',
        shaderPreset: 'dream_haze',
        isMock: dreamProvider.isMock,
        isStitched: true
      };

      session.video = finalVideo;
      session.status = 'completed';

      recentDreams.unshift({
        id: session.dreamId,
        title: jobData.dreamTitle || 'Multi-Scene Vision',
        keyframeUrl: sortedScenes[0]?.keyframes?.[0]?.imageUrl || '',
        video: finalVideo,
        prompt: session.refinedPrompt,
        createdAt: new Date().toISOString()
      });

      emitDreamProgress(session.dreamId, {
        stage: 'COMPLETED',
        stageLabel: 'Multi-Scene Dream Manifestation Complete',
        detail: `Seamlessly stitched ${totalScenes} scenes (${stitchResult.durationSeconds.toFixed(1)}s)`,
        percent: 100,
        elapsedSeconds: finalVideo.durationSeconds,
        jobId: jobData.jobId,
        queuePosition: 0,
        currentScene: totalScenes,
        totalScenes,
        result: finalVideo
      });

      return finalVideo;
    } catch (err: any) {
      console.error(`💥 [StitchWorker] Stitching failed for dream ${session.dreamId}:`, err);
      // NOTE: Scenes remain 'completed' with intact videos!
      // Credits are NOT refunded or deducted here (stitching is free, scene videos exist).
      session.status = 'stitch_failed';
      session.error = err.message;

      emitDreamProgress(session.dreamId, {
        stage: 'ERROR',
        stageLabel: 'Scene Stitching Failed',
        detail: `FFmpeg stitching failed: ${err.message}. Scenes remain intact and can be re-stitched.`,
        percent: 0,
        elapsedSeconds: 0,
        jobId: jobData.jobId,
        currentScene: totalScenes,
        totalScenes
      });

      throw err;
    }
  }

  // Master Unified Processor
  async function processGpuJob(jobData: GpuJobData, updateJobProgress: (prog: DreamProgressEvent) => void): Promise<any> {
    if (jobData.jobType === 'KEYFRAMES') {
      return processKeyframesJob(jobData, updateJobProgress);
    } else if (jobData.jobType === 'VIDEO') {
      return processVideoJob(jobData, updateJobProgress);
    } else if (jobData.jobType === 'STITCH') {
      return processStitchJob(jobData, updateJobProgress);
    } else {
      throw new Error(`Unknown jobType`);
    }
  }

  // Dream Queue initialization
  let dreamQueue: IDreamQueue;
  if (options?.dreamQueue) {
    dreamQueue = options.dreamQueue;
  } else {
    const driver = options?.queueDriver || (process.env.QUEUE_DRIVER as any) || 'memory';
    if (driver === 'bullmq') {
      const host = process.env.REDIS_HOST || '127.0.0.1';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || undefined;
      dreamQueue = new BullMQDreamQueue(host, port, password, processGpuJob);
    } else {
      dreamQueue = new MemoryDreamQueue(processGpuJob);
    }
  }

  // --- REST ROUTES ---

  app.get('/api/health', async (_req, res) => {
    const queueStats = await dreamQueue.getQueueStats();
    res.json({
      status: 'online',
      service: 'Dream Viewer API',
      timestamp: new Date().toISOString(),
      provider: dreamProvider.name,
      isMock: dreamProvider.isMock,
      isGpuBusy: queueStats.active > 0,
      activeGpuJobs: queueStats.active,
      waitingQueue: queueStats.waiting,
      queueDriver: queueStats.driver
    });
  });

  app.get('/api/user/profile', (_req, res) => {
    const balance = creditLedger.getBalance(demoUser.id);
    res.json({
      ...demoUser,
      credits: balance.credits,
      reservedCredits: balance.reservedCredits,
      availableCredits: balance.availableCredits
    });
  });

  app.get('/api/dreams/recent', (_req, res) => {
    res.json({ dreams: recentDreams });
  });

  // Step 1: Analyze Dream
  app.post('/api/dreams/analyze', async (req, res) => {
    try {
      const parseResult = AnalyzeSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: parseResult.error.errors[0]?.message || 'Invalid request parameters'
        });
      }

      const { rawDreamText, moodHint } = parseResult.data;

      // 1. Layer 1 Moderation
      const rawModeration = SafetyShield.auditPrompt(rawDreamText);
      if (!rawModeration.passed) {
        return res.status(400).json({
          error: 'MODERATION_REJECTED',
          message: rawModeration.reason,
          categories: rawModeration.flaggedCategories
        });
      }

      // 2. Dream Architect Decomposition
      const analysis = await dreamArchitect.analyzeDream(rawDreamText, moodHint);

      // Check safety from architect
      if (!analysis.safety.allowed) {
        return res.status(400).json({
          error: 'MODERATION_REJECTED',
          message: 'The submitted dream concept violated safety guidelines during architectural analysis.',
          categories: analysis.safety.category ? [analysis.safety.category] : ['SAFETY_VIOLATION']
        });
      }

      // 3. Layer 3 Moderation on each prompt
      for (const scene of analysis.scenes) {
        const sceneKfMod = SafetyShield.auditPrompt(scene.keyframePrompt);
        if (!sceneKfMod.passed) {
          return res.status(400).json({
            error: 'MODERATION_REJECTED',
            message: `Keyframe prompt for Scene #${scene.sceneNumber} failed moderation shield: ${sceneKfMod.reason}`,
            categories: sceneKfMod.flaggedCategories
          });
        }
        const sceneMotionMod = SafetyShield.auditPrompt(scene.motionPrompt);
        if (!sceneMotionMod.passed) {
          return res.status(400).json({
            error: 'MODERATION_REJECTED',
            message: `Motion prompt for Scene #${scene.sceneNumber} failed moderation shield: ${sceneMotionMod.reason}`,
            categories: sceneMotionMod.flaggedCategories
          });
        }
      }

      // Calculate total duration strictly on server
      const totalEstimatedSeconds = analysis.scenes.length * 5;
      const dreamId = `dream_${Date.now()}_${crypto.randomUUID()}`;

      const session: DreamSession = {
        dreamId,
        userId: demoUser.id,
        rawText: rawDreamText,
        refinedPrompt: analysis.scenes[0]?.keyframePrompt || rawDreamText,
        keyframePrompt: analysis.scenes[0]?.keyframePrompt || rawDreamText,
        motionPrompt: analysis.scenes[0]?.motionPrompt || '',
        negativePrompt: 'blurry, low quality, distorted anatomy, text, watermark, violent, grotesque',
        cameraMotion: analysis.scenes[0]?.cameraMotion || 'smooth slow pan',
        mood: (analysis.scenes[0]?.mood as MoodStyle) || 'ETHEREAL_LUCID',
        scenes: analysis.scenes.map(s => ({
          ...s,
          status: 'pending'
        })),
        totalEstimatedSeconds,
        keyframes: [],
        status: 'analyzed',
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + SESSION_TTL_MS
      };

      dreamSessions.set(dreamId, session);

      return res.json({
        success: true,
        dreamId,
        data: {
          refinedPrompt: session.refinedPrompt,
          keyframePrompt: session.keyframePrompt,
          motionPrompt: session.motionPrompt,
          negativePrompt: session.negativePrompt,
          cameraMotion: session.cameraMotion,
          detectedMood: session.mood,
          scenes: session.scenes,
          totalEstimatedSeconds,
          visualElements: {
            setting: session.scenes[0]?.summary || 'Surreal environment',
            surrealTwist: session.scenes[1]?.summary || 'Ethereal shift',
            lighting: 'Cinematic atmospheric glow'
          }
        }
      });
    } catch (error: any) {
      console.error('Error analyzing dream:', error);
      res.status(500).json({ error: 'FAILED_TO_ANALYZE_DREAM', message: error.message });
    }
  });

  // Step 2: Generate Keyframe Previews (Returns 202 Accepted)
  app.post('/api/dreams/keyframes', async (req, res) => {
    try {
      const parseResult = KeyframesSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: parseResult.error.errors[0]?.message || 'Invalid request'
        });
      }

      const { dreamId, sceneNumber, count } = parseResult.data;
      const session = dreamSessions.get(dreamId);
      if (!session) {
        return res.status(404).json({
          error: 'SESSION_NOT_FOUND',
          message: 'Dream session expired or invalid. Please re-analyze your dream.'
        });
      }

      // Bug 3 Fix: Do NOT fall back to scenes[0]!
      const targetScene = session.scenes.find(s => s.sceneNumber === sceneNumber);
      if (!targetScene) {
        return res.status(404).json({
          error: 'SCENE_NOT_FOUND',
          message: `Scene #${sceneNumber} not found in this dream session.`
        });
      }

      // Per-scene lock
      if (targetScene.status === 'keyframes_queued' || targetScene.status === 'rendering') {
        return res.status(409).json({
          error: 'GENERATION_IN_PROGRESS',
          message: `Keyframe generation is already queued or generating for Scene #${targetScene.sceneNumber}. Please wait.`
        });
      }

      session.expiresAt = Date.now() + SESSION_TTL_MS;

      const jobId = `kf_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      targetScene.status = 'keyframes_queued';
      targetScene.activeJobId = jobId;

      const { queuePosition } = await dreamQueue.addJob({
        jobType: 'KEYFRAMES',
        jobId,
        dreamId,
        sceneNumber: targetScene.sceneNumber,
        prompt: targetScene.keyframePrompt || session.refinedPrompt,
        count,
        enqueuedAt: Date.now()
      });

      emitDreamProgress(dreamId, {
        stage: 'QUEUED',
        stageLabel: `Keyframes Queued for Scene #${targetScene.sceneNumber} (Position #${queuePosition})`,
        detail: queuePosition === 1 ? 'Next up on GPU' : `${queuePosition - 1} job(s) ahead in GPU queue`,
        percent: 0,
        elapsedSeconds: 0,
        jobId,
        queuePosition,
        currentScene: targetScene.sceneNumber,
        totalScenes: session.scenes.length
      });

      return res.status(202).json({
        success: true,
        jobId,
        dreamId,
        sceneNumber: targetScene.sceneNumber,
        status: 'queued',
        queuePosition,
        message: `Keyframe generation job for Scene #${targetScene.sceneNumber} queued successfully`
      });
    } catch (error: any) {
      console.error('Error queueing keyframes:', error);
      res.status(500).json({ error: 'FAILED_TO_GENERATE_KEYFRAMES', message: error.message });
    }
  });

  // Step 3: Animate Approved Keyframe into Dream Video (Returns 202 Accepted)
  app.post('/api/dreams/generate-video', async (req, res) => {
    const parseResult = GenerateVideoSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: parseResult.error.errors[0]?.message || 'Invalid request'
      });
    }

    const { dreamId, sceneNumber, keyframeId, dreamTitle } = parseResult.data;
    const session = dreamSessions.get(dreamId);
    if (!session) {
      return res.status(404).json({
        error: 'SESSION_NOT_FOUND',
        message: 'Dream session expired or invalid. Please re-analyze your dream.'
      });
    }

    // Bug 3 Fix: Do NOT fall back to scenes[0]!
    const targetScene = session.scenes.find(s => s.sceneNumber === sceneNumber);
    if (!targetScene) {
      return res.status(404).json({
        error: 'SCENE_NOT_FOUND',
        message: `Scene #${sceneNumber} not found in this dream session.`
      });
    }

    // Scene-level lock
    if (targetScene.status === 'video_queued' || targetScene.status === 'rendering') {
      return res.status(409).json({
        error: 'GENERATION_IN_PROGRESS',
        message: `A video generation job is already queued or generating for Scene #${targetScene.sceneNumber}. Please wait.`
      });
    }

    // Bug 1 Fix: Keyframe must exist strictly in targetScene.keyframes! NO session.keyframes fallback!
    const approvedKeyframe = targetScene.keyframes?.find(k => k.id === keyframeId);
    if (!approvedKeyframe) {
      return res.status(400).json({
        error: 'INVALID_KEYFRAME_ID',
        message: `The selected keyframe does not exist in Scene #${targetScene.sceneNumber}.`
      });
    }

    targetScene.selectedKeyframeId = approvedKeyframe.id;

    // Credit Reservation via CreditLedger
    let reservation;
    try {
      reservation = creditLedger.reserve(demoUser.id, 1, `${dreamId}_scene_${targetScene.sceneNumber}`);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(402).json({
          error: 'INSUFFICIENT_CREDITS',
          message: 'Insufficient available dream credits. Credits are reserved for pending jobs in the queue.'
        });
      }
      throw err;
    }

    const jobId = `job_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    targetScene.status = 'video_queued';
    targetScene.activeJobId = jobId;

    const { queuePosition } = await dreamQueue.addJob({
      jobType: 'VIDEO',
      jobId,
      dreamId,
      sceneNumber: targetScene.sceneNumber,
      userId: demoUser.id,
      keyframeId: approvedKeyframe.id,
      reservationId: reservation.id,
      dreamTitle: dreamTitle || 'Lucid Vision',
      reservedCredits: 1,
      enqueuedAt: Date.now()
    });

    emitDreamProgress(dreamId, {
      stage: 'QUEUED',
      stageLabel: `Scene #${targetScene.sceneNumber} in Queue (Position #${queuePosition})`,
      detail: queuePosition === 1 ? 'Next up for rendering on GPU' : `${queuePosition - 1} job(s) ahead in queue`,
      percent: 0,
      elapsedSeconds: 0,
      jobId,
      queuePosition,
      currentScene: targetScene.sceneNumber,
      totalScenes: session.scenes.length
    });

    const balance = creditLedger.getBalance(demoUser.id);
    return res.status(202).json({
      success: true,
      jobId,
      dreamId,
      sceneNumber: targetScene.sceneNumber,
      status: 'queued',
      queuePosition,
      reservedCredits: 1,
      availableCredits: balance.availableCredits,
      message: `Video generation job for Scene #${targetScene.sceneNumber} queued successfully`
    });
  });

  // Step 3b: "Generate Missing Scenes" Batch Endpoint
  app.post('/api/dreams/generate-scenes', async (req, res) => {
    const parseResult = GenerateScenesSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: parseResult.error.errors[0]?.message || 'Invalid request'
      });
    }

    const { dreamId, dreamTitle } = parseResult.data;
    const session = dreamSessions.get(dreamId);
    if (!session) {
      return res.status(404).json({
        error: 'SESSION_NOT_FOUND',
        message: 'Dream session expired or invalid. Please re-analyze your dream.'
      });
    }

    // Find scenes that are uncompleted
    const uncompletedScenes = session.scenes.filter(s => 
      s.status !== 'completed' && s.status !== 'video_queued' && s.status !== 'rendering'
    );

    if (uncompletedScenes.length === 0) {
      return res.json({
        success: true,
        message: 'All scenes are already completed or actively rendering in the queue.',
        scenes: session.scenes
      });
    }

    // Bug 1 Fix: Verify that ALL uncompleted scenes have keyframes ready!
    // NO session.keyframes fallback!
    const missingScenes = uncompletedScenes
      .filter(s => !s.selectedKeyframeId && (!s.keyframes || s.keyframes.length === 0))
      .map(s => s.sceneNumber);

    if (missingScenes.length > 0) {
      return res.status(400).json({
        error: 'KEYFRAMES_MISSING',
        message: `Cannot generate video for scenes without keyframes. Scenes [${missingScenes.join(', ')}] require keyframe generation first.`,
        missingScenes
      });
    }

    // Check available credits for all uncompleted scenes
    const requiredCredits = uncompletedScenes.length;
    const balance = creditLedger.getBalance(demoUser.id);
    if (balance.availableCredits < requiredCredits) {
      return res.status(402).json({
        error: 'INSUFFICIENT_CREDITS',
        message: `Insufficient dream credits. Generating ${requiredCredits} scene(s) requires ${requiredCredits} available credits, but you have ${balance.availableCredits}.`
      });
    }

    const queuedJobs: Array<{ jobId: string; sceneNumber: number; queuePosition: number }> = [];

    for (const scene of uncompletedScenes) {
      const keyframeId = scene.selectedKeyframeId || scene.keyframes![0].id;
      scene.selectedKeyframeId = keyframeId;

      const reservation = creditLedger.reserve(demoUser.id, 1, `${dreamId}_scene_${scene.sceneNumber}`);
      const jobId = `job_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      scene.status = 'video_queued';
      scene.activeJobId = jobId;

      const { queuePosition } = await dreamQueue.addJob({
        jobType: 'VIDEO',
        jobId,
        dreamId,
        sceneNumber: scene.sceneNumber,
        userId: demoUser.id,
        keyframeId,
        reservationId: reservation.id,
        dreamTitle: dreamTitle || `Scene #${scene.sceneNumber}`,
        reservedCredits: 1,
        enqueuedAt: Date.now()
      });

      queuedJobs.push({ jobId, sceneNumber: scene.sceneNumber, queuePosition });
    }

    return res.status(202).json({
      success: true,
      message: `Queued ${queuedJobs.length} scene(s) for video generation.`,
      jobs: queuedJobs,
      reservedCredits: queuedJobs.length,
      availableCredits: creditLedger.getBalance(demoUser.id).availableCredits
    });
  });

  // Step 3c: Free Re-Stitching Endpoint (Bug 2 Fix)
  app.post('/api/dreams/stitch', async (req, res) => {
    const parseResult = StitchSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: parseResult.error.errors[0]?.message || 'Invalid request'
      });
    }

    const { dreamId } = parseResult.data;
    const session = dreamSessions.get(dreamId);
    if (!session) {
      return res.status(404).json({
        error: 'SESSION_NOT_FOUND',
        message: 'Dream session expired or invalid.'
      });
    }

    if (session.scenes.length <= 1) {
      return res.status(400).json({
        error: 'SINGLE_SCENE_DREAM',
        message: 'Single scene dreams do not require stitching.'
      });
    }

    const incompleteScenes = session.scenes.filter(s => s.status !== 'completed');
    if (incompleteScenes.length > 0) {
      return res.status(400).json({
        error: 'SCENES_INCOMPLETE',
        message: `Cannot stitch dream. Scenes [${incompleteScenes.map(s => s.sceneNumber).join(', ')}] are not completed yet.`,
        incompleteScenes: incompleteScenes.map(s => s.sceneNumber)
      });
    }

    if (session.status === 'stitching_queued' || session.status === 'stitching') {
      return res.status(409).json({
        error: 'STITCHING_IN_PROGRESS',
        message: 'Stitching is already in progress for this dream.'
      });
    }

    const stitchJobId = `stitch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    session.status = 'stitching_queued';
    session.stitchJobId = stitchJobId;

    const { queuePosition } = await dreamQueue.addJob({
      jobType: 'STITCH',
      jobId: stitchJobId,
      dreamId: session.dreamId,
      userId: session.userId || demoUser.id,
      dreamTitle: 'Re-Stitched Vision',
      enqueuedAt: Date.now()
    });

    return res.status(202).json({
      success: true,
      jobId: stitchJobId,
      dreamId: session.dreamId,
      status: 'queued',
      queuePosition,
      message: 'Multi-scene stitching job queued successfully (Free of charge)'
    });
  });

  // Query Job Status
  app.get('/api/dreams/jobs/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const status = await dreamQueue.getJobStatus(jobId);
    if (!status) {
      return res.status(404).json({
        error: 'JOB_NOT_FOUND',
        message: `Job ${jobId} not found in queue records`
      });
    }

    let sceneKeyframes: KeyframeOption[] | undefined;
    let dreamVideo: DreamVideoResult | undefined;
    const session = dreamSessions.get(status.dreamId);
    if (session) {
      const scene = session.scenes.find(s => s.sceneNumber === status.sceneNumber);
      sceneKeyframes = scene?.keyframes || session.keyframes;
      dreamVideo = scene?.video || session.video;
    }

    return res.json({
      job: status,
      keyframes: sceneKeyframes,
      video: dreamVideo
    });
  });

  // Query Session State
  app.get('/api/dreams/session/:dreamId', (req, res) => {
    const { dreamId } = req.params;
    const session = dreamSessions.get(dreamId);
    if (!session) {
      return res.status(404).json({
        error: 'SESSION_NOT_FOUND',
        message: 'Dream session expired or invalid.'
      });
    }
    return res.json({ session });
  });

  // SSE Live Progress Endpoint (Supports both /progress/:dreamId and /:dreamId/progress)
  app.get(['/api/dreams/progress/:dreamId', '/api/dreams/:dreamId/progress'], (req, res) => {
    const { dreamId } = req.params;
    const session = dreamSessions.get(dreamId);
    if (!session) {
      return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Dream session not found' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    if (!progressClients.has(dreamId)) {
      progressClients.set(dreamId, new Set());
    }
    progressClients.get(dreamId)!.add(res);

    const lastEvent = progressEvents.get(dreamId);
    if (lastEvent) {
      res.write(`data: ${JSON.stringify(lastEvent)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const clients = progressClients.get(dreamId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
          progressClients.delete(dreamId);
        }
      }
    });
  });

  // Static Media Serving
  app.use('/api/media/keyframes', express.static(STORAGE_KEYFRAMES_DIR, {
    setHeaders: (res) => {
      res.set('Cache-Control', 'public, max-age=86400, immutable');
    }
  }));

  app.use('/api/media/videos', express.static(STORAGE_VIDEOS_DIR, {
    setHeaders: (res) => {
      res.set('Accept-Ranges', 'bytes');
      res.set('Cache-Control', 'public, max-age=86400');
    }
  }));

  return {
    app,
    dreamSessions,
    creditLedger,
    dreamQueue,
    dreamProvider,
    dreamArchitect
  };
}

export const defaultAppInstance = createApp();
export const app = defaultAppInstance.app;
export default app;
