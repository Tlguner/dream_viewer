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

  constructor(comfyHost = process.env.COMFYUI_HOST || 'http://127.0.0.1:8188') {
    this.comfyHost = comfyHost.replace(/\/$/, '');
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
    const detectedMood = moodHint || 'ETHEREAL_LUCID';

    // Cinematic prompt refinement tailored for Wan 2.2 diffusion video
    const refinedPrompt = `Surreal ethereal dreamscape: ${cleanText}. Volumetric fog, chromatic lighting, anamorphic lens flare, deep cosmic haze, solitary silhouette seen strictly from behind in shadows, no visible human face, magical realism, 35mm film grain, 8k cinematic masterpiece.`;
    const cameraMotion = 'Slow forward dolly tracking push with hypnotic subtle rotational tilt and floating weightlessness';

    return {
      refinedPrompt,
      negativePrompt: SafetyShield.getNegativePrompt(),
      cameraMotion,
      detectedMood,
      visualElements: {
        setting: 'Floating architectural horizon enveloped in luminous twilight mist',
        surrealTwist: 'Gravity-defying elements rippling with iridescent light particles',
        lighting: 'Volumetric bioluminescent beams and deep atmospheric shadows'
      }
    };
  }

  public async generateKeyframes(refinedPrompt: string, count: number = 3): Promise<KeyframeOption[]> {
    // High-resolution artistic composition anchors for keyframe selection
    // Explicitly marked as isMock: true to avoid misleading the user until a dedicated
    // local text-to-image keyframe pipeline is loaded into ComfyUI.
    const anchorPresets = [
      'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1200&q=80'
    ];

    return anchorPresets.slice(0, count).map((url, index) => ({
      id: `comfy_kf_${Date.now()}_${index + 1}`,
      imageUrl: url,
      aspectRatio: '16:9',
      seed: Math.floor(Math.random() * 9999999),
      isMock: true, // Honestly flagged: curated anchor composition
      isSelected: index === 0
    }));
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
   * Fetch image bytes from URL or local file
   */
  private async fetchImageBytes(imageUrl: string): Promise<Buffer> {
    const res = await fetch(imageUrl);
    if (!res.ok) {
      throw new Error(`Failed to retrieve keyframe image from ${imageUrl}: ${res.statusText}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /**
   * Submit and poll Wan 2.2 I2V workflow on ComfyUI
   */
  public async generateVideo(
    selectedKeyframe: KeyframeOption,
    prompt: string,
    _cameraMotion: string
  ): Promise<DreamVideoResult> {
    console.log(`📡 [ComfyDreamProvider] Starting Image-to-Video generation on ComfyUI at ${this.comfyHost}...`);

    // 1. Fetch Keyframe image
    const imageBytes = await this.fetchImageBytes(selectedKeyframe.imageUrl);
    const uploadedFilename = `dream_kf_${Date.now()}.png`;

    // 2. Upload to ComfyUI
    const comfyImageName = await this.uploadImageToComfy(imageBytes, uploadedFilename);
    console.log(`🖼️ [ComfyDreamProvider] Keyframe uploaded to ComfyUI as: ${comfyImageName}`);

    // 3. Build Wan 2.2 5B + EasyCache Image-to-Video Graph
    const seed = Math.floor(Math.random() * 9007199254740991);
    const videoFrames = 81; // 81 frames @ 24fps (~3.4s native, ~6.8s on-twos). Safe for 8GB VRAM.

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
          "reuse_threshold": 0.2,
          "start_percent": 0.15,
          "end_percent": 0.95,
          "verbose": false,
          "model": ["37", 0]
        }
      },
      "48": {
        "class_type": "ModelSamplingSD3",
        "inputs": {
          "shift": 8.0,
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
          "text": this.sanitizeForPrompt(prompt),
          "clip": ["38", 0]
        }
      },
      "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "nsfw, nude, naked, erotic, gore, blood, violence, close-up human face, cartoon, 3d render, cgi, flat lighting, blurry, low resolution, watermark",
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
          "width": 832,
          "height": 480,
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
          "steps": 15,
          "cfg": 5,
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
          "fps": 24,
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

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(r => setTimeout(r, 2000));

      const histRes = await fetch(`${this.comfyHost}/history/${promptId}`);
      if (!histRes.ok) continue;

      const histData = (await histRes.json()) as any;
      if (histData && histData[promptId]) {
        const item = histData[promptId];
        if (item.status?.status_str === 'error') {
          const errMsg = item.status?.messages?.[0]?.[1]?.message || 'ComfyUI execution error';
          throw new Error(`ComfyUI workflow failed: ${errMsg}`);
        }

        if (item.outputs && Object.keys(item.outputs).length > 0) {
          completedHistory = item;
          break;
        }
      }
    }

    if (!completedHistory) {
      throw new Error(`ComfyUI video generation timed out after ${timeoutMs / 1000} seconds.`);
    }

    // 6. Find output video file
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

    const videoUrl = `${this.comfyHost}/view?filename=${encodeURIComponent(videoFilename)}&subfolder=${encodeURIComponent(videoSubfolder)}&type=output`;
    const nativeDuration = Math.round(videoFrames / 24); // ~3s
    const effectiveDuration = nativeDuration * 2;        // ~6s on-twos

    console.log(`🎬 [ComfyDreamProvider] Video successfully generated: ${videoUrl}`);

    return {
      id: `comfy_vid_${Date.now()}`,
      videoUrl,
      durationSeconds: nativeDuration,
      effectiveSeconds: effectiveDuration,
      fps: 24,
      playbackRate: 0.5,
      faceBlurred: false,
      audioMood: 'ethereal_lucid_pad',
      shaderPreset: 'dream_haze',
      isMock: false
    };
  }
}
