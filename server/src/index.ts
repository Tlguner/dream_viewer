import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { SafetyShield } from './moderation/shield.js';
import { MockDreamProvider } from './providers/mock_provider.js';
import { LocalAiDreamProvider } from './providers/local_ai_provider.js';
import { MoodStyle, IDreamProvider } from './types/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Initialize Provider: Defaults to local GPU AI engine if available, or mock
const providerType = process.env.DREAM_PROVIDER || 'local';
const dreamProvider: IDreamProvider = providerType === 'local'
  ? new LocalAiDreamProvider(process.env.AI_SERVICE_URL || 'http://localhost:8000')
  : new MockDreamProvider();

// In-memory demo state for user & dreams (before DB migration)
let demoUser = {
  id: 'usr_demo_101',
  username: 'DreamExplorer',
  credits: 10,
  tier: 'Free Explorer'
};

const recentDreams: any[] = [];

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    provider: dreamProvider.name,
    providerType: providerType,
    isMock: providerType === 'mock',
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
    const { rawDreamText, moodHint } = req.body;

    // Layer 1 & 2: Safety & Moderation Shield
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

    res.json({
      success: true,
      data: analysis
    });
  } catch (error: any) {
    console.error('Error analyzing dream:', error);
    res.status(500).json({ error: 'FAILED_TO_ANALYZE_DREAM', message: error.message });
  }
});

// Step 2: Generate Keyframe Previews (Low cost exploration)
app.post('/api/dreams/keyframes', async (req, res) => {
  try {
    const { refinedPrompt, count = 3 } = req.body;

    if (!refinedPrompt) {
      return res.status(400).json({ error: 'refinedPrompt is required' });
    }

    const keyframes = await dreamProvider.generateKeyframes(refinedPrompt, count);

    res.json({
      success: true,
      keyframes
    });
  } catch (error: any) {
    console.error('Error generating keyframes:', error);
    res.status(500).json({ error: 'FAILED_TO_GENERATE_KEYFRAMES', message: error.message });
  }
});

// Step 3: Animate Approved Keyframe into Dream Video (Image-to-Video + On-twos stretch)
app.post('/api/dreams/generate-video', async (req, res) => {
  try {
    const { selectedKeyframeUrl, prompt, cameraMotion, dreamTitle } = req.body;

    if (!selectedKeyframeUrl) {
      return res.status(400).json({ error: 'selectedKeyframeUrl is required' });
    }

    if (demoUser.credits < 1) {
      return res.status(402).json({ 
        error: 'INSUFFICIENT_CREDITS', 
        message: 'You have used all your dream credits. Recharge to manifest more dreams!' 
      });
    }

    // Deduct 1 credit for video generation
    demoUser.credits -= 1;

    const video = await dreamProvider.generateVideo(selectedKeyframeUrl, prompt, cameraMotion);

    const completedDream = {
      id: `dream_${Date.now()}`,
      title: dreamTitle || 'Untitled Vision',
      keyframeUrl: selectedKeyframeUrl,
      video,
      prompt,
      createdAt: new Date().toISOString()
    };

    recentDreams.unshift(completedDream);

    res.json({
      success: true,
      remainingCredits: demoUser.credits,
      dream: completedDream
    });
  } catch (error: any) {
    console.error('Error generating video:', error);
    res.status(500).json({ error: 'FAILED_TO_GENERATE_VIDEO', message: error.message });
  }
});

// Recent Dreams Gallery
app.get('/api/dreams/recent', (req, res) => {
  res.json({ dreams: recentDreams });
});

app.listen(PORT, () => {
  console.log(`✨ Dream Viewer Server active on port ${PORT}`);
  console.log(`🔒 4-Layer Moderation Shield & Provider (${dreamProvider.name}) enabled.`);
});
