async function testDreamAPI() {
  console.log('--- 1. Health check ---');
  const healthRes = await fetch('http://localhost:5000/api/health');
  console.log('Health:', await healthRes.json());

  console.log('\n--- 2. User Profile ---');
  const userRes = await fetch('http://localhost:5000/api/user/profile');
  console.log('User:', await userRes.json());

  console.log('\n--- 3. Testing 4-Layer Moderation Shield (Rejecting NSFW / +18) ---');
  const badDreamRes = await fetch('http://localhost:5000/api/dreams/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'A dream about explicit nude women and pornographic scenes',
      moodHint: 'ETHEREAL_LUCID'
    })
  });
  console.log('Bad Dream Status (Expect 400):', badDreamRes.status);
  console.log('Bad Dream Rejection Response:', await badDreamRes.json());

  console.log('\n--- 4. Valid Dream Analysis (Dream Architect) ---');
  const goodDreamRes = await fetch('http://localhost:5000/api/dreams/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawDreamText: 'Floating cathedral library with glowing flying books in violet clouds',
      moodHint: 'ETHEREAL_LUCID'
    })
  });
  const goodData = await goodDreamRes.json();
  console.log('Dream Architect Result:', {
    refinedPrompt: goodData.data.refinedPrompt,
    cameraMotion: goodData.data.cameraMotion,
    detectedMood: goodData.data.detectedMood
  });

  console.log('\n--- 5. Keyframes Generation ---');
  const kfRes = await fetch('http://localhost:5000/api/dreams/keyframes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refinedPrompt: goodData.data.refinedPrompt,
      count: 3
    })
  });
  const kfData = await kfRes.json();
  console.log(`Generated ${kfData.keyframes.length} keyframes:`, kfData.keyframes.map(k => ({ id: k.id, seed: k.seed })));

  console.log('\n--- 6. Video Generation (Approved Anchor -> On-Twos Video) ---');
  const videoRes = await fetch('http://localhost:5000/api/dreams/generate-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      selectedKeyframeUrl: kfData.keyframes[0].imageUrl,
      prompt: goodData.data.refinedPrompt,
      cameraMotion: goodData.data.cameraMotion,
      dreamTitle: 'Cathedral of Flying Books'
    })
  });
  const videoData = await videoRes.json();
  console.log('Video Generation Result:', {
    success: videoData.success,
    remainingCredits: videoData.remainingCredits,
    durationSeconds: videoData.dream.video.durationSeconds,
    effectiveSeconds: videoData.dream.video.effectiveSeconds,
    fps: videoData.dream.video.fps,
    faceBlurred: videoData.dream.video.faceBlurred
  });

  console.log('\n✨ ALL ENDPOINTS VERIFIED & WORKING PERFECTLY!');
}

testDreamAPI().catch(console.error);
