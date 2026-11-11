import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  ComfyDreamProvider,
  buildWanVideoGraph,
  buildVideoNegativePrompt
} from '../src/providers/comfy_provider.js';
import { DREAM_ARCHITECT_SYSTEM_PROMPT } from '../src/architect/system_prompt.js';
import { MockDreamArchitect } from '../src/architect/index.js';

describe('Wan 2.2 Video Config, EasyCache Bypass & Anti-Morphing Prompts', () => {
  let tempDir: string;
  let tempVideosDir: string;
  let tempKeyframesDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-vid-test-'));
    tempVideosDir = path.join(tempDir, 'videos');
    tempKeyframesDir = path.join(tempDir, 'keyframes');
    fs.mkdirSync(tempVideosDir, { recursive: true });
    fs.mkdirSync(tempKeyframesDir, { recursive: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should default to WAN_VIDEO_FRAMES=49, WAN_STEPS=20, and WAN_EASYCACHE_THRESHOLD=0', () => {
    delete process.env.WAN_VIDEO_FRAMES;
    delete process.env.WAN_STEPS;
    delete process.env.WAN_EASYCACHE_THRESHOLD;
    delete process.env.KEYFRAME_BACKEND;

    const provider = new ComfyDreamProvider(
      'http://127.0.0.1:8188',
      'http://127.0.0.1:5000',
      tempVideosDir,
      tempKeyframesDir,
      new MockDreamArchitect()
    );

    const cfg = (provider as any).config;
    expect(cfg.videoFrames).toBe(49);
    expect(cfg.steps).toBe(20);
    expect(cfg.easyCacheThreshold).toBe(0);
    expect(cfg.width).toBe(832);
    expect(cfg.height).toBe(480);
  });

  it('should completely omit EasyCache node "60" and connect UNETLoader ("37") directly to ModelSamplingSD3 ("48") when threshold <= 0', () => {
    for (const threshold of [0, -0.5, Number.NaN]) {
      const graph = buildWanVideoGraph({
        comfyImageName: 'kf_01.png',
        positivePrompt: 'Slow push in toward Saturn rings',
        seed: 12345,
        videoFrames: 49,
        easyCacheThreshold: threshold,
        steps: 20,
        width: 832,
        height: 480,
        fps: 24,
        shift: 8.0,
        cfg: 5.0
      });

      expect(graph['60']).toBeUndefined();
      const classTypes = Object.values(graph).map(node => node.class_type);
      expect(classTypes).not.toContain('EasyCache');
      expect(graph['48'].class_type).toBe('ModelSamplingSD3');
      expect(graph['48'].inputs.model).toEqual(['37', 0]);
      expect(graph['3'].inputs.model).toEqual(['48', 0]);
      expect(graph['55'].inputs.length).toBe(49);
      expect(graph['3'].inputs.steps).toBe(20);
    }
  });

  it('should insert EasyCache node "60" between "37" and "48" when threshold > 0', () => {
    const graph = buildWanVideoGraph({
      comfyImageName: 'kf_01.png',
      positivePrompt: 'Slow push in toward Saturn rings',
      seed: 12345,
      videoFrames: 49,
      easyCacheThreshold: 0.15,
      steps: 20,
      width: 832,
      height: 480,
      fps: 24,
      shift: 8.0,
      cfg: 5.0
    });

    expect(graph['60']).toBeDefined();
    expect(graph['60'].class_type).toBe('EasyCache');
    expect(graph['60'].inputs.reuse_threshold).toBe(0.15);
    expect(graph['60'].inputs.model).toEqual(['37', 0]);
    expect(graph['48'].inputs.model).toEqual(['60', 0]);
  });

  it('should include anti-morphing and anti-static terms in the video negative prompt', () => {
    const neg = buildVideoNegativePrompt();
    const graph = buildWanVideoGraph({
      comfyImageName: 'kf_01.png',
      positivePrompt: 'Slow push in',
      seed: 99,
      videoFrames: 49,
      easyCacheThreshold: 0,
      steps: 20,
      width: 832,
      height: 480,
      fps: 24,
      shift: 8.0,
      cfg: 5.0
    });

    for (const term of [
      'extra parts',
      'extra antennas',
      'new objects appearing',
      'changing shape',
      'growing parts',
      'static',
      'still image',
      'no motion'
    ]) {
      expect(neg).toContain(term);
      expect(graph['7'].inputs.text).toContain(term);
    }
  });

  it('should instruct the Dream Architect to prioritize smooth camera motion and preserve object shape', () => {
    expect(DREAM_ARCHITECT_SYSTEM_PROMPT).toContain('CAMERA-FIRST VIDEO MOTION');
    expect(DREAM_ARCHITECT_SYSTEM_PROMPT).toContain('slow push in');
    expect(DREAM_ARCHITECT_SYSTEM_PROMPT).toContain('keep their exact shape');
  });
});
