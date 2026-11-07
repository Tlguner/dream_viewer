import os
import sys
import uuid
import time

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

import torch
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="DreamViewer Open-Source Video Generator")

# Enable CORS for frontend and server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Output directory for generated MP4 files
VIDEOS_DIR = Path(__file__).parent / "static_videos"
VIDEOS_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/videos", StaticFiles(directory=str(VIDEOS_DIR)), name="videos")

# Model configuration
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MODEL_ID = os.getenv("VIDEO_MODEL_ID", "Lightricks/LTX-Video")
pipeline = None
is_model_loading = False

class VideoRequest(BaseModel):
    prompt: str
    negative_prompt: str = "nsfw, nude, gore, ugly, deformed, blurry, close-up face"
    num_frames: int = 25
    fps: int = 12
    width: int = 704
    height: int = 480

def get_gpu_info():
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        vram_total = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        vram_allocated = torch.cuda.memory_allocated(0) / (1024**3)
        return {
            "gpu": gpu_name,
            "vram_total_gb": round(vram_total, 2),
            "vram_allocated_gb": round(vram_allocated, 2),
            "device": DEVICE
        }
    return {"device": "cpu", "gpu": "None"}

def load_video_pipeline():
    global pipeline, is_model_loading
    if pipeline is not None or is_model_loading:
        return

    is_model_loading = True
    print(f"⏳ Loading open-source video model: {MODEL_ID} on {DEVICE}...")

    try:
        from diffusers import LTXPipeline
        pipe = LTXPipeline.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        )

        # Optimize for 8GB VRAM (offload components to CPU when idle)
        if torch.cuda.is_available():
            pipe.enable_model_cpu_offload()

        pipeline = pipe
        print("✅ Open-source video model successfully loaded into memory!")
    except Exception as e:
        print(f"⚠️ Failed to load model '{MODEL_ID}': {e}")
        print("ℹ️ Note: If weights are still downloading, requests will use fallback or queue.")
    finally:
        is_model_loading = False

@app.get("/health")
def health():
    return {
        "status": "online",
        "model_id": MODEL_ID,
        "model_loaded": pipeline is not None,
        "gpu_info": get_gpu_info()
    }

@app.post("/api/load-model")
def trigger_load():
    """Trigger background downloading and loading of the open-source weights"""
    import threading
    thread = threading.Thread(target=load_video_pipeline)
    thread.start()
    return {"status": "started", "message": "Model load initiated in background"}

@app.post("/api/generate-video")
async def generate_video(req: VideoRequest):
    print(f"\n🎬 [GENERATE REQUEST RECEIVED]")
    print(f"Prompt: {req.prompt}")
    print(f"Negative: {req.negative_prompt}")
    print(f"Frames: {req.num_frames} @ {req.fps} fps")

    filename = f"dream_{uuid.uuid4().hex[:8]}.mp4"
    output_path = VIDEOS_DIR / filename

    if pipeline is not None:
        try:
            print("🚀 Generating real video with open-source pipeline on GPU...")
            start_time = time.time()
            
            # Run diffusion inference
            result = pipeline(
                prompt=req.prompt,
                negative_prompt=req.negative_prompt,
                width=req.width,
                height=req.height,
                num_frames=req.num_frames,
                num_inference_steps=20,
            )

            # Export video frames to MP4
            from diffusers.utils import export_to_video
            export_to_video(result.frames[0], str(output_path), fps=req.fps)
            
            elapsed = round(time.time() - start_time, 2)
            print(f"✨ Video saved to {output_path} in {elapsed}s!")

            return {
                "success": True,
                "video_url": f"http://localhost:8000/videos/{filename}",
                "duration_seconds": req.num_frames // req.fps,
                "fps": req.fps,
                "generation_time_seconds": elapsed,
                "mode": "real_gpu_inference"
            }
        except Exception as e:
            print(f"❌ Error during GPU generation: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    else:
        print("❌ Video model weights are not loaded in memory.")
        raise HTTPException(
            status_code=503,
            detail="Open-source video model weights are not loaded into memory. Please download/load the model in ComfyUI or trigger /api/load-model."
        )

if __name__ == "__main__":
    import uvicorn
    print("✨ Starting DreamViewer Open-Source Video Generator on port 8000...")
    uvicorn.run(app, host="0.0.0.0", port=8000)
