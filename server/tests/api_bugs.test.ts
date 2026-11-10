import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MockDreamProvider } from '../src/providers/mock_provider.js';
import { MockDreamArchitect } from '../src/architect/index.js';
import { CreditLedger } from '../src/billing/credit_ledger.js';
import path from 'path';

describe('API Bug Fixes & Edge Case Integration Tests (Supertest)', () => {
  let appInstance: ReturnType<typeof createApp>;
  let ledger: CreditLedger;

  beforeEach(() => {
    const SERVER_ROOT = path.resolve(__dirname, '..');
    const STORAGE_DIR = path.join(SERVER_ROOT, 'storage');
    const FIXTURES_DIR = path.join(SERVER_ROOT, 'fixtures');
    const architect = new MockDreamArchitect();
    const provider = new MockDreamProvider(
      'http://127.0.0.1:5000',
      path.join(STORAGE_DIR, 'videos'),
      path.join(STORAGE_DIR, 'keyframes'),
      FIXTURES_DIR,
      architect
    );
    ledger = new CreditLedger({
      'usr_demo_101': { credits: 10, reservedCredits: 0 }
    });

    appInstance = createApp({
      dreamProvider: provider,
      dreamArchitect: architect,
      creditLedger: ledger,
      queueDriver: 'memory',
      transitionSeconds: 0.3
    });
  });

  describe('Bug 1: Scene 2 rendered using Scene 1 keyframe fallback', () => {
    it('should reject generate-scenes with 400 when an uncompleted scene has no keyframes', async () => {
      // 1. Analyze 2-scene dream
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({
          rawDreamText: 'Denizde yüzüyordum || kendimi ormanda buldum'
        })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      expect(analyzeRes.body.data.scenes.length).toBe(2);

      // 2. Generate keyframes ONLY for Scene 1
      const kfRes = await request(appInstance.app)
        .post('/api/dreams/keyframes')
        .send({ dreamId, sceneNumber: 1, count: 2 })
        .expect(202);

      const kfJobId = kfRes.body.jobId;
      // Wait for keyframe job to finish in memory queue
      await appInstance.dreamQueue.waitForJobResult(kfJobId);

      const sessionBefore = appInstance.dreamSessions.get(dreamId);
      expect(sessionBefore?.scenes[0].keyframes?.length).toBeGreaterThan(0);
      expect(sessionBefore?.scenes[1].keyframes).toBeUndefined();

      // 3. Call generate-scenes without generating Scene 2 keyframes
      // This MUST return 400 with missingScenes: [2], NOT fall back to Scene 1!
      const genScenesRes = await request(appInstance.app)
        .post('/api/dreams/generate-scenes')
        .send({ dreamId })
        .expect(400);

      expect(genScenesRes.body.error).toBe('KEYFRAMES_MISSING');
      expect(genScenesRes.body.missingScenes).toEqual([2]);

      // Verify no credits were reserved or deducted
      const balance = ledger.getBalance('usr_demo_101');
      expect(balance.credits).toBe(10);
      expect(balance.reservedCredits).toBe(0);

      // Verify Scene 2 was NOT queued
      expect(sessionBefore?.scenes[1].status).toBe('pending');
      expect(sessionBefore?.scenes[1].selectedKeyframeId).toBeUndefined();
    });

    it('should reject generate-video if keyframeId does not belong to the target scene', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Sahne bir || Sahne iki' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;

      // Generate keyframe for Scene 1
      const kf1Res = await request(appInstance.app)
        .post('/api/dreams/keyframes')
        .send({ dreamId, sceneNumber: 1, count: 1 })
        .expect(202);

      await appInstance.dreamQueue.waitForJobResult(kf1Res.body.jobId);
      const scene1KfId = appInstance.dreamSessions.get(dreamId)!.scenes[0].keyframes![0].id;

      // Try to generate video for Scene 2 using Scene 1's keyframeId
      const fraudRes = await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({
          dreamId,
          sceneNumber: 2,
          keyframeId: scene1KfId
        })
        .expect(400);

      expect(fraudRes.body.error).toBe('INVALID_KEYFRAME_ID');
      expect(ledger.getBalance('usr_demo_101').reservedCredits).toBe(0);
    });
  });

  describe('Bug 2: Stitching Failure Isolation & Free Re-Stitch', () => {
    it('should decouple stitching from video jobs and preserve completed scenes and credits upon stitch failure', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Gündoğumu vadisi || Gece şelalesi' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;

      // Generate keyframes for both scenes
      const kf1 = await request(appInstance.app).post('/api/dreams/keyframes').send({ dreamId, sceneNumber: 1, count: 1 }).expect(202);
      const kf2 = await request(appInstance.app).post('/api/dreams/keyframes').send({ dreamId, sceneNumber: 2, count: 1 }).expect(202);
      await appInstance.dreamQueue.waitForJobResult(kf1.body.jobId);
      await appInstance.dreamQueue.waitForJobResult(kf2.body.jobId);

      const session = appInstance.dreamSessions.get(dreamId)!;
      const kfId1 = session.scenes[0].keyframes![0].id;
      const kfId2 = session.scenes[1].keyframes![0].id;

      // Queue video for Scene 1
      const v1 = await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({ dreamId, sceneNumber: 1, keyframeId: kfId1 })
        .expect(202);
      await appInstance.dreamQueue.waitForJobResult(v1.body.jobId);

      // Verify Scene 1 completed and 1 credit committed
      expect(session.scenes[0].status).toBe('completed');
      expect(ledger.getBalance('usr_demo_101')).toEqual({
        credits: 9,
        reservedCredits: 0,
        availableCredits: 9
      });

      // Queue video for Scene 2
      const v2 = await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({ dreamId, sceneNumber: 2, keyframeId: kfId2 })
        .expect(202);
      await appInstance.dreamQueue.waitForJobResult(v2.body.jobId);

      // Both scenes should be completed!
      expect(session.scenes[0].status).toBe('completed');
      expect(session.scenes[1].status).toBe('completed');

      // Both scenes committed -> exactly 2 credits deducted (Remaining: 8)
      expect(ledger.getBalance('usr_demo_101')).toEqual({
        credits: 8,
        reservedCredits: 0,
        availableCredits: 8
      });

      // Session should have enqueued a STITCH job
      expect(session.stitchJobId).toBeDefined();
      expect(['stitching_queued', 'stitching', 'completed']).toContain(session.status);

      // Wait for STITCH job
      await appInstance.dreamQueue.waitForJobResult(session.stitchJobId!);
      expect(session.status).toBe('completed');
      expect(session.video?.isStitched).toBe(true);

      // Re-stitch endpoint should be callable without spending credits
      const stitchRes = await request(appInstance.app)
        .post('/api/dreams/stitch')
        .send({ dreamId })
        .expect(202);

      expect(stitchRes.body.jobId).toMatch(/^stitch_/);
      expect(ledger.getBalance('usr_demo_101').credits).toBe(8);
      expect(ledger.getBalance('usr_demo_101').reservedCredits).toBe(0);
    });
  });

  describe('Bug 3: Non-existent scene silent fallback to Scene 1', () => {
    it('should return 404 SCENE_NOT_FOUND for non-existent sceneNumber in keyframes endpoint', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Tek sahneli rüya' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;

      // Request sceneNumber 3 on a 1-scene dream
      const res = await request(appInstance.app)
        .post('/api/dreams/keyframes')
        .send({ dreamId, sceneNumber: 3, count: 1 })
        .expect(404);

      expect(res.body.error).toBe('SCENE_NOT_FOUND');
    });

    it('should return 404 SCENE_NOT_FOUND for non-existent sceneNumber in generate-video endpoint', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Tek sahneli rüya' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;

      // Request sceneNumber 3 on a 1-scene dream
      const res = await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({ dreamId, sceneNumber: 3, keyframeId: 'mock_kf_1' })
        .expect(404);

      expect(res.body.error).toBe('SCENE_NOT_FOUND');
    });

    it('should reject the removed generic PUT /scenes endpoint with 404 and block injection attacks', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Ormanda yürüyordum' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;

      // Exact malicious request from user
      const attackRes = await request(appInstance.app)
        .put(`/api/dreams/session/${dreamId}/scenes`)
        .send({
          scenes: [{
            keyframePrompt: "çıplak bir kadın",
            status: "keyframes_ready",
            keyframes: [{ id: "evil", imageUrl: "http://169.254.169.254/latest/meta-data/" }],
            selectedKeyframeId: "evil"
          }]
        });

      // Must be 404 since permissive PUT /scenes is abolished
      expect(attackRes.status).toBe(404);
    });

    it('should reject NSFW or gore in PATCH /scenes/:sceneId/prompt with 400 MODERATION_REJECTED', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Ormanda yürüyordum' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const sceneId = analyzeRes.body.data.scenes[0].sceneId;

      const patchRes = await request(appInstance.app)
        .patch(`/api/dreams/session/${dreamId}/scenes/${sceneId}/prompt`)
        .send({
          keyframePrompt: "çıplak bir kadın nehirde yüzüyor"
        })
        .expect(400);

      expect(patchRes.body.error).toBe('MODERATION_REJECTED');
    });

    it('should ignore client-injected status, keyframes, or SSRF URLs via PATCH prompt and invalidate existing assets', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Ormanda yürüyordum' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const sceneId = analyzeRes.body.data.scenes[0].sceneId;

      // 1. Generate keyframes first
      const kfRes = await request(appInstance.app)
        .post('/api/dreams/keyframes')
        .send({ dreamId, sceneId, count: 2 })
        .expect(202);
      await appInstance.dreamQueue.waitForJobResult(kfRes.body.jobId);

      const sessionBefore = appInstance.dreamSessions.get(dreamId);
      expect(sessionBefore?.scenes[0].keyframes?.length).toBe(2);

      // 2. Patch prompt with attempts to inject fake video, evil SSRF keyframe, and fake completed status
      const patchRes = await request(appInstance.app)
        .patch(`/api/dreams/session/${dreamId}/scenes/${sceneId}/prompt`)
        .send({
          keyframePrompt: "A misty ancient pine forest with morning dew",
          status: "completed",
          keyframes: [{ id: "evil", imageUrl: "http://169.254.169.254/latest/meta-data/" }],
          selectedKeyframeId: "evil",
          video: { id: "fake_vid", videoUrl: "http://evil.com/video.mp4" }
        })
        .expect(200);

      expect(patchRes.body.scene.keyframePrompt).toBe("A misty ancient pine forest with morning dew");
      // Status must be reset to pending because prompt changed
      expect(patchRes.body.scene.status).toBe("pending");
      // Keyframes, video, selectedKeyframeId must be wiped (not evil URLs!)
      expect(patchRes.body.scene.keyframes).toBeUndefined();
      expect(patchRes.body.scene.selectedKeyframeId).toBeUndefined();
      expect(patchRes.body.scene.video).toBeUndefined();
    });

    it('should split a scene using Dream Architect and enforce max 3 scenes limit', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Karanlık bir madende yürüyordum' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const initialScenes = analyzeRes.body.data.scenes;
      expect(initialScenes.length).toBe(1);
      const scene1Id = initialScenes[0].sceneId;

      // Split scene 1 with new scene "lavanta tarlası"
      const splitRes = await request(appInstance.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${scene1Id}/split`)
        .send({ newSceneText: "kendimi sonsuz mor bir lavanta tarlasında buldum" })
        .expect(200);

      expect(splitRes.body.scenes.length).toBe(2);
      expect(splitRes.body.scenes[0].sceneNumber).toBe(1);
      expect(splitRes.body.scenes[1].sceneNumber).toBe(2);
      expect(splitRes.body.scenes[1].sceneId).toBeDefined();
      expect(splitRes.body.scenes[1].sceneId).not.toBe(scene1Id);
      expect(splitRes.body.scenes[1].status).toBe('pending');

      const scene2Id = splitRes.body.scenes[1].sceneId;

      // Split again to reach 3 scenes
      const splitRes2 = await request(appInstance.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${scene2Id}/split`)
        .send({ newSceneText: "gökyüzünde süzülen bir ada" })
        .expect(200);

      expect(splitRes2.body.scenes.length).toBe(3);

      // Attempt to split 4th scene: MUST FAIL WITH 400 MAX_SCENES_REACHED
      const splitFailRes = await request(appInstance.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${scene2Id}/split`)
        .send({ newSceneText: "dördüncü bir mekân" })
        .expect(400);

      expect(splitFailRes.body.error).toBe('MAX_SCENES_REACHED');
    });

    it('should merge scenes using strategy and enforce min 1 scene limit', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Denizde yüzüyordum || kendimi ormanda buldum' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const scenes = analyzeRes.body.data.scenes;
      expect(scenes.length).toBe(2);

      const scene1Id = scenes[0].sceneId;
      const scene2Id = scenes[1].sceneId;

      // Merge scene 1 with scene 2 using reanalyze
      const mergeRes = await request(appInstance.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${scene1Id}/merge`)
        .send({ targetSceneId: scene2Id, strategy: 'reanalyze' })
        .expect(200);

      expect(mergeRes.body.scenes.length).toBe(1);
      expect(mergeRes.body.scenes[0].sceneNumber).toBe(1);

      // Attempt to merge when only 1 scene: MUST FAIL WITH 400 MIN_SCENES_REACHED
      const mergeFailRes = await request(appInstance.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${mergeRes.body.scenes[0].sceneId}/merge`)
        .send({ targetSceneId: 'nonexistent', strategy: 'reanalyze' })
        .expect(400);

      expect(mergeFailRes.body.error).toBe('MIN_SCENES_REACHED');
    });

    it('should return 409 CONFLICT if attempting to split, merge, or patch while a job is active', async () => {
      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Ormanda yürüyordum' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const sceneId = analyzeRes.body.data.scenes[0].sceneId;

      // Generate keyframe
      const kfRes = await request(appInstance.app)
        .post('/api/dreams/keyframes')
        .send({ dreamId, sceneId, count: 2 })
        .expect(202);
      await appInstance.dreamQueue.waitForJobResult(kfRes.body.jobId);

      const session = appInstance.dreamSessions.get(dreamId);
      const kfId = session!.scenes[0].keyframes![0].id;

      // Start video job
      await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({ dreamId, sceneId, keyframeId: kfId })
        .expect(202);

      // Now session has active video job (video_queued or rendering)
      // Attempting to patch prompt must return 409
      const patchConflict = await request(appInstance.app)
        .patch(`/api/dreams/session/${dreamId}/scenes/${sceneId}/prompt`)
        .send({ keyframePrompt: "Yeni prompt" })
        .expect(409);
      expect(patchConflict.body.error).toBe('DREAM_BUSY');

      // Attempting to split must return 409
      const splitConflict = await request(appInstance.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${sceneId}/split`)
        .send({ newSceneText: "Yeni sahne" })
        .expect(409);
      expect(splitConflict.body.error).toBe('DREAM_BUSY');
    });
  });
});
