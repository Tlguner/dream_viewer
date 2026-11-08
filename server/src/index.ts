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
import { MoodStyle, IDreamProvider, DreamSession, DreamProgressEvent } from './types/index.js';

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

// Strict Provider Resolution: No silent fallback!
const providerType = (process.env.DREAM_PROVIDER || 'comfy').toLowerCase().trim();
let dreamProvider: IDreamProvider;

const FIXTURES_DIR = path.join(SERVER_ROOT, 'fixtures');

if (providerType === 'comfy') {
  const comfyHost = process.env.COMFYUI_HOST || 'http://127.0.0.1:8188';
  dreamProvider = new ComfyDreamProvider(comfyHost, SERVER_BASE_URL, STORAGE_VIDEOS_DIR, STORAGE_KEYFRAMES_DIR);
} else if (providerType === 'mock') {
  dreamProvider = new MockDreamProvider(SERVER_BASE_URL, STORAGE_VIDEOS_DIR, STORAGE_KEYFRAMES_DIR, FIXTURES_DIR);
} else {
  throw new Error(
    `[CRITICAL STARTUP ERROR] Unknown DREAM_PROVIDER="${providerType}". ` +
    `Supported providers: "comfy", "mock". Silent fallback has been disabled.`
  );
}

// In-memory demo state for user credits
const demoUser = {
  id: 'usr_demo_101',
  username: 'DreamExplorer',
  credits: 10,
  tier: 'Free Explorer'
};

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

// Evict expired sessions periodically (1-hour TTL)
const SESSION_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of dreamSessions.entries()) {
    if (session.expiresAt && session.expiresAt < now) {
      dreamSessions.delete(id);
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

// Health check with honest provider info
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    provider: dreamProvider.name,
    providerType,
    isMock: dreamProvider.isMock,
    isGpuBusy,
    environment: process.env.NODE_ENV || 'development'
  });
});

// SSE Progress Endpoint: Stream live real-time generation progress to frontend
app.get('/api/dreams/progress/:dreamId', (req, res) => {
  const { dreamId } = req.params;

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

// User Profile & Credits
app.get('/api/user/profile', (req, res) => {
  res.json(demoUser);
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

// Step 3: Animate Approved Keyframe into Dream Video (Image-to-Video)
// Protected against double-clicks, race conditions, and GPU OOM
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
      message: 'Dream session expired or invalid.'
    });
  }

  // 1. Session-level lock: Prevent duplicate concurrent requests on the same session (409 Conflict)
  if (session.status === 'generating') {
    return res.status(409).json({
      error: 'GENERATION_IN_PROGRESS',
      message: 'A video generation is already underway for this dream session. Please wait.'
    });
  }

  // 2. GPU-level lock: Prevent multiple simultaneous GPU loads on 8GB VRAM
  if (isGpuBusy) {
    return res.status(429).json({
      error: 'GPU_BUSY',
      message: 'The local GPU is currently synthesizing another dream. Please wait a moment.'
    });
  }

  // Look up approved keyframe strictly from server session
  const approvedKeyframe = session.keyframes.find(k => k.id === keyframeId);
  if (!approvedKeyframe) {
    return res.status(400).json({
      error: 'INVALID_KEYFRAME_ID',
      message: 'The selected keyframe does not exist in this dream session.'
    });
  }

  if (demoUser.credits < 1) {
    return res.status(402).json({ 
      error: 'INSUFFICIENT_CREDITS', 
      message: 'You have used all your dream credits. Recharge to manifest more dreams!' 
    });
  }

  // Acquire locks
  session.status = 'generating';
  isGpuBusy = true;

  try {
    // Generate video (persisted inside server storage and served through /api/media/videos/)
    const video = await dreamProvider.generateVideo(
      approvedKeyframe,
      session.motionPrompt || session.refinedPrompt,
      session.cameraMotion,
      (prog) => emitDreamProgress(session.dreamId, prog)
    );

    // Deduct credit ONLY upon verified success
    demoUser.credits -= 1;

    const completedDream = {
      id: session.dreamId,
      title: dreamTitle || 'Untitled Vision',
      keyframeUrl: approvedKeyframe.imageUrl,
      video,
      prompt: session.refinedPrompt,
      createdAt: new Date().toISOString()
    };

    session.video = video;
    session.status = 'completed';
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    recentDreams.unshift(completedDream);

    res.json({
      success: true,
      remainingCredits: demoUser.credits,
      dream: completedDream
    });
  } catch (error: any) {
    console.error('Error generating video:', error);
    session.status = 'failed';
    // User credits were NOT deducted
    res.status(500).json({ error: 'FAILED_TO_GENERATE_VIDEO', message: error.message });
  } finally {
    // Release GPU lock unconditionally
    isGpuBusy = false;
  }
});

// Recent Dreams Gallery
app.get('/api/dreams/recent', (req, res) => {
  res.json({ dreams: recentDreams });
});

app.listen(Number(PORT), HOST, () => {
  console.log(`✨ Dream Viewer Server active on http://${HOST}:${PORT}`);
  console.log(`🔒 4-Layer Moderation Shield & Provider: ${dreamProvider.name} (isMock=${dreamProvider.isMock})`);
  console.log(`📁 Media Storage: ${STORAGE_VIDEOS_DIR}`);
});
