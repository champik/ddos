# Daily Dose Of Stream (DDOS) — Automated Video Pipeline

## Що це

Щоденна автоматична система для YouTube каналу "Daily Dose Of Stream" (DDOS).
Твич кліпи → готовий YouTube епізод + Shorts + thumbnail + metadata.

**Output:** `projects/YYYY_MM_Month/Episode_N_YYYY_MM_DD/exports/episode-NNN.mp4` + shorts/ + thumbnail.png + metadata.json  
**Публікація:** ручна через YouTube Studio або автоматична після `/ddos approve`.

### Іменування папок проектів
- Проекти групуються по місяцях: `projects/YYYY_MM_Month/Episode_N_YYYY_MM_DD/`
- Приклад: `projects/2026_06_June/Episode_44_2026_06_28/`
- `YYYY_MM_Month` визначається по даті в runId (наприклад 2026_05_xx → `2026_05_May`)
- Для отримання шляху до проекту завжди використовувати `scripts/lib/project-path.js`:
  - `getProjectDir(runId)` → повний шлях
  - `monthFolderFromRunId(runId)` → папка місяця (напр. `2026_06_June`)
- Тестові/невдалі запуски: `Test_N_YYYY_MM_DD` (теж в місячній папці)
- Спеціальні епізоди: `Special_N_YYYY_MM_DD` — завжди в `projects/Special/`

### Іменування завантажених кліпів
- Формат: `{category}_{streamer}_{views}_{YYYY_MM_DD}_{idSuffix}.mp4`
- category = game_name sanitized (lowercase, пробіли→underscore, тільки [a-z0-9_])
- streamer = broadcaster_name lowercase  
- views = view_count (ціле число)
- idSuffix = останні 8 символів clip.id ([a-z0-9]) — захист від колізій імен
- Приклад: `just_chatting_xqc_45000_2026_05_15_a7k2m9qx.mp4`
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

- `/run` — повний pipeline за 24 години
- `/run N` — pipeline за останні N годин замість 24 (напр. `/run 120` — останні 5 днів); N>24 вмикає recency-компенсацію в SELECT (див. `ddos-ingest` skill)
- `/run special <опис>` — спеціальний епізод з довільною темою/критерієм (часовий діапазон, тема, подія)
- `/run month` — кращі кліпи за попередній місяць з recency-компенсацією (папка `Month_N_YYYY_MM_DD` в місяці покритого контенту)
- `/ddos resume <runId>` — продовжити з місця де зупинився
- `/ddos status <runId>` — показати статус всіх stages
- `/ddos approve <runId>` — approve для upload на YouTube

---

## Pipeline — порядок виконання

### Stage 1 (авто — до editorial)
```
1.  INGEST              Twitch API → raw-clips.json
2.  FILTER              відсіяти RU / gambling / занадто короткі / занадто довгі
3.  SELECT              JC/IRL: popularity+diversity-floor; Gaming: popularity (round 1)
4.  DOWNLOAD            yt-dlp → downloads/<filename>.mp4 (150 кліпів: 100 JC/IRL + 50 Gaming)
5.  GAMING_SCREEN       1 кадр/gaming-кліп → вебка/VTuber/турнірний HUD; 20+ = done; якщо <20 → +2×потрібно
6.  GENERATE_EDITORIAL  gen-editorial.js → edit/edit.html  ← ЗУПИНКА
```

Після GENERATE_EDITORIAL: відкрити `edit/edit.html` у браузері, зробити editorial рішення, "Copy Prompt" → вставити в чат.

### Stage 2 (після editorial JSON)
```
7.  APPLY_EDITORIAL  apply-editorial.js → clean.mp4 (trim + cuts з editorial.json)
                     + VOD replace: якщо editorial.vodClipIds не порожній → vod-segment.js замінює clean.mp4
7b. EXTRACT_FRAMES   extract-frames.js → 3 JPEG кадри per кліп (serial, до оверлеїв)
8.  TRANSCRIBE       WhisperX large-v3 → transcript.json (тільки вибрані кліпи, з clean.mp4)
9.  OVERLAYS         Puppeteer → streamer overlay + reconnecting panel
10. RENDER LONG      FFmpeg concat → episode-NNN.mp4
11. CAPTIONS         WhisperX ASS субтитри для shorts
12. METADATA         Claude → title/description/tags/shortIntros (на основі транскриптів)
13. RENDER SHORTS    FFmpeg → 1080×1920 (desktop/mobile/split) — ОБОВ'ЯЗКОВО після METADATA, бере intro-хук з shortIntros
14. THUMBNAIL        Puppeteer → thumbnail.png
15. REVIEW           review.html + index.html
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

Топ-10 по популярності (з топ-50 Twitch), виключаючи Core і бан-лист. Нові хайпові ігри природно з'являться тут самі.

### Download бакети (150 кліпів)
```
JC/IRL  → 100 (80 по popularity, max 5/streamer
              + 20 diversity-floor: ≥1 кліп кожному стрімеру з 0 слотів у перших 80;
                решта слотів по popularity, без ліміту на стрімера у diversity-пулі
              + fallback: якщо diversity < 20 — добирає з основного пулу по popularity до 100)
Gaming  → 50 (по популярності, max 5/гра, max 5/стрімер; ~50% очікуваний відсів
             GAMING_SCREEN; 20+ пройшло = done; якщо <20 → +2×потрібно, max 2 раунди)
```
Specialty (Music, Pools) — виключено. Velocity прибрана з відбору — дані показали
3-4x гіршу конверсію в епізод для кліпів, обраних лише завдяки velocity.

### Ліміти
- maxClipCandidates: 500
- maxDownloads: 150 базово (100 JC/IRL + 50 Gaming); якщо <20 gaming пройшли → backfill раунд 2
- maxClipsPerStreamer: 5 (у download selection)
- minDuration: 6s / maxDuration: 90s
- targetEpisodeMin: 720с (12 хв)
- targetEpisodeMax: 900с (15 хв)
- maxShorts: 10

### Фільтри — ЗАВЖДИ відхиляти
- language != "en" — будь-яка мова крім англійської (RU, UK, JA, KO, ZH, TH та всі інші)
- title містить: русский, россия, russian, путін, рф (додатковий захист для хибно-класифікованих кліпів)
- category: Slots, Casino, Gambling, Poker, Sports Betting, Escape from Tarkov, Overwatch 2, Marvel Rivals, Dark and Darker, Path of Exile 2
- стрімер у blacklist: Lyasyaa, Qoqsik, vedal987 (VTuber), miladeva, WINNINGBIKINI, Panterochka_, lily_off_valley

### Відбір кліпів (SELECT)
Без velocity — popularity (view_count) + diversity floor у scripts/ingest.js:
```
JC/IRL: 80 по popularity (max 5/streamer)
        + 20 diversity-floor (≥1 per unrepresented streamer, решта по popularity без ліміту)
        + fallback до 100 з основного пулу якщо diversity < 20
Gaming: 50 по popularity, max 5/гра, max 5/стрімер —
        GAMING_SCREEN перевіряє всі за один раунд; 20+ пройшло = done

filtered > 500 → пул обрізається до топ-500 по view_count (maxClipCandidates).
```

---

## Структура файлів

```
projects/<YYYY_MM_Month>/<runId>/
```
де `<YYYY_MM_Month>` = рік + номер + назва місяця (напр. `2026_06_June`), `<runId>` = `Episode_N_YYYY_MM_DD`.

```
projects/<YYYY_MM_Month>/<runId>/
├── state.json                     # stage статуси: pending/running/done/done_with_errors/failed
├── clips/
│   ├── raw-clips.json
│   ├── filtered-clips.json
│   ├── prescore-candidates.json
│   ├── downloaded-clips.json
│   ├── gaming-screen-results.json # рішення по кожному gaming-кліпу (вебка/VTuber/HUD)
│   ├── gaming-contact-sheet.png   # сітка кадрів для перегляду GAMING_SCREEN
│   ├── gaming-frames/<clipId>.jpg # 1 кадр на gaming-кліп
│   └── scored-clips.json
├── downloads/{category}_{streamer}_{views}_{YYYY_MM_DD}.mp4  # ім'я кліпу
├── processed/<clipId>/
│   ├── transcript.json
│   ├── clean.mp4                      # trimmed + re-encoded (CRF 18, 30fps) + loudnorm
│   ├── edit-hash.txt                  # хеш editorial-рішень для інвалідації кешу
│   ├── overlayed.mp4                  # clean.mp4 + animated MKV broadcaster overlay
│   └── captions-vertical.ass
├── edit/
│   ├── edit.html                      # Editorial UI (відкрити в браузері після SCORE)
│   ├── editorial.json                 # Рішення редактора (Claude пише при /ddos resume)
│   ├── episode-plan.json              # Генерується з editorial.json при resume
│   ├── shorts-selection.json
│   ├── captions-segments.json
│   ├── reconnecting.mp4               # ~2s glitch moment (тривалість залежить від кліпу)
│   └── concat-list.txt
├── exports/
│   ├── episode-NNN.mp4
│   ├── thumbnail.png
│   ├── metadata.json
│   └── shorts/<clipId>.mp4
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
assets/intro/intro_30fps.mp4        1920×1080, 1.25s, 30fps — завжди на початку (build-concat.js вимагає 30fps, бо решта епізоду теж 30fps)
assets/outro/outro_30fps.mp4        1920×1080, 1.25s, 30fps — завжди в кінці
assets/overlays/reconnecting.html   RECONNECTING transition overlay
assets/streamer-overlay/streamer_name.html  ім'я стрімера overlay
assets/thumbnail-template/thumbnail.html   шаблон thumbnail
assets/thumbnail-template/logo.svg         DDOS лого
```

---

## Перевірки звуку і перебивки

Захист від двох збоїв, які раніше проходили мовчки (ffmpeg віддавав код 0):

- **APPLY_EDITORIAL** — `[SILENT]` якщо доріжка кліпу є, але вона німа (перевірка
  по вже виміряному для loudnorm `input_i`, без зайвого проходу)
- **VOD replace** — `vod-segment.js` міряє гучність саме того діапазону, що піде
  у відео, і порівнює з тим самим відрізком оригінального кліпу. DMCA-мют лишає
  аудіо-стрім на місці, тому перевірки наявності доріжки не досить. При муті —
  звук береться з оригінального кліпу; якщо й це неможливо, VOD-заміна
  скасовується і лишається оригінальний `clean.mp4`
- **Реконект** — `apply-overlays.js` перевіряє межі кліпу перед нарізкою і
  верифікує результат (тривалість, обидва стріми, не чорний кадр). Якщо
  `reconnectSource.from` потрапляє у вирізане — помилка, а не мовчазний зсув
  у кінець файлу. Битий `reconnecting.mp4` видаляється, епізод іде без перебивки
- **BUILD_CONCAT** — по кожному сегменту: немає аудіо-доріжки → стоп (concat
  `-c copy` зламав би звук усього епізоду); німий або з провалом ≥3с → попередження
- **RENDER LONG** — фінальний `episode-NNN.mp4` перевіряється на наявність і
  чутність звуку; проблема → `renderLong: done_with_errors` + запис у `state.warnings`

Спільні probe-хелпери — `scripts/lib/media-probe.js`.
Тести таймлайну — `npm test`.

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
