# video-composer — Design Doc

Tool CLI (Node.js + TypeScript) che, dati in input N clip verticali (4–20s ciascuna),
produce un **Reel Instagram di ≤ 60 secondi** con tagli professionali, musica di
sottofondo e selezione dei momenti salienti assistita da AI (uso parsimonioso).

Target utente: fotografo che vuole automatizzare la creazione di contenuti
promozionali a basso sforzo e basso costo.

---

## 1. Verdetto di fattibilità

**Fattibile.** La parte "hard" di video editing (taglio, composizione, transizioni,
loudness, export verticale) è deterministica e si risolve con **FFmpeg** (locale,
gratis, già installato: 7.1.1). La parte "creativa" (riconoscere i momenti più
carini/interessanti) è dove l'AI aggiunge valore reale e si può fare in modo
**parsimonioso e a bassissimo costo** (qualche decina di chiamate vision per reel,
<0.10€/reel).

Il rischio non è la fattibilità tecnica ma la **qualità percettiva**. Un reel sembra
"professionale" o "amatoriale" soprattutto per tre fattori, su cui il design si
concentra in modo esplicito:

1. **Ritmo dei tagli sincronizzato alla musica** (beat sync).
2. **Transizioni non brusche** (snap ai confini di scena + crossfade brevi).
3. **Contenuto dei tagli** (momenti salienti, non spezzoni a caso).

---

## 2. Assunti di progetto (dal questionario iniziale)

| Assunto               | Decisione                                   | Impatto                                                                                |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Orientamento sorgente | **Verticale 9:16**                          | Nessun reframe/crop → pipeline molto più semplice e nessuna perdita di qualità         |
| Audio dei clip        | **B-roll, audio irrilevante**               | I clip vengono **mutati**; si mantiene solo la musica. Nessun VAD / ducking necessario |
| Musica                | **Library locale open-source pre-caricata** | Lo script sceglie un brano dalla cartella `assets/music` in base al mood rilevato      |
| Scope sessione 1      | **Solo scaffold + design doc + AGENTS.md**  | Nessuna logica implementata; tutti gli step sono stub `NotImplementedError`            |

Conseguenza importante: rispetto a un caso generale, **cadono i due step più
delicati e costosi** — il reframe verticale face-aware e il voice-activity detection
per evitare tagli mid-speech. Questo riduce drasticamente complessità e costo.

---

## 3. Stack tecnologico

| Concern                                                             | Strumento                                                                | Costo            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------- |
| Probe / tagli / concat / transizioni / audio / color grade / export | **FFmpeg** via `child_process` (runner in `src/ffmpeg/runner.ts`)        | 0€ (locale)      |
| Scene detection (punti di taglio naturali)                          | FFmpeg filter `select='gt(scene,T)'`                                     | 0€               |
| Beat detection sulla musica                                         | `music-tempo` (pure JS) o `essentia.js` (WASM) — da valutare in fase MVP | 0€               |
| Estrazione keyframe per AI                                          | FFmpeg (`fps=1` o 1 per scena)                                           | 0€               |
| Valutazione estetica/emozionale dei frame                           | **Vision model via OpenCode Go/Zen** (1 chiamata/clip)                   | ~0.01–0.10€/reel |
| Validazione config                                                  | `zod`                                                                    | 0€               |
| Client AI                                                           | `openai` SDK (endpoint OpenAI-compatible)                                | 0€               |
| Runtime                                                             | Node 22 + TypeScript (ESM, NodeNext)                                     | 0€               |

Prerequisiti: Node ≥ 20.10, FFmpeg + ffprobe nel PATH (o via `FFMPEG_PATH`/`FFPROBE_PATH`).

---

## 4. Pipeline (9 step)

Ogni step corrisponde a un modulo in `src/steps/` con firma tipata. L'orchestratore
è `src/pipeline.ts`.

```
Clip in input (4–20s, 9:16)
        │
   [1] probe            ffprobe: durata, risoluzione, fps, audio sì/no, codec
        │
   [2] sceneDetect      FFmpeg scene detection → confini di scena naturali
        │
   [3] keyframes        estrai 1 frame per scena (max VISION_MAX_FRAMES_PER_CLIP)
        │
   [4] aiScore          1 chiamata vision per clip → FrameScore[] (estetica,
                        emozione, movimento, soggetto, mood) + selectBestSegment
        │
   [5] budget           distribuisce i 60s tra i clip in base all'overallScore;
                        per ogni clip seleziona il sottosegmento "migliore"
        │
   [6] cutRefine        snap dei tagli ai confini di scena + regole
                        (durata min/max, evitare cut su soggetto in moto brusco)
        │
   [7] narrative        ordinamento: intro leggero → buildup → picco → outro
                        (rule-based; AI opzionale solo se serve riordinare)
        │
   [8] musicSync        scelta brano library per mood; analyzeMusic → BeatInfo;
                        snap dei tagli ai beat; trim/fade musica a 60s
        │
   [9] compose          FFmpeg: concat con crossfade, mute dei clip, mix musica,
                        loudness normalize (TARGET_LUFS), color grade leggero,
                        export H.264 1080x1920 @ 30fps
        │
   Reel output (.mp4, 9:16, ≤ 60s)
```

### 4.1 Dettaglio step critici

**[2] sceneDetect** — `ffmpeg -i clip -vf select='gt(scene\,0.30)',showinfo -f null -`.
Soglia 0.30 tunabile. Output: lista di timestamp con score. Questi timestamp sono i
**candidati preferiti per i tagli** perché cadono su transizioni di contenuto
naturali (non bruschi).

**[3] keyframes** — 1 frame per scena, al centro temporale della scena, JPEG 512px
lato corto (sufficiente per la vision, basso payload). Se le scene > maxFrames,
campiona in modo uniforme. Questo **limita le chiamate AI** (es. clip 15s con 4
scene → 4 frame → 1 chiamata batch).

**[4] aiScore** — Una singola chiamata chat/completions **multimodale** con tutti i
frame della clip in un unico messaggio (image_url base64). Prompt strutturato,
output JSON forzato. Vedi §5.

**[6] cutRefine** — Regole deterministiche (no AI):

- rispetta `MIN_SEGMENT_SEC` (default 1.2s) e `MAX_SEGMENT_SEC` (default 6s);
- se un taglio cade dentro un intervallo ±0.4s da un confine di scena, spostalo
  sul confine;
- evita tagli nei primi/ultimi 0.3s del clip (bordi neri/transizioni di camera);
- se due segmenti consecutivi vengono dallo stesso clip, inserisci comunque un
  crossfade (evita jump cut apparenti).

**[8] musicSync** — Beat detection sul brano scelto. Allinea i tagli ai beat:

- ogni segmento viene "stirato/compresso" entro tolleranza ±0.15s per cadere su un
  beat;
- se beat detection fallisce (confidence < 0.4), fallback su cadenza costante
  derivata dal BPM dichiarato o da un default (90 BPM);
- musica trimmata a `totalDurationSec` con fade-out 1.5s finale e fade-in 0.3s.

**[9] compose** — Catena FFmpeg (concettuale):

```
 concat con xfade (crossfade 0.3s) tra segmenti
 → mute completo dei clip (-an sui segmenti)
 → overlay musica normalizzata loudnorm I=-14 LRA=11 TP=-1.5
 → scale 1080x1920, setsar=1
 → color grade leggero (curva + saturazione +3%) opzionale
 → libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart
```

Hardware accel (NVENC `h264_nvenc`) opzionale se presente GPU Nvidia → da verificare
a runtime e usare come fast path.

---

## 5. Strategia AI parsimoniosa

### 5.1 Dove l'AI vale la pena (SÌ)

**Solo in [4] aiScore**: giudicare estetica/emozione dei frame. Qui l'AI è
insostituibile e costa pochissimo. Una chiamata per clip (batch di tutti i suoi
keyframe) → per 5–20 clip sono **5–20 chiamate totali per reel**.

**Opzionalmente in [7] narrative**: una chiamata testuale (senza immagini) con il
riassunto dei clip (mood + soggetto + score) per proporre un ordinamento "a
storia". Una sola chiamata per reel, contesto breve. Default: disattivata
(ordine rule-based); attivabile via flag.

### 5.2 Dove l'AI NON va usata

- **NO** decidere i millisecondi esatti di taglio → scene detection + regole sono
  più affidabili, deterministici e ripetibili.
- **NO** analizzare ogni frame → costoso, lento, inutile. Solo keyframe per scena.
- **NO** generare la musica → licensing e qualità non adatti; meglio library.
- **NO** trascrivere/analizzare l'audio dei clip → è B-roll mutato.

### 5.3 Prompt vision (bozza, da iterare)

System:

> Sei un editor video professionista per contenuti Instagram di un fotografo.
> Valuti frame estratti da un clip verticale per scegliere i momenti migliori.

User (con N immagini in ordine temporale):

> Questi frame vengono da un unico clip, in ordine temporale (t1 < t2 < ...).
> Per ciascuno restituisci un oggetto JSON con: timeSec, aesthetic (1-10,
> composizione/luce/qualità tecnica), emotionalWarmth (1-10, espressioni,
> calore, "carineria"), motionLevel (1-10, movimento/soggetto in azione),
> focusSubject (≤5 parole, soggetto principale), mood (uno tra: joyful, calm,
> energetic, intimate, epic, melancholic, neutral), notes (opzionale, ≤15 parole).
> Rispondi SOLO con un array JSON di oggetti, senza testo aggiuntivo.

Output forzato JSON via `response_format: { type: 'json_object' }` o schema, a
seconda del modello. Validazione con zod lato codice; retry 1× se malformed.

### 5.4 Costo stimato per reel

Modello vision economico (es. `gpt-5.4-nano` a 0.20$/1M input, 1.25$/1M output —
prezzi Zen, da verificare sul piano Go):

- ~6 frame/clip × 20 clip = 120 immagini; ogni frame ~512px JPEG ≈ 30–60KB
  → come token di immagine, stima ~300–800 token immagine ciascuno.
- Token totali per reel: ~50k–150k input + ~2k output.
- **Costo: ~0.02–0.10€/reel**. Trascurabile.

---

## 6. Integrazione OpenCode Go / Zen API

- **Endpoint base**: `https://opencode.ai/zen/v1` (OpenAI-compatible).
- **Path**: `/chat/completions` per i modelli OpenAI-compatible (GPT, GLM, DeepSeek,
  Qwen, Kimi…). Per Claude è `/messages`, per Gemini `/models/...`: in fase MVP si
  usa un modello su `/chat/completions` per semplicità.
- **Auth**: `Authorization: Bearer $OPENCODE_API_KEY`.
- **Client**: SDK `openai` puntato a `OPENCODE_BASE_URL` → swap del provider senza
  toccare il codice.

### 6.1 Caveat critico: modello vision

I modelli in lista Zen/Go sono curati come **coding agent**. Non c'è un "vision
model" esplicito. Molti (GPT 5.x, Gemini 3.x, Claude 4.x) sono **multimodali** ma
va **verificato** sul piano Go dell'utente quale modello accetti immagini in input
e a quale prezzo. `glm-5.2` (modello di default dell'abbonamento Go) è un coding
model: **non è garantito che supporti vision**.

**Mitigazione progettuale:**

1. Tutto l'AI è dietro l'interfaccia `VisionClient` (`src/ai/visionClient.ts`),
   configurabile via `VISION_MODEL` + `OPENCODE_BASE_URL`.
2. `DESIGN` prevede un **fallback deterministico** se nessun modello vision è
   disponibile/economico: highlight selection basata solo su segnali FFmpeg
   (densità di scene change, varianza luminanza, energia movimento via
   `mpdecimate`/`select`). Qualità inferiore ma pipeline funzionante a costo 0.
3. In fase MVP si **prova prima** un modello vision economico (gpt-5.4-nano /
   gemini-3-flash); se non disponibile sul piano Go, si passa al fallback.

### 6.2 Privacy

I frame inviati al modello contengono persone (soggetti del fotografo). Verificare
la policy di retention del provider scelto (Zen: provider US, retention 30gg per
OpenAI/Anthropic, zero-retention per altri). Per contenuti sensibili, preferire
modelli con policy zero-retention o valutare un modello locale (Ollama) come
alternativa off-label.

---

## 7. Selezione musicale (library locale)

- L'utente popola `assets/music/` con brani **royalty-free** (es. YouTube Audio
  Library, Free Music Archive, Pixabay Music, Uppbeat free tier). **Responsabilità
  licensing è dell'utente** — il tool non distribuisce brani, li usa localmente.
- Ogni brano viene analizzato una volta (BPM + beats) e **cached** in un metadata
  file (es. `assets/music/.index.json`) per non ricalcolare.
- Scelta del brano: match sul **mood dominante** dei clip (mediana dei `FrameScore.mood`).
  Se più brani matchano, si sceglie per BPM più adatto alla densità di tagli
  (tagli frequenti → BPM più alto).
- L'utente può forzare un brano via `--music <path>`.

---

## 8. Qualità "professionale": leva specifiche

| leva              | Come                                                                        |
| ----------------- | --------------------------------------------------------------------------- |
| Ritmo             | Tagli sui beat della musica (step 8)                                        |
| Non-bruschi       | Snap ai confini di scena (step 6) + crossfade 0.3s (step 9)                 |
| No jump cut       | Crossfade anche tra segmenti dello stesso clip                              |
| Durate bilanciate | `MIN_SEGMENT 1.2s` / `MAX_SEGMENT 6s`; niente spezzoni < 1s                 |
| Loudness coerente | `loudnorm I=-14 LUFS, LRA=11, TP=-1.5` sulla musica                         |
| Export IG-ready   | 1080x1920, 30fps, H.264 CRF 18, `+faststart`, yuv420p                       |
| Color grade       | Curva leggera + saturazione +3% (opzionale, attivabile)                     |
| Fade              | Fade-in 0.3s, fade-out 1.5s sulla musica; nero 0.2s in testa/coda opzionale |

---

## 9. Rischi & mitigazioni

| Rischio                                   | Probabilità | Impatto      | Mitigazione                                                                            |
| ----------------------------------------- | ----------- | ------------ | -------------------------------------------------------------------------------------- |
| Nessun modello vision sul piano Go        | Media       | Alto         | Fallback deterministico (§6.1)                                                         |
| AI giudica "carino" in modo incoerente    | Alta        | Medio        | Prompt tuning iterativo + normalizzazione punteggi + regole deterministico di fallback |
| Beat detection imprecisa                  | Media       | Medio        | Fallback su BPM dichiarato / cadenza costante se confidence < 0.4                      |
| Encoding lento su clip lunghi             | Bassa       | Basso        | NVENC fast path; `preset slow` solo su clip corti è OK                                 |
| Frame con soggetti sensibili inviati a AI | Media       | Medio        | Scelta modello zero-retention o opzione locale (Ollama)                                |
| Musica non royalty-free                   | Bassa       | Alto (legal) | Documentazione licensing a carico utente; tool non distribuisce audio                  |
| Variazioni di fps/risoluzione tra clip    | Media       | Medio        | Normalizzazione in step 9 (scale + fps uniformi)                                       |

---

## 10. Costo & effort

- **Costo per reel**: <0.10€ (quasi tutto AI vision; resto locale e gratis).
- **MVP end-to-end** (pipeline completa, qualità base): ~1–2 settimane solo.
- **Qualità "professionale"**: richiede iterazione su prompt + beat sync + regole
  di taglio. Il tuning è continuo.

---

## 11. Struttura del progetto

```
video-composer/
├── AGENTS.md              convenzioni + comandi per agent/CI
├── DESIGN.md              questo documento
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── .prettierrc.json
├── .env.example           template config (copiare in .env)
├── assets/music/          library brani royalty-free (gitignored)
├── input/                 clip sorgente (gitignored)
├── output/                reel prodotti (gitignored)
└── src/
    ├── index.ts           entry point
    ├── config.ts          env + zod
    ├── pipeline.ts        orchestratore (stub)
    ├── types.ts           tipi di dominio
    ├── ai/
    │   └── visionClient.ts    client vision (OpenAI-compatible)
    ├── ffmpeg/
    │   └── runner.ts      wrapper fluent-ffmpeg (stub)
    ├── steps/
    │   ├── probe.ts       [1]
    │   ├── sceneDetect.ts [2]
    │   ├── keyframes.ts   [3]
    │   ├── aiScore.ts     [4]
    │   ├── budget.ts      [5]
    │   ├── cutRefine.ts   [6]
    │   ├── narrative.ts   [7]
    │   ├── musicSync.ts   [8]
    │   └── compose.ts     [9]
    └── utils/
        ├── logger.ts      logger JSON a livelli
        └── errors.ts      NotImplementedError
```

---

## 12. Roadmap

- **Fase 0 — Scaffold** ✅ (questa sessione): progetto, tipi, stub, design doc, AGENTS.md.
- **Fase 1 — MVP deterministico**: probe + sceneDetect + keyframes + budget/cut
  rule-based (senza AI) + musicSync + compose. Reel valido ma selezione "naive".
  Validare l'infrastruttura FFmpeg end-to-end.
- **Fase 2 — AI vision**: implementare `VisionClient` + `aiScore`; collegare al
  budget/cut. Verificare modello vision disponibile sul piano Go.
- **Fase 3 — Qualità**: beat sync real, crossfade real, color grade, fast path
  NVENC, caching metadata musica.
- **Fase 4 — UX**: CLI con argomenti (input dir, --music, --out, --no-ai, --dry-run),
  report selezione (quali spezzoni scelti e perché), preview plan prima del render.
- **Fase 5 — Tuning continuo**: prompt, soglie scene detect, regole cut.

---

## 13. Sicurezza

- **API key**: solo via variabile d'ambiente (`.env`, gitignored). Mai nel codice,
  mai committata. La chiave postata in chat va **ruotata**.
- **Musica**: licensing a carico dell'utente. Il tool non distribuisce audio.
- **Dati in uscita (frame verso AI)**: valutare retention del provider; per
  contenuti sensibili preferire modello zero-retention o locale.

---

## 14. Stato attuale

- ✅ Scaffold Node + TypeScript (ESM/NodeNext, strict).
- ✅ Tipi di dominio completi in `src/types.ts`.
- ✅ Runner FFmpeg (`src/ffmpeg/runner.ts`) via `child_process`.
- ✅ **Fase 1 — MVP deterministico**: probe, sceneDetect, scoring deterministico,
  budget, cutRefine, narrative, musicSync (beat sintetici), compose (xfade + loudnorm).
- ✅ **Fase 2 — AI vision**: `VisionClient` via Responses API (`/responses`,
  `gpt-5.4-nano`), `selectBestSegment` con finestra scorrevole, fallback resiliente
  al deterministico se l'AI fallisce. Endpoint corretti: Zen per vision, Go per text.
- ✅ **Fase 3 — Qualità professionale**:
  - **Beat detection real** (`musicSync.ts`): estrazione PCM via FFmpeg + onset
    detection energy-based + BPM via mediana degli intervalli + allineamento beat.
    Confidenza calcolata (0.7 su fairy.mp3, BPM 129). `snapCutsToBeats` allinea i
    tagli ai beat entro ±150ms. Fallback a 120 BPM fisso se detection fallisce.
  - **Color consistency** (`compose.ts`): `eq` (saturazione +8%, contrasto +3%,
    brightness +1%) + `curves=increase_contrast` + `unsharp` applicati a ogni
    segmento per uniformare look tra clip diverse.
  - **Speed ramping sul picco emotivo** (`compose.ts`): il segmento con
    `emotionalWarmth` più alto (marcato da `markEmotionalPeak` in pipeline) viene
    rallentato (setpts 1.6×) negli ultimi 0.8s per enfatizzare il momento clou.
    Durata reale misurata dopo il ramp per xfade/concat coerenti.
  - **Concat robusto**: per >4 segmenti usa `concat` con fade in/out per segmento
    (xfade a cascata è fragile su N>6); per ≤4 segmenti usa xfade a cascata.
- ✅ **Fase 3b — Detection AI + scoring tecnico**:
  - **B. Detection via AI** (`visionClient.ts`): prompt esteso con `personVisible`
    (boolean), `facePosition` ("center"/"left"/"right"/"out-of-frame"/"none") e
    `framingQuality` (1-10). Stessa chiamata API, costo invariato.
    `selectBestSegment` penalizza: volto out-of-frame ×0.5, volto assente ma
    persona presente ×0.7. `framingQuality` pesa 20% nello score combinato.
  - **H. Sharpness/exposure scoring** (`keyframes.ts`): `measureFrameTechnical`
    estrae il frame in grayscale raw via FFmpeg e calcola nitidezza (varianza del
    laplaciano) ed esposizione (luminanza media). Valori normalizzati 1-10.
    `selectBestSegment` applica: moltiplicatore sharpness (0.7-1.0) e
    moltiplicatore exposure (sottoesposto <2.5 → 0.6, <4 → 0.85, sovraesposto
    > 8.5 → 0.7, >7.5 → 0.9). Pre-filtro gratuito che migliora la qualità
    > dell'input all'AI.
- ✅ **Fase 3c — Face detection deterministica (ONNX Runtime)**:
  - **MediaPipe Tasks Vision** resultò inutilizzabile in Node puro (richiede DOM
    browser completo: `document`, `canvas`, `addEventListener` su elementi).
    Sostituito con **ONNX Runtime Node** + modello **UltraFace RFB-320** (1.2MB,
    Apache-2.0, stesso family di BlazeFace). Funziona nativamente in Node, nessun
    polyfill DOM.
  - `src/vision/faceDetector.ts`: preprocessing RGB→CHW con mean subtraction,
    inferenza ONNX, estrazione candidate con confidence ≥ 0.6, NMS con IoU 0.3,
    calcolo `facePosition` (center/left/right/out-of-frame) + `framingQuality`
    (1-10) dal bounding box più grande. Coordinate clampate ai bordi [0,1];
    `overflow` tracciato per distinguere volti parzialmente fuori campo.
  - **Prompt AI semplificato**: rimossi `personVisible`/`facePosition`/
    `framingQuality` dal prompt vision (ora forniti da ONNX, deterministico e
    gratuito). Meno token output → meno costo.
  - Integrazione nel pipeline: per ogni keyframe, `detectFaces` arricchisce il
    `FrameScore` con detection deterministica (0€, privacy totale — i frame non
    lasciano il PC). L'AI rimane per aesthetic/emotionalWarmth/mood.
  - `FACE_DETECT_ENABLED` in `.env` per disabilitare (default: true).
- ⏳ Fase 4 (opzionale): UX CLI avanzata, report selezione, preview plan, NVENC.
