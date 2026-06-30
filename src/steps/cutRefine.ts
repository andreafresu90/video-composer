import type { ClipProbe, CutSegment, SceneBoundary } from '../types.js';

const SNAP_TOLERANCE_SEC = 0.4;
const EDGE_GUARD_SEC = 0.3;

function snapToScene(timeSec: number, scenes: SceneBoundary[], clipDuration: number): number {
  const candidates = [0, ...scenes.map((s) => s.timeSec), clipDuration];
  let best = timeSec;
  let bestDist = SNAP_TOLERANCE_SEC;
  for (const c of candidates) {
    const d = Math.abs(c - timeSec);
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function refineCuts(
  segments: CutSegment[],
  scenesByClip: Map<string, SceneBoundary[]>,
  probesByClip: Map<string, ClipProbe>,
  minSegmentSec: number,
  maxSegmentSec: number,
): CutSegment[] {
  const out: CutSegment[] = [];
  for (const seg of segments) {
    const probe = probesByClip.get(seg.clipId);
    if (!probe) continue;
    const scenes = scenesByClip.get(seg.clipId) ?? [];
    const dur = clipDurationSec(probe);
    let start = snapToScene(seg.startSec, scenes, dur);
    let end = snapToScene(seg.endSec, scenes, dur);
    start = clamp(start, EDGE_GUARD_SEC, Math.max(EDGE_GUARD_SEC, dur - EDGE_GUARD_SEC));
    end = clamp(end, EDGE_GUARD_SEC, Math.max(EDGE_GUARD_SEC, dur - EDGE_GUARD_SEC));
    let length = end - start;
    if (length > maxSegmentSec) {
      end = start + maxSegmentSec;
      length = maxSegmentSec;
    }
    if (length < minSegmentSec) {
      end = start + minSegmentSec;
      if (end > dur - EDGE_GUARD_SEC) {
        end = dur - EDGE_GUARD_SEC;
        start = Math.max(EDGE_GUARD_SEC, end - minSegmentSec);
      }
      length = end - start;
    }
    if (length < minSegmentSec) continue;
    out.push({ ...seg, startSec: start, endSec: end });
  }
  return out;
}

function clipDurationSec(probe: ClipProbe): number {
  return probe.durationSec;
}
