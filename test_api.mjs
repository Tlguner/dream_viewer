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

  // 5. Keyframes Generation with Server-Locked Session
  console.log('\nTest 5: Keyframe generation requiring valid dreamId');
  
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
  assert.strictEqual(kfData.keyframes.length, 3, 'Must return 3 keyframes');
  assert(kfData.keyframes[0].id, 'Keyframe must have id');
  assert(kfData.keyframes[0].imageUrl, 'Keyframe must have imageUrl');
  assert.strictEqual(typeof kfData.keyframes[0].isMock, 'boolean', 'Keyframe must have isMock flag');
  console.log(`  ✓ Passed: Generated 3 keyframes (isMock=${kfData.keyframes[0].isMock})`);

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

  // 7. Credit Integrity on Failure / Execution
  console.log('\nTest 7: Credit deduction semantics (Credits NOT deducted on rejection)');
  const profileAfterBadCall = await (await fetch(`${BASE_URL}/user/profile`)).json();
  assert.strictEqual(profileAfterBadCall.credits, initialCredits, 'Credits must not be deducted on failed requests');
  console.log(`  ✓ Passed: Credits preserved (${profileAfterBadCall.credits} credits remaining)`);

  console.log('\n======================================================');
  console.log('🎉 ALL ASSERTIONS PASSED! DREAM VIEWER BACKEND VERIFIED.');
  console.log('======================================================\n');
}

runApiVerification().catch(err => {
  console.error('\n❌ ASSERTION FAILED:', err);
  process.exit(1);
});
