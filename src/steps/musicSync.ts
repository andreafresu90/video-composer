import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BeatInfo, ComposerOptions, CutSegment, Mood, MusicTrack } from '../types.js';
import type { FfmpegRunner } from '../ffmpeg/runner.js';
// @ts-expect-error - No types available for music-tempo
import MusicTempo from 'music-tempo';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const SAMPLE_RATE = 22050;
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
    
    const mt = new MusicTempo(samples);
    const bpm = Math.round(Number(mt.tempo));
    const beats: number[] = (mt.beats as number[]).map((b) => Number(b.toFixed(3)));
    
    const confidence = beats.length > 4 && bpm > 0 ? 0.8 : beats.length > 0 ? 0.4 : 0;
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
