import { z } from 'zod';

export const MOOD_STYLES = [
  'ETHEREAL_LUCID',
  'NOSTALGIC_FOG',
  'SURREAL_CYBERPUNK',
  'DEEP_OCEAN',
  'FLOATING_SKY',
  'GOLDEN_DREAM'
] as const;

export const DreamScenePlanSchema = z.object({
  sceneNumber: z.number().int().min(1).max(3),
  summary: z.string().min(2).max(250),
  mood: z.enum(MOOD_STYLES),
  keyframePrompt: z.string().min(10).max(1000),
  motionPrompt: z.string().min(10).max(1000),
  cameraMotion: z.string().min(5).max(300)
});

export const DreamArchitectResponseSchema = z.object({
  safety: z.object({
    allowed: z.boolean(),
    category: z.string().nullable()
  }),
  scenes: z.array(DreamScenePlanSchema).min(1).max(3)
});

export type DreamScenePlanValidated = z.infer<typeof DreamScenePlanSchema>;
export type DreamArchitectResponseValidated = z.infer<typeof DreamArchitectResponseSchema>;

/**
 * Strict JSON Schema for OpenAI-compatible structured output
 * (Supported by LM Studio, OpenAI, Groq, etc. via response_format: { type: "json_schema", ... })
 */
export const DREAM_ARCHITECT_JSON_SCHEMA = {
  name: "dream_architect_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      safety: {
        type: "object",
        properties: {
          allowed: {
            type: "boolean",
            description: "false if prompt contains prohibited real violence, sexual content, or real personal attacks; true otherwise"
          },
          category: {
            type: ["string", "null"],
            description: "Violation category if not allowed, or null"
          }
        },
        required: ["allowed", "category"],
        additionalProperties: false
      },
      scenes: {
        type: "array",
        description: "List of 1 to 3 distinct scenes based on physical spatial/location changes",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            sceneNumber: {
              type: "integer",
              description: "1-indexed sequential scene number (1, 2, or 3)"
            },
            summary: {
              type: "string",
              description: "Short scene title in the user's language (e.g. 'Derin sularda yüzüş')"
            },
            mood: {
              type: "string",
              enum: MOOD_STYLES,
              description: "Artistic mood lighting and color palette for this scene"
            },
            keyframePrompt: {
              type: "string",
              description: "Highly descriptive cinematic keyframe image prompt in ENGLISH for Wan 2.2 diffusion"
            },
            motionPrompt: {
              type: "string",
              description: "Dedicated fluid motion and environmental animation prompt in ENGLISH"
            },
            cameraMotion: {
              type: "string",
              description: "Cinematic camera movement description (e.g. 'Slow forward dolly tracking push')"
            }
          },
          required: ["sceneNumber", "summary", "mood", "keyframePrompt", "motionPrompt", "cameraMotion"],
          additionalProperties: false
        }
      }
    },
    required: ["safety", "scenes"],
    additionalProperties: false
  }
};
