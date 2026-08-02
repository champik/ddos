# Daily Dose Of Stream (DDOS) — Automated Video Pipeline

## Що це

Щоденна автоматична система для YouTube каналу "Daily Dose Of Stream" (DDOS).
Твич кліпи → відібрані, обрізані, зацензурені й оверлеєні кліпи, готові для монтажу.

**Selection-only pipeline:** автоматизація закінчується на готових кліпах
(`processed/overlayed/*.mp4`) — фінальний монтаж (склейка епізоду, reconnecting-перебивки,
Shorts, субтитри) робиться вручну в CapCut. Деталі й межа система/CapCut —
`docs/superpowers/specs/2026-08-02-capcut-handoff-design.md`.

**Output системи:** `processed/overlayed/<NN>_<streamer>_<idSuffix>.mp4` (кліпи для CapCut) +
`exports/thumbnail.png` + `exports/metadata.json` (title/tags/visibleTags/chapters/shortsMetadata).  
**Після CapCut:** користувач кладе фінальний експорт у `exports/episode.mp4` +
`exports/shorts/*.mp4`, публікація — вручну через `/ddos approve` (YouTube upload,
metadata.json вже готовий).

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

### Іменування оброблених кліпів (processed/)

- Формат: `{NN}_{streamer}_{idSuffix}` (без розширення — застосовується до всіх типів файлів)
- NN = 2-значна позиція кліпу в `editorial.clipOrder` (1-based, `padStart(2,'0')`) — дає
  порядок, зручний для перетягування в CapCut
- streamer = broadcaster_name lowercase, idSuffix = той самий суфікс що й у downloads/
- Приклад: `01_xqc_a7k2m9qx.mp4`
- Будується через `scripts/lib/clip-naming.js` (`buildBasenameMap`) — єдине джерело правди,
  використовується в усіх скриптах що читають/пишуть `processed/`
- NN — не про унікальність (її вже дає позиція), а про людське сортування; idSuffix — стабільний
  зв'язок з `clipId` для кешу. Зміна порядку в `edit.html` = перейменування файлів
  (без переобробки, кеш keyed по clipId всередині файлу)

---

## AUTONOMOUS MODE

**Від команди до готових кліпів без зупинок.**

Єдині дозволені паузи:
1. Показ scored clips список перед рендером (швидкий огляд)
2. Фінальний `/ddos approve <runId>` перед upload (вже після монтажу в CapCut)

Ніяких "продовжувати?", "дозволити bash?", "confirm?".  
Якщо щось пішло не так — записати в state.json і продовжити далі.

**Коли `stage2.js` завершується** (processed/overlayed/*.mp4 готові) — одразу вивести
список файлів у чат, щоб користувач міг почати монтаж негайно; METADATA → THUMBNAIL → REVIEW
запускати далі у фоні, не блокуючи чат очікуванням.

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

### Stage 2 (після editorial JSON) — selection-only, один серійний ланцюг

```
7.  APPLY_EDITORIAL  apply-editorial.js → processed/clean/<basename>.mp4 (trim + cuts з editorial.json)
                     + VOD replace: якщо editorial.vodClipIds не порожній → vod-segment.js замінює clean.mp4
8.  TRANSCRIBE       WhisperX large-v3 → processed/transcripts/<basename>.json (тільки вибрані кліпи, з clean.mp4)
8b. CENSOR           apply-censor.js → мьютить Tier 1/2 матюки/слюри в processed/clean/<basename>.mp4
                     (за word-level таймстемпами з transcript.json + ручні
                     позначки 🔇 Mute з edit.html), підставляє glitch.wav
9.  OVERLAYS         Puppeteer → streamer overlay → processed/overlayed/<basename>.mp4
                     ← ГОТОВО ДЛЯ CAPCUT (список видається в чат одразу після stage2.js)
12. METADATA         Claude → title/tags/visibleTags/chapters/shortsMetadata (на основі транскриптів,
                     БЕЗ опису — користувач пише сам у YouTube Studio)
14. THUMBNAIL        Higgsfield (nano_banana_pro + seedream_v4_5) → exports/thumbnail.png
15. REVIEW           review.html (мінімальний — без embed фінального відео/shorts,
                     секція Tags замість Metadata) + index.html
     ↓ (користувач монтує processed/overlayed/*.mp4 в CapCut, експортує в exports/)
16. PUBLISH          /ddos approve — вручну, читає exports/episode.mp4 + exports/shorts/*.mp4
```

**Вимкнено (файли лишились, виклики прибрані з `stage2.js`/`apply-overlays.js`):**
EXTRACT_FRAMES (нема споживача — thumbnail сам робить frame-grab), RECONNECTING-рендер
(готовий прозорий actив — `assets/overlays/reconnecting-panel.mov`, накладається вручну в
CapCut), CAPTIONS (`gen-captions.js`), RENDER LONG (`build-concat.js`, `render-final.js`,
`render-concat-filter.js`), RENDER SHORTS (`render-shorts.js`).

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
├── processed/                         # групування за типом, файли = <NN>_<streamer>_<idSuffix>
│   ├── clean/
│   │   ├── <basename>.mp4             # trimmed + re-encoded (CRF 18, 30fps) + loudnorm + censored
│   │   ├── <basename>.edit-hash.txt   # хеш editorial-рішень для інвалідації кешу
│   │   └── <basename>.precensor.mp4   # untouched backup до CENSOR (для повторних mute-прогонів)
│   ├── transcripts/<basename>.json
│   ├── censor/
│   │   ├── <basename>.censor-log.json # список замьючених слів/міток (слово, час, source: auto/manual)
│   │   └── <basename>.censor-hash.txt # хеш mute-вікон для інвалідації кешу цензури
│   └── overlayed/<basename>.mp4       # clean.mp4 + animated MKV broadcaster overlay ← для CapCut
├── edit/
│   ├── edit.html                      # Editorial UI (відкрити в браузері після SCORE)
│   ├── editorial.json                 # Рішення редактора (Claude пише при /ddos resume)
│   ├── episode-plan.json              # Генерується з editorial.json при resume
│   └── shorts-selection.json
├── exports/
│   ├── episode.mp4                    # користувач кладе сюди фінальний експорт з CapCut
│   ├── thumbnail.png
│   ├── metadata.json                  # title/tags/visibleTags/chapters/shortsMetadata (без description)
│   └── shorts/*.mp4                   # користувач кладе сюди Shorts-експорт з CapCut
└── review/review.html
```

EXTRACT_FRAMES вимкнено → `processed/frames/` і `frames-hash.txt` більше не генеруються.
RECONNECTING-рендер вимкнено → `edit/reconnecting.mp4` і `edit/concat-list.txt` більше не
генеруються (`build-concat.js`/`render-final.js` не викликаються).

**Глобальний кеш (поза папкою проекту):**
```
cache/overlays/<broadcaster>.mkv    # кешовані streamer overlays (FFV1 MKV, перевикористовуються між епізодами)
```

Прозорий reconnecting-actив (для ручного накладання в CapCut) — не кеш, статичний asset:
```
assets/overlays/reconnecting-panel.mkv   # джерело (FFV1 alpha)
assets/overlays/reconnecting-panel.mov   # ProRes 4444 alpha, готовий для CapCut
```

---

## Assets (вже існують)

```
assets/intro/intro_30fps.mp4        1920×1080, 1.25s, 30fps — для монтажу в CapCut (початок епізоду)
assets/outro/outro_30fps.mp4        1920×1080, 1.25s, 30fps — для монтажу в CapCut (кінець епізоду)
assets/overlays/reconnecting.html   джерело для reconnecting-panel.mkv/.mov (Puppeteer render)
assets/overlays/reconnecting-panel.mkv/.mov  готовий прозорий actив — накласти вручну в CapCut
assets/streamer-overlay/streamer_name.html  ім'я стрімера overlay (досі автоматично, у STREAMER OVERLAY)
assets/thumbnail-template/thumbnail.html   старий Puppeteer-шаблон thumbnail (fallback, не викликається — thumbnail йде через Higgsfield)
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
  Крім `clean.mp4`, `vod-segment.js` ТАКОЖ перезаписує сирий завантажений файл
  (`downloads/…`, той самий `dlClip.localPath`) на VOD-якість — той самий
  діапазон `[0, fullDur]`, тому всі `keeps`/`trim` таймстемпи лишаються дійсними.
  Позначається `downloaded-clips.json[].sourceReplacedWithVod = true`.
  **Чому:** без цього будь-яка подальша регенерація `clean.mp4` (інша обрізка,
  виправлення мьюту) через `apply-editorial.js` читає `dlClip.localPath` заново
  і мовчки повертає сирий (не-VOD) кліп — `vod-segment.js` довелось би
  пам'ятати запускати повторно вручну щоразу. Тепер джерело правди на диску
  завжди VOD-якості, і жодного окремого кроку не треба.
- **CENSOR** (stage 8b, деталі вище) — працює ДО OVERLAYS, тому
  `apply-overlays.js` в `stage2.js` чекає завершення CENSOR (інакше overlays
  прочитав би ще нецензурований `clean.mp4`).

**Вимкнено разом з рештою рендер-стадій** (файли лишились, не викликаються):
`renderReconnecting()` у `apply-overlays.js` (перевірка меж/верифікація reconnecting.mp4),
BUILD_CONCAT (`build-concat.js`) і RENDER LONG (`render-final.js`) перевірки звуку сегментів/
фінального файлу. Ці ffmpeg-кроки тепер робить користувач у CapCut — перевіряти звук там
доводиться на слух.

Спільні probe-хелпери — `scripts/lib/media-probe.js`.
Тести таймлайну — `npm test`.

---

## Skills

- `ddos-ingest`           — Twitch API + filter + yt-dlp download
- `ddos-score`            — GENERATE_EDITORIAL (Stage 1); TRANSCRIBE — в Stage 2 через transcribe-batch.js
- `ddos-render`           — FFmpeg trim + censor + streamer overlay (без reconnecting/long-form — CapCut)
- `ddos-shorts`           — вимкнено (RENDER SHORTS робить користувач у CapCut)
- `ddos-youtube-creatives`— METADATA: title/tags/visibleTags/chapters/shortsMetadata → exports/metadata.json (без опису)
- `ddos-thumbnail`        — Higgsfield thumbnail (читає metadata.json, сам його не генерує)
- `ddos-review`           — review.html генерація (мінімальний — без embed фінального відео/shorts)
- `ddos-publish`          — YouTube upload вручну, читає exports/episode.mp4 + exports/shorts/*.mp4 з CapCut

---

## Мова

Спілкування — українська. Промпти до Claude API, імена файлів — англійська.
