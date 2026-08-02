# CapCut Handoff — Selection-Only Pipeline

## Контекст

Зараз система робить повний pipeline до готового `episode-NNN.mp4` + shorts. Користувач хоче
натомість монтувати фінальний епізод і Shorts вручну в CapCut (динамічний монтаж, темп,
переходи — те, що незручно автоматизувати). Система лишається відповідальною за все, що
дає реальний виграш від автоматизації: відбір кліпів, обрізку по editorial-рішенням,
цензуру, оверлей імені стрімера, метадані, thumbnail.

Ключова вимога користувача: **нічого не видаляти**. Стадії, які більше не потрібні в
автоматичному запуску, вимикаються на рівні виклику (orchestrator/call site), а самі
скрипти-джерела лишаються на диску без змін — можуть знадобитись знову.

## Межа: система vs CapCut

### Лишається автоматизованим
```
INGEST → FILTER → SELECT → DOWNLOAD → GAMING_SCREEN → GENERATE_EDITORIAL (edit.html)
     ↓ (користувач редагує editorial.json: keeps/cuts, видаляє кліпи, VOD-заміни)
APPLY_EDITORIAL (TRIM)   → processed/clean/<basename>.mp4
VOD REPLACE              → без змін (vod-segment.js)
TRANSCRIBE               → processed/transcripts/<basename>.json
CENSOR                   → мьютить processed/clean/<basename>.mp4
STREAMER OVERLAY         → processed/overlayed/<basename>.mp4   ← користувач тягне це в CapCut
METADATA (без опису)     → exports/metadata.json: title, tags (hidden), visibleTags
                            (hashtags що раніше йшли в опис), chapters
                            (shortIntros прибирається — нікому вже не потрібен,
                            RENDER SHORTS більше не читає його в системі)
THUMBNAIL                → gen-thumbnails-higgsfield.js генерує кандидати
                            (thumb-candidate-{i}-{model}.png, nano_banana_pro +
                            seedream_v4_5) для editorial.thumbnails; користувач обирає
                            в review.html; обраний → exports/thumbnail.png при /approve
                            (youtube-upload.js). render-thumbnail.js (старий Puppeteer
                            template-рендер) лишається як fallback-код, не викликається
REVIEW (мінімальний)     → review.html: список кліпів у порядку + tags-секція +
                            вибір thumbnail/title (без embed фінального відео/shorts)
PUBLISH (вручну)         → /ddos approve читає projects/<runId>/exports/episode.mp4 +
                            exports/shorts/*.mp4 (користувач кладе туди експорт з CapCut)
```

### Вимикається (виклик прибирається, файли лишаються)
- **EXTRACT_FRAMES** — вже нікому не потрібен: `gen-thumbnails-higgsfield.js` сам робить
  ffmpeg frame-grab для клипів з `editorial.thumbnails`, `processed/<id>/frames/` більше
  ніким не читається.
- **RECONNECTING render** — виклик `renderReconnecting()` всередині `apply-overlays.js`
  прибирається з `main()`; функція й `render-overlay.js reconnecting` лишаються в коді.
  Готовий прозорий actив вже є: `assets/overlays/reconnecting-panel.mov` (ProRes 4444,
  alpha) — користувач сам накладає його в CapCut.
- **CAPTIONS** (`gen-captions.js`) — виклик прибирається з `stage2.js`.
- **RENDER LONG** (`build-concat.js`, `render-concat-filter.js`, `render-final.js`) —
  виклики прибираються з `stage2.js`.
- **RENDER SHORTS** (`render-shorts.js`) — не викликається орkestrator'ом/Claude.

## Нейминг та структура `processed/`

Групування за типом замість за clipId:

```
processed/
├── clean/<NN>_<streamer>_<idSuffix>.mp4 (+ .edit-hash.txt)
├── overlayed/<NN>_<streamer>_<idSuffix>.mp4      ← фінальна папка для CapCut
├── transcripts/<NN>_<streamer>_<idSuffix>.json
├── censor/<NN>_<streamer>_<idSuffix>.censor-log.json (+ .censor-hash.txt)
```
де `NN` — 2-значна позиція в `editorial.clipOrder`, `streamer` — lowercase ім'я стрімера,
`idSuffix` — останні 8 символів Twitch clip ID (як зараз у `downloads/`).

`idSuffix` тут не для унікальності (її вже дає `NN`) — це стабільний зв'язок з `clipId`
для кешування. При зміні порядку в `edit.html` файли перейменовуються (дешева операція),
кеш (`*-hash.txt`, keyed по clipId всередині файлу) не інвалідується.

Спільний helper `scripts/lib/clip-naming.js` будує мапу `clipId → basename` з
`editorial.clipOrder` + `downloaded-clips.json`, використовується в: `apply-editorial.js`,
`transcribe-batch.js`, `apply-censor.js`, `apply-overlays.js`.

`downloads/` (сирі завантажені кліпи) — без змін.

## METADATA

`build-metadata.js`:
- прибирається блок, що дописує чаптери+hashtags у `meta.description` — Claude більше не
  генерує description взагалі (правиться інструкція в `ddos-youtube-creatives` skill)
- `meta.tags` (прихований YouTube tags field) — без змін, автогенерація лишається
- **нове поле** `meta.visibleTags` = `buildDescriptionHashtags(...)` — те, що раніше
  вбудовувалось у текст опису, тепер окреме поле для показу на review
- `meta.chapters` — chapters лишаються (`buildChapters(...)`), окремим полем, не вбудовані
  в опис. Точність нижче критичної, бо кліпи в CapCut вже потрапляють обрізаними —
  ревізія пізніше, якщо CapCut почне їх ламати

## REVIEW (мінімальний)

`gen-review.js` втрачає:
- секцію `Long-form` (video embed `episode-NNN.mp4` — файлу більше нема)
- секцію `Shorts` grid (video embed — файлів більше нема)

Лишається / додається:
- таблиця кліпів у порядку `clipOrder` (без змін, окрім прибирання reconnect-row —
  нема більше системних reconnect-маркерів для рендеру)
- Thumbnail-вибір (без змін — залежить лише від `exports/thumb-candidate-*.png`)
- Title-вибір (без змін — залежить лише від `meta.clipHooks`)
- **нова секція Tags**: дві групи — "Video tags (hidden)" = `meta.tags`, "Description
  hashtags (visible)" = `meta.visibleTags`
- approve-box лишається як є (генерує `/approve` команду)

## Orchestration: stage2.js

Спрощується до єдиного серійного ланцюга (більше не потрібен `Promise.allSettled` на
3 паралельні chain'и — лишається один):

```
APPLY_EDITORIAL → VOD_REPLACE → TRANSCRIBE → CENSOR → fetch-avatars → APPLY_OVERLAYS
```

Коли `stage2.js` завершується — `processed/overlayed/*.mp4` вже готові до монтажу.

## Поведінка Claude під час запуску

Як тільки `processed/overlayed/*.mp4` готові (кінець `stage2.js`) — одразу вивести список
файлів у чат (щоб користувач міг почати монтаж негайно), а METADATA → THUMBNAIL → REVIEW
запускати далі у фоні, не блокуючи чат очікуванням.

## Publish handoff

Користувач монтує `processed/overlayed/*.mp4` у CapCut → експортує в
`projects/<runId>/exports/episode.mp4` + `exports/shorts/*.mp4` → `/ddos approve <runId>`
підхоплює ці файли і вручну (без авто-тригера після approve) заливає на YouTube з готовим
`metadata.json`.
