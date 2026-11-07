import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { z } from 'zod';
import { SafetyShield } from './moderation/shield.js';
import { MockDreamProvider } from './providers/mock_provider.js';
import { ComfyDreamProvider } from './providers/comfy_provider.js';
import { MoodStyle, IDreamProvider, DreamSession } from './types/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '127.0.0.1';

// Restrict CORS to trusted origins; avoid open '*' in production/local network
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
app.use(cors({
  origin: [CLIENT_URL, 'http://127.0.0.1:5173', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parser with 100kb limit to prevent payload flooding
app.use(express.json({ limit: '100kb' }));

// Strict Provider Resolution: No silent fallback!
const providerType = (process.env.DREAM_PROVIDER || 'comfy').toLowerCase().trim();
let dreamProvider: IDreamProvider;

if (providerType === 'comfy') {
  const comfyHost = process.env.COMFYUI_HOST || 'http://127.0.0.1:8188';
  dreamProvider = new ComfyDreamProvider(comfyHost);
} else if (providerType === 'mock') {
  dreamProvider = new MockDreamProvider();
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
// Keyed by unique dreamId
const dreamSessions = new Map<string, DreamSession>();

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
    environment: process.env.NODE_ENV || 'development'
  });
});

// User Profile & Credits
app.get('/api/user/profile', (req, res) => {
  res.json(demoUser);
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

    // Create server-side session to lock prompt and prevent client tampering
    const dreamId = `dream_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const session: DreamSession = {
      dreamId,
      userId: demoUser.id,
      rawText: rawDreamText,
      refinedPrompt: analysis.refinedPrompt,
      negativePrompt: analysis.negativePrompt,
      cameraMotion: analysis.cameraMotion,
      mood: analysis.detectedMood,
      keyframes: [],
      createdAt: new Date().toISOString()
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

// Step 2: Generate Keyframe Previews (Prompt is retrieved from server session)
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

    // Generate keyframes using server-locked prompt (client cannot override)
    const keyframes = await dreamProvider.generateKeyframes(session.refinedPrompt, count);
    session.keyframes = keyframes;

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
// Client passes ONLY dreamId & keyframeId (eliminates SSRF and prompt injection)
app.post('/api/dreams/generate-video', async (req, res) => {
  try {
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

    // IMPORTANT: Generate video BEFORE deducting credit!
    // If the GPU/ComfyUI call fails or times out, the user retains their credit.
    const video = await dreamProvider.generateVideo(
      approvedKeyframe,
      session.refinedPrompt,
      session.cameraMotion
    );

    // Deduct credit ONLY upon successful video creation
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
    recentDreams.unshift(completedDream);

    res.json({
      success: true,
      remainingCredits: demoUser.credits,
      dream: completedDream
    });
  } catch (error: any) {
    console.error('Error generating video:', error);
    // User credits were NOT deducted
    res.status(500).json({ error: 'FAILED_TO_GENERATE_VIDEO', message: error.message });
  }
});

// Recent Dreams Gallery
app.get('/api/dreams/recent', (req, res) => {
  res.json({ dreams: recentDreams });
});

app.listen(Number(PORT), HOST, () => {
  console.log(`✨ Dream Viewer Server active on http://${HOST}:${PORT}`);
  console.log(`🔒 4-Layer Moderation Shield & Provider: ${dreamProvider.name} (isMock=${dreamProvider.isMock})`);
});
