# video-composer

Tool CLI che compone **Reel Instagram** (≤ 60s, 9:16) da clip verticali in input,
con selezione AI parsimoniosa dei momenti salienti, musica di sottofondo, beat sync,
color consistency e speed ramping sul picco emotivo.

Pensato per fotografi che vogliono automatizzare la creazione di contenuti
promozionali a basso sforzo e basso costo.

---

## Indice

- [Requisiti](#requisiti)
- [Installazione](#installazione)
- [Configurazione](#configurazione)
- [Uso rapido](#uso-rapido)
- [Riferimento CLI](#riferimento-cli)
- [Variabili d'ambiente](#variabili-dambiente)
- [Come funziona](#come-funziona)
- [Percorso AI vs deterministico](#percorso-ai-vs-deterministico)
- [Musica di sottofondo](#musica-di-sottofondo)
- [Costi](#costi)
- [Risoluzione dei problemi](#risoluzione-dei-probletti)
- [Struttura del progetto](#struttura-del-progetto)
- [Sviluppo](#sviluppo)

---

## Requisiti

| Requisito         | Versione                | Note                        |
| ----------------- | ----------------------- | --------------------------- |
| Node.js           | ≥ 20.10                 | verificato con Node 22      |
| FFmpeg            | qualsiasi build recente | verificato con 7.1.1        |
| ffprobe           | (incluso con FFmpeg)    | serve per il probe dei file |
| OpenCode Go / Zen | opzionale               | solo per `--ai`             |

FFmpeg e ffprobe devono essere nel `PATH`, oppure punta ai binari via `FFMPEG_PATH` /
`FFPROBE_PATH` nel `.env`.

---

## Installazione

```bash
git clone <repo> video-composer
cd video-composer
npm install
```

---

## Configurazione

1. Copia `.env.example` in `.env` (il file è gitignored):

```bash
cp .env.example .env
```

2. Compila almeno `OPENCODE_API_KEY` (necessaria solo per `--ai`):
   - Ottieni la chiave su https://opencode.ai/auth
   - Abbonamento **OpenCode Go** (~5$/mese) per modelli text, oppure crediti **Zen**
     per il modello vision `gpt-5.4-nano`

3. **Mai** committare il `.env` o la chiave API.

---

## Uso rapido

### Reel con AI (consigliato)

Metti i tuoi clip verticali in `input/` e una traccia musicale in `assets/music/`:

```bash
npx tsx src/index.ts --ai --music assets/music/fairy.mp3 --out output/mio-reel.mp4
```

### Reel deterministico (senza AI, gratis)

```bash
npx tsx src/index.ts --out output/mio-reel.mp4
```

### Solo piano, senza render (per ispezionare la selezione)

```bash
npx tsx src/index.ts --ai --dry-run
```

### Dopo il build

```bash
npm run build
node dist/index.js --ai --out output/mio-reel.mp4
```

---

## Riferimento CLI

```
Usage: npx tsx src/index.ts [options]

Options:
  --input <dir>     Directory con i clip sorgente (default: $INPUT_DIR, ./input)
  --music <path>    Traccia musicale da usare (default: auto-select da $MUSIC_DIR)
  --out <path>      File di output (default: $OUTPUT_DIR/reel-<timestamp>.mp4)
  --ai              Abilita scoring AI dei momenti salienti (default: off)
  --no-ai           Forza scoring deterministico (default)
  --dry-run         Solo piano, salta il render finale
  -h, --help        Mostra questo help
```

**Esempi:**

```bash
# Clip da una cartella diversa
npx tsx src/index.ts --ai --input ./mia-cartella --out output/reel.mp4

# Musica auto-selezionata dalla library in base al mood
npx tsx src/index.ts --ai

# Solo deterministico, musica specifica
npx tsx src/index.ts --music assets/music/epic_am_f_c_g.mp3
```

> **Nota PowerShell**: su Windows PowerShell, usa `npx tsx src/index.ts <flag>` per
> inoltrare correttamente gli argomenti (il `--` di `npm run dev` non sempre
> inoltra su PS).

---

## Variabili d'ambiente

Definite nel `.env` (vedi `.env.example` per il template):

### API AI

| Variabile                    | Default                                | Descrizione                                      |
| ---------------------------- | -------------------------------------- | ------------------------------------------------ |
| `OPENCODE_API_KEY`           | (obbligatoria per `--ai`)              | Chiave API OpenCode Go/Zen                       |
| `OPENCODE_VISION_BASE_URL`   | `https://opencode.ai/zen/v1`           | Endpoint API vision (Zen Responses)              |
| `VISION_MODEL`               | `gpt-5.4-nano`                         | Modello vision per lo scoring dei frame          |
| `VISION_MAX_FRAMES_PER_CLIP` | `6`                                    | Max keyframe inviati all'AI per clip             |
| `OPENCODE_TEXT_BASE_URL`     | `https://opencode.ai/zen/go/v1`        | Endpoint API text (Go, futuro uso)               |
| `TEXT_MODEL`                 | `glm-5.2`                              | Modello text (futuro, per narrativa)             |
| `FACE_DETECT_MODEL_PATH`     | `./assets/models/version-RFB-320.onnx` | Modello ONNX per face detection                  |
| `FACE_DETECT_ENABLED`        | `true`                                 | Abilita/disabilita face detection deterministica |

### FFmpeg

| Variabile      | Default | Descrizione               |
| -------------- | ------- | ------------------------- |
| `FFMPEG_PATH`  | (PATH)  | Path al binario `ffmpeg`  |
| `FFPROBE_PATH` | (PATH)  | Path al binario `ffprobe` |

### Directory

| Variabile    | Default          | Descrizione                            |
| ------------ | ---------------- | -------------------------------------- |
| `INPUT_DIR`  | `./input`        | Cartella clip sorgente                 |
| `OUTPUT_DIR` | `./output`       | Cartella reel prodotti                 |
| `MUSIC_DIR`  | `./assets/music` | Library brani musicali                 |
| `TEMP_DIR`   | `./.tmp`         | File temporanei (puliti dopo ogni run) |

### Vincoli Reel

| Variabile          | Default | Descrizione                                   |
| ------------------ | ------- | --------------------------------------------- |
| `MAX_DURATION_SEC` | `60`    | Durata massima del reel                       |
| `MIN_SEGMENT_SEC`  | `1.2`   | Durata minima di un segmento                  |
| `MAX_SEGMENT_SEC`  | `6`     | Durata massima di un segmento                 |
| `CROSSFADE_SEC`    | `0.3`   | Durata crossfade/fade tra segmenti            |
| `TARGET_LUFS`      | `-14`   | Loudness target della musica (LUFS)           |
| `LOG_LEVEL`        | `info`  | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |

---

## Come funziona

La pipeline è composta da 9 step:

```
probe → sceneDetect → keyframes → aiScore → budget → cutRefine → narrative → musicSync → compose
```

1. **probe** — `ffprobe` per durata, risoluzione, fps, audio di ogni clip
2. **sceneDetect** — FFmpeg `select='gt(scene,0.3)'` per trovare i confini di scena naturali (candidati per i tagli non bruschi)
3. **keyframes** — estrae 1 frame per scena (max `VISION_MAX_FRAMES_PER_CLIP`) a 512px per l'AI
4. **aiScore** — 1 chiamata vision per clip → valutazione estetica/emozionale/movimento/mood (solo con `--ai`)
5. **budget** — distribuisce i 60s tra i clip in base all'`overallScore`, con cap `MAX_SEGMENT_SEC`
6. **cutRefine** — snap dei tagli ai confini di scena ±0.4s, guard bordi 0.3s, min/max durata
7. **narrative** — ordine crescente di score → picco emotivo alla fine (struttura classica reel)
8. **musicSync** — selezione brano in base al mood, **beat detection real** (onset detection energy-based su PCM), snap tagli ai beat ±150ms, fade in/out, `loudnorm` a -14 LUFS
9. **compose** — estrazione segmenti normalizzati 1080×1920@30fps, **color consistency** (`eq`+`curves`+`unsharp`), **speed ramping** (slow-motion 1.6×) sul picco emotivo, concat con fade, export H.264 CRF 18 `+faststart`

Dettagli architetturali completi in **DESIGN.md**.

---

## Percorso AI vs deterministico

| Aspetto            | AI (`--ai`)                                      | Deterministico (default)  |
| ------------------ | ------------------------------------------------ | ------------------------- |
| Segnale usato      | Contenuto visivo (estetica, emozione, movimento) | Densità di scene (FFmpeg) |
| Costo              | ~$0.0007/reel                                    | 0€                        |
| Tempo extra        | ~4s per clip di chiamata API                     | 0                         |
| Selezione segmento | Finestra scorrevole sui frame valutati           | Centro del clip           |
| Mood               | Rilevato dall'AI (intimate, calm, energetic…)    | Sempre `neutral`          |
| Fallback           | → deterministico se AI fallisce                  | —                         |

Con `--ai`, se la chiamata vision fallisce (crediti insufficienti, modello non
vision, errori di rete), il pipeline **disattiva automaticamente l'AI** per i clip
rimanenti e usa il deterministico. Il reel viene comunque prodotto — non blocca mai.

Il log finale mostra `aiRequested` e `aiSucceeded` per transparency.

---

## Musica di sottofondo

### Library locale

Metti brani **royalty-free** in `assets/music/`. Formati supportati: `.mp3`, `.wav`,
`.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`.

Senza `--music`, il tool seleziona automaticamente un brano in base al **mood
dominante** dei clip (rilevato dall'AI). Con `--ai` disattivato, prende il primo
brano disponibile.

### Fonti royalty-free consigliate

- **Pixabay Music** — https://pixabay.com/music/ — gratis, nessuna attribuzione
- **YouTube Audio Library** — gratis, filtri per mood/genre
- **Uppbeat** — https://uppbeat.io/ — free tier con crediti

> **Nota legale**: il licensing della musica è a carico dell'utente. Il tool non
> distribuisce audio, lo usa solo localmente per comporre il reel.

---

## Costi

| Componente                                   | Costo                                                     |
| -------------------------------------------- | --------------------------------------------------------- |
| FFmpeg (probe, tagli, concat, color, export) | 0€ (locale)                                               |
| Beat detection                               | 0€ (algoritmo JS puro su PCM)                             |
| Face detection (ONNX Runtime, UltraFace)     | 0€ (locale, privacy totale)                               |
| AI vision (`--ai`)                           | ~$0.0007/reel (10 chiamate × $0.00007 con `gpt-5.4-nano`) |

Con 10$ di credito OpenCode Zen puoi produrre **~14.000 reel** con AI.

### Modello face detection

Il modello `version-RFB-320.onnx` (UltraFace, ~1.2MB) va scaricato e posizionato in
`assets/models/`. Non è incluso nel repo (gitignored). Scaricarlo da:

```bash
curl -L -o assets/models/version-RFB-320.onnx \
  https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/raw/master/models/onnx/version-RFB-320.onnx
```

Licenza: MIT. Processing 100% locale — i frame con persone non lasciano il tuo PC.

---

## Risoluzione dei problemi

### `ffmpeg not found`

FFmpeg non è nel PATH. Soluzioni:

- Installa FFmpeg e assicurati che `ffmpeg` e `ffprobe` siano eseguibili da terminale
- Oppure imposta `FFMPEG_PATH` e `FFPROBE_PATH` nel `.env` con i path completi

### `No video clips found in ./input`

Metti file video (`.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.m4v`) nella cartella
`input/` (o in quella specificata con `--input`).

### `No music track available`

Metti almeno un file audio in `assets/music/`, oppure usa `--music <path>` per
specificare una traccia.

### AI fallisce con "Insufficient balance"

Il piano OpenCode Go/Zen non ha crediti per il modello vision. Opzioni:

- Ricarica credito su https://opencode.ai/auth
- Usa senza `--ai` (deterministico, gratis)
- Il pipeline fa comunque fallback automatico al deterministico

### `400 status code` con `--ai`

Il modello `VISION_MODEL` potrebbe non supportare le immagini. Prova a cambiare
in `.env`:

- `gemini-3-flash` (richiede crediti Zen)
- `gpt-5.4-mini` (richiede crediti Zen)

### Audio mono nel reel

L'audio del reel viene normalizzato a 48kHz. Se la musica sorgente è mono,
l'output sarà mono. Usa una traccia stereo per output stereo.

### I tagli non seguono la musica

La beat detection ha confidence < 0.4 (musica ambient senza beat marcato). Il
pipeline usa fallback su cadenza costante. Per musica con beat chiaro (electronic,
pop), la detection funziona meglio.

---

## Struttura del progetto

```
video-composer/
├── README.md              questo file
├── DESIGN.md              documento di design (architettura, decisioni, rischi)
├── AGENTS.md              convenzioni per agent AI e contributor
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── .prettierrc.json
├── .env.example           template configurazione (copiare in .env)
├── assets/music/          library brani royalty-free (gitignored il contenuto)
├── input/                 clip sorgente (gitignored il contenuto)
├── output/                reel prodotti (gitignored il contenuto)
└── src/
    ├── index.ts           entry point + CLI
    ├── config.ts          env + validazione zod
    ├── pipeline.ts        orchestratore 9 step
    ├── types.ts           tipi di dominio
    ├── ai/
    │   └── visionClient.ts    client vision (Responses API, gpt-5.4-nano)
    ├── ffmpeg/
    │   └── runner.ts      wrapper child_process (ffprobe + ffmpeg)
    ├── steps/
    │   ├── probe.ts       [1] ffprobe
    │   ├── sceneDetect.ts [2] scene detection
    │   ├── keyframes.ts   [3] estrazione keyframe
    │   ├── aiScore.ts     [4] scoring AI + selectBestSegment
    │   ├── budget.ts      [5] allocazione durata
    │   ├── cutRefine.ts   [6] snap tagli + regole
    │   ├── narrative.ts   [7] ordinamento
    │   ├── musicSync.ts   [8] beat detection + snap + fade
    │   └── compose.ts     [9] color grade + speed ramp + export
    └── utils/
        ├── logger.ts      logger JSON a livelli
        └── errors.ts      NotImplementedError
```

---

## Sviluppo

### Comandi

```bash
npm install          # installa dipendenze
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run lint:fix     # eslint --fix
npm run format       # prettier --write .
npm run format:check # prettier --check .
npm run build        # tsc -> dist/
npm run dev          # tsx src/index.ts (esecuzione diretta in dev)
npm start            # node dist/index.js (dopo build)
```

**Prima di considerare un task completato**: esegui `npm run typecheck` e
`npm run lint` e verifica che passino senza errori.

### Convenzioni

- **Niente commenti** nel codice a meno che non siano richiesti esplicitamente
- ESM con estensione `.js` negli import relativi
- Tipi condivisi in `src/types.ts`, importati con `import type`
- Nessun `any`: usare `unknown` e restringere
- Logger via `createLogger`, passato per dipendenza
- Vedi **AGENTS.md** per le convenzioni complete

### Debug

Per ispezionare i file temporanei dopo un run (segmenti renderizzati, keyframe):

```bash
# PowerShell
$env:VC_KEEP_TEMP='1'; npx tsx src/index.ts --ai --out output/test.mp4
# ispeziona .tmp/<uuid>/
```

Imposta `LOG_LEVEL=debug` nel `.env` per log più verbose.
