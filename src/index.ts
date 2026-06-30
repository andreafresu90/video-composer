import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { runPipeline, type PipelineInput } from './pipeline.js';

interface CliArgs {
  inputDir?: string;
  musicPath?: string;
  outputPath?: string;
  useAI: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { useAI: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input':
        out.inputDir = argv[++i];
        break;
      case '--music':
        out.musicPath = argv[++i];
        break;
      case '--out':
        out.outputPath = argv[++i];
        break;
      case '--ai':
        out.useAI = true;
        break;
      case '--no-ai':
        out.useAI = false;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        printHelp();
        process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  console.error(`video-composer

Usage: npm run dev -- [options]

Options:
  --input <dir>     Directory with source clips (default: $INPUT_DIR)
  --music <path>    Music track to use (default: auto-select from $MUSIC_DIR)
  --out <path>      Output file path (default: $OUTPUT_DIR/reel-<timestamp>.mp4)
  --ai              Enable AI highlight scoring (Fase 2; default: off)
  --no-ai           Force deterministic scoring (default)
  --dry-run         Plan only, skip final compose
  -h, --help        Show this help
`);
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({
    ...process.env,
    ...(args.inputDir ? { INPUT_DIR: args.inputDir } : {}),
  });
  const log = createLogger(config.LOG_LEVEL);
  log.info('video-composer starting', {
    visionModel: config.VISION_MODEL,
    textModel: config.TEXT_MODEL,
    maxDuration: config.MAX_DURATION_SEC,
    useAI: args.useAI,
    dryRun: args.dryRun,
  });

  const input: PipelineInput = {
    clips: [],
    musicPath: args.musicPath ? resolve(args.musicPath) : undefined,
    outputPath: args.outputPath ? resolve(args.outputPath) : undefined,
    useAI: args.useAI,
    dryRun: args.dryRun,
  };

  const result = await runPipeline(config, log, input);
  if (result.path) {
    log.info('done', { output: result.path, durationSec: result.durationSec });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
