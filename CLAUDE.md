# Daily Dose Of Stream (DDOS) — Automated Video Pipeline

## Що це

Щоденна автоматична система для YouTube каналу "Daily Dose Of Stream" (DDOS).
Твич кліпи → готовий YouTube епізод + Shorts + thumbnail + metadata.

**Output:** `projects/<runId>/exports/episode-NNN.mp4` + shorts/ + thumbnail.png + metadata.json  
**Публікація:** ручна через YouTube Studio або автоматична після `/ddos approve`.

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
├── downloads/<clipId>.mp4
├── processed/<clipId>/
│   ├── transcript.json
│   ├── score.json
│   ├── hook.txt
│   ├── clean.mp4
│   ├── normalized.mp4
│   ├── streamer-overlay.png
│   ├── overlayed.mp4
│   ├── captions-longform.ass
│   └── captions-vertical.ass
├── edit/
│   ├── episode-plan.json
│   ├── shorts-selection.json
│   └── reconnecting.mp4
├── exports/
│   ├── episode-NNN.mp4
│   ├── thumbnail.png
│   ├── metadata.json
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
