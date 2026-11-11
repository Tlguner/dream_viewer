import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  buildSdxlKeyframeGraph,
  buildWanKeyframeGraph,
  collectSavedKeyframeImages,
  parseKeyframeBackend
} from '../src/providers/comfy/keyframe_graphs.js';
import { ComfyDreamProvider } from '../src/providers/comfy_provider.js';
import { MockDreamArchitect } from '../src/architect/index.js';

describe('Keyframe Workflow Graphs & SDXL Integration', () => {
  let tempDir: string;
  let tempVideosDir: string;
  let tempKeyframesDir: string;
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-kf-test-'));
    tempVideosDir = path.join(tempDir, 'videos');
    tempKeyframesDir = path.join(tempDir, 'keyframes');
    fs.mkdirSync(tempVideosDir, { recursive: true });
    fs.mkdirSync(tempKeyframesDir, { recursive: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should build SDXL graph reflecting checkpoint, dimensions, batch_size, steps, cfg, sampler, and scheduler from config', () => {
    const config = {
      checkpoint: 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',
      width: 1344,
      height: 768,
      steps: 25,
      cfg: 6.5,
      sampler: 'dpmpp_2m',
      scheduler: 'karras'
    };

    const { graph, saveNodeIds } = buildSdxlKeyframeGraph(
      'Glowing bioluminescent forest floor',
      'people, blurry, watermark',
      3,
      424242,
      config
    );

    expect(saveNodeIds).toEqual(['kf_save']);

    expect(graph.kf_ckpt.class_type).toBe('CheckpointLoaderSimple');
    expect(graph.kf_ckpt.inputs.ckpt_name).toBe('Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors');

    expect(graph.kf_latent.class_type).toBe('EmptyLatentImage');
    expect(graph.kf_latent.inputs).toEqual({
      width: 1344,
      height: 768,
      batch_size: 3
    });

    expect(graph.kf_sampler.class_type).toBe('KSampler');
    expect(graph.kf_sampler.inputs.seed).toBe(424242);
    expect(graph.kf_sampler.inputs.steps).toBe(25);
    expect(graph.kf_sampler.inputs.cfg).toBe(6.5);
    expect(graph.kf_sampler.inputs.sampler_name).toBe('dpmpp_2m');
    expect(graph.kf_sampler.inputs.scheduler).toBe('karras');
    expect(graph.kf_sampler.inputs.denoise).toBe(1);
    expect(graph.kf_pos.inputs.text).toBe('Glowing bioluminescent forest floor');
    expect(graph.kf_neg.inputs.text).toBe('people, blurry, watermark');
  });

  it('should wire SDXL graph connections strictly according to ComfyUI node ports', () => {
    const { graph } = buildSdxlKeyframeGraph('prompt', 'neg', 3, 100, {
      checkpoint: 'dreamshaperXL.safetensors',
      width: 1344,
      height: 768,
      steps: 20,
      cfg: 5.5,
      sampler: 'euler',
      scheduler: 'normal'
    });

    expect(graph.kf_decode.inputs.vae).toEqual(['kf_ckpt', 2]);
    expect(graph.kf_decode.inputs.samples).toEqual(['kf_sampler', 0]);
    expect(graph.kf_pos.inputs.clip).toEqual(['kf_ckpt', 1]);
    expect(graph.kf_neg.inputs.clip).toEqual(['kf_ckpt', 1]);
    expect(graph.kf_sampler.inputs.model).toEqual(['kf_ckpt', 0]);
    expect(graph.kf_sampler.inputs.positive).toEqual(['kf_pos', 0]);
    expect(graph.kf_sampler.inputs.negative).toEqual(['kf_neg', 0]);
    expect(graph.kf_sampler.inputs.latent_image).toEqual(['kf_latent', 0]);
    expect(graph.kf_save.inputs.images).toEqual(['kf_decode', 0]);
    expect(graph.kf_save.inputs.filename_prefix).toBe('keyframe/DreamViewer_KF');
  });

  it('should NOT contain any Wan video nodes inside SDXL keyframe graph', () => {
    const { graph } = buildSdxlKeyframeGraph('prompt', 'neg', 3, 100, {
      checkpoint: 'juggernaut.safetensors',
      width: 1344,
      height: 768,
      steps: 25,
      cfg: 6.5,
      sampler: 'dpmpp_2m',
      scheduler: 'karras'
    });

    const nodeTypes = Object.values(graph).map(node => node.class_type);
    expect(nodeTypes).not.toContain('UNETLoader');
    expect(nodeTypes).not.toContain('Wan22ImageToVideoLatent');
    expect(nodeTypes).not.toContain('ModelSamplingSD3');
    expect(nodeTypes).not.toContain('CLIPLoader');
  });

  it('should build valid legacy Wan keyframe graph with separate KSamplers when KEYFRAME_BACKEND=wan', () => {
    const { graph, saveNodeIds } = buildWanKeyframeGraph('prompt', 'neg', 3, 1000, {
      width: 832,
      height: 480,
      steps: 20,
      cfg: 5.0,
      shift: 8.0
    });

    expect(saveNodeIds).toEqual(['saveimage_kf_1', 'saveimage_kf_2', 'saveimage_kf_3']);
    expect(graph['37'].class_type).toBe('UNETLoader');
    expect(graph['55'].class_type).toBe('Wan22ImageToVideoLatent');
    expect(graph['55'].inputs.length).toBe(1);
    expect(graph['ksampler_kf_1'].inputs.steps).toBe(20);
    expect(graph['ksampler_kf_2'].inputs.seed).toBe(1000 + 1013904223);
    expect(graph['ksampler_kf_3'].inputs.seed).toBe(1000 + 2 * 1013904223);
  });

  it('should consider keyframe job complete when a single SaveImage node outputs 3 batched images', async () => {
    // 1. Direct unit check on image aggregation helper
    const singleNodeOutputs = {
      kf_save: {
        images: [
          { filename: 'DreamViewer_KF_00001_.png', subfolder: 'keyframe', type: 'output' },
          { filename: 'DreamViewer_KF_00002_.png', subfolder: 'keyframe', type: 'output' },
          { filename: 'DreamViewer_KF_00003_.png', subfolder: 'keyframe', type: 'output' }
        ]
      }
    };
    const collected = collectSavedKeyframeImages(singleNodeOutputs, ['kf_save']);
    expect(collected).toHaveLength(3);

    // 2. End-to-end provider check via mocked ComfyUI HTTP API
    process.env.KEYFRAME_BACKEND = 'sdxl';
    process.env.KEYFRAME_CHECKPOINT = 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors';
    process.env.KEYFRAME_WIDTH = '1344';
    process.env.KEYFRAME_HEIGHT = '768';
    process.env.KEYFRAME_STEPS = '25';
    process.env.KEYFRAME_CFG = '6.5';
    process.env.KEYFRAME_SAMPLER = 'dpmpp_2m';
    process.env.KEYFRAME_SCHEDULER = 'karras';
    process.env.KEYFRAME_TIMEOUT_MS = '10000';

    const provider = new ComfyDreamProvider(
      'http://127.0.0.1:8188',
      'http://127.0.0.1:5000',
      tempVideosDir,
      tempKeyframesDir,
      new MockDreamArchitect()
    );
    provider.pollIntervalMs = 10;

    let postedPromptGraph: Record<string, any> | null = null;
    const fakePngBuffer = Buffer.from('fake-png-bytes');

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/prompt')) {
        postedPromptGraph = JSON.parse(init?.body as string).prompt;
        return new Response(JSON.stringify({ prompt_id: 'mock_prompt_123' }), { status: 200 });
      }
      if (url.includes('/history/mock_prompt_123')) {
        return new Response(
          JSON.stringify({
            mock_prompt_123: {
              status: { status_str: 'success' },
              outputs: singleNodeOutputs
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes('/view?')) {
        return new Response(fakePngBuffer, { status: 200 });
      }
      throw new Error(`Unexpected fetch URL in mock: ${url}`);
    }) as any;

    const keyframes = await provider.generateKeyframes('Glowing bioluminescent forest', 3);

    expect(postedPromptGraph).not.toBeNull();
    expect(postedPromptGraph!.kf_latent.inputs.batch_size).toBe(3);
    expect(postedPromptGraph!.kf_neg.inputs.text).toContain(
      'people, person, face, text, watermark, logo, cartoon, blurry, low quality, distorted, deformed, multiple objects'
    );

    expect(keyframes).toHaveLength(3);
    expect(keyframes[0].isMock).toBe(false);
    expect(keyframes[0].isSelected).toBe(true);
    expect(keyframes[1].isSelected).toBe(false);
    expect(keyframes[1].seed).toBe(keyframes[0].seed + 1);
    expect(keyframes[2].seed).toBe(keyframes[0].seed + 2);
  });

  it('verifyKeyframeModel should pass when checkpoint exists and throw listing models when missing', async () => {
    process.env.KEYFRAME_BACKEND = 'sdxl';
    process.env.KEYFRAME_CHECKPOINT = 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors';

    const provider = new ComfyDreamProvider(
      'http://127.0.0.1:8188',
      'http://127.0.0.1:5000',
      tempVideosDir,
      tempKeyframesDir,
      new MockDreamArchitect()
    );

    // Case 1: Model IS in list -> resolves without error
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          CheckpointLoaderSimple: {
            input: {
              required: {
                ckpt_name: [[
                  'sd_xl_base_1.0.safetensors',
                  'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors'
                ]]
              }
            }
          }
        }),
        { status: 200 }
      )
    ) as any;

    await expect(provider.verifyKeyframeModel()).resolves.toBeUndefined();

    // Case 2: Model is NOT in list -> throws descriptive error with available models
    process.env.KEYFRAME_CHECKPOINT = 'MissingModelXL.safetensors';
    await expect(provider.verifyKeyframeModel()).rejects.toThrow(
      /MissingModelXL\.safetensors.*Available models: \[sd_xl_base_1\.0\.safetensors, Juggernaut-XL_v9_RunDiffusionPhoto_v2\.safetensors\]/
    );
  });

  it('should throw an explicit error on invalid KEYFRAME_BACKEND values instead of falling back', async () => {
    expect(() => parseKeyframeBackend('flux')).toThrow(/Invalid KEYFRAME_BACKEND="flux"/);
    expect(() => parseKeyframeBackend('')).toThrow(/Invalid KEYFRAME_BACKEND=""/);
    expect(parseKeyframeBackend('sdxl')).toBe('sdxl');
    expect(parseKeyframeBackend('WAN')).toBe('wan');

    process.env.KEYFRAME_BACKEND = 'invalid_backend';
    const provider = new ComfyDreamProvider(
      'http://127.0.0.1:8188',
      'http://127.0.0.1:5000',
      tempVideosDir,
      tempKeyframesDir,
      new MockDreamArchitect()
    );

    await expect(provider.verifyKeyframeModel()).rejects.toThrow(/Invalid KEYFRAME_BACKEND="invalid_backend"/);
    await expect(provider.generateKeyframes('test prompt', 3)).rejects.toThrow(/Invalid KEYFRAME_BACKEND="invalid_backend"/);
  });
});
