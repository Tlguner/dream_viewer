import assert from 'node:assert/strict';

const BASE_URL = process.env.API_BASE || 'http://127.0.0.1:5000/api';

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

  // 5. Keyframes Generation with Server-Locked Session
  console.log('\nTest 5: Keyframe generation requiring valid dreamId & verifying mock status');
  
  // 5a: Missing / invalid dreamId must return 404
  const badKfRes = await fetch(`${BASE_URL}/dreams/keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId: 'non_existent_session_123', count: 3 })
  });
  assert.strictEqual(badKfRes.status, 404, 'Invalid dreamId must return 404');
  console.log('  ✓ Passed: Invalid dreamId correctly rejected with 404');

  // 5b: Valid dreamId produces keyframes
  const goodKfRes = await fetch(`${BASE_URL}/dreams/keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dreamId, count: 3 })
  });
  assert.strictEqual(goodKfRes.status, 200);
  const kfData = await goodKfRes.json();
  assert.strictEqual(kfData.keyframes.length, 3, 'Must return exactly 3 keyframes');

  // In Comfy mode: ALL 3 keyframes MUST have isMock === false (no Unsplash stock photo fallback!)
  if (!health.isMock) {
    const allReal = kfData.keyframes.every((k) => k.isMock === false);
    assert.strictEqual(allReal, true, 'CRITICAL: In comfy mode, ALL 3 keyframes must be real GPU generated (isMock === false)!');
    console.log('  ✓ Passed: All 3 keyframes are 100% genuine GPU outputs (isMock === false on all items)');
  } else {
    console.log('  ✓ Passed: Keyframes returned in mock mode with honest isMock=true');
  }

  // Verify keyframes are served by our media server
  const kfMediaRes = await fetch(kfData.keyframes[0].imageUrl);
  assert.strictEqual(kfMediaRes.status, 200, 'Keyframe image must be accessible via media endpoint');
  console.log(`  ✓ Passed: Keyframe image endpoint returns 200 OK (${kfData.keyframes[0].imageUrl})`);

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

  // 7. Concurrency & Double-Click Lock (409 Conflict on duplicate generation requests)
  console.log('\nTest 7: Concurrency & Double-Click Lock (409 Conflict on simultaneous requests)');
  const [req1, req2] = await Promise.all([
    fetch(`${BASE_URL}/dreams/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dreamId, keyframeId: kfData.keyframes[0].id, dreamTitle: 'Race Test 1' })
    }),
    fetch(`${BASE_URL}/dreams/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dreamId, keyframeId: kfData.keyframes[0].id, dreamTitle: 'Race Test 2' })
    })
  ]);

  const statuses = [req1.status, req2.status];
  assert(
    statuses.includes(409) || statuses.includes(429),
    `Concurrent requests on same session must reject duplicate with 409 Conflict or 429 GPU Busy. Received: ${statuses.join(', ')}`
  );
  console.log(`  ✓ Passed: Duplicate simultaneous generation request was safely blocked with 409/429 (Statuses: ${statuses.join(', ')})`);

  // 8. Credit Integrity on Failure / Execution
  console.log('\nTest 8: Credit deduction semantics');
  const profileAfterCalls = await (await fetch(`${BASE_URL}/user/profile`)).json();
  // One generation was either running or completed, or rejected; credits must be >= 9
  assert(profileAfterCalls.credits <= initialCredits, 'Credits cannot increase');
  assert(profileAfterCalls.credits >= initialCredits - 1, 'Credits cannot decrease by more than 1');
  console.log(`  ✓ Passed: Credits maintained safely (${profileAfterCalls.credits} credits remaining)`);

  console.log('\n======================================================');
  console.log('🎉 ALL ASSERTIONS PASSED! DREAM VIEWER BACKEND VERIFIED.');
  console.log('======================================================\n');
}

runApiVerification().catch(err => {
  console.error('\n❌ ASSERTION FAILED:', err);
  process.exit(1);
});
