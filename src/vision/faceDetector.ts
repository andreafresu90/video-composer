import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as ort from 'onnxruntime-node';
import type { FacePosition } from '../types.js';
import type { FfmpegRunner } from '../ffmpeg/runner.js';

const MODEL_INPUT_W = 320;
const MODEL_INPUT_H = 240;
const IMAGE_MEAN = [104, 117, 123];
const CONFIDENCE_THRESHOLD = 0.6;
const IOU_THRESHOLD = 0.3;
const TOP_K = 50;

export interface BoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  overflow: number;
}

export interface FaceDetectionResult {
  boxes: BoundingBox[];
  personVisible: boolean;
  facePosition: FacePosition;
  framingQuality: number;
}

let sessionCache: ort.InferenceSession | null = null;

async function getSession(modelPath: string): Promise<ort.InferenceSession> {
  if (sessionCache) return sessionCache;
  sessionCache = await ort.InferenceSession.create(modelPath);
  return sessionCache;
}

export async function detectFaces(
  runner: FfmpegRunner,
  keyframePath: string,
  modelPath: string,
): Promise<FaceDetectionResult> {
  const session = await getSession(modelPath);
  const raw = await extractRgb(runner, keyframePath);
  if (raw.length !== MODEL_INPUT_W * MODEL_INPUT_H * 3) {
    return emptyResult();
  }
  const input = preprocess(raw);
  const feeds = {
    [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, MODEL_INPUT_H, MODEL_INPUT_W]),
  };
  const out = await session.run(feeds);
  const scores = out[session.outputNames[0]].data as Float32Array;
  const boxes = out[session.outputNames[1]].data as Float32Array;
  const candidates = extractCandidates(scores, boxes);
  const kept = nms(candidates, IOU_THRESHOLD, TOP_K);
  return computeMetrics(kept);
}

async function extractRgb(runner: FfmpegRunner, keyframePath: string): Promise<Uint8Array> {
  const tmpPath = join(tmpdir(), `vc_face_${Date.now()}_${Math.random().toString(36).slice(2)}.raw`);
  try {
    await runner.ffmpeg([
      '-hide_banner',
      '-y',
      '-i',
      keyframePath,
      '-vf',
      `scale=${MODEL_INPUT_W}:${MODEL_INPUT_H},format=rgb24`,
      '-f',
      'rawvideo',
      '-c:a',
      'pcm_s16le',
      tmpPath,
    ]);
    return readFileSync(tmpPath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

function preprocess(rgb: Uint8Array): Float32Array {
  const chw = new Float32Array(3 * MODEL_INPUT_H * MODEL_INPUT_W);
  const plane = MODEL_INPUT_H * MODEL_INPUT_W;
  for (let i = 0; i < plane; i++) {
    chw[i] = rgb[i * 3 + 2] - IMAGE_MEAN[0];
    chw[plane + i] = rgb[i * 3 + 1] - IMAGE_MEAN[1];
    chw[2 * plane + i] = rgb[i * 3] - IMAGE_MEAN[2];
  }
  return chw;
}

function extractCandidates(scores: Float32Array, boxes: Float32Array): BoundingBox[] {
  const count = scores.length / 2;
  const out: BoundingBox[] = [];
  for (let i = 0; i < count; i++) {
    const faceScore = scores[i * 2 + 1];
    if (faceScore < CONFIDENCE_THRESHOLD) continue;
    const rawX1 = boxes[i * 4];
    const rawY1 = boxes[i * 4 + 1];
    const rawX2 = boxes[i * 4 + 2];
    const rawY2 = boxes[i * 4 + 3];
    const x1 = Math.max(0, rawX1);
    const y1 = Math.max(0, rawY1);
    const x2 = Math.min(1, rawX2);
    const y2 = Math.min(1, rawY2);
    const area = (x2 - x1) * (y2 - y1);
    if (area < 0.0008 || area > 0.95) continue;
    const overflow =
      Math.max(0, -rawX1) + Math.max(0, -rawY1) + Math.max(0, rawX2 - 1) + Math.max(0, rawY2 - 1);
    out.push({ x1, y1, x2, y2, score: faceScore, overflow });
  }
  return out;
}

function iou(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function nms(boxes: BoundingBox[], iouThreshold: number, topK: number): BoundingBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: BoundingBox[] = [];
  for (const box of sorted) {
    if (kept.length >= topK) break;
    let suppress = false;
    for (const k of kept) {
      if (iou(box, k) > iouThreshold) {
        suppress = true;
        break;
      }
    }
    if (!suppress) kept.push(box);
  }
  return kept;
}

function computeMetrics(boxes: BoundingBox[]): FaceDetectionResult {
  if (boxes.length === 0) {
    return { boxes, personVisible: false, facePosition: 'none', framingQuality: 5 };
  }
  const largest = boxes.reduce((best, b) => {
    const area = (b.x2 - b.x1) * (b.y2 - b.y1);
    const bestArea = (best.x2 - best.x1) * (best.y2 - best.y1);
    return area > bestArea ? b : best;
  });
  const cx = (largest.x1 + largest.x2) / 2;
  const cy = (largest.y1 + largest.y2) / 2;
  const w = largest.x2 - largest.x1;
  const h = largest.y2 - largest.y1;
  const outOfFrame = largest.overflow > 0.05;
  let position: FacePosition;
  if (outOfFrame) {
    position = 'out-of-frame';
  } else if (cx < 0.38) {
    position = 'left';
  } else if (cx > 0.62) {
    position = 'right';
  } else {
    position = 'center';
  }
  let framing = 5;
  if (!outOfFrame) {
    framing = 7;
    if (cx > 0.3 && cx < 0.7 && cy > 0.2 && cy < 0.8) framing += 1.5;
    if (w > 0.15 && w < 0.6 && h > 0.15 && h < 0.6) framing += 1;
    const margin = Math.min(largest.x1, 1 - largest.x2, largest.y1, 1 - largest.y2);
    if (margin > 0.08) framing += 0.5;
  } else {
    framing = 3;
  }
  framing = Math.max(1, Math.min(10, Math.round(framing * 10) / 10));
  return { boxes, personVisible: true, facePosition: position, framingQuality: framing };
}

function emptyResult(): FaceDetectionResult {
  return { boxes: [], personVisible: false, facePosition: 'none', framingQuality: 5 };
}

export function defaultModelPath(musicDir: string): string {
  void musicDir;
  return join(process.cwd(), 'assets', 'models', 'version-RFB-320.onnx');
}
