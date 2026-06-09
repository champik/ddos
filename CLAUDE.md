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

### Stage 1 (авто — до editorial)
```
1.  INGEST              Twitch API → raw-clips.json
2.  FILTER              відсіяти RU / gambling / занадто короткі / занадто довгі
3.  SELECT              bucket відбір по velocity+popularity → prescore-candidates.json
4.  DOWNLOAD            yt-dlp → downloads/<filename>.mp4 (100 кліпів)
5.  GENERATE_EDITORIAL  gen-editorial.js → edit/edit.html  ← ЗУПИНКА
```

Після GENERATE_EDITORIAL: відкрити `edit/edit.html` у браузері, зробити editorial рішення, "Copy Prompt" → вставити в чат.

### Stage 2 (після editorial JSON)
```
6.  APPLY_EDITORIAL  apply-editorial.js → clean.mp4 (trim + cuts з editorial.json)
7.  TRANSCRIBE       WhisperX large-v2 → transcript.json (тільки вибрані кліпи, з clean.mp4)
8.  OVERLAYS         Puppeteer → streamer overlay + reconnecting panel
9.  RENDER LONG      FFmpeg concat → episode-NNN.mp4
10. CAPTIONS         WhisperX ASS субтитри для shorts
11. RENDER SHORTS    FFmpeg → 1080×1920 (desktop/mobile/split)
12. METADATA         Claude → title/description/tags (на основі транскриптів)
13. THUMBNAIL        Puppeteer → thumbnail.png
14. REVIEW           review.html + index.html
```

---

## Конфігурація

### Twitch категорії

**Core (завжди фетчаться):**

| Бакет | Категорія | gameId |
|-------|-----------|--------|
| JC/IRL | Just Chatting | 509658 |
| JC/IRL | IRL | 509672 |
| Specialty | Music | 26936 |
| Specialty | Pools, Hot Tubs, and Beaches | 116747788 |
| Gaming | Counter-Strike | 32399 |
| Gaming | VALORANT | 516575 |
| Gaming | League of Legends | 21779 |
| Gaming | Dota 2 | 29595 |
| Gaming | PUBG: BATTLEGROUNDS | 493057 |

**Dynamic Gaming (додаткові категорії понад Core):**

Топ-5 з Twitch топ-20, виключаючи Core і бан-лист. Нові хайпові ігри природно з'являться тут самі.

### Download бакети (100 кліпів)
```
JC/IRL     → до 50  (30 по вірусності + 20 по популярності)
Specialty  → до 10  (7 по вірусності + 3 по популярності, max 6 з однієї категорії)
Gaming     → до 40  (30 по вірусності + 10 по популярності, max 5 з однієї гри)
```

### Ліміти
- maxClipCandidates: 500
- maxDownloads: 100
- maxClipsPerStreamer: 5 (у download selection)
- minDuration: 6s / maxDuration: 90s
- targetEpisodeMin: 720с (12 хв)
- targetEpisodeMax: 900с (15 хв)
- maxShorts: 10

### Фільтри — ЗАВЖДИ відхиляти
- language != "en" — будь-яка мова крім англійської (RU, UK, JA, KO, ZH, TH та всі інші)
- title містить: русский, россия, russian, путін, рф (додатковий захист для хибно-класифікованих кліпів)
- category: Slots, Casino, Gambling, Poker, Sports Betting, Escape from Tarkov, Overwatch 2, Marvel Rivals, Dark and Darker, Path of Exile 2
- стрімер у blacklist: Lyasyaa, Qoqsik, vedal987 (VTuber)

### DDOS Score формула
```
viralityScore = min(100, sqrt(viralityRatio) * 35)
  // viralityRatio = view_count / hours_alive / avg_viewers (TwitchTracker cache)

ddosScore =
  viralityScore  * 0.30
  + retentionScore * 0.25
  + funnyScore   * 0.20
  + payoffStrength * 0.15
  + contextClarity * 0.10
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
│   ├── clean.mp4                      # trimmed + re-encoded + loudnorm
│   ├── overlayed.mp4                  # clean.mp4 + animated MKV broadcaster overlay
│   ├── captions-longform.ass
│   └── captions-vertical.ass
├── edit/
│   ├── edit.html                      # Editorial UI (відкрити в браузері після SCORE)
│   ├── editorial.json                 # Рішення редактора (Claude пише при /ddos resume)
│   ├── episode-plan.json              # Генерується з editorial.json при resume
│   ├── shorts-selection.json
│   ├── captions-segments.json
│   ├── episode.ass                    # merged episode captions
│   ├── reconnecting.mp4               # ~2s glitch moment (тривалість залежить від кліпу)
│   └── concat-list.txt
├── exports/
│   ├── episode-NNN.mp4
│   ├── thumbnail.png
│   ├── metadata.json
│   ├── shorts/<clipId>.mp4
│   └── clean/<clipId>.mp4           # копія clean.mp4 для шортсів (тільки short-кліпи)
└── review/review.html
```

**Глобальний кеш (поза папкою проекту):**
```
cache/overlays/<broadcaster>.mkv    # кешовані streamer overlays (FFV1 MKV, перевикористовуються між епізодами)
cache/overlays/reconnecting-panel.mkv
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

- `ddos-ingest`    — Twitch API + filter + yt-dlp download
- `ddos-score`     — GENERATE_EDITORIAL (Stage 1); TRANSCRIBE — в Stage 2 через transcribe-batch.js
- `ddos-render`    — FFmpeg trim + overlays + long-form render
- `ddos-shorts`    — vertical crop + captions + shorts render
- `ddos-thumbnail` — Puppeteer thumbnail + metadata generation
- `ddos-review`    — review.html генерація
- `ddos-publish`   — YouTube upload + OAuth2 publish flow

---

## Мова

Спілкування — українська. Промпти до Claude API, імена файлів — англійська.
