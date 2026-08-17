# Daily Dose Of Stream (DDOS) — Automated Video Pipeline

## Що це

Щоденна автоматична система для YouTube каналу "Daily Dose Of Stream" (DDOS).
Твич кліпи → відібрані кліпи повної довжини + картинки імені стрімера, готові для монтажу.

**Selection-only pipeline:** автоматизація закінчується на готових кліпах ПОВНОЇ довжини
(`processed/clean/*.mp4`) + картинках імені стрімера (`processed/streamers_name/*.png`) —
фінальний монтаж (обрізка кліпів, склейка епізоду, reconnecting-перебивки, накладання імені
стрімера, Shorts, субтитри) робиться вручну в CapCut. Деталі й межа система/CapCut —
`docs/superpowers/specs/2026-08-02-capcut-handoff-design.md`.

**Output системи:** `processed/clean/<NN>_<streamer>_<idSuffix>.mp4` (кліпи повної довжини для
CapCut) + `processed/streamers_name/<NN>_<streamer>_<idSuffix>.png` (картинка імені стрімера на
кожен кліп, той самий basename що й відповідний `.mp4` — несе перегляди/дату кліпу, і для
ranking-епізодів `#N` — не дедуплікується по стрімеру, бо ці дані відрізняються кліп від кліпу)
+ `exports/thumbnail.png` (якщо позначені `editorial.thumbnails`).
**METADATA/REVIEW тимчасово вимкнені** (залежали від транскриптів/metadata.json, яких більше
нема — див. "Вимкнено" нижче) — `exports/metadata.json` не генерується.
**Після CapCut:** користувач кладе фінальний експорт у `exports/episode.mp4` +
`exports/shorts/*.mp4`, публікація — вручну через `/ddos approve` (YouTube upload).

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

**Коли `stage2.js` завершується** (`processed/clean/*.mp4` повної довжини +
`processed/streamers_name/*.png` готові) — одразу вивести список файлів у чат, щоб
користувач міг почати монтаж негайно; THUMBNAIL (якщо є `editorial.thumbnails`) запускати
далі у фоні, не блокуючи чат очікуванням. METADATA/REVIEW вимкнені (див. Stage 2 нижче).

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
6b. VOD_REPLACE      якщо editorial.vodClipIds не порожній → vod-segment.js замінює СИРИЙ
                     файл (downloads/<file>.mp4) на той самий діапазон з VOD, ДО кодування —
                     чисте джерело, а не другий encode того самого кліпу
7.  APPLY_EDITORIAL  apply-editorial.js → processed/clean/<basename>.mp4 — ПОВНА довжина
                     клipу, без trim/cuts (editorial.json's trim/keeps ігноруються — CapCut
                     ріже сам). Єдиний encode на кліп, читає downloads/ яким він є на
                     момент запуску (оригінал Twitch або вже VOD-замінений)
9.  STREAMER_NAMES   fetch-avatars.js → render-streamer-names.js → одна статична PNG-картинка
                     на КОЖЕН кліп (basename = той самий що у processed/clean/, через
                     lib/clip-naming.js) → processed/streamers_name/<NN>_<streamer>_<idSuffix>.png
                     — несе views+дату кліпу, і #N (ранг у категорії, fewest→most views) якщо
                     state.viewOrderAscending/categoryOrder виставлені (ranking-епізод типу
                     TopClips) ← ГОТОВО ДЛЯ CAPCUT (список видається в чат одразу після stage2.js)
14. THUMBNAIL        якщо editorial.thumbnails не порожній — Higgsfield прибирає стрімерський
                     chat/HUD/сабки/рекламу з позначеного кадру + upscale (БЕЗ творчої
                     трансформації емоції), потім Claude накладає наш дизайн (caution-tape
                     смужки + заголовок) → exports/thumbnail.png. Хук — editorial.thumbnails[].hook,
                     вписаний користувачем в edit.html (без transcript/metadata.json)
     ↓ (користувач монтує/ріже processed/clean/*.mp4 в CapCut, накладає streamers_name/*.png
       вручну, експортує в exports/)
16. PUBLISH          /ddos approve — вручну, читає exports/episode.mp4 + exports/shorts/*.mp4
```

**Вимкнено (файли лишились, виклики прибрані з `stage2.js`/`apply-overlays.js`):**
TRANSCRIBE (`transcribe-batch.js` — нема споживача: CENSOR і METADATA обидві читали
транскрипти), CENSOR (`apply-censor.js` — без транскриптів нема word-level таймстемпів для
мьюту), video-burn OVERLAYS (стара версія `apply-overlays.js` — animated banner burned у
відео; замінена на STREAMER_NAMES вище), METADATA/REVIEW (`ddos-youtube-creatives`/
`ddos-review` — METADATA будувала title/tags з транскриптів, яких нема; REVIEW залежить від
`exports/metadata.json`, який METADATA більше не пише — THUMBNAIL більше НЕ залежить від
жодного з них, працює окремо), EXTRACT_FRAMES (нема споживача), RECONNECTING-рендер (готовий
прозорий actив — `assets/overlays/reconnecting-panel.mov`, накладається вручну в CapCut),
CAPTIONS (`gen-captions.js`), RENDER LONG (`build-concat.js`, `render-final.js`,
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
│   │   ├── <basename>.mp4             # ПОВНА довжина (без trim/cuts), re-encoded (CRF 18, 30fps)
│   │   │                              # + loudnorm ← для CapCut
│   │   └── <basename>.edit-hash.txt   # хеш audio-рішення (skipLoudnorm) для інвалідації кешу
│   └── streamers_name/<basename>.png  # картинка імені стрімера, одна на кліп (basename як у
│                                       # clean/) — views+дата, #N ранг для ranking-епізодів —
│                                       # для ручного накладання в CapCut
├── edit/
│   ├── edit.html                      # Editorial UI (відкрити в браузері після SCORE)
│   ├── editorial.json                 # Рішення редактора (Claude пише при /ddos resume)
│   ├── episode-plan.json              # Генерується з editorial.json при resume
│   └── shorts-selection.json
├── exports/
│   ├── episode.mp4                    # користувач кладе сюди фінальний експорт з CapCut
│   ├── thumbnail.png                  # якщо є editorial.thumbnails (ddos-thumbnail, Higgsfield)
│   ├── thumb-candidate-{i}-{model}.png     # альтернативні кандидати (nano/seedream)
│   ├── thumb-candidate-{i}-{model}-raw.png # без нашого caution-tape overlay, для reference
│   └── shorts/*.mp4                   # користувач кладе сюди Shorts-експорт з CapCut
└── review/review.html                 # ВИМКНЕНО — залежить від exports/metadata.json
```

EXTRACT_FRAMES вимкнено → `processed/frames/` і `frames-hash.txt` більше не генеруються.
RECONNECTING-рендер вимкнено → `edit/reconnecting.mp4` і `edit/concat-list.txt` більше не
генеруються (`build-concat.js`/`render-final.js` не викликаються).
TRANSCRIBE/CENSOR вимкнено → `processed/transcripts/`, `processed/censor/`,
`<basename>.precensor.mp4` більше не генеруються. METADATA вимкнено →
`exports/metadata.json` більше не генерується (THUMBNAIL більше не залежить від нього).

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

- **VOD_REPLACE** (працює ДО APPLY_EDITORIAL) — `vod-segment.js` міряє гучність саме того
  діапазону, що піде у відео, і порівнює з тим самим відрізком оригінального кліпу. DMCA-мют
  лишає аудіо-стрім на місці, тому перевірки наявності доріжки не досить. При муті — звук
  береться з оригінального кліпу; якщо й це неможливо, заміна скасовується і сирий файл
  лишається як є.
  `vod-segment.js` перезаписує ЛИШЕ сирий завантажений файл (`downloads/…`, той самий
  `dlClip.localPath`) на VOD-якість — той самий діапазон `[0, fullDur]`. Він більше НЕ пише
  `processed/clean/` напряму (це робив старий дизайн — прибрано, бо дублювало encode і
  застосовувало застарілі `keeps`/`trim`, яких `apply-editorial.js` вже не читає, і тому
  могло тихо обрізати VOD-кліп назад до старого keep-діапазону).
  Позначається `downloaded-clips.json[].sourceReplacedWithVod = true`.
  **Чому порядок такий:** `apply-editorial.js` читає `dlClip.localPath` — якщо VOD-заміна вже
  сталась ДО нього, він кодує VOD-версію з нуля як звичайний кліп, без окремого кроку. Кодування
  відбувається рівно один раз на кліп, а не двічі (раз в apply-editorial, ще раз у vod-segment).
  `apply-editorial.js` інвалідовує свій кеш (`edit-hash.txt`) по mtime сирого файлу — заміна
  джерела (VOD чи будь-яка інша) завжди форсує перекодування, кеш не застаріє.

**Вимкнено разом з рештою рендер-стадій** (файли лишились, не викликаються):
CENSOR-перевірка мьют-вікон (`apply-censor.js` — немає транскриптів, тож немає що мьютити),
`renderReconnecting()` у `apply-overlays.js` (перевірка меж/верифікація reconnecting.mp4),
BUILD_CONCAT (`build-concat.js`) і RENDER LONG (`render-final.js`) перевірки звуку сегментів/
фінального файлу. Ці ffmpeg-кроки тепер робить користувач у CapCut — перевіряти звук там
доводиться на слух.

Спільні probe-хелпери — `scripts/lib/media-probe.js`.
Тести таймлайну — `npm test`.

---

## Skills

- `ddos-ingest`           — Twitch API + filter + yt-dlp download
- `ddos-score`            — GENERATE_EDITORIAL (Stage 1); TRANSCRIBE вимкнено
- `ddos-render`           — full-length re-encode (без trim/cuts) + статичні картинки імені
                            стрімера (без censor/reconnecting/long-form — CapCut)
- `ddos-shorts`           — вимкнено (RENDER SHORTS робить користувач у CapCut)
- `ddos-youtube-creatives`— вимкнено (METADATA залежала від транскриптів, яких нема)
- `ddos-thumbnail`        — Higgsfield прибирає стрімерський HUD + upscale, наш дизайн
                            (caution-tape + hook з editorial.thumbnails) — не залежить від metadata.json
- `ddos-review`           — вимкнено (залежить від exports/metadata.json)
- `ddos-publish`          — YouTube upload вручну, читає exports/episode.mp4 + exports/shorts/*.mp4 з CapCut

---

## Мова

Спілкування — українська. Промпти до Claude API, імена файлів — англійська.
