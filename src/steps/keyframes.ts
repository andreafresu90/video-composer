import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ClipProbe, Keyframe, SceneBoundary } from '../types.js';
import type { FfmpegRunner } from '../ffmpeg/runner.js';

function sceneCenters(scenes: SceneBoundary[], durationSec: number): number[] {
  if (scenes.length === 0) return [durationSec / 2];
  const points = [0, ...scenes.map((s) => s.timeSec), durationSec];
  const centers: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    centers.push((points[i] + points[i + 1]) / 2);
  }
  return centers;
}

function uniformSample(times: number[], maxFrames: number): number[] {
  if (times.length <= maxFrames) return times;
  const step = (times.length - 1) / (maxFrames - 1);
  const out: number[] = [];
  for (let i = 0; i < maxFrames; i++) out.push(times[Math.round(i * step)]);
  return out;
}

export async function extractKeyframes(
  runner: FfmpegRunner,
  probe: ClipProbe,
  scenes: SceneBoundary[],
  maxFrames: number,
  outDir: string,
): Promise<Keyframe[]> {
  const centers = sceneCenters(scenes, probe.durationSec);
  const times = uniformSample(centers, Math.max(1, maxFrames));
  const frames: Keyframe[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const filePath = join(outDir, `${probe.clipId}_kf${String(i).padStart(2, '0')}.jpg`);
    await runner.ffmpeg([
      '-hide_banner',
      '-y',
      '-ss',
      t.toFixed(3),
      '-i',
      probe.path,
      '-frames:v',
      '1',
      '-vf',
      'scale=256:-2',
      '-q:v',
      '3',
      filePath,
    ]);
    frames.push({ clipId: probe.clipId, timeSec: t, filePath });
  }
  return frames;
}

export interface FrameTechnicalMetrics {
  sharpness: number;
  exposure: number;
}

export async function measureFrameTechnical(
  runner: FfmpegRunner,
  keyframePath: string,
): Promise<FrameTechnicalMetrics> {
  const tmpPath = join(tmpdir(), `vc_tech_${Date.now()}_${Math.random().toString(36).slice(2)}.raw`);
  try {
    await runner.ffmpeg([
      '-hide_banner',
      '-y',
      '-i',
      keyframePath,
      '-vf',
      'scale=128:-2,format=gray',
      '-f',
      'rawvideo',
      '-c:a',
      'pcm_s16le',
      tmpPath,
    ]);
    const pixels = readFileSync(tmpPath);
    return computeMetrics(new Uint8Array(pixels));
  } catch {
    return measureFromJpegFile(keyframePath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

function measureFromJpegFile(path: string): FrameTechnicalMetrics {
  try {
    const buf = readFileSync(path);
    return computeMetrics(new Uint8Array(buf));
  } catch {
    return { sharpness: 5, exposure: 5 };
  }
}

function computeMetrics(pixels: Uint8Array): FrameTechnicalMetrics {
  if (pixels.length === 0) return { sharpness: 5, exposure: 5 };
  const side = Math.round(Math.sqrt(pixels.length));
  const width = side > 0 ? side : 128;
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) sum += pixels[i];
  const mean = sum / pixels.length;
  let lapVar = 0;
  let count = 0;
  for (let y = 1; y < Math.floor(pixels.length / width) - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const center = pixels[idx];
      const lap = pixels[idx - width] + pixels[idx + width] + pixels[idx - 1] + pixels[idx + 1] - 4 * center;
      lapVar += lap * lap;
      count++;
    }
  }
  const variance = count > 0 ? lapVar / count : 0;
  const sharpness = Math.max(1, Math.min(10, Math.round(Math.log10(variance + 1) * 3 * 10) / 10));
  const exposure = Math.min(10, Math.max(1, Math.round((mean / 25.5) * 10) / 10));
  return { sharpness, exposure };
}
