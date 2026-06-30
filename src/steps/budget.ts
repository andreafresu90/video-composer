import type { ClipScore, ComposerOptions, CutSegment, TransitionType } from '../types.js';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function allocateBudget(scores: ClipScore[], options: ComposerOptions): CutSegment[] {
  if (scores.length === 0) return [];
  const weights = scores.map((s) => Math.max(0.1, s.overallScore));
  const sumWeight = weights.reduce((a, b) => a + b, 0);
  const segments: CutSegment[] = [];
  let remaining = options.maxDurationSec;
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    const clipDur = score.bestSegmentEndSec - score.bestSegmentStartSec;
    if (clipDur <= 0 || remaining <= 0) continue;
    const ideal = (weights[i] / sumWeight) * options.maxDurationSec;
    let dur = clamp(ideal, options.minSegmentSec, Math.min(options.maxSegmentSec, clipDur));
    dur = Math.min(dur, remaining);
    if (dur < options.minSegmentSec) continue;
    remaining -= dur;
    const transitionIn: TransitionType = i === 0 ? 'none' : 'crossfade';
    segments.push({
      clipId: score.clipId,
      clipPath: score.clipPath,
      startSec: score.bestSegmentStartSec,
      endSec: score.bestSegmentStartSec + dur,
      order: i,
      transitionIn,
    });
  }
  return segments;
}
