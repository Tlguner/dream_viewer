import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { 
  IDreamProvider, 
  DreamPromptAnalysis, 
  KeyframeOption, 
  DreamVideoResult, 
  MoodStyle,
  DreamProgressEvent,
  ProgressCallback
} from '../types/index.js';
import { SafetyShield } from '../moderation/shield.js';
import { IDreamArchitect, OpenAICompatibleArchitect } from '../architect/index.js';
import {
  parseKeyframeBackend,
  buildSdxlKeyframeGraph,
  buildWanKeyframeGraph,
  collectSavedKeyframeImages,
  ComfySavedImageRef
} from './comfy/keyframe_graphs.js';

export class ComfyDreamProvider implements IDreamProvider {
  public name = 'ComfyUI (Wan 2.2 5B + EasyCache GPU)';
  public isMock = false;
  private comfyHost: string;
  private serverBaseUrl: string;
  private storageVideosDir: string;
  private storageKeyframesDir: string;
  private clientId: string = 'dream_viewer_' + crypto.randomUUID().substring(0, 8);
  private ws: any = null;
  private wsListeners: Set<(msg: any) => void> = new Set();
  private architect: IDreamArchitect;

  private ensureWebSocket(): void {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 0)) {
      return;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    try {
      const wsUrl = `${this.comfyHost.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`;
      this.ws = new (globalThis as any).WebSocket(wsUrl);

      this.ws.onmessage = (event: any) => {
        try {
          const parsed = JSON.parse(event.data.toString());
          for (const listener of this.wsListeners) {
            listener(parsed);
          }
        } catch {
          // ignore non-json messages
        }
      };

      this.ws.onerror = (_e: any) => {
        // softly handled
      };

      this.ws.onclose = () => {
        this.ws = null;
      };
    } catch (err: any) {
      console.warn('[ComfyDreamProvider] WebSocket initialization notice:', err.message);
    }
  }

  // Dynamically load parameters so .env edits apply immediately in development without server restart
  private get config() {
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      try {
        const candidatePaths = [
          path.resolve(this.storageVideosDir, '..', '..', '..', '.env'), // project root (dream_viewer/.env)
          path.resolve(this.storageVideosDir, '..', '..', '.env'),       // server directory (server/.env)
          path.resolve(process.cwd(), '..', '.env'),
          path.resolve(process.cwd(), '.env'),
        ];
        for (const envPath of candidatePaths) {
          if (fs.existsSync(envPath)) {
            dotenv.config({ path: envPath, override: true });
          }
        }
      } catch {
        // fallback to existing process.env
      }
    }

    const keyframeBackend = parseKeyframeBackend(process.env.KEYFRAME_BACKEND);

    return {
      videoFrames: parseInt(process.env.WAN_VIDEO_FRAMES || '121', 10),
      videoTimeoutMs: parseInt(process.env.WAN_VIDEO_TIMEOUT_MS || '900000', 10),
      easyCacheThreshold: parseFloat(process.env.WAN_EASYCACHE_THRESHOLD || '0.15'),
      steps: parseInt(process.env.WAN_STEPS || '15', 10),
      keyframeSteps: parseInt(process.env.KEYFRAME_STEPS || '25', 10),
      wanKeyframeSteps: parseInt(process.env.WAN_KEYFRAME_STEPS || '20', 10),
      width: parseInt(process.env.WAN_WIDTH || '832', 10),
      height: parseInt(process.env.WAN_HEIGHT || '480', 10),
      fps: parseInt(process.env.WAN_FPS || '24', 10),
      shift: parseFloat(process.env.WAN_SHIFT || '8.0'),
      cfg: parseFloat(process.env.WAN_CFG || '5.0'),
      keyframeBackend,
      keyframeCheckpoint: (process.env.KEYFRAME_CHECKPOINT || 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors').trim(),
      keyframeWidth: parseInt(process.env.KEYFRAME_WIDTH || '1344', 10),
      keyframeHeight: parseInt(process.env.KEYFRAME_HEIGHT || '768', 10),
      keyframeCfg: parseFloat(process.env.KEYFRAME_CFG || '6.5'),
      keyframeSampler: (process.env.KEYFRAME_SAMPLER || 'dpmpp_2m').trim(),
      keyframeScheduler: (process.env.KEYFRAME_SCHEDULER || 'karras').trim(),
      keyframeTimeoutMs: parseInt(process.env.KEYFRAME_TIMEOUT_MS || '180000', 10),
    };
  }

  public pollIntervalMs: number = 1500;

  constructor(
    comfyHost = process.env.COMFYUI_HOST || 'http://127.0.0.1:8188',
    serverBaseUrl = process.env.SERVER_BASE_URL || 'http://127.0.0.1:5000',
    storageVideosDir = path.resolve('storage', 'videos'),
    storageKeyframesDir = path.resolve('storage', 'keyframes'),
    architect?: IDreamArchitect
  ) {
    this.comfyHost = comfyHost.replace(/\/$/, '');
    this.serverBaseUrl = serverBaseUrl.replace(/\/$/, '');
    this.storageVideosDir = storageVideosDir;
    this.storageKeyframesDir = storageKeyframesDir;
    this.architect = architect || new OpenAICompatibleArchitect();

    fs.mkdirSync(this.storageVideosDir, { recursive: true });
    fs.mkdirSync(this.storageKeyframesDir, { recursive: true });
  }

  /**
   * Verifies at startup that the configured SDXL keyframe checkpoint exists in ComfyUI.
   */
  public async verifyKeyframeModel(): Promise<void> {
    const cfg = this.config;

    if (cfg.keyframeBackend !== 'sdxl') {
      console.log(`ℹ️ [ComfyDreamProvider] KEYFRAME_BACKEND="${cfg.keyframeBackend}". Skipping SDXL CheckpointLoaderSimple check.`);
      return;
    }

    const url = `${this.comfyHost}/object_info/CheckpointLoaderSimple`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err: any) {
      throw new Error(
        `ComfyUI is unreachable at ${this.comfyHost} while verifying SDXL keyframe checkpoint "${cfg.keyframeCheckpoint}": ${err.message}`
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `Failed to query ComfyUI checkpoints at ${url} (${res.status}): ${errText}`
      );
    }

    const data = (await res.json()) as any;
    const availableCheckpoints = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];

    if (!Array.isArray(availableCheckpoints)) {
      throw new Error(
        `Unexpected response from ComfyUI /object_info/CheckpointLoaderSimple; could not locate checkpoint list.`
      );
    }

    if (!availableCheckpoints.includes(cfg.keyframeCheckpoint)) {
      const availableList = availableCheckpoints.length > 0 ? availableCheckpoints.join(', ') : '(none)';
      throw new Error(
        `Configured KEYFRAME_CHECKPOINT "${cfg.keyframeCheckpoint}" was not found in ComfyUI checkpoints. Available models: [${availableList}]`
      );
    }

    console.log(`✅ [ComfyDreamProvider] Verified SDXL keyframe checkpoint: ${cfg.keyframeCheckpoint}`);
  }

  private sanitizeForPrompt(text: string): string {
    return text
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\\"{}[\]]/g, '')
      .replace(/\b(ignore previous|system prompt|jailbreak|disregard instructions)\b/gi, '')
      .trim();
  }

  public async analyzeDream(rawText: string, moodHint?: MoodStyle): Promise<DreamPromptAnalysis> {
    const cleanText = this.sanitizeForPrompt(rawText);

    // 1. Layer 1: Regex Hard-Block (Pre-LLM)
    const preAudit = SafetyShield.auditPrompt(cleanText);
    if (!preAudit.passed) {
      const err: any = new Error(preAudit.reason || 'Prompt rejected by safety filter.');
      err.code = 'MODERATION_REJECTED';
      err.categories = preAudit.flaggedCategories;
      throw err;
    }

    // 2. Layer 2: LLM Architect (Spatial decomposition into 1-3 scenes with structured schema)
    console.log(`🎬 [ComfyDreamProvider] Invoking Dream Architect for narrative decomposition...`);
    const architectResult = await this.architect.analyzeDream(cleanText, moodHint);

    // 3. Layer 3: LLM Safety Assessment
    if (!architectResult.safety?.allowed) {
      const err: any = new Error(`Dream prompt rejected: ${architectResult.safety?.category || 'Content policy violation'}`);
      err.code = 'MODERATION_REJECTED';
      err.categories = [architectResult.safety?.category || 'LLM_SAFETY_VIOLATION'];
      throw err;
    }

    if (!architectResult.scenes || architectResult.scenes.length === 0) {
      throw new Error('Dream Architect returned 0 scenes. At least 1 valid scene is required.');
    }

    // 4. Layer 4: Post-LLM Prompt Sanitization & Moderation Audit for each scene
    for (const scene of architectResult.scenes) {
      const kfAudit = SafetyShield.auditPrompt(scene.keyframePrompt);
      if (!kfAudit.passed) {
        const err: any = new Error(`Generated scene ${scene.sceneNumber} keyframe prompt violated safety policy: ${kfAudit.reason}`);
        err.code = 'MODERATION_REJECTED';
        err.categories = kfAudit.flaggedCategories;
        throw err;
      }

      const motionAudit = SafetyShield.auditPrompt(scene.motionPrompt);
      if (!motionAudit.passed) {
        const err: any = new Error(`Generated scene ${scene.sceneNumber} motion prompt violated safety policy: ${motionAudit.reason}`);
        err.code = 'MODERATION_REJECTED';
        err.categories = motionAudit.flaggedCategories;
        throw err;
      }
    }

    // 5. Server-side duration calculation (Duration comes strictly from server config, NOT LLM hallucination)
    const rawSecondsPerScene = this.config.videoFrames / this.config.fps;
    const effectiveSecondsPerScene = Math.round(rawSecondsPerScene * 2); // On-twos playback
    const totalEstimatedSeconds = architectResult.scenes.length * effectiveSecondsPerScene;

    const primaryScene = architectResult.scenes[0];

    return {
      refinedPrompt: primaryScene.keyframePrompt,
      keyframePrompt: primaryScene.keyframePrompt,
      motionPrompt: primaryScene.motionPrompt,
      negativePrompt: SafetyShield.getNegativePrompt(),
      cameraMotion: primaryScene.cameraMotion,
      detectedMood: primaryScene.mood,
      scenes: architectResult.scenes,
      totalEstimatedSeconds,
      visualElements: {
        setting: primaryScene.summary,
        surrealTwist: `${architectResult.scenes.length} scene(s) structured by Dream Architect`,
        lighting: `${primaryScene.mood} cinematic illumination`
      }
    };
  }

  /**
   * Safe cancellation: Inspects ComfyUI /queue before interrupting.
   * If the prompt is actively executing (queue_running), calls /interrupt.
   * If the prompt is pending (queue_pending), deletes it from queue without interrupting other running jobs.
   */
  private async cancelComfyJob(promptId: string): Promise<void> {
    console.log(`⚠️ [ComfyDreamProvider] Checking queue to safely cancel prompt: ${promptId}...`);
    try {
      const queueRes = await fetch(`${this.comfyHost}/queue`);
      if (!queueRes.ok) return;

      const queueData = (await queueRes.json()) as any;
      const isRunning = Array.isArray(queueData.queue_running) &&
        queueData.queue_running.some((item: any) => item[1] === promptId);
      const isPending = Array.isArray(queueData.queue_pending) &&
        queueData.queue_pending.some((item: any) => item[1] === promptId);

      if (isRunning) {
        console.log(`🛑 [ComfyDreamProvider] Prompt ${promptId} is actively running on GPU. Calling /interrupt...`);
        await fetch(`${this.comfyHost}/interrupt`, { method: 'POST' });
      } else if (isPending) {
        console.log(`🗑️ [ComfyDreamProvider] Prompt ${promptId} is pending in queue. Deleting entry without interrupting GPU...`);
        await fetch(`${this.comfyHost}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] })
        });
      } else {
        console.log(`ℹ️ [ComfyDreamProvider] Prompt ${promptId} is neither running nor pending.`);
      }
    } catch (err: any) {
      console.warn(`Failed to safely cancel ComfyUI job ${promptId}:`, err.message);
    }
  }

  /**
   * Generate 100% genuine GPU keyframes using SDXL (default) or Wan 2.2 text-to-image.
   * In Comfy mode, this does NOT fall back to stock photos.
   */
  public async generateKeyframes(
    keyframePrompt: string, 
    count: number = 3,
    onProgress?: ProgressCallback
  ): Promise<KeyframeOption[]> {
    const cfg = this.config;
    const sanitizedPrompt = this.sanitizeForPrompt(keyframePrompt);
    const keyframeNegativePrompt = `${SafetyShield.getNegativePrompt()}, people, person, face, text, watermark, logo, cartoon, blurry, low quality, distorted, deformed, multiple objects`;
    const baseSeed = Math.floor(Math.random() * 8000000000000000);

    console.log(`🎨 [ComfyDreamProvider] Generating ${count} genuine GPU keyframes via ${cfg.keyframeBackend.toUpperCase()}...`);

    const { graph: kfPrompt, saveNodeIds } =
      cfg.keyframeBackend === 'sdxl'
        ? buildSdxlKeyframeGraph(sanitizedPrompt, keyframeNegativePrompt, count, baseSeed, {
            checkpoint: cfg.keyframeCheckpoint,
            width: cfg.keyframeWidth,
            height: cfg.keyframeHeight,
            steps: cfg.keyframeSteps,
            cfg: cfg.keyframeCfg,
            sampler: cfg.keyframeSampler,
            scheduler: cfg.keyframeScheduler
          })
        : buildWanKeyframeGraph(sanitizedPrompt, keyframeNegativePrompt, count, baseSeed, {
            width: cfg.width,
            height: cfg.height,
            steps: cfg.wanKeyframeSteps,
            cfg: cfg.cfg,
            shift: cfg.shift
          });

    this.ensureWebSocket();

    const queueRes = await fetch(`${this.comfyHost}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: kfPrompt, client_id: this.clientId })
    });

    if (!queueRes.ok) {
      const errText = await queueRes.text();
      throw new Error(`ComfyUI rejected keyframe prompt queue (${queueRes.status}): ${errText}`);
    }

    const queueData = (await queueRes.json()) as any;
    const promptId = queueData.prompt_id;
    console.log(`🚀 [ComfyDreamProvider] Keyframe prompt enqueued with ID: ${promptId}`);

    // Poll for keyframe completion using configured KEYFRAME_TIMEOUT_MS
    const startTime = Date.now();
    const timeoutMs = cfg.keyframeTimeoutMs;
    let completedItem: any = null;
    let completedImages: ComfySavedImageRef[] = [];

    const kfProgressListener = (msg: any) => {
      try {
        if (!msg || !msg.type || !msg.data) return;
        const data = msg.data;
        if (data.prompt_id && data.prompt_id !== promptId) return;

        const elapsedSec = Math.max(0, (Date.now() - startTime) / 1000);

        if (msg.type === 'execution_start') {
          onProgress?.({
            stage: 'INITIALIZING',
            stageLabel: 'Composition Engine',
            detail: `Synthesizing ${count} artistic anchors on RTX GPU (${cfg.keyframeBackend.toUpperCase()})...`,
            percent: 5,
            elapsedSeconds: Math.round(elapsedSec),
            etaSeconds: 20
          });
        } else if (msg.type === 'progress') {
          const val = Number(data.value || 0);
          const max = Number(data.max || 10);
          const ratio = Math.min(1, Math.max(0, val / max));

          if (cfg.keyframeBackend === 'sdxl' || data.node === 'kf_sampler') {
            const percent = Math.min(95, Math.max(5, Math.round((val / max) * 100)));
            const remainingSec = Math.max(2, Math.round((1 - ratio) * 25));

            onProgress?.({
              stage: 'DIFFUSION',
              stageLabel: 'Synthesizing Keyframes (SDXL)',
              detail: `Rendering ${count} keyframe variations (Step ${val}/${max})`,
              percent,
              step: val,
              totalSteps: max,
              elapsedSeconds: Math.round(elapsedSec),
              etaSeconds: remainingSec,
              nodeType: 'KSampler'
            });
          } else {
            let basePercent = 8;
            let currentKfIndex = 1;
            if (data.node === 'ksampler_kf_2') {
              basePercent = 38;
              currentKfIndex = 2;
            } else if (data.node === 'ksampler_kf_3') {
              basePercent = 68;
              currentKfIndex = 3;
            }

            const percent = Math.min(95, Math.round(basePercent + (ratio * 28)));
            const remainingSec = Math.max(2, Math.round((count - currentKfIndex + 1 - ratio) * 6));

            onProgress?.({
              stage: 'DIFFUSION',
              stageLabel: 'Synthesizing Keyframes',
              detail: `Rendering Keyframe ${currentKfIndex}/${count} (Step ${val}/${max})`,
              percent,
              step: val,
              totalSteps: max,
              elapsedSeconds: Math.round(elapsedSec),
              etaSeconds: remainingSec,
              nodeType: 'KSampler'
            });
          }
        }
      } catch (err: any) {
        console.warn('Keyframe progress listener error:', err.message);
      }
    };

    this.wsListeners.add(kfProgressListener);

    try {
      while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, this.pollIntervalMs));
        const hRes = await fetch(`${this.comfyHost}/history/${promptId}`);
        if (!hRes.ok) continue;

        const hData = (await hRes.json()) as any;
        if (hData && hData[promptId]) {
          const item = hData[promptId];
          if (item.status?.status_str === 'error') {
            let errMsg = 'ComfyUI execution error';
            if (Array.isArray(item.status?.messages)) {
              const errEntry = item.status.messages.find((m: any) => m[0] === 'execution_error');
              if (errEntry && errEntry[1]) {
                const { exception_message, exception_type, node_type } = errEntry[1];
                errMsg = `${node_type || 'Node'} failed [${exception_type || 'Error'}]: ${exception_message || 'Unknown error'}`;
              }
            }
            throw new Error(`ComfyUI keyframe generation failed: ${errMsg}`);
          }

          const savedImages = collectSavedKeyframeImages(item.outputs, saveNodeIds);
          if (savedImages.length >= count) {
            completedItem = item;
            completedImages = savedImages.slice(0, count);
            break;
          }
        }
      }

      if (!completedItem) {
        await this.cancelComfyJob(promptId);
        throw new Error(`ComfyUI keyframe generation timed out after ${timeoutMs / 1000} seconds.`);
      }
    } catch (pollErr: any) {
      if (!completedItem) {
        await this.cancelComfyJob(promptId);
      }
      throw pollErr;
    } finally {
      this.wsListeners.delete(kfProgressListener);
    }

    // Process and persist all generated keyframe images into server storage
    const keyframes: KeyframeOption[] = [];

    for (let i = 0; i < completedImages.length; i++) {
      const outImg = completedImages[i];
      const comfyViewUrl = `${this.comfyHost}/view?filename=${encodeURIComponent(outImg.filename)}&subfolder=${encodeURIComponent(outImg.subfolder || '')}&type=output`;

      const imgRes = await fetch(comfyViewUrl);
      if (!imgRes.ok) {
        throw new Error(`Failed to download keyframe image ${outImg.filename} from ComfyUI (${imgRes.status})`);
      }

      const imgBuf = Buffer.from(await imgRes.arrayBuffer());
      const keyframeId = `kf_gpu_${Date.now()}_${i + 1}`;
      const localFilename = `${keyframeId}.png`;
      await fs.promises.writeFile(path.join(this.storageKeyframesDir, localFilename), imgBuf);

      keyframes.push({
        id: keyframeId,
        imageUrl: `${this.serverBaseUrl}/api/media/keyframes/${localFilename}`,
        aspectRatio: '16:9',
        seed: cfg.keyframeBackend === 'sdxl' ? baseSeed + i : baseSeed + (i * 1013904223),
        isMock: false, // 100% genuine GPU generated keyframe!
        isSelected: i === 0
      });
    }

    console.log(`✅ [ComfyDreamProvider] Successfully generated and stored ${keyframes.length} GPU keyframes (${cfg.keyframeBackend.toUpperCase()}).`);
    return keyframes;
  }

  /**
   * Upload an image buffer to ComfyUI /upload/image
   */
  private async uploadImageToComfy(imageBuffer: Buffer, filename: string): Promise<string> {
    const formData = new FormData();
    const blob = new Blob([imageBuffer], { type: 'image/png' });
    formData.append('image', blob, filename);
    formData.append('overwrite', 'true');

    const response = await fetch(`${this.comfyHost}/upload/image`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to upload keyframe to ComfyUI (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as any;
    return data.name;
  }

  /**
   * Retrieve image bytes from local disk or URL
   */
  private async fetchImageBytes(imageUrl: string): Promise<Buffer> {
    // If it points to our local server storage, read directly from disk
    if (imageUrl.includes('/api/media/keyframes/')) {
      const filename = path.basename(imageUrl);
      const localPath = path.join(this.storageKeyframesDir, filename);
      if (fs.existsSync(localPath)) {
        return await fs.promises.readFile(localPath);
      }
    }

    const res = await fetch(imageUrl);
    if (!res.ok) {
      throw new Error(`Failed to retrieve keyframe image from ${imageUrl}: ${res.statusText}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /**
   * Submit and poll Wan 2.2 I2V workflow on ComfyUI, download result, and persist locally
   */
  public async generateVideo(
    selectedKeyframe: KeyframeOption,
    motionPrompt: string,
    cameraMotion: string,
    onProgress?: ProgressCallback
  ): Promise<DreamVideoResult> {
    console.log(`📡 [ComfyDreamProvider] Starting Image-to-Video generation on ComfyUI at ${this.comfyHost}...`);

    // 1. Fetch Keyframe image bytes
    const imageBytes = await this.fetchImageBytes(selectedKeyframe.imageUrl);
    const uploadedFilename = `dream_kf_${Date.now()}_${crypto.randomUUID().substring(0, 8)}.png`;

    // 2. Upload to ComfyUI
    const comfyImageName = await this.uploadImageToComfy(imageBytes, uploadedFilename);
    console.log(`🖼️ [ComfyDreamProvider] Keyframe uploaded to ComfyUI as: ${comfyImageName}`);

    // 3. Build Wan 2.2 5B + EasyCache Image-to-Video Graph with configured parameters
    const seed = Math.floor(Math.random() * 9007199254740991);
    const { videoFrames, easyCacheThreshold, steps, width, height, fps, shift, cfg } = this.config;
    console.log(`🎬 [ComfyDreamProvider] Configured Video: ${videoFrames} frames (~${(videoFrames / fps).toFixed(1)}s raw, ~${((videoFrames / fps) * 2).toFixed(1)}s on-twos) @ ${fps}fps (${width}x${height}, ${steps} steps)`);

    const workflowPrompt: Record<string, any> = {
      "37": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": "wan2.2_ti2v_5B_fp16.safetensors",
          "weight_dtype": "default"
        }
      },
      "60": {
        "class_type": "EasyCache",
        "inputs": {
          "reuse_threshold": easyCacheThreshold,
          "start_percent": 0.15,
          "end_percent": 0.95,
          "verbose": false,
          "model": ["37", 0]
        }
      },
      "48": {
        "class_type": "ModelSamplingSD3",
        "inputs": {
          "shift": shift,
          "model": ["60", 0]
        }
      },
      "38": {
        "class_type": "CLIPLoader",
        "inputs": {
          "clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
          "type": "wan",
          "device": "default"
        }
      },
      "39": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "wan2.2_vae.safetensors"
        }
      },
      "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": this.sanitizeForPrompt(`${motionPrompt}. ${cameraMotion}. Smooth motion, high temporal coherence, 24fps.`),
          "clip": ["38", 0]
        }
      },
      "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": `${SafetyShield.getNegativePrompt()}, jitter, morphing, sudden camera cuts, flashing distortion, warped geometry, rapid flicker, frozen frame, watermark, blurry`,
          "clip": ["38", 0]
        }
      },
      "56": {
        "class_type": "LoadImage",
        "inputs": {
          "image": comfyImageName
        }
      },
      "55": {
        "class_type": "Wan22ImageToVideoLatent",
        "inputs": {
          "width": width,
          "height": height,
          "length": videoFrames,
          "batch_size": 1,
          "vae": ["39", 0],
          "start_image": ["56", 0]
        }
      },
      "3": {
        "class_type": "KSampler",
        "inputs": {
          "seed": seed,
          "steps": steps,
          "cfg": cfg,
          "sampler_name": "uni_pc",
          "scheduler": "simple",
          "denoise": 1,
          "model": ["48", 0],
          "positive": ["6", 0],
          "negative": ["7", 0],
          "latent_image": ["55", 0]
        }
      },
      "8": {
        "class_type": "VAEDecodeTiled",
        "inputs": {
          "samples": ["3", 0],
          "vae": ["39", 0],
          "tile_size": 512,
          "overlap": 64,
          "temporal_size": 64,
          "temporal_overlap": 8
        }
      },
      "57": {
        "class_type": "CreateVideo",
        "inputs": {
          "fps": fps,
          "bit_depth": "auto",
          "color_space": "sRGB",
          "codec": "none",
          "images": ["8", 0]
        }
      },
      "58": {
        "class_type": "SaveVideo",
        "inputs": {
          "filename_prefix": "video/DreamViewer",
          "format": "auto",
          "format.codec": "auto",
          "codec": "auto",
          "video": ["57", 0]
        }
      }
    };

    this.ensureWebSocket();

    // 4. Send workflow to ComfyUI /prompt
    const queueResponse = await fetch(`${this.comfyHost}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflowPrompt, client_id: this.clientId })
    });

    if (!queueResponse.ok) {
      const errText = await queueResponse.text();
      throw new Error(`ComfyUI rejected prompt queue (${queueResponse.status}): ${errText}`);
    }

    const queueData = (await queueResponse.json()) as any;
    const promptId = queueData.prompt_id;
    console.log(`🚀 [ComfyDreamProvider] Prompt enqueued with ID: ${promptId}`);

    // 5. Poll /history/{prompt_id} until completed (configurable via WAN_VIDEO_TIMEOUT_MS)
    const startTime = Date.now();
    const timeoutMs = this.config.videoTimeoutMs;
    let completedHistory: any = null;

    const progressListener = (msg: any) => {
      try {
        if (!msg || !msg.type || !msg.data) return;
        const data = msg.data;
        if (data.prompt_id && data.prompt_id !== promptId) return;

        const elapsedSec = Math.max(0, (Date.now() - startTime) / 1000);

        if (msg.type === 'execution_start') {
          onProgress?.({
            stage: 'INITIALIZING',
            stageLabel: 'Preparing GPU Latents',
            detail: 'Allocating VRAM and initializing Wan 2.2 model...',
            percent: 5,
            elapsedSeconds: Math.round(elapsedSec),
            etaSeconds: Math.round((videoFrames / 49) * 110)
          });
        } else if (msg.type === 'executing') {
          const node = data.node;
          if (node === '56') {
            onProgress?.({
              stage: 'INITIALIZING',
              stageLabel: 'Keyframe Ingestion',
              detail: 'Uploading keyframe image to GPU latent buffer...',
              percent: 10,
              elapsedSeconds: Math.round(elapsedSec)
            });
          } else if (node === '3') {
            onProgress?.({
              stage: 'DIFFUSION',
              stageLabel: 'Wan 2.2 Neural Diffusion',
              detail: `Starting ${steps} denoising sampling steps...`,
              percent: 15,
              step: 0,
              totalSteps: steps,
              elapsedSeconds: Math.round(elapsedSec),
              nodeType: 'KSampler'
            });
          } else if (node === '8') {
            onProgress?.({
              stage: 'DECODING',
              stageLabel: 'Tiled Neural VAE Decoding',
              detail: `Decoding ${videoFrames} latent frames into RGB pixels (tiled VAE)...`,
              percent: 88,
              elapsedSeconds: Math.round(elapsedSec),
              etaSeconds: 12,
              nodeType: 'VAEDecodeTiled'
            });
          } else if (node === '57' || node === '58') {
            onProgress?.({
              stage: 'SAVING',
              stageLabel: 'Compiling MP4 Video',
              detail: 'Encoding video stream and writing to server storage...',
              percent: 96,
              elapsedSeconds: Math.round(elapsedSec),
              etaSeconds: 2,
              nodeType: 'SaveVideo'
            });
          }
        } else if (msg.type === 'progress') {
          const val = Number(data.value || 0);
          const max = Number(data.max || steps || 1);
          const ratio = Math.min(1, Math.max(0, val / max));
          const percent = Math.min(85, Math.round(15 + (ratio * 70)));
          const secPerStep = val > 0 ? elapsedSec / val : 3.2;
          const remainingSteps = Math.max(0, max - val);
          const etaSeconds = Math.max(4, Math.round(remainingSteps * secPerStep + 8));

          onProgress?.({
            stage: 'DIFFUSION',
            stageLabel: 'Wan 2.2 Neural Diffusion',
            detail: `Sampling step ${val}/${max} (${Math.round(ratio * 100)}%)`,
            percent,
            step: val,
            totalSteps: max,
            elapsedSeconds: Math.round(elapsedSec),
            etaSeconds,
            nodeType: 'KSampler'
          });
        }
      } catch (err: any) {
        console.warn('Progress listener error:', err.message);
      }
    };

    this.wsListeners.add(progressListener);

    try {
      while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, 2000));

        const histRes = await fetch(`${this.comfyHost}/history/${promptId}`);
        if (!histRes.ok) continue;

        const histData = (await histRes.json()) as any;
        if (histData && histData[promptId]) {
          const item = histData[promptId];

          // Accurate error extraction from execution_error message
          if (item.status?.status_str === 'error') {
            let errMsg = 'ComfyUI execution error';
            if (Array.isArray(item.status?.messages)) {
              const errEntry = item.status.messages.find((m: any) => m[0] === 'execution_error');
              if (errEntry && errEntry[1]) {
                const { exception_message, exception_type, node_type } = errEntry[1];
                errMsg = `${node_type || 'Node'} failed [${exception_type || 'Error'}]: ${exception_message || 'Unknown error'}`;
              }
            }
            throw new Error(errMsg);
          }

          if (item.outputs && Object.keys(item.outputs).length > 0) {
            completedHistory = item;
            break;
          }
        }
      }

      if (!completedHistory) {
        await this.cancelComfyJob(promptId);
        throw new Error(`ComfyUI video generation timed out after ${timeoutMs / 1000} seconds. Job cancelled.`);
      }
    } catch (pollErr: any) {
      if (!completedHistory) {
        await this.cancelComfyJob(promptId);
      }
      throw pollErr;
    } finally {
      this.wsListeners.delete(progressListener);
    }

    // 6. Find output video file from history
    let videoFilename = '';
    let videoSubfolder = 'video';
    const outputs = completedHistory.outputs;

    for (const nodeId in outputs) {
      const nodeOut = outputs[nodeId];
      if (nodeOut.videos && nodeOut.videos.length > 0) {
        videoFilename = nodeOut.videos[0].filename;
        if (nodeOut.videos[0].subfolder) videoSubfolder = nodeOut.videos[0].subfolder;
        break;
      }
      if (nodeOut.images && nodeOut.images.length > 0) {
        const candidate = nodeOut.images.find((i: any) => i.filename.endsWith('.mp4') || i.filename.endsWith('.webm'));
        if (candidate) {
          videoFilename = candidate.filename;
          if (candidate.subfolder) videoSubfolder = candidate.subfolder;
          break;
        }
      }
    }

    if (!videoFilename) {
      throw new Error('ComfyUI finished execution but no video output file was found in output nodes.');
    }

    // 7. Download video from ComfyUI and persist inside server storage
    const comfyVideoUrl = `${this.comfyHost}/view?filename=${encodeURIComponent(videoFilename)}&subfolder=${encodeURIComponent(videoSubfolder)}&type=output`;
    const videoStreamRes = await fetch(comfyVideoUrl);
    if (!videoStreamRes.ok) {
      throw new Error(`Failed to fetch generated video from ComfyUI (${videoStreamRes.status})`);
    }

    const videoBuffer = Buffer.from(await videoStreamRes.arrayBuffer());
    const videoId = `vid_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
    const localVideoFilename = `${videoId}.mp4`;
    const localVideoPath = path.join(this.storageVideosDir, localVideoFilename);

    await fs.promises.writeFile(localVideoPath, videoBuffer);
    console.log(`💾 [ComfyDreamProvider] Video saved to server storage: ${localVideoPath} (${videoBuffer.length} bytes)`);

    // 8. Construct self-hosted server media URL
    const serverMediaUrl = `${this.serverBaseUrl}/api/media/videos/${localVideoFilename}`;
    const nativeDuration = Number((videoFrames / fps).toFixed(1));
    const effectiveDuration = Number((nativeDuration * 2).toFixed(1));

    onProgress?.({
      stage: 'COMPLETED',
      stageLabel: 'Dream Manifested!',
      detail: 'Video stream ready for playback',
      percent: 100,
      elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
      etaSeconds: 0
    });

    console.log(`🎬 [ComfyDreamProvider] Serving video from: ${serverMediaUrl}`);

    return {
      id: videoId,
      videoUrl: serverMediaUrl,
      durationSeconds: nativeDuration,
      effectiveSeconds: effectiveDuration,
      fps: fps,
      playbackRate: 0.5,
      faceBlurred: false,
      audioMood: 'ethereal_lucid_pad',
      shaderPreset: 'dream_haze',
      isMock: false
    };
  }
}
