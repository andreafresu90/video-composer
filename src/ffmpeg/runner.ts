import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FfprobeStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
}

export interface FfprobeFormat {
  duration?: string;
  size?: string;
  nb_streams?: number;
}

export interface FfprobeJson {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface FfmpegRunner {
  ffprobe(path: string): Promise<FfprobeJson>;
  ffmpeg(args: string[]): Promise<RunResult>;
  getPaths(): { ffmpeg: string; ffprobe: string };
}

export function createFfmpegRunner(ffmpegPath?: string, ffprobePath?: string): FfmpegRunner {
  const ffmpeg = ffmpegPath ?? 'ffmpeg';
  const ffprobe = ffprobePath ?? 'ffprobe';
  const MAX = 100 * 1024 * 1024;
  return {
    getPaths() {
      return { ffmpeg, ffprobe };
    },
    async ffprobe(path) {
      try {
        const { stdout } = await execFileAsync(
          ffprobe,
          ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
          { maxBuffer: MAX },
        );
        return JSON.parse(stdout) as FfprobeJson;
      } catch (err) {
        throw new Error(`ffprobe failed for ${path}: ${(err as Error).message}`);
      }
    },
    async ffmpeg(args) {
      try {
        const { stdout, stderr } = await execFileAsync(ffmpeg, args, { maxBuffer: MAX });
        return { stdout, stderr };
      } catch (err) {
        const e = err as Error & { stderr?: string; code?: string };
        throw new Error(
          `ffmpeg failed (code ${e.code ?? 'unknown'}): ${e.message}\n--- stderr ---\n${e.stderr ?? ''}`,
        );
      }
    },
  };
}
