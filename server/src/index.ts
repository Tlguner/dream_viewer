import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { z } from 'zod';
import { SafetyShield } from './moderation/shield.js';
import { MockDreamProvider } from './providers/mock_provider.js';
import { ComfyDreamProvider } from './providers/comfy_provider.js';
import { MoodStyle, IDreamProvider, DreamSession } from './types/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '127.0.0.1';
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || `http://${HOST}:${PORT}`;

// Create local media storage directories
const STORAGE_DIR = path.resolve('storage');
const STORAGE_VIDEOS_DIR = path.join(STORAGE_DIR, 'videos');
const STORAGE_KEYFRAMES_DIR = path.join(STORAGE_DIR, 'keyframes');
fs.mkdirSync(STORAGE_VIDEOS_DIR, { recursive: true });
fs.mkdirSync(STORAGE_KEYFRAMES_DIR, { recursive: true });

// CORS: allow frontend clients
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
app.use(cors({
  origin: [CLIENT_URL, 'http://127.0.0.1:5173', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range']
}));

// Body parser with 100kb limit
app.use(express.json({ limit: '100kb' }));

// Strict Provider Resolution: No silent fallback!
const providerType = (process.env.DREAM_PROVIDER || 'comfy').toLowerCase().trim();
let dreamProvider: IDreamProvider;

if (providerType === 'comfy') {
  const comfyHost = process.env.COMFYUI_HOST || 'http://127.0.0.1:8188';
  dreamProvider = new ComfyDreamProvider(comfyHost, SERVER_BASE_URL, STORAGE_VIDEOS_DIR, STORAGE_KEYFRAMES_DIR);
} else if (providerType === 'mock') {
  dreamProvider = new MockDreamProvider(SERVER_BASE_URL, STORAGE_VIDEOS_DIR);
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

// Concurrency guard: Only 1 active generation allowed on single GPU
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

// User Profile & Credits
app.get('/api/user/profile', (req, res) => {
  res.json(demoUser);
});

// Self-Hosted Media Serving: Videos with HTTP Range requests (scrubbing/streaming)
app.get('/api/media/videos/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(STORAGE_VIDEOS_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND', message: 'Requested video does not exist.' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Self-Hosted Media Serving: Keyframe Images
app.get('/api/media/keyframes/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(STORAGE_KEYFRAMES_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND', message: 'Requested keyframe does not exist.' });
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(filePath).pipe(res);
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

// Step 2: Generate Keyframe Previews (Server session locked)
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

    // Refresh TTL
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    // Generate keyframes using server-locked prompt
    const keyframes = await dreamProvider.generateKeyframes(session.refinedPrompt, count);
    session.keyframes = keyframes;
    session.status = 'keyframes_ready';

    res.json({
      success: true,
      dreamId,
      keyframes
    });
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

  // 1. Session-level lock: Prevent duplicate requests on the same session
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
      session.refinedPrompt,
      session.cameraMotion
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
