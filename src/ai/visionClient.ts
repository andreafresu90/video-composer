import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { FrameScore, Keyframe, Mood } from '../types.js';

const MOODS: Mood[] = ['joyful', 'calm', 'energetic', 'intimate', 'epic', 'melancholic', 'neutral'];

const frameScoreSchema = z.object({
  timeSec: z.number(),
  aesthetic: z.number().min(1).max(10),
  emotionalWarmth: z.number().min(1).max(10),
  motionLevel: z.number().min(1).max(10),
  focusSubject: z.string().max(80),
  mood: z.enum(MOODS as [Mood, ...Mood[]]),
  notes: z.string().max(200).optional(),
});

const SYSTEM_PROMPT = [
  'Sei un editor video professionista per contenuti Instagram di un fotografo.',
  'Valuti frame estratti da un clip verticale per scegliere i momenti migliori.',
  'Rispondi SOLO con un oggetto JSON della forma',
  '{"frames":[{"timeSec":number,"aesthetic":1-10,"emotionalWarmth":1-10,',
  '"motionLevel":1-10,"focusSubject":"<=5 parole","mood":<uno tra: ' +
    MOODS.join(', ') +
    '>,"notes":"opzionale <=15 parole"}]}.',
  'aesthetic=composizione/luce/qualita tecnica, emotionalWarmth=espressioni/calore/emozione,',
  'motionLevel=movimento/soggetto in azione. Nessun testo aggiuntivo, solo il JSON.',
].join(' ');

interface ResponsesContent {
  type: string;
  text?: string;
  image_url?: string;
}

interface ResponsesInput {
  role: string;
  content: ResponsesContent[];
}

interface ResponsesOutput {
  type: string;
  content?: { type: string; text?: string }[];
  text?: string;
}

interface ResponsesApiResult {
  id: string;
  status: string;
  output?: ResponsesOutput[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string } | null;
}

export interface VisionClientOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  maxFramesPerClip: number;
  timeoutMs?: number;
}

export interface ScoreFramesResult {
  scores: FrameScore[];
  tokensIn?: number;
  tokensOut?: number;
}

export class VisionClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly maxFramesPerClip: number;
  private readonly timeoutMs: number;

  constructor(opts: VisionClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.model = opts.model;
    this.maxFramesPerClip = opts.maxFramesPerClip;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  async scoreFrames(frames: Keyframe[]): Promise<ScoreFramesResult> {
    if (frames.length === 0) return { scores: [] };
    const selected = frames.slice(0, this.maxFramesPerClip);
    const content: ResponsesContent[] = [
      { type: 'input_text', text: this.buildUserPrompt(selected) },
      ...selected.map((f) => ({
        type: 'input_image',
        image_url: this.toDataUrl(f.filePath),
      })),
    ];
    const input: ResponsesInput[] = [
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM_PROMPT }] },
      { role: 'user', content },
    ];
    const body = {
      model: this.model,
      input,
      text: { format: { type: 'json_object' } },
    };
    const url = `${this.baseURL}/responses`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Vision API ${res.status}: ${text || res.statusText}`);
      }
      const data = (await res.json()) as ResponsesApiResult;
      if (data.error) {
        throw new Error(`Vision API error: ${data.error.message ?? 'unknown'}`);
      }
      const raw = this.extractText(data);
      const scores = this.parseResponse(raw, selected);
      return {
        scores,
        tokensIn: data.usage?.input_tokens,
        tokensOut: data.usage?.output_tokens,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private extractText(data: ResponsesApiResult): string {
    const out = data.output ?? [];
    for (const item of out) {
      if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) return c.text;
        }
      }
      if (item.text) return item.text;
    }
    return '';
  }

  private buildUserPrompt(frames: Keyframe[]): string {
    const list = frames.map((f) => `frame[${f.timeSec.toFixed(2)}s]`).join(', ');
    return `Questi frame vengono da un unico clip, in ordine temporale crescente (${list}). Restituisci un oggetto per ciascun frame con il suo timeSec.`;
  }

  private toDataUrl(filePath: string): string {
    const buf = readFileSync(filePath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  private parseResponse(raw: string, frames: Keyframe[]): FrameScore[] {
    let jsonText = raw.trim();
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start >= 0 && end > start) jsonText = jsonText.slice(start, end + 1);
    let data: unknown;
    try {
      data = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`Vision response is not valid JSON: ${(err as Error).message}`);
    }
    const maybeArray = data as { frames?: unknown };
    const arr = Array.isArray(maybeArray.frames) ? maybeArray.frames : Array.isArray(data) ? data : [];
    const frameByTime = new Map(frames.map((f) => [f.timeSec, f]));
    const out: FrameScore[] = [];
    for (let i = 0; i < arr.length; i++) {
      const parsed = frameScoreSchema.safeParse(arr[i]);
      if (!parsed.success) continue;
      const v = parsed.data;
      const key = frames[i]?.timeSec ?? v.timeSec;
      const kf = frameByTime.get(key) ?? frames[i];
      if (!kf) continue;
      out.push({
        clipId: kf.clipId,
        timeSec: kf.timeSec,
        aesthetic: v.aesthetic,
        emotionalWarmth: v.emotionalWarmth,
        motionLevel: v.motionLevel,
        focusSubject: v.focusSubject,
        mood: v.mood,
        notes: v.notes,
      });
    }
    return out;
  }
}
