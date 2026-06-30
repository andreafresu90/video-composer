import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { Logger } from './utils/logger.js';
import type {
  ClipInput,
  ClipScore,
  ComposerOptions,
  CutSegment,
  FrameScore,
  MusicTrack,
  ReelOutput,
  ReelPlan,
  SceneBoundary,
} from './types.js';
import { createFfmpegRunner } from './ffmpeg/runner.js';
import { VisionClient } from './ai/visionClient.js';
import { detectFaces } from './vision/faceDetector.js';
import { probeClip } from './steps/probe.js';
import { detectScenes } from './steps/sceneDetect.js';
import { extractKeyframes, measureFrameTechnical } from './steps/keyframes.js';
import { scoreClipDeterministic, selectBestSegment } from './steps/aiScore.js';
import { allocateBudget } from './steps/budget.js';
import { refineCuts } from './steps/cutRefine.js';
import { orderForNarrative } from './steps/narrative.js';
import { analyzeMusic, listMusicTracks, selectMusicTrack, snapCutsToBeats } from './steps/musicSync.js';
import { composeReel } from './steps/compose.js';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

export interface PipelineInput {
  clips: ClipInput[];
  musicPath?: string;
  outputPath?: string;
  useAI: boolean;
  dryRun: boolean;
}

function scanClips(inputDir: string): ClipInput[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(inputDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => VIDEO_EXTS.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ id: f.replace(/\.[^.]+$/, ''), path: resolve(join(inputDir, f)) }));
}

function composerOptions(config: AppConfig): ComposerOptions {
  return {
    maxDurationSec: config.MAX_DURATION_SEC,
    minSegmentSec: config.MIN_SEGMENT_SEC,
    maxSegmentSec: config.MAX_SEGMENT_SEC,
    crossfadeSec: config.CROSSFADE_SEC,
    targetLufs: config.TARGET_LUFS,
    resolution: { width: 1080, height: 1920 },
    fps: 30,
  };
}

async function timed<T>(log: Logger, label: string, fn: () => Promise<T>): Promise<T>;
function timed<T>(log: Logger, label: string, fn: () => T): T;
function timed<T>(log: Logger, label: string, fn: () => Promise<T> | T): Promise<T> | T {
  const start = Date.now();
  log.info(`${label} …`);
  const maybe = fn();
  if (maybe instanceof Promise) {
    return maybe.then((r) => {
      log.info(`${label} done`, { ms: Date.now() - start });
      return r;
    });
  }
  log.info(`${label} done`, { ms: Date.now() - start });
  return maybe;
}

export async function runPipeline(config: AppConfig, log: Logger, input: PipelineInput): Promise<ReelOutput> {
  const opts = composerOptions(config);
  const runner = createFfmpegRunner(config.FFMPEG_PATH, config.FFPROBE_PATH);

  const clips = input.clips.length > 0 ? input.clips : scanClips(config.INPUT_DIR);
  if (clips.length === 0) {
    throw new Error(`No video clips found in ${config.INPUT_DIR}`);
  }
  log.info('clips discovered', { count: clips.length });

  const probes = await timed(log, 'probe', () => Promise.all(clips.map((c) => probeClip(runner, c))));
  const probesByClip = new Map(probes.map((p) => [p.clipId, p]));

  const scenesByClip = new Map<string, SceneBoundary[]>();
  for (const probe of probes) {
    const scenes = await timed(log, `sceneDetect[${probe.clipId}]`, () => detectScenes(runner, probe));
    scenesByClip.set(probe.clipId, scenes);
    log.debug('scenes', { clipId: probe.clipId, count: scenes.length });
  }

  const scores: ClipScore[] = [];
  const tempDir = resolve(join(config.TEMP_DIR, randomUUID()));
  mkdirSync(tempDir, { recursive: true });
  try {
    const vision = input.useAI
      ? new VisionClient({
          apiKey: config.OPENCODE_API_KEY,
          baseURL: config.OPENCODE_VISION_BASE_URL,
          model: config.VISION_MODEL,
          maxFramesPerClip: config.VISION_MAX_FRAMES_PER_CLIP,
        })
      : null;

    let aiAvailable = input.useAI;
    let aiSuccessCount = 0;
    for (const probe of probes) {
      const scenes = scenesByClip.get(probe.clipId) ?? [];
      if (!aiAvailable || !vision) {
        scores.push(scoreClipDeterministic(probe, scenes, opts));
        continue;
      }
      try {
        const frames = await timed(log, `keyframes[${probe.clipId}]`, () =>
          extractKeyframes(runner, probe, scenes, config.VISION_MAX_FRAMES_PER_CLIP, tempDir),
        );
        const frameScores: FrameScore[] = await timed(log, `aiScore[${probe.clipId}]`, () =>
          vision.scoreFrames(frames).then((r) => r.scores),
        );
        for (let k = 0; k < frameScores.length && k < frames.length; k++) {
          const m = await measureFrameTechnical(runner, frames[k].filePath);
          frameScores[k].sharpness = m.sharpness;
          frameScores[k].exposure = m.exposure;
          if (config.FACE_DETECT_ENABLED) {
            try {
              const fd = await detectFaces(
                runner,
                frames[k].filePath,
                resolve(config.FACE_DETECT_MODEL_PATH),
              );
              frameScores[k].personVisible = fd.personVisible;
              frameScores[k].facePosition = fd.facePosition;
              frameScores[k].framingQuality = fd.framingQuality;
            } catch (fdErr) {
              log.debug('faceDetect failed', { clipId: probe.clipId, error: (fdErr as Error).message });
            }
          }
        }
        const score = selectBestSegment(probe, frameScores, opts);
        scores.push(score);
        aiSuccessCount++;
        log.info('aiScore ok', {
          clipId: probe.clipId,
          overall: Number(score.overallScore.toFixed(2)),
          mood: score.mood,
          frames: frameScores.length,
          face: frameScores[0]?.facePosition,
          framing: frameScores[0]?.framingQuality,
          faces: frameScores.reduce((a, f) => a + (f.personVisible ? 1 : 0), 0),
          sharp: frameScores[0]?.sharpness,
          expo: frameScores[0]?.exposure,
        });
      } catch (err) {
        const e = err as { message?: string; status?: number; error?: { message?: string } };
        const msg = e.message ?? e.error?.message ?? String(err);
        const status = e.status;
        const isCreditOrVision = isCreditError(msg) || status === 400 || status === 402 || status === 404;
        if (isCreditOrVision) {
          aiAvailable = false;
          log.warn(
            'AI vision unavailable (insufficient balance or unsupported model); switching to deterministic scoring for all clips',
            { model: config.VISION_MODEL, status, error: msg },
          );
          scores.push(scoreClipDeterministic(probe, scenes, opts));
        } else {
          log.warn('aiScore failed for clip, using deterministic fallback', {
            clipId: probe.clipId,
            status,
            error: msg,
          });
          scores.push(scoreClipDeterministic(probe, scenes, opts));
        }
      }
    }
    log.info('scored clips', {
      count: scores.length,
      aiRequested: input.useAI,
      aiSucceeded: aiSuccessCount,
    });

    let segments: CutSegment[] = timed(log, 'budget', () => allocateBudget(scores, opts));
    segments = timed(log, 'cutRefine', () =>
      refineCuts(segments, scenesByClip, probesByClip, opts.minSegmentSec, opts.maxSegmentSec),
    );
    segments = timed(log, 'narrative', () => orderForNarrative(segments, scores));
    segments = markEmotionalPeak(segments, scores);
    log.info('emotional peak', {
      clipId: segments.find((s) => s.isEmotionalPeak)?.clipId ?? 'none',
    });

    if (segments.length === 0) {
      throw new Error('No segments survived budgeting/refinement');
    }
    log.info('plan built', { segments: segments.length, totalPlanned: segmentsTotal(segments) });

    const tracks = listMusicTracks(config.MUSIC_DIR);
    const dominantMood = pickDominantMood(scores);
    const music = selectMusicTrack(tracks, dominantMood, input.musicPath);
    if (!music) {
      throw new Error(
        `No music track available. Place royalty-free audio in ${config.MUSIC_DIR} or pass --music.`,
      );
    }
    log.info('music selected', { title: music.title, mood: dominantMood });

    const beats = await timed(log, 'analyzeMusic', () => analyzeMusic(runner, music));
    segments = timed(log, 'snapCutsToBeats', () => snapCutsToBeats(segments, beats, opts));

    const totalDurationSec = segmentsTotal(segments);
    const plan: ReelPlan = { segments, music, totalDurationSec, beats };

    if (input.dryRun) {
      log.info('dry-run: skipping compose', { plan });
      return { path: '', durationSec: totalDurationSec, sizeBytes: 0 };
    }

    const outputPath =
      input.outputPath ??
      join(config.OUTPUT_DIR, `reel-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`);
    mkdirSync(resolve(config.OUTPUT_DIR), { recursive: true });

    const out = await timed(log, 'compose', () =>
      composeReel(runner, plan, opts, tempDir, resolve(outputPath)),
    );
    log.info('reel ready', { path: out.path, durationSec: out.durationSec, sizeBytes: out.sizeBytes });
    return out;
  } finally {
    if (!input.dryRun && process.env.VC_KEEP_TEMP !== '1') {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function segmentsTotal(segments: CutSegment[]): number {
  return segments.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
}

function pickDominantMood(scores: ClipScore[]): MusicTrack['mood'] {
  const counts = new Map<MusicTrack['mood'], number>();
  for (const s of scores) counts.set(s.mood, (counts.get(s.mood) ?? 0) + 1);
  let best: MusicTrack['mood'] = 'neutral';
  let bestN = -1;
  for (const [m, n] of counts) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return best;
}

function isCreditError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('insufficient balance') ||
    m.includes('creditserror') ||
    m.includes('no endpoints found that support image') ||
    m.includes('unknown variant `image_url`') ||
    m.includes('free promotion has ended') ||
    m.includes('billing')
  );
}

function markEmotionalPeak(segments: CutSegment[], scores: ClipScore[]): CutSegment[] {
  let bestClipId: string | null = null;
  let bestWarmth = -1;
  for (const s of scores) {
    const warmth = peakWarmth(s);
    if (warmth > bestWarmth) {
      bestWarmth = warmth;
      bestClipId = s.clipId;
    }
  }
  if (!bestClipId) return segments;
  return segments.map((seg) => (seg.clipId === bestClipId ? { ...seg, isEmotionalPeak: true } : seg));
}

function peakWarmth(score: ClipScore): number {
  if (score.frameScores.length === 0) return score.overallScore * 0.5;
  return Math.max(...score.frameScores.map((f) => f.emotionalWarmth));
}
