import { join } from 'node:path';
import type { ComposerOptions, CutSegment, ReelOutput, ReelPlan } from '../types.js';
import type { FfmpegRunner } from '../ffmpeg/runner.js';

function segmentDuration(seg: CutSegment): number {
  return Math.max(0, seg.endSec - seg.startSec);
}

interface RenderedSegment {
  file: string;
  durationSec: number;
  transitionIn: CutSegment['transitionIn'];
}

function buildXfadeChain(
  rendered: RenderedSegment[],
  crossfade: number,
): { filter: string; totalDurationSec: number; valid: boolean } {
  if (rendered.length === 0) return { filter: '', totalDurationSec: 0, valid: false };
  if (rendered.length === 1) {
    return { filter: '[0:v]copy[vout]', totalDurationSec: rendered[0].durationSec, valid: true };
  }
  const cd = Math.min(crossfade, ...rendered.map((s) => s.durationSec / 2));
  const parts: string[] = [];
  for (let i = 0; i < rendered.length; i++) {
    parts.push(`[${i}:v]setpts=PTS-STARTPTS,fps=30[vtb${i}]`);
  }
  let acc = rendered[0].durationSec;
  let prevLabel = 'vtb0';
  for (let i = 1; i < rendered.length; i++) {
    const offset = Math.max(0, acc - cd);
    const outLabel = i === rendered.length - 1 ? 'vout' : `x${i}`;
    parts.push(
      `[${prevLabel}][vtb${i}]xfade=transition=fade:duration=${cd.toFixed(3)}:offset=${offset.toFixed(3)},fps=30[${outLabel}]`,
    );
    acc = acc + rendered[i].durationSec - cd;
    prevLabel = outLabel;
  }
  return { filter: parts.join(';'), totalDurationSec: acc, valid: true };
}

function buildAudioFilter(totalDurationSec: number, crossfadeSec: number): string {
  const fadeOutStart = Math.max(0, totalDurationSec - 1.5);
  return [
    `atrim=0:${totalDurationSec.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
    'loudnorm=I=-14:LRA=11:TP=-1.5',
    `afade=t=in:st=0:d=${crossfadeSec.toFixed(3)}`,
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=1.500[aout]`,
  ].join(',');
}

function colorGradeFilter(): string {
  return [
    'eq=saturation=1.08:contrast=1.03:brightness=0.01',
    'curves=preset=increase_contrast',
    'unsharp=3:3:0.5:3:3:0.0',
  ].join(',');
}

function speedRampFilter(seg: CutSegment, baseVf: string): string {
  const dur = segmentDuration(seg);
  const rampStart = Math.max(0, dur - 0.8);
  return [
    `${baseVf},split=2[norm][ramp]`,
    `[ramp]trim=start=${rampStart.toFixed(3)}:end=${dur.toFixed(3)},setpts=PTS-STARTPTS,setpts=1.6*PTS,minterpolate=fps=30:mi_mode=mci[ramped]`,
    `[norm]trim=0:${rampStart.toFixed(3)},setpts=PTS-STARTPTS[pre]`,
    '[pre][ramped]concat=n=2:v=1:a=0[ramped_full]',
    '[ramped_full]setpts=PTS-STARTPTS[out]',
  ].join(';');
}

export async function composeReel(
  runner: FfmpegRunner,
  plan: ReelPlan,
  options: ComposerOptions,
  segmentDir: string,
  outputPath: string,
): Promise<ReelOutput> {
  const segments = plan.segments;
  if (segments.length === 0) throw new Error('Cannot compose reel with zero segments');

  const peakIdx = segments.reduce((best, seg, i) => (seg.isEmotionalPeak ? i : best), -1);

  const rendered: RenderedSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = segmentDuration(seg);
    if (dur <= 0) continue;
    const file = join(segmentDir, `seg_${String(i).padStart(2, '0')}.mp4`);
    const baseVf = [
      `scale=${options.resolution.width}:${options.resolution.height}:force_original_aspect_ratio=decrease`,
      `pad=${options.resolution.width}:${options.resolution.height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1',
      `fps=${options.fps}`,
      colorGradeFilter(),
    ].join(',');

    const isPeak = i === peakIdx && seg.isEmotionalPeak;
    const args = [
      '-hide_banner',
      '-y',
      '-ss',
      seg.startSec.toFixed(3),
      '-i',
      seg.clipPath,
      '-t',
      dur.toFixed(3),
      '-an',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-preset',
      'fast',
      '-pix_fmt',
      'yuv420p',
    ];
    if (isPeak) {
      const filter = speedRampFilter(seg, baseVf);
      args.push('-filter_complex', filter, '-map', '[out]');
    } else {
      args.push('-vf', baseVf);
    }
    args.push(file);
    await runner.ffmpeg(args);

    const probe = await runner.ffprobe(file);
    const realDur = Number(probe.format.duration ?? dur);
    rendered.push({ file, durationSec: realDur, transitionIn: seg.transitionIn });
  }

  const videoFilter = buildXfadeChain(rendered, options.crossfadeSec);
  if (!videoFilter.valid) throw new Error('Failed to build video chain');
  const total = videoFilter.totalDurationSec;

  const inputArgs: string[] = [];
  for (const r of rendered) inputArgs.push('-i', r.file);
  inputArgs.push('-stream_loop', '-1', '-i', plan.music.path);

  const musicIndex = rendered.length;
  const filterComplex = `${videoFilter.filter};[${musicIndex}:a]${buildAudioFilter(total, options.crossfadeSec)}`;

  await runner.ffmpeg([
    '-hide_banner',
    '-y',
    ...inputArgs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'slow',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(options.fps),
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-shortest',
    outputPath,
  ]);

  const probe = await runner.ffprobe(outputPath);
  const sizeBytes = Number(probe.format.size ?? 0);
  const durationSec = Number(probe.format.duration ?? total);
  return { path: outputPath, durationSec, sizeBytes };
}
