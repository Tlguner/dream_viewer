# 🌌 DreamViewer — AI Lucid Dream Visualizer

> Transform fragmented memories and dreams into cinematic, surreal visual stories. Built with an ultra-efficient unit-economic architecture: **Keyframe approval first**, **12fps "on-twos" frame doubling**, and a **4-Layer Safety Shield**.

---

## 🌟 Key Highlights

- **4-Layer Safety Shield**: Enforces strict G/PG safety. Profanity, nudity, +18, and graphic violence are rejected at the prompt stage before consuming any compute.
- **Dream Architect Directive**: Uses an LLM to refine messy dream descriptions into cinematic camera movements, volumetric lighting, and silhouettes without identifiable faces.
- **Keyframe-First Approval**: Users generate and iterate on cheap image keyframes (~$0.002). Only the approved keyframe is animated into a video.
- **On-Twos Temporal Engine (Spider-Verse Effect)**: Generates a 5s clip and plays it at 12fps holding frames on twos. Perceived runtime doubles to 10s at 50% of the API cost with an intentional, artistic dream-stutter.
- **$0 Web Audio Soundscape**: Client-side procedural ambient sound generator (warm sub-bass drone, ethereal harmonics, vinyl textures). Zero audio API cost.
- **Real-Time WebGL/CSS Shaders**: Dream Haze, Retro VHS scanlines, and Halftone presets rendered on the client.

---

## 🛠️ Tech Stack & DevOps

| Layer                | Technology                                                                     |
| :------------------- | :----------------------------------------------------------------------------- |
| **Frontend**         | React 19, TypeScript, Tailwind CSS, Vite, Lucide Icons, Web Audio API          |
| **Backend**          | Node.js, Express, TypeScript, BullMQ, Prisma ORM                               |
| **Database & Cache** | PostgreSQL 16 + Redis 7 (Docker Compose ready)                                 |
| **CI/CD**            | GitHub Actions (`.github/workflows/ci.yml`)                                    |
| **AI Architecture**  | Modular Provider Pattern (`MockDreamProvider`, `ComfyProvider`, `FalProvider`) |

---

## 🚀 Quick Start

### 1. Start Database & Redis (Optional / Local Dev)

```bash
docker compose up -d
```

### 2. Start the Backend API Server

```bash
cd server
npm install
npm run build
npm start
```

_Server runs on [http://localhost:5000](http://localhost:5000)._

### 3. Start the Frontend Client

```bash
cd client
npm install
npm run dev
```

_Open [http://localhost:5173](http://localhost:5173) in your browser._

---

## 🧪 Testing the API Flow

Run the automated test suite verifying the 4-layer moderation shield, keyframe generation, and video generation:

```bash
node test_api.mjs
```
