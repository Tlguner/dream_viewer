import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { 
  IDreamProvider, 
  DreamPromptAnalysis, 
  KeyframeOption, 
  DreamVideoResult, 
  MoodStyle 
} from '../types/index.js';
import { SafetyShield } from '../moderation/shield.js';

export class ComfyDreamProvider implements IDreamProvider {
  public name = 'ComfyUI (Wan 2.2 5B + EasyCache GPU)';
  public isMock = false;
  private comfyHost: string;
  private serverBaseUrl: string;
  private storageVideosDir: string;
  private storageKeyframesDir: string;

  // Dynamically load Wan 2.2 parameters so .env edits apply immediately without server restart
  private get config() {
    try {
      const rootEnv = path.resolve(this.storageVideosDir, '..', '..', '.env');
      if (fs.existsSync(rootEnv)) {
        dotenv.config({ path: rootEnv, override: true });
      }
    } catch {
      // fallback to existing process.env
    }

    return {
      videoFrames: parseInt(process.env.WAN_VIDEO_FRAMES || '49', 10),
      easyCacheThreshold: parseFloat(process.env.WAN_EASYCACHE_THRESHOLD || '0.15'),
      steps: parseInt(process.env.WAN_STEPS || '15', 10),
      keyframeSteps: parseInt(process.env.WAN_KEYFRAME_STEPS || '10', 10),
      width: parseInt(process.env.WAN_WIDTH || '832', 10),
      height: parseInt(process.env.WAN_HEIGHT || '480', 10),
      fps: parseInt(process.env.WAN_FPS || '24', 10),
      shift: parseFloat(process.env.WAN_SHIFT || '8.0'),
      cfg: parseFloat(process.env.WAN_CFG || '5.0'),
    };
  }

  constructor(
    comfyHost = process.env.COMFYUI_HOST || 'http://127.0.0.1:8188',
    serverBaseUrl = process.env.SERVER_BASE_URL || 'http://127.0.0.1:5000',
    storageVideosDir = path.resolve('storage', 'videos'),
    storageKeyframesDir = path.resolve('storage', 'keyframes')
  ) {
    this.comfyHost = comfyHost.replace(/\/$/, '');
    this.serverBaseUrl = serverBaseUrl.replace(/\/$/, '');
    this.storageVideosDir = storageVideosDir;
    this.storageKeyframesDir = storageKeyframesDir;

    fs.mkdirSync(this.storageVideosDir, { recursive: true });
    fs.mkdirSync(this.storageKeyframesDir, { recursive: true });
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
    const detectedMood: MoodStyle = moodHint || 'ETHEREAL_LUCID';

    let keyframePrompt = '';
    let motionPrompt = '';
    let cameraMotion = '';
    let visualElements = {
      setting: '',
      surrealTwist: '',
      lighting: ''
    };

    switch (detectedMood) {
      case 'SURREAL_CYBERPUNK':
        keyframePrompt = `Wide aerial establishing shot of a futuristic cyberpunk megacity at night: ${cleanText}. Dozens of towering dark skyscrapers stretching to the horizon, giant neon billboards on facades in vibrant cyan and magenta, small flying cars with glowing headlights between towers, clean wet reflective surfaces, sharp architectural geometry, photorealistic sharp detail.`;
        motionPrompt = 'Slow steady forward drone flight over the futuristic city. Flying vehicles glide slowly through the frame between skyscrapers, neon signs softly flicker, light rain drifts smoothly. Continuous 24fps motion.';
        cameraMotion = 'Slow forward aerial drone glide between skyscrapers';
        visualElements = {
          setting: 'Dense vertical megacity with towering brutalist skyscrapers and skybridges',
          surrealTwist: 'Holographic neon advertisements and airborne transit lanes',
          lighting: 'High-contrast cyan and magenta neon illumination with clean wet reflections'
        };
        break;

      case 'NOSTALGIC_FOG':
        keyframePrompt = `Vintage 35mm film still: ${cleanText}. Muted color palette, nostalgic atmospheric dreamscape, soft rim light, clean focal composition, fine film grain, evocative cinema aesthetic.`;
        motionPrompt = 'Slow contemplative camera push forward. Soft atmospheric dust motes gently drifting, subtle ambient light shifting, smooth calm motion.';
        cameraMotion = 'Slow contemplative dolly tracking push';
        visualElements = {
          setting: 'Misty nostalgic landscape with vintage timeless architecture',
          surrealTwist: 'Dreamlike memories suspended in soft atmospheric light',
          lighting: 'Muted warm dawn glow with soft cinematic shadows'
        };
        break;

      case 'DEEP_OCEAN':
        keyframePrompt = `Deep oceanic abyss: ${cleanText}. Underwater bioluminescent glow in azure and deep indigo, floating aquatic structures, shimmering caustic light patterns dancing across surfaces, cinematic wide angle, sharp detail.`;
        motionPrompt = 'Submerged underwater slow forward drift. Floating bioluminescent plankton swirling gently, flowing fluid currents, smooth underwater camera motion.';
        cameraMotion = 'Submerged fluid forward drift with gentle vertical sway';
        visualElements = {
          setting: 'Submerged oceanic abyss with colossal bioluminescent architecture',
          surrealTwist: 'Weightless aquatic dreamscape with floating luminescent elements',
          lighting: 'Deep indigo water with vibrant bioluminescent cyan caustics'
        };
        break;

      case 'FLOATING_SKY':
        keyframePrompt = `High altitude panoramic view: ${cleanText}. Floating architectural monoliths above expansive golden clouds, brilliant daylight, vast infinite horizon, crisp architectural edges, cinematic scale.`;
        motionPrompt = 'Smooth aerial gliding flight above the cloud deck. Slow floating motion of architectural structures, drifting clouds, majestic wide camera glide.';
        cameraMotion = 'High altitude aerial forward glide with wide panoramic view';
        visualElements = {
          setting: 'Vast cloudscape horizon with colossal floating structures',
          surrealTwist: 'Gravity-defying architecture floating effortlessly above the clouds',
          lighting: 'Brilliant golden daylight casting sharp sunbeams across clouds'
        };
        break;

      case 'GOLDEN_DREAM':
        keyframePrompt = `Golden hour cinematic masterpiece: ${cleanText}. Warm amber and gilded sunlight, rich rim lighting, long dramatic shadows, atmospheric warmth, crisp focal elements, photorealistic quality.`;
        motionPrompt = 'Slow golden hour camera push. Shifting golden light rays, soft floating dust particles in sunbeams, smooth majestic motion.';
        cameraMotion = 'Majestic slow forward dolly push into the golden light';
        visualElements = {
          setting: 'Luminous dream realm bathed in eternal sunset',
          surrealTwist: 'Gilded surreal structures radiating warm amber light',
          lighting: 'Rich golden hour rim lighting with deep amber warmth'
        };
        break;

      case 'ETHEREAL_LUCID':
      default:
        keyframePrompt = `Lucid dream vision: ${cleanText}. Ethereal twilight illumination, clean surreal architectural composition, iridescent accents, crisp subject focus, magical realism, cinematic wide shot.`;
        motionPrompt = 'Smooth weightless forward drift. Gentle shimmering light particles, subtle environmental motion, hypnotic calm cinematic movement.';
        cameraMotion = 'Slow forward tracking push with gentle weightless float';
        visualElements = {
          setting: 'Luminous surreal horizon with dream architecture',
          surrealTwist: 'Weightless gravity-defying forms and iridescent light',
          lighting: 'Soft twilight radiance with clean atmospheric clarity'
        };
        break;
    }

    return {
      refinedPrompt: keyframePrompt,
      keyframePrompt,
      motionPrompt,
      negativePrompt: SafetyShield.getNegativePrompt(),
      cameraMotion,
      detectedMood,
      visualElements
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
   * Generate 100% genuine GPU keyframes using Wan 2.2 length:1 text-to-image.
   * In Comfy mode, this does NOT fall back to Unsplash stock photos.
   * Generates `count` distinct seeds in a single cached ComfyUI execution graph.
   */
  public async generateKeyframes(keyframePrompt: string, count: number = 3): Promise<KeyframeOption[]> {
    console.log(`🎨 [ComfyDreamProvider] Generating ${count} genuine GPU keyframes via Wan 2.2...`);

    const baseSeed = Math.floor(Math.random() * 8000000000000000);
    const kfPrompt: Record<string, any> = {
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
          "reuse_threshold": this.config.easyCacheThreshold,
          "start_percent": 0.15,
          "end_percent": 0.95,
          "verbose": false,
          "model": ["37", 0]
        }
      },
      "48": {
        "class_type": "ModelSamplingSD3",
        "inputs": {
          "shift": this.config.shift,
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
          "text": this.sanitizeForPrompt(keyframePrompt),
          "clip": ["38", 0]
        }
      },
      "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": `${SafetyShield.getNegativePrompt()}, blurry, low resolution, flat lighting, muddy textures, deformed, oversaturated, obscuring thick fog, dark smear, watermark, cartoon, 3d render`,
          "clip": ["38", 0]
        }
      },
      "55": {
        "class_type": "Wan22ImageToVideoLatent",
        "inputs": {
          "width": this.config.width,
          "height": this.config.height,
          "length": 1, // 1 frame produces a single still keyframe
          "batch_size": 1,
          "vae": ["39", 0]
        }
      }
    };

    // Construct distinct KSamplers and SaveImage nodes for each keyframe in the same prompt
    const saveNodeIds: string[] = [];
    const seeds: number[] = [];

    for (let i = 0; i < count; i++) {
      const seed = baseSeed + (i * 1013904223);
      seeds.push(seed);
      const ksamplerId = `ksampler_kf_${i + 1}`;
      const vaeDecodeId = `vaedecode_kf_${i + 1}`;
      const saveImageId = `saveimage_kf_${i + 1}`;
      saveNodeIds.push(saveImageId);

      kfPrompt[ksamplerId] = {
        "class_type": "KSampler",
        "inputs": {
          "seed": seed,
          "steps": this.config.keyframeSteps,
          "cfg": this.config.cfg,
          "sampler_name": "uni_pc",
          "scheduler": "simple",
          "denoise": 1,
          "model": ["48", 0],
          "positive": ["6", 0],
          "negative": ["7", 0],
          "latent_image": ["55", 0]
        }
      };

      kfPrompt[vaeDecodeId] = {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [ksamplerId, 0],
          "vae": ["39", 0]
        }
      };

      kfPrompt[saveImageId] = {
        "class_type": "SaveImage",
        "inputs": {
          "filename_prefix": `keyframe/DreamViewer_KF_${i + 1}`,
          "images": [vaeDecodeId, 0]
        }
      };
    }

    const queueRes = await fetch(`${this.comfyHost}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: kfPrompt })
    });

    if (!queueRes.ok) {
      const errText = await queueRes.text();
      throw new Error(`ComfyUI rejected keyframe prompt queue (${queueRes.status}): ${errText}`);
    }

    const queueData = (await queueRes.json()) as any;
    const promptId = queueData.prompt_id;
    console.log(`🚀 [ComfyDreamProvider] Keyframe prompt enqueued with ID: ${promptId}`);

    // Poll for keyframe completion (up to 90 seconds for 3 keyframes)
    const startTime = Date.now();
    const timeoutMs = 90_000;
    let completedItem: any = null;

    try {
      while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, 1500));
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

          if (item.outputs && Object.keys(item.outputs).length >= count) {
            completedItem = item;
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
    }

    // Process and persist all generated keyframe images into server storage
    const keyframes: KeyframeOption[] = [];
    const outputs = completedItem.outputs;

    for (let i = 0; i < saveNodeIds.length; i++) {
      const nodeId = saveNodeIds[i];
      const nodeOut = outputs[nodeId];
      if (!nodeOut || !nodeOut.images || nodeOut.images.length === 0) {
        throw new Error(`Expected image output missing for keyframe node ${nodeId}`);
      }

      const outImg = nodeOut.images[0];
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
        seed: seeds[i],
        isMock: false, // 100% genuine GPU generated keyframe!
        isSelected: i === 0
      });
    }

    console.log(`✅ [ComfyDreamProvider] Successfully generated and stored ${keyframes.length} GPU keyframes.`);
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
    cameraMotion: string
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
        "class_type": "VAEDecode",
        "inputs": {
          "samples": ["3", 0],
          "vae": ["39", 0]
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

    // 4. Send workflow to ComfyUI /prompt
    const queueResponse = await fetch(`${this.comfyHost}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflowPrompt })
    });

    if (!queueResponse.ok) {
      const errText = await queueResponse.text();
      throw new Error(`ComfyUI rejected prompt queue (${queueResponse.status}): ${errText}`);
    }

    const queueData = (await queueResponse.json()) as any;
    const promptId = queueData.prompt_id;
    console.log(`🚀 [ComfyDreamProvider] Prompt enqueued with ID: ${promptId}`);

    // 5. Poll /history/{prompt_id} until completed (up to 300 seconds)
    const startTime = Date.now();
    const timeoutMs = 300_000;
    let completedHistory: any = null;

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
