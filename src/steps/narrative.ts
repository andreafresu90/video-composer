import type { ClipScore, CutSegment } from '../types.js';

export function orderForNarrative(segments: CutSegment[], scores: ClipScore[]): CutSegment[] {
  if (segments.length <= 1) return segments;
  const scoreByClip = new Map(scores.map((s) => [s.clipId, s.overallScore]));
  const sorted = [...segments].sort((a, b) => {
    const sa = scoreByClip.get(a.clipId) ?? 0;
    const sb = scoreByClip.get(b.clipId) ?? 0;
    return sa - sb;
  });
  const peakIndex = sorted.length - 1;
  return sorted.map((seg, i) => ({
    ...seg,
    order: i,
    transitionIn: i === 0 ? 'none' : i === peakIndex ? 'crossfade' : seg.transitionIn,
  }));
}
