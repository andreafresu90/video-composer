import type { ClipInput, ClipProbe } from '../types.js';
import type { FfmpegRunner } from '../ffmpeg/runner.js';

function parseFps(rate: string | undefined): number {
  if (!rate || rate === '0/0') return 30;
  const [num, den] = rate.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 30;
  return num / den;
}

export async function probeClip(runner: FfmpegRunner, input: ClipInput): Promise<ClipProbe> {
  const data = await runner.ffprobe(input.path);
  const video = data.streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error(`No video stream in ${input.path}`);
  const hasAudio = data.streams.some((s) => s.codec_type === 'audio');
  const duration =
    Number(data.format.duration) ||
    Number(video.duration) ||
    (() => {
      const fps = parseFps(video.avg_frame_rate);
      const nb = Number(video.nb_frames);
      return Number.isFinite(nb) && fps > 0 ? nb / fps : 0;
    })();
  return {
    clipId: input.id,
    path: input.path,
    durationSec: duration,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFps(video.avg_frame_rate ?? video.r_frame_rate),
    hasAudio,
    codec: video.codec_name,
    sizeBytes: Number(data.format.size ?? 0),
  };
}
