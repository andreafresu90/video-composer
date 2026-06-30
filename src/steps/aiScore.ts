import type { ClipProbe, ClipScore, ComposerOptions, FrameScore, Keyframe, Mood } from '../types.js';
import type { VisionClient } from '../ai/visionClient.js';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export async function scoreClipFrames(client: VisionClient, frames: Keyframe[]): Promise<FrameScore[]> {
  const result = await client.scoreFrames(frames);
  return result.scores;
}

function modeMood(scores: FrameScore[]): Mood {
  const counts = new Map<Mood, number>();
  for (const s of scores) counts.set(s.mood, (counts.get(s.mood) ?? 0) + 1);
  let best: Mood = 'neutral';
  let bestN = -1;
  for (const [m, n] of counts) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return best;
}

export function selectBestSegment(
  probe: ClipProbe,
  scores: FrameScore[],
  options: ComposerOptions,
): ClipScore {
  const clipPath = probe.path;
  if (scores.length === 0) {
    return fallbackScore(probe, options);
  }
  const maxLen = Math.min(options.maxSegmentSec, probe.durationSec - 0.6);
  const minLen = options.minSegmentSec;
  if (maxLen < minLen) {
    return fallbackScore(probe, options);
  }
  const sorted = [...scores].sort((a, b) => a.timeSec - b.timeSec);
  const times = sorted.map((s) => s.timeSec);
  const values = sorted.map((s) => {
    let v = 0.5 * s.aesthetic + 0.3 * s.emotionalWarmth + 0.2 * s.motionLevel;
    if (s.framingQuality !== undefined) {
      v = 0.4 * s.aesthetic + 0.25 * s.emotionalWarmth + 0.15 * s.motionLevel + 0.2 * s.framingQuality;
    }
    if (s.facePosition === 'out-of-frame') v *= 0.5;
    if (s.facePosition === 'none' && s.personVisible === true) v *= 0.7;
    const sharpMul = s.sharpness !== undefined ? 0.7 + 0.3 * (s.sharpness / 10) : 1;
    const expoMul = exposureMultiplier(s.exposure);
    return v * sharpMul * expoMul;
  });

  const start = times[0] ?? 0;
  const end = (times[times.length - 1] ?? probe.durationSec) + 0.1;
  const usableStart = clamp(start - 0.2, 0.3, Math.max(0.3, probe.durationSec - 0.3));
  const usableEnd = clamp(end + 0.2, 0.3, probe.durationSec - 0.3);
  const usableSpan = usableEnd - usableStart;
  if (usableSpan <= 0) return fallbackScore(probe, options);

  const targetLen = Math.min(maxLen, probe.durationSec - 0.6);
  const clampedTarget = Math.max(minLen, targetLen);
  let bestStart = clamp(
    (sorted[0].timeSec + sorted[sorted.length - 1].timeSec) / 2 - clampedTarget / 2,
    0.3,
    Math.max(0.3, probe.durationSec - 0.3 - clampedTarget),
  );
  let bestScore = -Infinity;
  const step = Math.max(0.2, clampedTarget / 12);
  for (let s = 0.3; s + clampedTarget <= probe.durationSec - 0.3 + 1e-6; s += step) {
    const winScore = windowScore(s, s + clampedTarget, times, values);
    if (winScore > bestScore) {
      bestScore = winScore;
      bestStart = s;
    }
  }
  let segStart = clamp(bestStart, 0.3, Math.max(0.3, probe.durationSec - clampedTarget - 0.3));
  let segEnd = segStart + clampedTarget;
  if (segEnd > probe.durationSec - 0.3) {
    segEnd = probe.durationSec - 0.3;
    segStart = Math.max(0.3, segEnd - targetLen);
  }
  const overall = bestScore > -Infinity ? bestScore : avg(values);
  return {
    clipId: probe.clipId,
    clipPath,
    overallScore: clamp(overall, 1, 10),
    bestSegmentStartSec: segStart,
    bestSegmentEndSec: segEnd,
    mood: modeMood(sorted),
    frameScores: sorted,
  };
}

function windowScore(s0: number, s1: number, times: number[], values: number[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= s0 && times[i] <= s1) {
      sum += values[i];
      n++;
    }
  }
  if (n === 0) return -Infinity;
  const inside = sum / n;
  const coverage = clamp01(n / Math.max(1, times.length));
  return inside * (0.7 + 0.3 * coverage);
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 5;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function exposureMultiplier(exposure?: number): number {
  if (exposure === undefined) return 1;
  if (exposure < 2.5) return 0.6;
  if (exposure < 4) return 0.85;
  if (exposure > 8.5) return 0.7;
  if (exposure > 7.5) return 0.9;
  return 1;
}

function fallbackScore(probe: ClipProbe, options: ComposerOptions): ClipScore {
  const segLen = Math.min(options.maxSegmentSec, Math.max(0, probe.durationSec - 0.6));
  const start = clamp((probe.durationSec - segLen) / 2, 0.3, Math.max(0.3, probe.durationSec - 0.3 - segLen));
  return {
    clipId: probe.clipId,
    clipPath: probe.path,
    overallScore: 5,
    bestSegmentStartSec: start,
    bestSegmentEndSec: start + segLen,
    mood: 'neutral',
    frameScores: [],
  };
}

export function scoreClipDeterministic(
  probe: ClipProbe,
  scenes: { length: number },
  options: ComposerOptions,
): ClipScore {
  const density = probe.durationSec > 0 ? scenes.length / probe.durationSec : 0;
  const overallScore = clamp(density * 3 + 2, 1, 10);
  const segLen = Math.min(options.maxSegmentSec, Math.max(0, probe.durationSec - 0.6));
  const start = clamp((probe.durationSec - segLen) / 2, 0.3, Math.max(0.3, probe.durationSec - 0.3 - segLen));
  return {
    clipId: probe.clipId,
    clipPath: probe.path,
    overallScore,
    bestSegmentStartSec: start,
    bestSegmentEndSec: start + segLen,
    mood: 'neutral',
    frameScores: [],
  };
}
