import assert from 'node:assert/strict';

const BASE_URL = process.env.API_BASE || 'http://127.0.0.1:5000/api';

/**
 * Resilient poller for asynchronous GPU queue jobs
 */
async function pollJob(jobId, maxWaitMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${BASE_URL}/dreams/jobs/${jobId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.job?.status === 'completed' || data.job?.status === 'failed') {
        return data;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Job ${jobId} did not complete within ${maxWaitMs}ms`);
}

async function runApiVerification() {
  console.log(`\n======================================================`);
  console.log(`🧪 STARTING DREAM VIEWER RIGOROUS API VERIFICATION`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`======================================================\n`);

  // 1. Health Check
  console.log('Test 1: Health check endpoint verification');
  const healthRes = await fetch(`${BASE_URL}/health`);
  assert.strictEqual(healthRes.status, 200, 'Health check must return 200 OK');
  const health = await healthRes.json();
  assert.strictEqual(health.status, 'online', 'Status must be online');
  assert.strictEqual(typeof health.provider, 'string', 'Provider name must be string');
  assert.strictEqual(typeof health.isMock, 'boolean', 'isMock must be boolean');
  assert.strictEqual(typeof health.isGpuBusy, 'boolean', 'isGpuBusy must be boolean');
  console.log(`  ✓ Passed: Provider=${health.provider}, isMock=${health.isMock}, isGpuBusy=${health.isGpuBusy}`);

  // 2. User Profile & Credits
  console.log('\nTest 2: User profile & initial credit verification');
  const userRes = await fetch(`${BASE_URL}/user/profile`);
  assert.strictEqual(userRes.status, 200);
  const user = await userRes.json();
  assert.strictEqual(typeof user.credits, 'number');
  const initialCredits = user.credits;
  console.log(`  ✓ Passed: Demo user=${user.username}, credits=${initialCredits}`);

  // 3. Moderation Shield: Unicode Turkish & False-Positive Tests
  console.log('\nTest 3: Moderation Shield Unicode & False-Positive Precision');
  
  // 3a: Turkish "çıplak" must be blocked
  const trNsfwRes = await fetch(`${BASE_URL}/dreams/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'rüyamda kendimi çıplak gördüm gökyüzünde uçuyordum',
      moodHint: 'ETHEREAL_LUCID'
    })
  });
  assert.strictEqual(trNsfwRes.status, 400, 'Turkish "çıplak" must be blocked');
  const trNsfwData = await trNsfwRes.json();
  assert.strictEqual(trNsfwData.error, 'MODERATION_REJECTED');
  console.log('  ✓ Passed: Turkish Unicode "çıplak" correctly rejected');

  // 3b: English "I got lost in the forest" must PASS (not blocked by "got")
  const gotTestRes = await fetch(`${BASE_URL}/dreams/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'I got lost in the forest with luminous glowing trees',
      moodHint: 'NOSTALGIC_FOG'
    })
  });
  assert.strictEqual(gotTestRes.status, 200, '"I got lost in the forest" must NOT be blocked');
  console.log('  ✓ Passed: "I got lost in the forest" permitted (no false positive on "got")');

  // 3c: Turkish "bir meme gördüm" must PASS (internet culture meme, not anatomy)
  const memeTestRes = await fetch(`${BASE_URL}/dreams/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'internette komik bir meme gördüm rüyamda tekrar etti',
      moodHint: 'SURREAL_CYBERPUNK'
    })
  });
  assert.strictEqual(memeTestRes.status, 200, '"bir meme gördüm" must NOT be blocked');
  console.log('  ✓ Passed: "bir meme gördüm" permitted (no false positive on "meme")');

  // 3d: Atmospheric nightmare words (blood/kan) permitted for moody dreams
  const bloodTestRes = await fetch(`${BASE_URL}/dreams/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'A deep blood red crimson moon rising above a misty lake',
      moodHint: 'ETHEREAL_LUCID'
    })
  });
  assert.strictEqual(bloodTestRes.status, 200, 'Atmospheric color "blood red" must NOT be blocked');
  console.log('  ✓ Passed: Atmospheric color "blood red" permitted');

  // 4. Session Creation & Dream Analysis
  console.log('\nTest 4: Stateful dream session creation & prompt locking');
  const dreamRes = await fetch(`${BASE_URL}/dreams/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'Floating crystal sanctuary over deep amethyst clouds in starlight',
      moodHint: 'ETHEREAL_LUCID'
    })
  });
  assert.strictEqual(dreamRes.status, 200);
  const dreamData = await dreamRes.json();
  assert(dreamData.dreamId, 'Server must return a locked dreamId');
  assert(dreamData.data.refinedPrompt, 'Server must return refinedPrompt');
  assert(Array.isArray(dreamData.data.scenes), 'Server must return scenes array');
  assert(dreamData.data.scenes.length >= 1 && dreamData.data.scenes.length <= 3, 'Scenes count must be 1 to 3');
  assert(typeof dreamData.data.totalEstimatedSeconds === 'number', 'totalEstimatedSeconds must be number');
  const sc1 = dreamData.data.scenes[0];
  assert(sc1.sceneNumber === 1, 'First scene number must be 1');
  assert(typeof sc1.summary === 'string' && sc1.summary.length > 0, 'Scene summary required');
  assert(typeof sc1.keyframePrompt === 'string' && sc1.keyframePrompt.length > 0, 'Scene keyframePrompt required');
  assert(typeof sc1.motionPrompt === 'string' && sc1.motionPrompt.length > 0, 'Scene motionPrompt required');
  console.log(`  ✓ Passed: Dream Architect returned ${dreamData.data.scenes.length} structured scene(s) with ${dreamData.data.totalEstimatedSeconds}s estimated`);

  // 4a-2: Multi-scene spatial transition test with deterministic || delimiter
  const multiSceneRes = await fetch(`${BASE_URL}/dreams/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'Derin sularda yüzüyordum || Sisli bir çam ormanında buldum',
      moodHint: 'DEEP_OCEAN'
    })
  });
  assert.strictEqual(multiSceneRes.status, 200);
  const multiData = await multiSceneRes.json();
  assert.strictEqual(multiData.data.scenes.length, 2, 'Must decompose Ocean -> Forest transition into exactly 2 scenes');
  assert.strictEqual(multiData.data.scenes[0].sceneNumber, 1);
  assert.strictEqual(multiData.data.scenes[1].sceneNumber, 2);
  console.log(`  ✓ Passed: Spatial transition (Ocean -> Forest) accurately decomposed into 2 distinct scenes`);

  const dreamId = dreamData.dreamId;
  console.log(`  ✓ Passed: Session created with dreamId=${dreamId}`);

  // 4b: SSE Live Progress Endpoint verification
  const progressRes = await fetch(`${BASE_URL}/dreams/progress/${dreamId}`);
  assert.strictEqual(progressRes.status, 200, 'SSE endpoint must return 200 OK');
  assert(progressRes.headers.get('content-type')?.includes('text/event-stream'), 'Must serve text/event-stream');
  console.log('  ✓ Passed: SSE Live Progress endpoint returns 200 with text/event-stream header');

  // 4c: SSE endpoint with non-existent session must return 404
  const badProgressRes = await fetch(`${BASE_URL}/dreams/progress/non_existent_session`);
  assert.strictEqual(badProgressRes.status, 404, 'SSE endpoint must return 404 for invalid dreamId');
  console.log('  ✓ Passed: SSE Live Progress endpoint rejects invalid dreamId with 404');

  // 5. Keyframes Generation via Unified Asynchronous 202 Queue
  console.log('\nTest 5: Asynchronous Keyframe Generation (HTTP 202 Accepted + Queue Polling)');
  
  // 5a: Missing / invalid dreamId must return 404
  const badKfRes = await fetch(`${BASE_URL}/dreams/keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: 'non_existent_session_123', count: 3 })
  });
  assert.strictEqual(badKfRes.status, 404, 'Invalid dreamId must return 404');
  console.log('  ✓ Passed: Invalid dreamId correctly rejected with 404');

  // 5b: Valid dreamId produces keyframes asynchronously (202 Accepted + Job Polling)
  const goodKfRes = await fetch(`${BASE_URL}/dreams/keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId, sceneNumber: 1, count: 3 })
  });
  assert.strictEqual(goodKfRes.status, 202, 'Keyframes endpoint must return 202 Accepted');
  const kfInit = await goodKfRes.json();
  assert(kfInit.jobId, 'Keyframes endpoint must return jobId');
  assert.strictEqual(kfInit.status, 'queued');

  // Poll until worker finishes keyframes on GPU
  const kfJobResult = await pollJob(kfInit.jobId);
  assert.strictEqual(kfJobResult.job.status, 'completed');
  const keyframes = kfJobResult.keyframes || kfJobResult.job.keyframes;
  assert(Array.isArray(keyframes) && keyframes.length === 3, 'Must return exactly 3 keyframes');

  // In Comfy mode: ALL 3 keyframes MUST have isMock === false (no Unsplash stock photo fallback!)
  if (!health.isMock) {
    const allReal = keyframes.every((k) => k.isMock === false);
    assert.strictEqual(allReal, true, 'CRITICAL: In comfy mode, ALL 3 keyframes must be real GPU generated (isMock === false)!');
    console.log('  ✓ Passed: All 3 keyframes are 100% genuine GPU outputs (isMock === false on all items)');
  } else {
    console.log('  ✓ Passed: Keyframes returned in mock mode with honest isMock=true');
  }

  // Verify keyframes are served by our media server
  const kfMediaRes = await fetch(keyframes[0].imageUrl);
  assert.strictEqual(kfMediaRes.status, 200, 'Keyframe image must be accessible via media endpoint');
  console.log(`  ✓ Passed: Keyframe image endpoint returns 200 OK (${keyframes[0].imageUrl})`);

  // 6. Security & SSRF Protection: Arbitrary Keyframe ID Rejected
  console.log('\nTest 6: SSRF & tampering rejection with unapproved keyframe ID');
  const fakeKfVideoRes = await fetch(`${BASE_URL}/dreams/generate-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dreamId,
      keyframeId: 'arbitrary_tampered_id',
      dreamTitle: 'Tampered Dream'
    })
  });
  assert.strictEqual(fakeKfVideoRes.status, 400, 'Unapproved keyframe ID must return 400');
  console.log('  ✓ Passed: Unapproved keyframe ID rejected');

  // 7. Concurrency & Double-Click Lock (409 Conflict on simultaneous requests)
  console.log('\nTest 7: Concurrency & Double-Click Lock (409 Conflict on simultaneous requests)');
  const [req1, req2] = await Promise.all([
    fetch(`${BASE_URL}/dreams/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dreamId, sceneNumber: 1, keyframeId: keyframes[0].id, dreamTitle: 'Race Test 1' })
    }),
    fetch(`${BASE_URL}/dreams/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dreamId, sceneNumber: 1, keyframeId: keyframes[0].id, dreamTitle: 'Race Test 2' })
    })
  ]);

  const statuses = [req1.status, req2.status];
  assert(
    statuses.includes(409) || statuses.includes(429),
    `Concurrent requests on same session must reject duplicate with 409 Conflict or 429 GPU Busy. Received: ${statuses.join(', ')}`
  );
  console.log(`  ✓ Passed: Duplicate simultaneous generation request was safely blocked with 409/429 (Statuses: ${statuses.join(', ')})`);

  // Let the accepted job finish
  const acceptedReq = req1.status === 202 ? req1 : (req2.status === 202 ? req2 : null);
  if (acceptedReq) {
    const acceptedData = await acceptedReq.json();
    await pollJob(acceptedData.jobId);
  }

  // 8. Credit Integrity on Single Scene
  console.log('\nTest 8: Credit deduction semantics for single scene');
  const profileAfterCalls = await (await fetch(`${BASE_URL}/user/profile`)).json();
  assert(profileAfterCalls.credits <= initialCredits, 'Credits cannot increase');
  assert(profileAfterCalls.credits >= initialCredits - 1, 'Credits cannot decrease by more than 1');
  console.log(`  ✓ Passed: Credits maintained safely (${profileAfterCalls.credits} credits remaining)`);

  // 9. Phase 3: Multi-Scene End-to-End Pipeline with FFmpeg Crossfade Stitching
  console.log('\nTest 9: Phase 3 Multi-Scene End-to-End Pipeline with FFmpeg Crossfade Stitching');
  const multiDreamRes = await fetch(`${BASE_URL}/dreams/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'Antik mermer tapınakta yürüyüş || Kristal yeraltı mağarasında süzülüş',
      moodHint: 'GOLDEN_DREAM'
    })
  });
  assert.strictEqual(multiDreamRes.status, 200);
  const multiDreamData = await multiDreamRes.json();
  const multiDreamId = multiDreamData.dreamId;
  assert.strictEqual(multiDreamData.data.scenes.length, 2, 'Must have 2 scenes');

  // Queue keyframes for Scene 1 (202 Accepted + poll)
  const kf1Res = await fetch(`${BASE_URL}/dreams/keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: multiDreamId, sceneNumber: 1, count: 2 })
  });
  assert.strictEqual(kf1Res.status, 202);
  const kf1Init = await kf1Res.json();
  const kf1Result = await pollJob(kf1Init.jobId);
  assert.strictEqual(kf1Result.job.status, 'completed');
  const scene1Keyframes = kf1Result.keyframes || kf1Result.job.keyframes;

  // Queue keyframes for Scene 2 (202 Accepted + poll)
  const kf2Res = await fetch(`${BASE_URL}/dreams/keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: multiDreamId, sceneNumber: 2, count: 2 })
  });
  assert.strictEqual(kf2Res.status, 202);
  const kf2Init = await kf2Res.json();
  const kf2Result = await pollJob(kf2Init.jobId);
  assert.strictEqual(kf2Result.job.status, 'completed');
  const scene2Keyframes = kf2Result.keyframes || kf2Result.job.keyframes;

  console.log('  ✓ Passed: Both scene keyframes generated asynchronously via unified GPU queue');

  const creditsBeforeMultiVideo = (await (await fetch(`${BASE_URL}/user/profile`)).json()).credits;

  // Queue video for Scene 1 (reserves 1 credit)
  const vid1Res = await fetch(`${BASE_URL}/dreams/generate-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: multiDreamId, sceneNumber: 1, keyframeId: scene1Keyframes[0].id })
  });
  assert.strictEqual(vid1Res.status, 202);
  const vid1Init = await vid1Res.json();

  // Queue video for Scene 2 (reserves 1 credit)
  const vid2Res = await fetch(`${BASE_URL}/dreams/generate-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: multiDreamId, sceneNumber: 2, keyframeId: scene2Keyframes[0].id })
  });
  assert.strictEqual(vid2Res.status, 202);
  const vid2Init = await vid2Res.json();

  console.log(`  ✓ Passed: Both scenes enqueued for video synthesis (Jobs: ${vid1Init.jobId}, ${vid2Init.jobId})`);

  // Wait for both worker jobs to complete in FIFO order
  await pollJob(vid1Init.jobId);
  const vid2Result = await pollJob(vid2Init.jobId);
  assert.strictEqual(vid2Result.job.status, 'completed');

  // Verify session has final stitched video
  const sessionRes = await fetch(`${BASE_URL}/dreams/session/${multiDreamId}`);
  assert.strictEqual(sessionRes.status, 200);
  const sessionData = await sessionRes.json();
  const session = sessionData.session;

  assert.strictEqual(session.scenes[0].status, 'completed', 'Scene 1 must be completed');
  assert.strictEqual(session.scenes[1].status, 'completed', 'Scene 2 must be completed');
  assert.strictEqual(session.status, 'completed', 'Dream session must be marked completed');
  assert(session.video, 'Session must have final video');
  assert.strictEqual(session.video.isStitched, true, 'Multi-scene dream must be stitched via FFmpeg');
  assert(session.video.durationSeconds > 0, 'Stitched video must have non-zero duration');

  // Verify stitched video is served via media endpoint
  const stitchedMediaRes = await fetch(session.video.videoUrl);
  assert.strictEqual(stitchedMediaRes.status, 200, 'Stitched video must be downloadable from media endpoint');
  console.log(`  ✓ Passed: FFmpeg stitched video successfully generated and served (${session.video.videoUrl}, duration=${session.video.durationSeconds}s)`);

  const creditsAfterMultiVideo = (await (await fetch(`${BASE_URL}/user/profile`)).json()).credits;
  assert.strictEqual(creditsAfterMultiVideo, creditsBeforeMultiVideo - 2, 'Exactly 2 credits must be deducted for 2 scenes');
  console.log(`  ✓ Passed: Exactly 2 credits deducted for 2 completed scenes (Remaining: ${creditsAfterMultiVideo})`);

  // 10. Phase 3: Partial Failure & Per-Scene Credit Refund Isolation
  console.log('\nTest 10: Phase 3 Per-Scene Credit Isolation & Partial Failure Recovery');
  const failDreamRes = await fetch(`${BASE_URL}/dreams/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'Huzurlu lavanta tarlası || fail_scene girdap beni yuttu',
      moodHint: 'ETHEREAL_LUCID'
    })
  });
  const failDreamData = await failDreamRes.json();
  const failDreamId = failDreamData.dreamId;
  assert.strictEqual(failDreamData.data.scenes.length, 2);

  // Generate keyframes for both scenes
  const kfFail1 = await (await fetch(`${BASE_URL}/dreams/keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: failDreamId, sceneNumber: 1, count: 1 })
  })).json();
  const kfFail1Result = await pollJob(kfFail1.jobId);
  const failScene1Kf = kfFail1Result.keyframes || kfFail1Result.job.keyframes;

  const kfFail2 = await (await fetch(`${BASE_URL}/dreams/keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: failDreamId, sceneNumber: 2, count: 1 })
  })).json();
  const kfFail2Result = await pollJob(kfFail2.jobId);
  const failScene2Kf = kfFail2Result.keyframes || kfFail2Result.job.keyframes;

  const creditsBeforeFailTest = (await (await fetch(`${BASE_URL}/user/profile`)).json()).credits;

  // Queue Scene 1 (will succeed)
  const vidFail1 = await (await fetch(`${BASE_URL}/dreams/generate-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: failDreamId, sceneNumber: 1, keyframeId: failScene1Kf[0].id })
  })).json();

  // Queue Scene 2 (will fail because prompt has fail_scene)
  const vidFail2 = await (await fetch(`${BASE_URL}/dreams/generate-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: failDreamId, sceneNumber: 2, keyframeId: failScene2Kf[0].id })
  })).json();

  // Poll Scene 1 (expected to succeed)
  const scene1Job = await pollJob(vidFail1.jobId);
  assert.strictEqual(scene1Job.job.status, 'completed', 'Scene 1 must succeed');

  // Poll Scene 2 (expected to fail)
  const scene2Job = await pollJob(vidFail2.jobId);
  assert.strictEqual(scene2Job.job.status, 'failed', 'Scene 2 must fail due to simulated error');

  console.log('  ✓ Passed: Scene 1 completed successfully while Scene 2 failed gracefully in queue');

  // Check session state
  const failSessionRes = await fetch(`${BASE_URL}/dreams/session/${failDreamId}`);
  const failSession = (await failSessionRes.json()).session;
  assert.strictEqual(failSession.scenes[0].status, 'completed', 'Scene 1 clip must remain saved');
  assert(failSession.scenes[0].video, 'Scene 1 video must be saved');
  assert.strictEqual(failSession.scenes[1].status, 'failed', 'Scene 2 must be marked failed');
  assert(failSession.scenes[1].error, 'Scene 2 must record error message');

  // Check user credits: exactly 1 credit deducted for Scene 1, Scene 2 reserved credit refunded!
  const userProfileAfterFail = await (await fetch(`${BASE_URL}/user/profile`)).json();
  assert.strictEqual(userProfileAfterFail.credits, creditsBeforeFailTest - 1, 'Only 1 credit deducted for successful scene');
  assert.strictEqual(userProfileAfterFail.reservedCredits, 0, 'Reserved credits for failed scene must be completely refunded to 0');
  console.log(`  ✓ Passed: Credit isolation verified - Scene 1 credit finalized, Scene 2 credit refunded (Reserved: 0, Balance: ${userProfileAfterFail.credits})`);

  console.log('\n======================================================');
  console.log('🎉 ALL ASSERTIONS PASSED! DREAM VIEWER BACKEND VERIFIED.');
  console.log('======================================================\n');
}

runApiVerification().catch(err => {
  console.error('\n❌ ASSERTION FAILED:', err);
  process.exit(1);
});
