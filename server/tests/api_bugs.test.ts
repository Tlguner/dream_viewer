import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MockDreamProvider } from '../src/providers/mock_provider.js';
import { MockDreamArchitect } from '../src/architect/index.js';
import { CreditLedger } from '../src/billing/credit_ledger.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

async function waitForJobCompletion(app: any, jobId: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/dreams/jobs/${jobId}`);
    if (res.status === 200) {
      const status = res.body?.job?.status;
      if (status === 'completed' || status === 'failed') {
        return res.body;
      }
    }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach terminal status within ${timeoutMs}ms`);
}

describe('API Bug Fixes & Edge Case Integration Tests (Supertest)', () => {
  let appInstance: ReturnType<typeof createApp>;
  let ledger: CreditLedger;
  let tempStorageDir: string;
  const originalStorageDir = process.env.STORAGE_DIR;

  beforeEach(() => {
    const SERVER_ROOT = path.resolve(__dirname, '..');
    const FIXTURES_DIR = path.join(SERVER_ROOT, 'fixtures');
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-api-bugs-'));
    process.env.STORAGE_DIR = tempStorageDir;

    const architect = new MockDreamArchitect();
    const provider = new MockDreamProvider(
      'http://127.0.0.1:5000',
      path.join(tempStorageDir, 'videos'),
      path.join(tempStorageDir, 'keyframes'),
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

  afterEach(async () => {
    await appInstance.dreamQueue.close();
    if (originalStorageDir === undefined) {
      delete process.env.STORAGE_DIR;
    } else {
      process.env.STORAGE_DIR = originalStorageDir;
    }
    fs.rmSync(tempStorageDir, { recursive: true, force: true });
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

      // Generate keyframes for both scenes and wait for actual job completion
      const kf1 = await request(appInstance.app).post('/api/dreams/keyframes').send({ dreamId, sceneNumber: 1, count: 1 }).expect(202);
      const kf2 = await request(appInstance.app).post('/api/dreams/keyframes').send({ dreamId, sceneNumber: 2, count: 1 }).expect(202);
      const kf1Done = await waitForJobCompletion(appInstance.app, kf1.body.jobId, 15000);
      const kf2Done = await waitForJobCompletion(appInstance.app, kf2.body.jobId, 15000);
      expect(kf1Done.job.status).toBe('completed');
      expect(kf2Done.job.status).toBe('completed');

      const sessionAfterKf = await request(appInstance.app).get(`/api/dreams/session/${dreamId}`).expect(200);
      const kfId1 = sessionAfterKf.body.session.scenes[0].keyframes[0].id;
      const kfId2 = sessionAfterKf.body.session.scenes[1].keyframes[0].id;

      // Queue video for Scene 1 and wait for actual job completion
      const v1 = await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({ dreamId, sceneNumber: 1, keyframeId: kfId1 })
        .expect(202);
      const v1Done = await waitForJobCompletion(appInstance.app, v1.body.jobId, 15000);
      expect(v1Done.job.status).toBe('completed');

      const afterV1Session = await request(appInstance.app).get(`/api/dreams/session/${dreamId}`).expect(200);
      expect(afterV1Session.body.session.scenes[0].status).toBe('completed');
      expect(ledger.getBalance('usr_demo_101')).toEqual({
        credits: 9,
        reservedCredits: 0,
        availableCredits: 9
      });

      // Queue video for Scene 2 and wait for actual job completion
      const v2 = await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({ dreamId, sceneNumber: 2, keyframeId: kfId2 })
        .expect(202);
      const v2Done = await waitForJobCompletion(appInstance.app, v2.body.jobId, 15000);
      expect(v2Done.job.status).toBe('completed');

      // Both scenes committed -> exactly 2 credits deducted (Remaining: 8)
      expect(ledger.getBalance('usr_demo_101')).toEqual({
        credits: 8,
        reservedCredits: 0,
        availableCredits: 8
      });

      const afterV2Session = await request(appInstance.app).get(`/api/dreams/session/${dreamId}`).expect(200);
      const stitchJobId = afterV2Session.body.session.stitchJobId as string | undefined;
      expect(afterV2Session.body.session.scenes[0].status).toBe('completed');
      expect(afterV2Session.body.session.scenes[1].status).toBe('completed');
      expect(stitchJobId).toBeDefined();
      expect(['stitching_queued', 'stitching', 'completed']).toContain(afterV2Session.body.session.status);

      // Poll real FFmpeg stitch job until it reaches terminal completed state
      const stitchDone = await waitForJobCompletion(appInstance.app, stitchJobId!, 20000);
      expect(stitchDone.job.status).toBe('completed');

      const completedSession = await request(appInstance.app).get(`/api/dreams/session/${dreamId}`).expect(200);
      expect(completedSession.body.session.status).toBe('completed');
      expect(completedSession.body.session.video?.isStitched).toBe(true);

      // Re-stitch endpoint should run and complete without spending credits (await completion so no FFmpeg lingers)
      const stitchRes = await request(appInstance.app)
        .post('/api/dreams/stitch')
        .send({ dreamId })
        .expect(202);

      expect(stitchRes.body.jobId).toMatch(/^stitch_/);
      const reStitchDone = await waitForJobCompletion(appInstance.app, stitchRes.body.jobId, 20000);
      expect(reStitchDone.job.status).toBe('completed');
      expect(ledger.getBalance('usr_demo_101').credits).toBe(8);
      expect(ledger.getBalance('usr_demo_101').reservedCredits).toBe(0);
    }, 30000);

    it('should preserve completed scenes and credits when stitch fails and allow free re-stitch recovery', async () => {
      const SERVER_ROOT = path.resolve(__dirname, '..');
      const fixtureVid = path.join(SERVER_ROOT, 'fixtures', 'mock_video.mp4');

      const analyzeRes = await request(appInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Kristal mağara || Yıldızlı çöl' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;

      const kf1 = await request(appInstance.app).post('/api/dreams/keyframes').send({ dreamId, sceneNumber: 1, count: 1 }).expect(202);
      const kf2 = await request(appInstance.app).post('/api/dreams/keyframes').send({ dreamId, sceneNumber: 2, count: 1 }).expect(202);
      await waitForJobCompletion(appInstance.app, kf1.body.jobId, 15000);
      await waitForJobCompletion(appInstance.app, kf2.body.jobId, 15000);

      const sessionAfterKf = await request(appInstance.app).get(`/api/dreams/session/${dreamId}`).expect(200);
      const kfId1 = sessionAfterKf.body.session.scenes[0].keyframes[0].id;
      const kfId2 = sessionAfterKf.body.session.scenes[1].keyframes[0].id;

      // Render Scene 1, then remove its clip from disk so auto-stitch fails deterministically
      const v1 = await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({ dreamId, sceneNumber: 1, keyframeId: kfId1 })
        .expect(202);
      const v1Done = await waitForJobCompletion(appInstance.app, v1.body.jobId, 15000);
      expect(v1Done.job.status).toBe('completed');

      const scene1VideoFilename = path.basename(v1Done.video.videoUrl);
      const scene1VideoPath = path.join(tempStorageDir, 'videos', scene1VideoFilename);
      fs.unlinkSync(scene1VideoPath);

      // Render Scene 2 -> auto-stitch fails, but both scenes and 8 credits remain intact
      const v2 = await request(appInstance.app)
        .post('/api/dreams/generate-video')
        .send({ dreamId, sceneNumber: 2, keyframeId: kfId2 })
        .expect(202);
      await waitForJobCompletion(appInstance.app, v2.body.jobId, 15000);

      const preFailSession = await request(appInstance.app).get(`/api/dreams/session/${dreamId}`).expect(200);
      const failedStitchDone = await waitForJobCompletion(appInstance.app, preFailSession.body.session.stitchJobId, 20000);
      expect(failedStitchDone.job.status).toBe('failed');

      const failedSession = await request(appInstance.app).get(`/api/dreams/session/${dreamId}`).expect(200);
      expect(failedSession.body.session.status).toBe('stitch_failed');
      expect(failedSession.body.session.scenes[0].status).toBe('completed');
      expect(failedSession.body.session.scenes[1].status).toBe('completed');
      expect(ledger.getBalance('usr_demo_101')).toEqual({
        credits: 8,
        reservedCredits: 0,
        availableCredits: 8
      });

      // Restore missing clip and trigger free re-stitch
      fs.copyFileSync(fixtureVid, scene1VideoPath);
      const recoveryRes = await request(appInstance.app)
        .post('/api/dreams/stitch')
        .send({ dreamId })
        .expect(202);

      const recoveryDone = await waitForJobCompletion(appInstance.app, recoveryRes.body.jobId, 20000);
      expect(recoveryDone.job.status).toBe('completed');

      const recoveredSession = await request(appInstance.app).get(`/api/dreams/session/${dreamId}`).expect(200);
      expect(recoveredSession.body.session.status).toBe('completed');
      expect(recoveredSession.body.session.video?.isStitched).toBe(true);
      expect(ledger.getBalance('usr_demo_101')).toEqual({
        credits: 8,
        reservedCredits: 0,
        availableCredits: 8
      });
    }, 30000);
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
      const videoRes = await request(appInstance.app)
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

      // Wait for background video job to finish before afterEach cleans up tempStorageDir
      const videoDone = await waitForJobCompletion(appInstance.app, videoRes.body.jobId, 15000);
      expect(videoDone.job.status).toBe('completed');
    });
  });

  describe('Architect Concurrency Lock & Single-Scene Synthesis (Race Conditions & Post-LLM Moderation)', () => {
    let delayedAppInstance: ReturnType<typeof createApp>;
    let delayedLedger: CreditLedger;

    beforeEach(() => {
      const SERVER_ROOT = path.resolve(__dirname, '..');
      const FIXTURES_DIR = path.join(SERVER_ROOT, 'fixtures');
      // Mock architect with 80ms delay to reliably test concurrency race conditions
      const delayedArchitect = new MockDreamArchitect(80);
      const provider = new MockDreamProvider(
        'http://127.0.0.1:5000',
        path.join(tempStorageDir, 'videos'),
        path.join(tempStorageDir, 'keyframes'),
        FIXTURES_DIR,
        delayedArchitect
      );
      delayedLedger = new CreditLedger({
        'usr_demo_101': { credits: 10, reservedCredits: 0 }
      });

      delayedAppInstance = createApp({
        dreamProvider: provider,
        dreamArchitect: delayedArchitect,
        creditLedger: delayedLedger,
        queueDriver: 'memory',
        transitionSeconds: 0.3
      });
    });

    afterEach(async () => {
      await delayedAppInstance.dreamQueue.close();
    });

    it('should reject concurrent split requests with 409 DREAM_BUSY to prevent race conditions', async () => {
      const analyzeRes = await request(delayedAppInstance.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Sakin bir göl kenarı' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const sceneId = analyzeRes.body.data.scenes[0].sceneId;

      // Fire two concurrent split requests simultaneously
      const [resA, resB] = await Promise.all([
        request(delayedAppInstance.app)
          .post(`/api/dreams/session/${dreamId}/scenes/${sceneId}/split`)
          .send({ newSceneText: 'Sisli dağ zirvesi' }),
        request(delayedAppInstance.app)
          .post(`/api/dreams/session/${dreamId}/scenes/${sceneId}/split`)
          .send({ newSceneText: 'Karanlık orman patikası' })
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = resA.status === 409 ? resA : resB;
      expect(conflictRes.body.error).toBe('DREAM_BUSY');

      const session = delayedAppInstance.dreamSessions.get(dreamId);
      // Since one succeeded and one was blocked by lock, scenes must be 2, not 3
      expect(session?.scenes.length).toBe(2);
      expect(session?.isArchitectBusy).toBe(false);
    });

    it('should reject video generation with 409 DREAM_BUSY while Architect is editing/synthesizing', async () => {
      const SERVER_ROOT = path.resolve(__dirname, '..');
      const FIXTURES_DIR = path.join(SERVER_ROOT, 'fixtures');

      let markSplitEntered!: () => void;
      const splitEntered = new Promise<void>(resolve => {
        markSplitEntered = resolve;
      });
      let releaseSplit!: () => void;
      const splitCanFinish = new Promise<void>(resolve => {
        releaseSplit = resolve;
      });

      const barrierArchitect = new MockDreamArchitect(0);
      const originalSynthesize = barrierArchitect.synthesizeSingleScene.bind(barrierArchitect);
      barrierArchitect.synthesizeSingleScene = async (narrative, moodHint) => {
        markSplitEntered();
        await splitCanFinish;
        return originalSynthesize(narrative, moodHint);
      };

      const barrierApp = createApp({
        dreamProvider: new MockDreamProvider(
          'http://127.0.0.1:5000',
          path.join(tempStorageDir, 'videos'),
          path.join(tempStorageDir, 'keyframes'),
          FIXTURES_DIR,
          barrierArchitect
        ),
        dreamArchitect: barrierArchitect,
        creditLedger: new CreditLedger({ usr_demo_101: { credits: 10, reservedCredits: 0 } }),
        queueDriver: 'memory',
        transitionSeconds: 0.3
      });

      const analyzeRes = await request(barrierApp.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Sakin bir sahil' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const sceneId = analyzeRes.body.data.scenes[0].sceneId;

      // Generate keyframe first so scene has a valid keyframe
      const kfRes = await request(barrierApp.app)
        .post('/api/dreams/keyframes')
        .send({ dreamId, sceneId, count: 1 })
        .expect(202);
      await waitForJobCompletion(barrierApp.app, kfRes.body.jobId, 15000);

      const session = barrierApp.dreamSessions.get(dreamId);
      const kfId = session!.scenes[0].keyframes![0].id;

      // Start split immediately (.then triggers Supertest request execution) and wait until Architect holds the lock
      const splitPromise = request(barrierApp.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${sceneId}/split`)
        .send({ newSceneText: 'Güneş batımı' })
        .then(res => res);

      let videoRes!: request.Response;
      let splitRes!: request.Response;
      try {
        await splitEntered;
        videoRes = await request(barrierApp.app)
          .post('/api/dreams/generate-video')
          .send({ dreamId, sceneId, keyframeId: kfId });
      } finally {
        releaseSplit();
        splitRes = await splitPromise;
        await barrierApp.dreamQueue.close();
      }

      expect(splitRes.status).toBe(200);
      expect(videoRes.status).toBe(409);
      expect(videoRes.body.error).toBe('DREAM_BUSY');
      expect(session?.isArchitectBusy).toBe(false);
    });

    it('should reject merge reanalyze when post-LLM prompt audit detects prohibited content', async () => {
      const customArchitect = new MockDreamArchitect();
      customArchitect.synthesizeSingleScene = async () => ({
        safety: { allowed: true, category: null },
        scenes: [{
          sceneNumber: 1,
          summary: 'Karanlık kule',
          mood: 'DARK_SURREAL',
          keyframePrompt: 'A gothic castle with çıplak figures in the shadows', // flagged word: çıplak
          motionPrompt: 'Camera tracking forward through the hall',
          cameraMotion: 'Pan forward'
        }]
      });

      const SERVER_ROOT = path.resolve(__dirname, '..');
      const customApp = createApp({
        dreamProvider: new MockDreamProvider(
          'http://127.0.0.1:5000',
          path.join(tempStorageDir, 'videos'),
          path.join(tempStorageDir, 'keyframes'),
          path.join(SERVER_ROOT, 'fixtures'),
          customArchitect
        ),
        dreamArchitect: customArchitect,
        creditLedger: new CreditLedger({ 'usr_demo_101': { credits: 10, reservedCredits: 0 } }),
        queueDriver: 'memory',
        transitionSeconds: 0.3
      });

      const analyzeRes = await request(customApp.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Denizde yüzüyordum || sisli bir ada' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const scenes = analyzeRes.body.data.scenes;
      expect(scenes.length).toBe(2);

      // Attempt merge with reanalyze -> post-LLM moderation audit MUST catch the flagged keyframe prompt
      const mergeRes = await request(customApp.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${scenes[0].sceneId}/merge`)
        .send({ targetSceneId: scenes[1].sceneId, strategy: 'reanalyze' })
        .expect(400);

      expect(mergeRes.body.error).toBe('MODERATION_REJECTED');
      expect(mergeRes.body.categories).toContain('NSFW_OR_ADULT');

      // Verify session was NOT corrupted and scenes remain 2
      const session = customApp.dreamSessions.get(dreamId);
      expect(session?.scenes.length).toBe(2);
      expect(session?.isArchitectBusy).toBe(false);
    });

    it('should fail with explicit error if architect returns multiple scenes during single-scene synthesis', async () => {
      const multiSceneArchitect = new MockDreamArchitect();
      multiSceneArchitect.synthesizeSingleScene = async () => ({
        safety: { allowed: true, category: null },
        scenes: [
          {
            sceneNumber: 1,
            summary: 'Scene 1',
            mood: 'ETHEREAL_LUCID',
            keyframePrompt: 'Keyframe 1',
            motionPrompt: 'Motion 1',
            cameraMotion: 'Pan'
          },
          {
            sceneNumber: 2,
            summary: 'Scene 2',
            mood: 'ETHEREAL_LUCID',
            keyframePrompt: 'Keyframe 2',
            motionPrompt: 'Motion 2',
            cameraMotion: 'Pan'
          }
        ]
      });

      const SERVER_ROOT = path.resolve(__dirname, '..');
      const customApp = createApp({
        dreamProvider: new MockDreamProvider(
          'http://127.0.0.1:5000',
          path.join(tempStorageDir, 'videos'),
          path.join(tempStorageDir, 'keyframes'),
          path.join(SERVER_ROOT, 'fixtures'),
          multiSceneArchitect
        ),
        dreamArchitect: multiSceneArchitect,
        creditLedger: new CreditLedger({ 'usr_demo_101': { credits: 10, reservedCredits: 0 } }),
        queueDriver: 'memory',
        transitionSeconds: 0.3
      });

      const analyzeRes = await request(customApp.app)
        .post('/api/dreams/analyze')
        .send({ rawDreamText: 'Deniz || Orman' })
        .expect(200);

      const dreamId = analyzeRes.body.dreamId;
      const scenes = analyzeRes.body.data.scenes;

      // 1. Merge must fail if architect returns 2 scenes
      const mergeRes = await request(customApp.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${scenes[0].sceneId}/merge`)
        .send({ targetSceneId: scenes[1].sceneId, strategy: 'reanalyze' })
        .expect(400);

      expect(mergeRes.body.error).toBe('MERGE_FAILED');

      // 2. Split must fail if architect returns 2 scenes
      const splitRes = await request(customApp.app)
        .post(`/api/dreams/session/${dreamId}/scenes/${scenes[0].sceneId}/split`)
        .send({ newSceneText: 'Deniz ve orman' })
        .expect(400);

      expect(splitRes.body.error).toBe('SPLIT_FAILED');
    });
  });
});
