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
3.  DOWNLOAD    yt-dlp → downloads/<clipId>.mp4 (100 кліпів)
4.  TRANSCRIBE  faster-whisper (Python) → transcript.json (word timestamps)
5.  SCORE       Claude аналізує кожен кліп → score.json (DDOS Score 0–100)
6.  TRIM        FFmpeg incremental: топ-30 за ddosScore → перевір суму → +10 поки не 12–15хв
7.  PLAN        Claude будує план по ТРИВАЛОСТІ 12–15 хв (сума clean.mp4)
8.  HOOKS       Claude генерує текстовий хук для кожного кліпу (2–5 слів)
9.  CAPTIONS    ASS субтитри (word-by-word Shorts / selective long-form)
10. OVERLAYS    Puppeteer → streamer name PNG + reconnecting PNG → FFmpeg burn
11. RENDER LONG FFmpeg concat: intro + кліпи + transitions + outro → 1920×1080
12. RENDER SHORTS FFmpeg vertical crop → 1080×1920 + captions
13. METADATA    Claude → title options / description / hashtags / shorts captions
14. THUMBNAIL   Puppeteer рендер thumbnail.html → best frame + текст + епізод №
15. REVIEW      Генерувати review.html з превью всього
```

> **Чому TRIM перед PLAN:** plan використовує реальні тривалості clean.mp4 для точного
> таргетингу 12–15 хв. Raw duration з Twitch API може бути на 30–70% довшим за фактичну
> тривалість після обрізки тиші. Incremental підхід: trim топ-30 → якщо < 12хв → trim ще 10 → ...
> Зупинка якщо ddosScore наступного кліпу < 45 (якісна підлога).

---

## Конфігурація

### Twitch категорії

**Core (завжди фетчаться, categoryScore=88 у pre-score):**

| Бакет | Категорія | gameId |
|-------|-----------|--------|
| JC/IRL | Just Chatting | 509658 |
| JC/IRL | IRL | 509672 |
| Specialty | Music | 26936 |
| Specialty | Food & Drink | 509667 |
| Specialty | Fitness & Health | 509671 |
| Specialty | Pools, Hot Tubs, and Beaches | 116747788 |
| Specialty | Talk Shows & Podcasts | 417752 |

**Dynamic (топ-12 з Twitch топ-20, виключаючи core і gambling):**
Gaming категорії що в тренді (CS2, GTA, Valorant, LoL тощо).

### Download бакети (100 кліпів)
```
JC/IRL     → до 50  (40 по вірусності + 10 по популярності)
Specialty  → до 15  (10 по вірусності + 5 по популярності, max 5 з однієї категорії)
Gaming     → до 35  (25 по вірусності + 10 по популярності, max 5 з однієї гри)
```

### Ліміти
- maxClipCandidates: 500
- maxDownloads: 100
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
- стрімер у blacklist: Lyasyaa

### Детекція російських стрімерів (багатошарова)
Окрім `language == "ru"`, перевіряти додатково при FILTER stage:

**1. Blacklist (ручний список)**
Стрімери додані вручну — відхиляти одразу.  
Поточний список: `Lyasyaa`

**2. Сигнали з Twitch API (metadata)**
- `broadcaster_language == "ru"` — мова каналу
- `broadcaster_name` або `display_name` містить кирилицю
- `title` або `description` каналу містить кирилицю або слова зі списку: россия, русский, рф, путін, москва, питер
- `stream_language == "ru"` у полі clips endpoint

**3. Транскрипт (після TRANSCRIBE)**
- `detected_language == "ru"` від Whisper — відхиляти навіть якщо Twitch сказав інше
- Якщо >30% слів кирилиця — відхиляти

**4. Логіка при конфлікті**
Якщо будь-який з сигналів = RU → відхиляти без винятків.  
Принцип: краще пропустити хороший кліп, ніж включити RU контент.

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
│   ├── hook.txt
│   ├── clean.mp4                      # trimmed + re-encoded + loudnorm
│   ├── overlayed.mp4                  # clean.mp4 + animated MKV broadcaster overlay
│   ├── captions-longform.ass
│   └── captions-vertical.ass
├── cache/overlays/<broadcaster>.mkv   # cached streamer overlays (FFV1 MKV) + reconnecting-panel.mkv
├── edit/
│   ├── episode-plan.json
│   ├── shorts-selection.json
│   ├── captions-segments.json
│   ├── episode.ass                    # merged episode captions
│   ├── reconnecting.mp4               # ~2s glitch moment (тривалість залежить від кліпу)
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
