# AGENTS.md

Linee guida per chi lavora su questo progetto (umani e agent AI).

## Progetto

`video-composer` compone Reel Instagram (≤ 60s, 9:16) da clip verticali in input,
con selezione AI parsimoniosa dei momenti salienti e musica di sottofondo.
Dettagli architetturali: vedi **DESIGN.md**.

## Stack

- Node.js ≥ 20.10 + TypeScript (ESM, `module: NodeNext`).
- FFmpeg + ffprobe nel PATH (o `FFMPEG_PATH` / `FFPROBE_PATH`).
- AI via SDK `openai` puntato a endpoint OpenAI-compatible (OpenCode Go/Zen).

## Comandi

```bash
npm install          # installa dipendenze
npm run typecheck    # tsc --noEmit (verifica tipi)
npm run lint         # eslint .
npm run lint:fix     # eslint --fix
npm run format       # prettier --write .
npm run format:check # prettier --check .
npm run build        # tsc -> dist/
npm run dev          # tsx src/index.ts (esecuzione diretta in dev)
npm start            # node dist/index.js (dopo build)
```

**Prima di considerare un task completato**: eseguire `npm run typecheck` e
`npm run lint` e verificare che passino senza errori.

## Configurazione

- Copiare `.env.example` in `.env` e compilare. `.env` è gitignored.
- La config è validata con `zod` in `src/config.ts`; errori di config vengono
  sollevati all'avvio con messaggio leggibile.
- La chiave API va **solo** in `.env` come `OPENCODE_API_KEY`. Mai nel codice, mai
  committata.

## Convenzioni di codice

- **Niente commenti** nel codice a meno che non siano richiesti esplicitamente.
  Le decisioni di design vanno in DESIGN.md.
- ESM con estensione `.js` negli import relativi (es. `import { x } from './config.js';`).
- Tipi condivisi in `src/types.ts`. Importare i tipi con `import type`.
- Nessun `any`: usare `unknown` e restringere. `@typescript-eslint/no-explicit-any` è `warn`.
- Errori "non ancora implementato": usare `NotImplementedError` da `src/utils/errors.ts`.
- Logger: usare `createLogger` da `src/utils/logger.js`; passare `Logger` via
  dipendenza, non importare `console` direttamente nei moduli di dominio.
- Un step della pipeline = un file in `src/steps/` con funzioni esportate e tipate.
- Non committare segreti, file in `input/`, `output/`, `assets/music/` o `.tmp/`.

## Architettura (riassunto)

Pipeline in 9 step (vedi DESIGN.md §4): `probe → sceneDetect → keyframes →
aiScore → budget → cutRefine → narrative → musicSync → compose`, orchestrati da
`src/pipeline.ts`. L'AI è confinata dietro `VisionClient` in `src/ai/` e usata
solo in `aiScore` (e opzionalmente `narrative`); tutto il resto è deterministico
via FFmpeg (`src/ffmpeg/runner.ts`).

## Note

- L'AI va usata in modo **parsimonioso**: 1 chiamata vision per clip, mai per frame.
- Se si aggiungono dipendenze, verificarne i tipi (aggiungere `@types/*` se mancano)
  e mantenerle in `package.json` con caret range ragionevole.
- FFmpeg è un prerequisito: se un test/comando fallisce per "ffmpeg not found",
  segnalare all'utente di installarlo o impostare `FFMPEG_PATH`.
