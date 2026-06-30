import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BeatInfo, ComposerOptions, CutSegment, Mood, MusicTrack } from '../types.js';
import type { FfmpegRunner } from '../ffmpeg/runner.js';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const SAMPLE_RATE = 22050;
const FRAME_SIZE = 1024;
const HOP_SIZE = 512;
const ONSET_THRESHOLD = 1.5;
const MIN_BPM = 60;
const MAX_BPM = 200;
const SNAP_TOLERANCE_SEC = 0.15;

export function listMusicTracks(musicDir: string): MusicTrack[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(musicDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => AUDIO_EXTS.has(extname(f).toLowerCase()))
    .map((f) => ({
      path: join(musicDir, f),
      title: f.replace(/\.[^.]+$/, ''),
      mood: 'neutral' as Mood,
    }));
}

export function selectMusicTrack(
  tracks: MusicTrack[],
  requestedMood: Mood,
  musicPath?: string,
): MusicTrack | null {
  if (musicPath) return { path: musicPath, title: 'user-track', mood: requestedMood };
  if (tracks.length === 0) return null;
  const match = tracks.find((t) => t.mood === requestedMood);
  return match ?? tracks[0];
}

export async function analyzeMusic(runner: FfmpegRunner, track: MusicTrack): Promise<BeatInfo> {
  const probe = await runner.ffprobe(track.path);
  const durationSec = Number(probe.format.duration ?? 0);
  if (durationSec <= 0) return fallbackBeats(durationSec);

  const pcmPath = join(tmpdir(), `vc_pcm_${Date.now()}.raw`);
  try {
    await runner.ffmpeg([
      '-hide_banner',
      '-y',
      '-i',
      track.path,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      '-c:a',
      'pcm_f32le',
      pcmPath,
    ]);
    const buf = readFileSync(pcmPath);
    const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const onsets = detectOnsets(samples);
    const bpm = estimateBpm(onsets);
    const beats = alignBeats(onsets, bpm, durationSec);
    const confidence = onsets.length > 4 && bpm > 0 ? 0.7 : onsets.length > 0 ? 0.4 : 0;
    return { bpm, timesSec: beats, confidence };
  } catch {
    return fallbackBeats(durationSec);
  } finally {
    try {
      unlinkSync(pcmPath);
    } catch {
      /* ignore */
    }
  }
}

function detectOnsets(samples: Float32Array): number[] {
  const frames: number[] = [];
  for (let i = 0; i + FRAME_SIZE <= samples.length; i += HOP_SIZE) {
    let energy = 0;
    for (let j = 0; j < FRAME_SIZE; j++) {
      const s = samples[i + j];
      energy += s * s;
    }
    frames.push(Math.sqrt(energy / FRAME_SIZE));
  }
  if (frames.length < 4) return [];
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
  const onsets: number[] = [];
  let aboveCount = 0;
  for (let i = 1; i < frames.length; i++) {
    const localMean = computeLocalMean(frames, i, 8);
    const threshold = localMean * ONSET_THRESHOLD;
    if (frames[i] > threshold && frames[i] > mean * 0.5 && frames[i] > frames[i - 1]) {
      const t = (i * HOP_SIZE) / SAMPLE_RATE;
      if (onsets.length === 0 || t - onsets[onsets.length - 1] > 0.2) {
        onsets.push(Number(t.toFixed(3)));
        aboveCount++;
      }
    }
  }
  void aboveCount;
  return onsets;
}

function computeLocalMean(frames: number[], idx: number, window: number): number {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, idx - window); j < idx; j++) {
    sum += frames[j];
    n++;
  }
  return n > 0 ? sum / n : (frames[idx] ?? 0);
}

function estimateBpm(onsets: number[]): number {
  if (onsets.length < 4) return 0;
  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    intervals.push(onsets[i] - onsets[i - 1]);
  }
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  if (median <= 0) return 0;
  let bpm = 60 / median;
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;
  return Math.round(bpm);
}

function alignBeats(onsets: number[], bpm: number, durationSec: number): number[] {
  if (bpm <= 0 || onsets.length === 0) {
    return onsets.length > 0 ? onsets : [];
  }
  const interval = 60 / bpm;
  const beats: number[] = [];
  const startOnset = onsets[0];
  for (let t = startOnset; t < durationSec; t += interval) {
    beats.push(Number(t.toFixed(3)));
  }
  for (let t = startOnset - interval; t >= 0; t -= interval) {
    beats.unshift(Number(t.toFixed(3)));
  }
  return beats.filter((t) => t >= 0 && t <= durationSec);
}

function fallbackBeats(durationSec: number): BeatInfo {
  const bpm = 120;
  const interval = 60 / bpm;
  const timesSec: number[] = [];
  for (let t = 0; t < durationSec; t += interval) timesSec.push(Number(t.toFixed(3)));
  return { bpm, timesSec, confidence: 0 };
}

export function snapCutsToBeats(
  segments: CutSegment[],
  beats: BeatInfo,
  options: ComposerOptions,
): CutSegment[] {
  void options;
  if (beats.confidence < 0.4 || beats.timesSec.length === 0) return segments;
  return segments.map((seg) => {
    const snappedEnd = snapToBeat(seg.endSec, beats.timesSec, SNAP_TOLERANCE_SEC);
    const newDur = snappedEnd - seg.startSec;
    if (newDur < 0.8 || newDur > 8) return seg;
    return { ...seg, endSec: snappedEnd };
  });
}

function snapToBeat(timeSec: number, beats: number[], tolerance: number): number {
  let best = timeSec;
  let bestDist = tolerance;
  for (const b of beats) {
    const d = Math.abs(b - timeSec);
    if (d <= bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}
