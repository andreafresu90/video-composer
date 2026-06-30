export interface ClipInput {
  id: string;
  path: string;
  label?: string;
}

export interface ClipProbe {
  clipId: string;
  path: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
  sizeBytes: number;
}

export interface SceneBoundary {
  clipId: string;
  timeSec: number;
  score: number;
}

export interface Keyframe {
  clipId: string;
  timeSec: number;
  filePath: string;
}

export type Mood = 'joyful' | 'calm' | 'energetic' | 'intimate' | 'epic' | 'melancholic' | 'neutral';

export interface FrameScore {
  clipId: string;
  timeSec: number;
  aesthetic: number;
  emotionalWarmth: number;
  motionLevel: number;
  focusSubject: string;
  mood: Mood;
  personVisible?: boolean;
  facePosition?: FacePosition;
  framingQuality?: number;
  sharpness?: number;
  exposure?: number;
  notes?: string;
}

export type FacePosition = 'center' | 'left' | 'right' | 'out-of-frame' | 'none';

export interface ClipScore {
  clipId: string;
  clipPath: string;
  overallScore: number;
  bestSegmentStartSec: number;
  bestSegmentEndSec: number;
  mood: Mood;
  frameScores: FrameScore[];
}

export type TransitionType = 'none' | 'crossfade' | 'fade-black' | 'whip' | 'cut';

export interface CutSegment {
  clipId: string;
  clipPath: string;
  startSec: number;
  endSec: number;
  order: number;
  transitionIn: TransitionType;
  isEmotionalPeak?: boolean;
}

export interface BeatInfo {
  bpm: number;
  timesSec: number[];
  confidence: number;
}

export interface MusicTrack {
  path: string;
  title: string;
  mood: Mood;
  bpm?: number;
  beats?: BeatInfo;
}

export interface ReelPlan {
  segments: CutSegment[];
  music: MusicTrack;
  totalDurationSec: number;
  beats: BeatInfo;
}

export interface ReelOutput {
  path: string;
  durationSec: number;
  sizeBytes: number;
}

export interface ComposerOptions {
  maxDurationSec: number;
  minSegmentSec: number;
  maxSegmentSec: number;
  crossfadeSec: number;
  targetLufs: number;
  resolution: { width: number; height: number };
  fps: number;
}
