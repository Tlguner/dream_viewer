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
import { MoodStyle, IDreamProvider, DreamSession, DreamProgressEvent, GpuJobData, KeyframeJobData, VideoJobData, DreamVideoResult, KeyframeOption } from './types/index.js';
import { createDreamQueue, IDreamQueue } from './queue/dream_queue.js';
import { stitchSceneVideos } from './media/stitcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Deterministic server root path (immune to working directory changes)
const SERVER_ROOT = path.resolve(__dirname, '..');

// Load environment configuration from server directory or project root
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });
dotenv.config({ path: path.join(SERVER_ROOT, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '127.0.0.1';
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || `http://${HOST}:${PORT}`;

// Deterministic local media storage directories
const STORAGE_DIR = process.env.STORAGE_DIR 
  ? path.resolve(process.env.STORAGE_DIR) 
  : path.join(SERVER_ROOT, 'storage');
const STORAGE_VIDEOS_DIR = path.join(STORAGE_DIR, 'videos');
const STORAGE_KEYFRAMES_DIR = path.join(STORAGE_DIR, 'keyframes');
fs.mkdirSync(STORAGE_VIDEOS_DIR, { recursive: true });
fs.mkdirSync(STORAGE_KEYFRAMES_DIR, { recursive: true });

// CORS: allow frontend clients (including Vite dev ports 5173-5179)
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

// Body parser with 100kb limit
app.use(express.json({ limit: '100kb' }));

// Strict Architect Resolution (No silent fallback!)
const architectType = (process.env.ARCHITECT_PROVIDER || (process.env.DREAM_PROVIDER === 'mock' ? 'mock' : 'openai_compat')).toLowerCase().trim();
let dreamArchitect: IDreamArchitect;

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
  throw new Error(
    `[CRITICAL STARTUP ERROR] Unknown ARCHITECT_PROVIDER="${architectType}". ` +
    `Supported architect providers: "openai_compat", "mock". Silent fallback has been disabled.`
  );
}

// Strict Provider Resolution: No silent fallback!
const providerType = (process.env.DREAM_PROVIDER || 'comfy').toLowerCase().trim();
let dreamProvider: IDreamProvider;

const FIXTURES_DIR = path.join(SERVER_ROOT, 'fixtures');

if (providerType === 'comfy') {
  const comfyHost = process.env.COMFYUI_HOST || 'http://127.0.0.1:8188';
  dreamProvider = new ComfyDreamProvider(comfyHost, SERVER_BASE_URL, STORAGE_VIDEOS_DIR, STORAGE_KEYFRAMES_DIR, dreamArchitect);
} else if (providerType === 'mock') {
  dreamProvider = new MockDreamProvider(SERVER_BASE_URL, STORAGE_VIDEOS_DIR, STORAGE_KEYFRAMES_DIR, FIXTURES_DIR, dreamArchitect);
} else {
  throw new Error(
    `[CRITICAL STARTUP ERROR] Unknown DREAM_PROVIDER="${providerType}". ` +
    `Supported providers: "comfy", "mock". Silent fallback has been disabled.`
  );
}

// In-memory demo state for user credits with atomic reservation guard
const demoUser = {
  id: 'usr_demo_101',
  username: 'DreamExplorer',
  credits: 10,
  reservedCredits: 0,
  tier: 'Free Explorer'
};

let dreamQueue: IDreamQueue;

// Stateful dream sessions: Prevents moderation bypass, prompt injection, and SSRF
const dreamSessions = new Map<string, DreamSession>();

// Active live progress subscriptions per dreamId
const progressEvents = new Map<string, DreamProgressEvent>();
const progressClients = new Map<string, Set<express.Response>>();

function emitDreamProgress(dreamId: string, event: DreamProgressEvent) {
  progressEvents.set(dreamId, event);
  const clients = progressClients.get(dreamId);
  if (clients && clients.size > 0) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }
}

// Evict expired sessions periodically (1-hour TTL) and clean up progress maps
const SESSION_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of dreamSessions.entries()) {
    if (session.expiresAt && session.expiresAt < now) {
      dreamSessions.delete(id);
      progressEvents.delete(id);
      const clients = progressClients.get(id);
      if (clients) {
        for (const client of clients) {
          try { client.end(); } catch {}
        }
        progressClients.delete(id);
      }
    }
  }
}, 10 * 60 * 1000).unref();

// Periodic Storage Cleanup: Prune files older than 24 hours
const FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
function pruneOldFiles(dirPath: string) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath);
    const now = Date.now();
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > FILE_RETENTION_MS) {
        fs.unlinkSync(fullPath);
        console.log(`🧹 [StorageCleanup] Pruned expired file: ${file}`);
      }
    }
  } catch (err: any) {
    console.warn(`Storage cleanup error in ${dirPath}:`, err.message);
  }
}

setInterval(() => {
  pruneOldFiles(STORAGE_VIDEOS_DIR);
  pruneOldFiles(STORAGE_KEYFRAMES_DIR);
}, 60 * 60 * 1000).unref();

// In-memory gallery of completed dreams
const recentDreams: any[] = [];

// Zod Validation Schemas
const AnalyzeDreamSchema = z.object({
  rawDreamText: z.string()
    .min(5, 'Dream description must be at least 5 characters.')
    .max(2000, 'Dream description cannot exceed 2000 characters.'),
  moodHint: z.enum([
    'ETHEREAL_LUCID',
    'NOSTALGIC_FOG',
    'SURREAL_CYBERPUNK',
    'DEEP_OCEAN',
    'FLOATING_SKY',
    'GOLDEN_DREAM'
  ]).optional()
});

const KeyframesSchema = z.object({
  dreamId: z.string().min(1, 'dreamId is required'),
  sceneNumber: z.number().int().min(1).max(3).optional().default(1),
  count: z.number().int().min(1).max(6).default(3)
});

const GenerateVideoSchema = z.object({
  dreamId: z.string().min(1, 'dreamId is required'),
  sceneNumber: z.number().int().min(1).max(3).optional().default(1),
  keyframeId: z.string().min(1, 'keyframeId is required'),
  dreamTitle: z.string().max(100).optional()
});

const GenerateScenesSchema = z.object({
  dreamId: z.string().min(1, 'dreamId is required'),
  dreamTitle: z.string().max(100).optional()
});

// Health check with honest provider, architect, and GPU queue status
app.get(['/health', '/api/health'], async (req, res) => {
  try {
    const queueStats = await dreamQueue.getQueueStats();
    const isGpuActive = queueStats.active > 0;
    res.json({
      status: 'online',
      timestamp: new Date().toISOString(),
      provider: dreamProvider.name,
      providerType,
      architect: dreamArchitect.name,
      architectType,
      isMock: dreamProvider.isMock,
      isGpuBusy: isGpuActive,
      queue: queueStats,
      gpu: {
        isBusy: isGpuActive
      },
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// SSE Progress Endpoint: Stream live real-time generation progress to frontend
app.get('/api/dreams/progress/:dreamId', (req, res) => {
  const { dreamId } = req.params;

  const session = dreamSessions.get(dreamId);
  if (!session) {
    return res.status(404).json({
      error: 'SESSION_NOT_FOUND',
      message: 'Dream session expired or invalid.'
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders?.();

  // Send latest cached event or default starting state immediately
  const latest = progressEvents.get(dreamId);
  if (latest) {
    res.write(`data: ${JSON.stringify(latest)}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({
      stage: 'INITIALIZING',
      stageLabel: 'Connecting to GPU Pipeline',
      detail: 'Awaiting execution queue...',
      percent: 0,
      elapsedSeconds: 0
    })}\n\n`);
  }

  if (!progressClients.has(dreamId)) {
    progressClients.set(dreamId, new Set());
  }
  progressClients.get(dreamId)!.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
    }
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



// User Profile & Credits with Atomic Available Calculation
app.get('/api/user/profile', (req, res) => {
  res.json({
    ...demoUser,
    availableCredits: Math.max(0, demoUser.credits - demoUser.reservedCredits)
  });
});

// Self-Hosted Media Serving: Videos using Express native res.sendFile
// Handles Range requests, 206 Partial Content, suffix ranges (-500), 416, and ETags automatically
app.get('/api/media/videos/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(STORAGE_VIDEOS_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND', message: 'Requested video does not exist.' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(filePath);
});

// Self-Hosted Media Serving: Keyframe Images using Express native res.sendFile
app.get('/api/media/keyframes/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(STORAGE_KEYFRAMES_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND', message: 'Requested keyframe does not exist.' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(filePath);
});

// Step 1: Dream Architect - Moderation & Cinematic Prompt Refinement
app.post('/api/dreams/analyze', async (req, res) => {
  try {
    const parseResult = AnalyzeDreamSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: parseResult.error.errors[0]?.message || 'Invalid request body'
      });
    }

    const { rawDreamText, moodHint } = parseResult.data;

    // Layer 1 & 2: 4-Layer Safety & Moderation Shield (Unicode-aware)
    const moderation = SafetyShield.auditPrompt(rawDreamText);
    if (!moderation.passed) {
      return res.status(400).json({
        error: 'MODERATION_REJECTED',
        message: moderation.reason,
        categories: moderation.flaggedCategories
      });
    }

    // Call Dream Architect LLM pass
    const analysis = await dreamProvider.analyzeDream(rawDreamText, moodHint as MoodStyle);

    // Cryptographically secure dreamId + 1h TTL
    const dreamId = `dream_${Date.now()}_${crypto.randomUUID()}`;
    const session: DreamSession = {
      dreamId,
      userId: demoUser.id,
      rawText: rawDreamText,
      refinedPrompt: analysis.refinedPrompt,
      keyframePrompt: analysis.keyframePrompt,
      motionPrompt: analysis.motionPrompt,
      negativePrompt: analysis.negativePrompt,
      cameraMotion: analysis.cameraMotion,
      mood: analysis.detectedMood,
      scenes: analysis.scenes.map(s => ({
        ...s,
        status: 'pending' as const,
        keyframes: []
      })),
      totalEstimatedSeconds: analysis.totalEstimatedSeconds,
      keyframes: [],
      status: 'analyzed',
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + SESSION_TTL_MS
    };

    dreamSessions.set(dreamId, session);

    res.json({
      success: true,
      dreamId,
      data: analysis
    });
  } catch (error: any) {
    console.error('Error analyzing dream:', error);
    res.status(500).json({ error: 'FAILED_TO_ANALYZE_DREAM', message: error.message });
  }
});

// Helper to map videoUrl to local filesystem path
function getLocalVideoPath(videoUrl: string): string {
  const filename = path.basename(videoUrl);
  return path.join(STORAGE_VIDEOS_DIR, filename);
}

const WAN_TRANSITION_SECONDS = parseFloat(process.env.WAN_TRANSITION_SECONDS || '0.3');

// Step 2: Generate Keyframe Previews (Asynchronous Queue Architecture - Returns 202 Accepted)
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

    const targetScene = session.scenes.find(s => s.sceneNumber === sceneNumber) || session.scenes[0];
    if (!targetScene) {
      return res.status(404).json({
        error: 'SCENE_NOT_FOUND',
        message: `Scene #${sceneNumber} not found in this dream session.`
      });
    }

    // Per-scene lock: Prevent concurrent keyframe requests on the same scene
    if (targetScene.status === 'keyframes_queued' || targetScene.status === 'rendering') {
      return res.status(409).json({
        error: 'GENERATION_IN_PROGRESS',
        message: `Keyframe generation is already queued or generating for Scene #${targetScene.sceneNumber}. Please wait.`
      });
    }

    // Refresh TTL
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    const jobId = `kf_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    targetScene.status = 'keyframes_queued';
    targetScene.activeJobId = jobId;

    // Enqueue keyframe generation into unified GPU queue (strictly concurrency: 1 with videos)
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

    // Asynchronous Response: HTTP 202 Accepted (No open HTTP holding!)
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

// Worker Keyframes Processing Function (Concurrency: 1 on GPU)
async function processKeyframesJob(jobData: KeyframeJobData, updateJobProgress: (prog: DreamProgressEvent) => void): Promise<KeyframeOption[]> {
  const session = dreamSessions.get(jobData.dreamId);
  if (!session) {
    throw new Error(`Dream session ${jobData.dreamId} expired or not found.`);
  }

  const targetScene = session.scenes.find(s => s.sceneNumber === jobData.sceneNumber) || session.scenes[0];
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

    // For backwards compatibility with single-scene flow
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

// Worker Video Processing Function (Concurrency: 1 on GPU)
async function processVideoJob(jobData: VideoJobData, updateJobProgress: (prog: DreamProgressEvent) => void): Promise<DreamVideoResult> {
  const session = dreamSessions.get(jobData.dreamId);
  if (!session) {
    // Refund credit reservation if session vanished
    demoUser.reservedCredits = Math.max(0, demoUser.reservedCredits - jobData.reservedCredits);
    throw new Error(`Dream session ${jobData.dreamId} expired or not found.`);
  }

  const targetScene = session.scenes.find(s => s.sceneNumber === jobData.sceneNumber) || session.scenes[0];
  const approvedKeyframe = targetScene?.keyframes?.find(k => k.id === jobData.keyframeId) ||
    session.keyframes.find(k => k.id === jobData.keyframeId);

  if (!approvedKeyframe) {
    demoUser.reservedCredits = Math.max(0, demoUser.reservedCredits - jobData.reservedCredits);
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

    // Finalize credit deduction ONLY upon verified successful synthesis of this scene
    demoUser.credits -= jobData.reservedCredits;
    demoUser.reservedCredits -= jobData.reservedCredits;

    targetScene.video = video;
    targetScene.status = 'completed';
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    console.log(`🎬 [SceneWorker] Scene #${targetScene.sceneNumber} synthesized successfully for dream ${session.dreamId}`);

    // Check Multi-Scene Completion and Stitching
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
      // Multi-scene: Check if all scenes have finished
      const allCompleted = session.scenes.every(s => s.status === 'completed' && s.video);

      if (allCompleted) {
        console.log(`🎬 [SceneWorker] All ${totalScenes} scenes completed for dream ${session.dreamId}. Launching FFmpeg stitching...`);
        emitDreamProgress(session.dreamId, {
          stage: 'STITCHING',
          stageLabel: 'Stitching Dream Scenes',
          detail: `Applying dynamic crossfade transition across ${totalScenes} scenes with FFmpeg...`,
          percent: 92,
          elapsedSeconds: 0,
          jobId: jobData.jobId,
          currentScene: totalScenes,
          totalScenes
        });

        // Collect all local scene video files in sceneNumber order
        const sortedScenes = [...session.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
        const inputPaths = sortedScenes.map(s => getLocalVideoPath(s.video!.videoUrl));
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
          keyframeUrl: sortedScenes[0]?.keyframes?.[0]?.imageUrl || approvedKeyframe.imageUrl,
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

    // Atomic refund of ONLY this scene's credit reservation on generation failure
    demoUser.reservedCredits = Math.max(0, demoUser.reservedCredits - jobData.reservedCredits);

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

// Master Unified GPU Processor (Strict Concurrency: 1 on local GPU)
async function processGpuJob(jobData: GpuJobData, updateJobProgress: (prog: DreamProgressEvent) => void): Promise<any> {
  if (jobData.jobType === 'KEYFRAMES') {
    return processKeyframesJob(jobData, updateJobProgress);
  } else {
    return processVideoJob(jobData, updateJobProgress);
  }
}

// Step 3: Animate Approved Keyframe into Dream Video (Asynchronous Queue Architecture)
// Dispatches per-scene job to queue, atomically reserves credit, and immediately returns HTTP 202 Accepted
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

  const targetScene = session.scenes.find(s => s.sceneNumber === sceneNumber) || session.scenes[0];
  if (!targetScene) {
    return res.status(404).json({
      error: 'SCENE_NOT_FOUND',
      message: `Scene #${sceneNumber} not found in this dream session.`
    });
  }

  // 1. Scene-level lock: Prevent duplicate concurrent requests on the same scene (409 Conflict)
  if (targetScene.status === 'video_queued' || targetScene.status === 'rendering') {
    return res.status(409).json({
      error: 'GENERATION_IN_PROGRESS',
      message: `A video generation job is already queued or generating for Scene #${targetScene.sceneNumber}. Please wait.`
    });
  }

  // 2. Validate selected keyframe strictly from scene or session
  const approvedKeyframe = targetScene?.keyframes?.find(k => k.id === keyframeId) ||
    session.keyframes.find(k => k.id === keyframeId);

  if (!approvedKeyframe) {
    return res.status(400).json({
      error: 'INVALID_KEYFRAME_ID',
      message: `The selected keyframe does not exist in Scene #${targetScene.sceneNumber}.`
    });
  }

  targetScene.selectedKeyframeId = approvedKeyframe.id;

  // 3. Credit Reservation Guard: Check available unreserved credits (1 credit per scene)
  const cost = 1;
  const availableCredits = demoUser.credits - demoUser.reservedCredits;
  if (availableCredits < cost) {
    return res.status(402).json({
      error: 'INSUFFICIENT_CREDITS',
      message: 'Insufficient available dream credits. Credits are reserved for pending jobs in the queue.'
    });
  }

  // Atomically reserve 1 credit for this scene
  demoUser.reservedCredits += cost;

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
    dreamTitle: dreamTitle || 'Lucid Vision',
    reservedCredits: cost,
    enqueuedAt: Date.now()
  });

  // Emit initial SSE QUEUED event
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

  // Asynchronous Response: HTTP 202 Accepted
  return res.status(202).json({
    success: true,
    jobId,
    dreamId,
    sceneNumber: targetScene.sceneNumber,
    status: 'queued',
    queuePosition,
    reservedCredits: cost,
    availableCredits: demoUser.credits - demoUser.reservedCredits,
    message: `Video generation job for Scene #${targetScene.sceneNumber} queued successfully`
  });
});

// Step 3b: "Generate Missing Scenes" Batch Endpoint
// Automatically queues all pending or failed scenes in a multi-scene dream session
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

  // Find scenes that have keyframes ready but are not completed or currently queued
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

  // Check required credits: 1 per uncompleted scene
  const requiredCredits = uncompletedScenes.length;
  const availableCredits = demoUser.credits - demoUser.reservedCredits;
  if (availableCredits < requiredCredits) {
    return res.status(402).json({
      error: 'INSUFFICIENT_CREDITS',
      message: `Insufficient dream credits. Generating ${requiredCredits} scene(s) requires ${requiredCredits} available credits, but you have ${availableCredits}.`
    });
  }

  const queuedJobs: Array<{ jobId: string; sceneNumber: number; queuePosition: number }> = [];

  for (const scene of uncompletedScenes) {
    const keyframeId = scene.selectedKeyframeId || scene.keyframes?.[0]?.id || session.keyframes[0]?.id;
    if (!keyframeId) {
      continue; // Skip scenes without keyframes
    }

    demoUser.reservedCredits += 1;
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
      dreamTitle: dreamTitle || `Scene #${scene.sceneNumber}`,
      reservedCredits: 1,
      enqueuedAt: Date.now()
    });

    queuedJobs.push({ jobId, sceneNumber: scene.sceneNumber, queuePosition });
  }

  return res.status(202).json({
    success: true,
    dreamId,
    queuedJobs,
    reservedCredits: queuedJobs.length,
    availableCredits: demoUser.credits - demoUser.reservedCredits,
    message: `Enqueued ${queuedJobs.length} missing scene(s) for rendering.`
  });
});

// Step 3c: Session Inspection Endpoint (returns scene statuses, clips, and keyframes)
app.get('/api/dreams/session/:dreamId', (req, res) => {
  const { dreamId } = req.params;
  const session = dreamSessions.get(dreamId);
  if (!session) {
    return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Dream session not found.' });
  }

  res.json({
    success: true,
    session: {
      dreamId: session.dreamId,
      status: session.status,
      scenes: session.scenes,
      video: session.video,
      totalEstimatedSeconds: session.totalEstimatedSeconds,
      createdAt: session.createdAt
    }
  });
});

// Step 4: Job Status & Polling Endpoint (Supports both Keyframes and Video jobs)
app.get('/api/dreams/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const jobStatus = await dreamQueue.getJobStatus(jobId);
  if (!jobStatus) {
    return res.status(404).json({
      error: 'JOB_NOT_FOUND',
      message: `Job ${jobId} was not found.`
    });
  }

  const session = dreamSessions.get(jobStatus.dreamId);
  const targetScene = session?.scenes.find(s => s.sceneNumber === jobStatus.sceneNumber) || session?.scenes[0];

  const dream = (session?.status === 'completed' && session.video) ? {
    id: session.dreamId,
    title: 'Lucid Vision',
    keyframeUrl: session.keyframes.find(k => k.id === session.video?.id)?.imageUrl || session.keyframes[0]?.imageUrl,
    video: session.video,
    prompt: session.refinedPrompt,
    createdAt: new Date().toISOString()
  } : undefined;

  res.json({
    success: true,
    job: jobStatus,
    keyframes: jobStatus.keyframes || targetScene?.keyframes,
    dream
  });
});

// Recent Dreams Gallery
app.get('/api/dreams/recent', (req, res) => {
  res.json({ dreams: recentDreams });
});

// Strict Server Startup with Queue Initialization
async function startServer() {
  // Initialize Unified Dream GPU Queue (concurrency: 1 for keyframes & videos)
  dreamQueue = await createDreamQueue(processGpuJob);

  app.listen(Number(PORT), HOST, () => {
    console.log(`✨ Dream Viewer Server active on http://${HOST}:${PORT}`);
    console.log(`🔒 4-Layer Moderation Shield & Provider: ${dreamProvider.name} (isMock=${dreamProvider.isMock})`);
    console.log(`📦 Queue Driver: ${dreamQueue.driver} (Worker Concurrency: 1)`);
    console.log(`📁 Media Storage: ${STORAGE_VIDEOS_DIR}`);
  });
}

startServer().catch(err => {
  console.error('[FATAL SERVER STARTUP ERROR]', err.message);
  process.exit(1);
});
