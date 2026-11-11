export type KeyframeBackend = 'sdxl' | 'wan';

export interface SdxlKeyframeConfig {
  checkpoint: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}

export interface WanKeyframeConfig {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  shift: number;
}

export interface KeyframeGraphResult {
  graph: Record<string, any>;
  saveNodeIds: string[];
}

export interface ComfySavedImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

/**
 * Validates KEYFRAME_BACKEND environment configuration strictly without silent fallbacks.
 */
export function parseKeyframeBackend(raw?: string): KeyframeBackend {
  const normalized = (raw === undefined ? 'sdxl' : raw).trim().toLowerCase();
  if (normalized !== 'sdxl' && normalized !== 'wan') {
    throw new Error(
      `[CONFIGURATION ERROR] Invalid KEYFRAME_BACKEND="${raw}". Supported values are "sdxl" or "wan".`
    );
  }
  return normalized;
}

/**
 * Builds an SDXL Text-to-Image ComfyUI API graph using a single batched EmptyLatentImage.
 */
export function buildSdxlKeyframeGraph(
  prompt: string,
  negative: string,
  count: number,
  seed: number,
  cfg: SdxlKeyframeConfig
): KeyframeGraphResult {
  const graph: Record<string, any> = {
    kf_ckpt: {
      class_type: 'CheckpointLoaderSimple',
      inputs: {
        ckpt_name: cfg.checkpoint
      }
    },
    kf_pos: {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: prompt,
        clip: ['kf_ckpt', 1]
      }
    },
    kf_neg: {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: negative,
        clip: ['kf_ckpt', 1]
      }
    },
    kf_latent: {
      class_type: 'EmptyLatentImage',
      inputs: {
        width: cfg.width,
        height: cfg.height,
        batch_size: count
      }
    },
    kf_sampler: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: cfg.sampler,
        scheduler: cfg.scheduler,
        denoise: 1,
        model: ['kf_ckpt', 0],
        positive: ['kf_pos', 0],
        negative: ['kf_neg', 0],
        latent_image: ['kf_latent', 0]
      }
    },
    kf_decode: {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['kf_sampler', 0],
        vae: ['kf_ckpt', 2]
      }
    },
    kf_save: {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: 'keyframe/DreamViewer_KF',
        images: ['kf_decode', 0]
      }
    }
  };

  return {
    graph,
    saveNodeIds: ['kf_save']
  };
}

/**
 * Builds the Wan 2.2 single-frame video latent ComfyUI graph with separate samplers per keyframe.
 */
export function buildWanKeyframeGraph(
  prompt: string,
  negative: string,
  count: number,
  seed: number,
  cfg: WanKeyframeConfig
): KeyframeGraphResult {
  const graph: Record<string, any> = {
    '37': {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: 'wan2.2_ti2v_5B_fp16.safetensors',
        weight_dtype: 'default'
      }
    },
    '48': {
      class_type: 'ModelSamplingSD3',
      inputs: {
        shift: cfg.shift,
        model: ['37', 0]
      }
    },
    '38': {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
        type: 'wan',
        device: 'default'
      }
    },
    '39': {
      class_type: 'VAELoader',
      inputs: {
        vae_name: 'wan2.2_vae.safetensors'
      }
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: prompt,
        clip: ['38', 0]
      }
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: negative,
        clip: ['38', 0]
      }
    },
    '55': {
      class_type: 'Wan22ImageToVideoLatent',
      inputs: {
        width: cfg.width,
        height: cfg.height,
        length: 1, // 1 frame produces a single still keyframe
        batch_size: 1,
        vae: ['39', 0]
      }
    }
  };

  const saveNodeIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const kfSeed = seed + i * 1013904223;
    const ksamplerId = `ksampler_kf_${i + 1}`;
    const vaeDecodeId = `vaedecode_kf_${i + 1}`;
    const saveImageId = `saveimage_kf_${i + 1}`;
    saveNodeIds.push(saveImageId);

    graph[ksamplerId] = {
      class_type: 'KSampler',
      inputs: {
        seed: kfSeed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: 'uni_pc',
        scheduler: 'simple',
        denoise: 1,
        model: ['48', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['55', 0]
      }
    };

    graph[vaeDecodeId] = {
      class_type: 'VAEDecode',
      inputs: {
        samples: [ksamplerId, 0],
        vae: ['39', 0]
      }
    };

    graph[saveImageId] = {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: `keyframe/DreamViewer_KF_${i + 1}`,
        images: [vaeDecodeId, 0]
      }
    };
  }

  return {
    graph,
    saveNodeIds
  };
}

/**
 * Collects all generated image references across the specified SaveImage nodes.
 * Supports both batched outputs (single SaveImage returning N images) and multi-node outputs (N SaveImages returning 1 image each).
 */
export function collectSavedKeyframeImages(
  outputs: Record<string, any> | undefined,
  saveNodeIds: string[]
): ComfySavedImageRef[] {
  if (!outputs) return [];
  const collected: ComfySavedImageRef[] = [];
  for (const nodeId of saveNodeIds) {
    const nodeOut = outputs[nodeId];
    if (nodeOut && Array.isArray(nodeOut.images)) {
      for (const img of nodeOut.images) {
        if (img && img.filename) {
          collected.push(img);
        }
      }
    }
  }
  return collected;
}
