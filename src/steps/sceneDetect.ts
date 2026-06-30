import type { ClipProbe, SceneBoundary } from '../types.js';
import type { FfmpegRunner } from '../ffmpeg/runner.js';

export interface SceneDetectOptions {
  threshold: number;
}

export async function detectScenes(
  runner: FfmpegRunner,
  probe: ClipProbe,
  options: SceneDetectOptions = { threshold: 0.3 },
): Promise<SceneBoundary[]> {
  const filter = `select='gt(scene,${options.threshold.toFixed(2)})',showinfo`;
  const result = await runner.ffmpeg([
    '-hide_banner',
    '-i',
    probe.path,
    '-filter_complex',
    filter,
    '-f',
    'null',
    '-',
  ]);
  const boundaries: SceneBoundary[] = [];
  const lineRegex = /pts_time:(\d+(?:\.\d+)?)/;
  const scoreRegex = /scene_score\s*=?\s*(\d+(?:\.\d+)?)/i;
  for (const line of result.stderr.split(/\r?\n/)) {
    if (!line.includes('showinfo')) continue;
    const t = lineRegex.exec(line)?.[1];
    if (!t) continue;
    const timeSec = Number(t);
    if (!Number.isFinite(timeSec)) continue;
    const score = Number(scoreRegex.exec(line)?.[1] ?? '1');
    boundaries.push({ clipId: probe.clipId, timeSec, score });
  }
  return boundaries;
}
