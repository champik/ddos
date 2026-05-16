# Daily Dose Of Stream (DDOS) — Automated Video Pipeline

## Що це

Щоденна автоматична система для YouTube каналу "Daily Dose Of Stream" (DDOS).
Твич кліпи → готовий YouTube епізод + Shorts + thumbnail + metadata.

**Output:** `projects/Episode_N_YYYY_MM_DD/exports/episode-NNN.mp4` + shorts/ + thumbnail.png + metadata.json  
**Публікація:** ручна через YouTube Studio або автоматична після `/ddos approve`.

### Іменування папок проектів
- Формат: `Episode_N_YYYY_MM_DD` де N — номер епізоду, дата — дата запуску
- Приклад: `Episode_1_2026_05_16`, `Episode_2_2026_05_17`
- Тестові/невдалі запуски: `Test_N_YYYY_MM_DD`

### Іменування завантажених кліпів
- Формат: `{category}_{streamer}_{views}_{YYYY_MM_DD}.mp4`
- category = game_name sanitized (lowercase, пробіли→underscore, тільки [a-z0-9_])
- streamer = broadcaster_name lowercase  
- views = view_count (ціле число)
- Приклад: `just_chatting_xqc_45000_2026_05_15.mp4`
- Зберігається у `downloads/` в папці проекту
- Поле `localPath` у `downloaded-clips.json` вказує на фактичний файл

---

## AUTONOMOUS MODE

**Від команди до готового відео без зупинок.**

Єдині дозволені паузи:
1. Показ scored clips список перед рендером (швидкий огляд)
2. Фінальний `/ddos approve <runId>` перед upload

Ніяких "продовжувати?", "дозволити bash?", "confirm?".  
Якщо щось пішло не так — записати в state.json і продовжити далі.

---

## Команди

- `/ddos run` — повний pipeline за 24 години
- `/ddos run --hours 48` — кліпи за останні 48 годин
- `/ddos run --dry-run` — тільки ingest + filter, без завантаження (тест)
- `/ddos resume <runId>` — продовжити з місця де зупинився
- `/ddos status <runId>` — показати статус всіх stages
- `/ddos approve <runId>` — approve для upload на YouTube

---

## Pipeline — порядок виконання

```
1.  INGEST      Twitch API → raw-clips.json (гібридний sampling)
2.  FILTER      відсіяти RU / gambling / занадто короткі / занадто довгі
3.  DOWNLOAD    yt-dlp → downloads/<clipId>.mp4
4.  TRANSCRIBE  faster-whisper (Python) → transcript.json (word timestamps)
5.  SCORE       Claude аналізує кожен кліп → score.json (DDOS Score 0–100)
6.  PLAN        Claude будує порядок епізоду, вибирає Shorts кандидатів
7.  TRIM        FFmpeg обрізка dead air на початку/кінці кожного кліпу
8.  HOOKS       Claude генерує текстовий хук для кожного кліпу (2–5 слів)
9.  CAPTIONS    ASS субтитри (word-by-word Shorts / selective long-form)
10. OVERLAYS    Puppeteer → streamer name PNG + reconnecting PNG → FFmpeg burn
11. RENDER LONG FFmpeg concat: intro + кліпи + transitions + outro → 1920×1080
12. RENDER SHORTS FFmpeg vertical crop → 1080×1920 + captions
13. THUMBNAIL   Puppeteer рендер thumbnail.html → best frame + текст + епізод №
14. METADATA    Claude → title options / description / hashtags / shorts captions
15. REVIEW      Генерувати review.html з превью всього
```

---

## Конфігурація

### Twitch категорії
```json
[
  { "name": "Just Chatting",      "gameId": "509658", "weight": 0.25 },
  { "name": "IRL",                "gameId": "509672", "weight": 0.10 },
  { "name": "Counter-Strike 2",   "gameId": "32399",  "weight": 0.12 },
  { "name": "PUBG",               "gameId": "493057", "weight": 0.06 },
  { "name": "Valorant",           "gameId": "516575", "weight": 0.10 },
  { "name": "Grand Theft Auto V", "gameId": "32982",  "weight": 0.10 },
  { "name": "World of Warcraft",  "gameId": "18122",  "weight": 0.05 },
  { "name": "League of Legends",  "gameId": "21779",  "weight": 0.08 },
  { "name": "Minecraft",          "gameId": "27471",  "weight": 0.06 },
  { "name": "Fortnite",           "gameId": "33214",  "weight": 0.08 }
]
```

### Ліміти
- maxClipCandidates: 500
- maxDownloads: 80
- maxClipsPerEpisode: 12–18
- maxClipsPerStreamer: 3 (у episode plan)
- minDuration: 6s / maxDuration: 90s
- targetEpisodeMin: 720с (12 хв)
- targetEpisodeMax: 900с (15 хв)
- maxShorts: 10
- maxDancingClipsInFinale: 10

### Фільтри — ЗАВЖДИ відхиляти
- language == "ru"
- language in ["ja", "ko", "zh", "th"] — азійські мови: переглядів багато але незрозуміло без контексту. Максимум 1 кліп на епізод тільки якщо момент суто візуальний (без діалогу) або міжнародно відомий стрімер
- title містить: русский, россия, russian, путін, рф
- category: Slots, Casino, Gambling, Sports Betting
- стрімер у blacklist: (порожній за замовчуванням)

### DDOS Score формула
```
ddosScore =
  retentionScore * 0.30
  + funnyScore   * 0.25
  + payoffStrength * 0.20
  + contextClarity * 0.15
  + noveltyScore * 0.10
  - (musicRisk > 60 ? (musicRisk - 60) * 0.3 : 0)
  - (toxicityRisk > 40 ? (toxicityRisk - 40) * 0.5 : 0)
```

---

## Структура файлів

```
projects/<runId>/
├── state.json                     # stage статуси: pending/running/done/failed
├── clips/
│   ├── raw-clips.json
│   ├── filtered-clips.json
│   ├── downloaded-clips.json
│   └── scored-clips.json
├── downloads/{category}_{streamer}_{views}_{YYYY_MM_DD}.mp4  # ім'я кліпу
├── processed/<clipId>/
│   ├── transcript.json
│   ├── score.json
│   ├── hook.txt
│   ├── clean.mp4                      # trimmed + re-encoded + loudnorm
│   ├── overlayed.mp4                  # clean.mp4 + animated WebM broadcaster overlay
│   ├── captions-longform.ass
│   └── captions-vertical.ass
├── cache/overlays/<broadcaster>.webm  # cached animated streamer overlays
├── edit/
│   ├── episode-plan.json
│   ├── shorts-selection.json
│   ├── captions-segments.json
│   ├── episode.ass                    # merged episode captions
│   ├── reconnecting-panel.webm        # pre-rendered reconnecting WebM
│   ├── reconnecting.mp4               # 1s glitch moment
│   ├── chill-finale.mp4               # singing + dancing finale (optional)
│   └── concat-list.txt
├── exports/
│   ├── episode-NNN.mp4
│   ├── thumbnail.png
│   ├── metadata.json
│   ├── analytics.json
│   └── shorts/<clipId>.mp4
└── review/review.html
```

---

## Assets (вже існують)

```
assets/intro/intro.mp4              1920×1080, 1.25s — завжди на початку
assets/outro/outro.mp4              1920×1080, 1.25s — завжди в кінці
assets/overlays/reconnecting.html   RECONNECTING transition overlay
assets/streamer-overlay/streamer_name.html  ім'я стрімера overlay
assets/thumbnail-template/thumbnail.html   шаблон thumbnail
assets/thumbnail-template/logo.svg         DDOS лого
```

---

## Skills

- `ddos-analytics` — YouTube Analytics → Notion tracking
- `ddos-ingest`    — Twitch API + filter + yt-dlp download
- `ddos-score`     — WhisperX transcribe + Claude scoring + hooks
- `ddos-render`    — FFmpeg trim + overlays + long-form render
- `ddos-shorts`    — vertical crop + captions + shorts render
- `ddos-thumbnail` — Puppeteer thumbnail + metadata generation
- `ddos-review`    — review.html генерація
- `ddos-publish`   — YouTube upload + OAuth2 publish flow

---

## Мова

Спілкування — українська. Промпти до Claude API, імена файлів — англійська.
