import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  OPENCODE_API_KEY: z.string().min(1),
  OPENCODE_VISION_BASE_URL: z.string().url().default('https://opencode.ai/zen/v1'),
  VISION_MODEL: z.string().default('gpt-5.4-nano'),
  VISION_MAX_FRAMES_PER_CLIP: z.coerce.number().int().min(1).default(6),
  OPENCODE_TEXT_BASE_URL: z.string().url().default('https://opencode.ai/zen/go/v1'),
  TEXT_MODEL: z.string().default('glm-5.2'),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  INPUT_DIR: z.string().default('./input'),
  OUTPUT_DIR: z.string().default('./output'),
  MUSIC_DIR: z.string().default('./assets/music'),
  TEMP_DIR: z.string().default('./.tmp'),
  MAX_DURATION_SEC: z.coerce.number().int().positive().default(60),
  MIN_SEGMENT_SEC: z.coerce.number().positive().default(1.2),
  MAX_SEGMENT_SEC: z.coerce.number().positive().default(6),
  CROSSFADE_SEC: z.coerce.number().min(0).default(0.3),
  TARGET_LUFS: z.coerce.number().default(-14),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
