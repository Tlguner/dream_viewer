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
import { MoodStyle, IDreamProvider, DreamSession, DreamProgressEvent, VideoJobData, DreamVideoResult } from './types/index.js';
import { createDreamQueue, IDreamQueue } from './queue/dream_queue.js';

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

// Concurrency guard: Only 1 active generation allowed on single local GPU (videos & keyframes)
let isGpuBusy = false;

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
  count: z.number().int().min(1).max(6).default(3)
});

const GenerateVideoSchema = z.object({
  dreamId: z.string().min(1, 'dreamId is required'),
  keyframeId: z.string().min(1, 'keyframeId is required'),
  dreamTitle: z.string().max(100).optional()
});

// Health check with honest provider and architect info
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    provider: dreamProvider.name,
    providerType,
    architect: dreamArchitect.name,
    architectType,
    isMock: dreamProvider.isMock,
    isGpuBusy,
    environment: process.env.NODE_ENV || 'development'
  });
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

// System Health & Queue Driver Transparency
app.get(['/health', '/api/health'], async (req, res) => {
  try {
    const queueStats = await dreamQueue.getQueueStats();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      queue: queueStats,
      gpu: {
        isBusy: isGpuBusy
      },
      provider: {
        name: dreamProvider.name,
        isMock: dreamProvider.isMock
      },
      architect: {
        name: dreamArchitect.name,
        isMock: dreamArchitect.isMock
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
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
      scenes: analysis.scenes,
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

// Step 2: Generate Keyframe Previews (Server session locked + GPU concurrency lock)
app.post('/api/dreams/keyframes', async (req, res) => {
  try {
    const parseResult = KeyframesSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: parseResult.error.errors[0]?.message || 'Invalid request'
      });
    }

    const { dreamId, count } = parseResult.data;
    const session = dreamSessions.get(dreamId);
    if (!session) {
      return res.status(404).json({
        error: 'SESSION_NOT_FOUND',
        message: 'Dream session expired or invalid. Please re-analyze your dream.'
      });
    }

    // GPU concurrency guard: prevent concurrent jobs on 8GB VRAM
    if (isGpuBusy) {
      return res.status(429).json({
        error: 'GPU_BUSY',
        message: 'The local GPU is currently busy synthesizing another vision or video. Please wait a moment.'
      });
    }

    isGpuBusy = true;
    try {
      // Refresh TTL
      session.expiresAt = Date.now() + SESSION_TTL_MS;

      // Generate keyframes using server-locked scene prompt with live progress
      const keyframes = await dreamProvider.generateKeyframes(
        session.keyframePrompt || session.refinedPrompt, 
        count,
        (prog) => emitDreamProgress(dreamId, prog)
      );
      session.keyframes = keyframes;
      session.status = 'keyframes_ready';

      res.json({
        success: true,
        dreamId,
        keyframes
      });
    } finally {
      isGpuBusy = false;
    }
  } catch (error: any) {
    console.error('Error generating keyframes:', error);
    res.status(500).json({ error: 'FAILED_TO_GENERATE_KEYFRAMES', message: error.message });
  }
});

// Worker Video Processing Function (Concurrency: 1 on GPU)
async function processVideoJob(jobData: VideoJobData, updateJobProgress: (prog: DreamProgressEvent) => void): Promise<DreamVideoResult> {
  const session = dreamSessions.get(jobData.dreamId);
  if (!session) {
    // Refund credit reservation if session vanished
    demoUser.reservedCredits = Math.max(0, demoUser.reservedCredits - jobData.reservedCredits);
    throw new Error(`Dream session ${jobData.dreamId} expired or not found.`);
  }

  const approvedKeyframe = session.keyframes.find(k => k.id === jobData.keyframeId);
  if (!approvedKeyframe) {
    demoUser.reservedCredits = Math.max(0, demoUser.reservedCredits - jobData.reservedCredits);
    throw new Error(`Approved keyframe ${jobData.keyframeId} not found in session.`);
  }

  session.status = 'generating';
  isGpuBusy = true;

  try {
    const video = await dreamProvider.generateVideo(
      approvedKeyframe,
      session.motionPrompt || session.refinedPrompt,
      session.cameraMotion,
      (prog) => {
        const enrichedProg: DreamProgressEvent = {
          ...prog,
          jobId: jobData.jobId,
          queuePosition: 0,
          currentScene: 1,
          totalScenes: session.scenes?.length || 1
        };
        emitDreamProgress(session.dreamId, enrichedProg);
        updateJobProgress(enrichedProg);
      }
    );

    // Finalize credit deduction ONLY upon verified successful synthesis
    demoUser.credits -= jobData.reservedCredits;
    demoUser.reservedCredits -= jobData.reservedCredits;

    const completedDream = {
      id: session.dreamId,
      title: jobData.dreamTitle || 'Untitled Vision',
      keyframeUrl: approvedKeyframe.imageUrl,
      video,
      prompt: session.refinedPrompt,
      createdAt: new Date().toISOString()
    };

    session.video = video;
    session.status = 'completed';
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    recentDreams.unshift(completedDream);

    emitDreamProgress(session.dreamId, {
      stage: 'COMPLETED',
      stageLabel: 'Dream Manifestation Complete',
      detail: 'Video generated successfully',
      percent: 100,
      elapsedSeconds: video.durationSeconds,
      jobId: jobData.jobId,
      queuePosition: 0,
      currentScene: 1,
      totalScenes: session.scenes?.length || 1,
      result: video
    });

    return video;
  } catch (err: any) {
    session.status = 'failed';
    // Atomic refund of credit reservation on generation failure
    demoUser.reservedCredits = Math.max(0, demoUser.reservedCredits - jobData.reservedCredits);
    emitDreamProgress(session.dreamId, {
      stage: 'ERROR',
      stageLabel: 'Synthesis Failed',
      detail: err.message,
      percent: 0,
      elapsedSeconds: 0,
      jobId: jobData.jobId
    });
    throw err;
  } finally {
    isGpuBusy = false;
  }
}

// Step 3: Animate Approved Keyframe into Dream Video (Asynchronous Queue Architecture)
// Dispatches job to queue, atomically reserves credits, and immediately returns HTTP 202 Accepted
app.post('/api/dreams/generate-video', async (req, res) => {
  const parseResult = GenerateVideoSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: parseResult.error.errors[0]?.message || 'Invalid request'
    });
  }

  const { dreamId, keyframeId, dreamTitle } = parseResult.data;
  const session = dreamSessions.get(dreamId);
  if (!session) {
    return res.status(404).json({
      error: 'SESSION_NOT_FOUND',
      message: 'Dream session expired or invalid. Please re-analyze your dream.'
    });
  }

  // 1. Session-level lock: Prevent duplicate concurrent requests on the same session (409 Conflict)
  if (session.status === 'generating' || session.status === 'queued') {
    return res.status(409).json({
      error: 'GENERATION_IN_PROGRESS',
      message: 'A video generation job is already queued or generating for this dream session. Please wait.'
    });
  }

  // 2. Validate selected keyframe strictly from server session
  const approvedKeyframe = session.keyframes.find(k => k.id === keyframeId);
  if (!approvedKeyframe) {
    return res.status(400).json({
      error: 'INVALID_KEYFRAME_ID',
      message: 'The selected keyframe does not exist in this dream session.'
    });
  }

  // 3. Credit Reservation Guard: Check available unreserved credits
  const cost = 1;
  const availableCredits = demoUser.credits - demoUser.reservedCredits;
  if (availableCredits < cost) {
    return res.status(402).json({
      error: 'INSUFFICIENT_CREDITS',
      message: 'Insufficient available dream credits. Credits are reserved for pending jobs in the queue.'
    });
  }

  // Atomically reserve credits at queue entry time (finalized on success, refunded on failure)
  demoUser.reservedCredits += cost;

  const jobId = `job_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  session.status = 'queued';
  session.activeJobId = jobId;

  const { queuePosition } = await dreamQueue.addJob({
    jobId,
    dreamId,
    userId: demoUser.id,
    keyframeId,
    dreamTitle: dreamTitle || 'Lucid Vision',
    reservedCredits: cost,
    enqueuedAt: Date.now()
  });

  // Emit initial SSE QUEUED event
  emitDreamProgress(dreamId, {
    stage: 'QUEUED',
    stageLabel: `In Queue (Position #${queuePosition})`,
    detail: queuePosition === 1 ? 'Next up for rendering on GPU' : `${queuePosition - 1} job(s) ahead in queue`,
    percent: 0,
    elapsedSeconds: 0,
    jobId,
    queuePosition,
    currentScene: 1,
    totalScenes: session.scenes?.length || 1
  });

  // Asynchronous Response: HTTP 202 Accepted
  return res.status(202).json({
    success: true,
    jobId,
    dreamId,
    status: 'queued',
    queuePosition,
    reservedCredits: cost,
    availableCredits: demoUser.credits - demoUser.reservedCredits,
    message: 'Video generation job queued successfully'
  });
});

// Step 4: Job Status & Polling Endpoint
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
    dream
  });
});

// Recent Dreams Gallery
app.get('/api/dreams/recent', (req, res) => {
  res.json({ dreams: recentDreams });
});

// Strict Server Startup with Queue Initialization
async function startServer() {
  // Initialize Dream Queue (validates Redis if QUEUE_DRIVER=bullmq, or boots memory queue if QUEUE_DRIVER=memory)
  dreamQueue = await createDreamQueue(processVideoJob);

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
