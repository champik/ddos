# Skill: ddos-render

Обріж кліпи, зацензуруй, накладе streamer overlay → `processed/overlayed/*.mp4`, готові для
монтажу в CapCut. **Selection-only pipeline** — RENDER LONG (склейка епізоду) і
RECONNECTING-рендер більше НЕ виконуються тут (файли/секції нижче лишені як довідка, код не
викликається) — див. `docs/superpowers/specs/2026-08-02-capcut-handoff-design.md`.

Всі шляхи `processed/...` тепер групуються за типом, файл = `<basename>` з
`scripts/lib/clip-naming.js` (`buildBasenameMap`), формат `<NN>_<streamer>_<idSuffix>` —
НЕ `<clipId>` напряму.

---

## APPLY_EDITORIAL — Обробка кліпів за editorial.json

```bash
node scripts/progress.js "<projectDir>" 6 "Обробка кліпів (editorial cuts)"
```

```bash
node scripts/apply-editorial.js "<runId>"
```

Скрипт читає `edit/editorial.json` → для кожного кліпу з `clipOrder` генерує `processed/clean/<basename>.mp4` з:
- `-ss trim.in -to trim.out` (якщо задано)
- FFmpeg filter_complex з множинними сегментами (якщо є `keeps[]`)
- Завжди: scale 1920×1080, loudnorm, libx264 CRF 18, 30fps, aac 192k, -ac 2
- Кліп без аудіодоріжки → автоматично додається тиша (anullsrc)
Кешування: `clean.mp4` пропускається тільки якщо хеш editorial-рішень (`edit-hash.txt`)
не змінився. Змінив trim/keeps у editorial.json → кліп перерендериться автоматично.

Оновити `state.stages.trim` (`done` / `done_with_errors` / `failed` — скрипт ставить сам).

---

## CENSOR — Мьют матюків/слюрів + glitch.wav

Виконується автоматично в `stage2.js` між TRANSCRIBE і OVERLAYS (серіально — OVERLAYS
читає `clean.mp4`, тож має чекати, поки CENSOR допише в нього цензуроване аудіо).

```bash
node scripts/apply-censor.js "<projectDir>"
```

Скрипт:
- Для кожного кліпу читає `processed/transcripts/<basename>.json` (word-level таймстемпи)
  і `edit/editorial.json → clips[id].manualMutes` (ручні позначки 🔇 Mute з edit.html)
- Список слів для мьюту — `scripts/lib/profanity.js` (Tier 1 матюки + Tier 2 слюри,
  без м'яких слів типу damn/hell/crap)
- Кожне знайдене слово: мьютить оригінальне аудіо в межах `[word.start-40ms, word.end+40ms]`
  (clamp щоб не зайти в сусіднє слово) і підмішує `assets/sounds/glitch.wav`, обрізаний
  точно під це вікно — не вилазить у сусіднє слово
- Ручні позначки: вікно `[at, at + тривалість glitch.wav]`
- Перезаписує `processed/clean/<basename>.mp4` на місці (відео — `-c:v copy`, без
  перекодування; лише аудіо-фільтр) — тому `apply-overlays.js` нічого не треба міняти,
  він і так читає вже зацензурований `clean.mp4`
- Кешування: `processed/censor/<basename>.censor-hash.txt` — пропускає кліп, якщо набір
  mute-вікон не змінився з минулого запуску
- Пише `processed/censor/<basename>.censor-log.json` (слово/маска/час/джерело auto|manual)
  для аудиту — показується в review.html Tags column

Оновити `state.stages.censor` (`done` / `done_with_errors` / `failed` — скрипт ставить сам).

---

## OVERLAYS — Puppeteer frame-by-frame → FFV1 MKV

> VP9/VP8 WebM alpha is broken on Windows FFmpeg — FFV1 in MKV correctly preserves alpha.
> Drawtext/drawbox cannot replicate the designed animation — use Puppeteer capture.

```bash
node scripts/apply-overlays.js "<projectDir>"
```

Скрипт:
- Читає `edit/episode-plan.json` і `clips/scored-clips.json`
- Для кожного кліпу: `processed/clean/<basename>.mp4` → `processed/overlayed/<basename>.mp4`
  з animated streamer name banner (перші 3с) — це фінальний output для CapCut
- Банер рендериться через `scripts/render-overlay.js streamer <name> <out.mkv>` (Puppeteer → FFV1 MKV)
- Кешується в `cache/overlays/<slug>.mkv` (повторно використовується між епізодами)
- Consecutивні кліпи від одного стрімера: банер не показується (лише `-c copy`)
- RECONNECTING **вимкнено** — `renderReconnecting()` лишається у файлі, але не викликається з
  `main()`. Готовий прозорий actив для ручного накладання в CapCut —
  `assets/overlays/reconnecting-panel.mov` (ProRes 4444, alpha)
- FFmpeg overlay (ВАЖЛИВО — НЕ використовувати `eof_action=pass`, не працює на Windows FFmpeg):
  ```
  [0:v][1:v]overlay=0:0:enable='between(t,0,3)':format=auto[out]
  ```
  `enable='between(t,0,3)'` — банер показується перші 3 секунди, потім зникає автоматично.

Якщо треба переробити overlay — видалити `cache/overlays/<slug>.mkv` вручну, потім запустити знову.

Оновити `state.stages.overlays = "done"`. `processed/overlayed/*.mp4` тепер готові —
видати список у чат, далі METADATA/THUMBNAIL/REVIEW у фоні (див. AUTONOMOUS MODE в CLAUDE.md).

**render-overlay.js modes:**
```bash
node scripts/render-overlay.js streamer "<broadcaster_name>" "<out.mkv>"
node scripts/render-overlay.js reconnecting "<out.mkv>"   # не викликається з apply-overlays.js більше
```

Streamer overlay HTML: `assets/streamer-overlay/streamer_name.html`

---

## EFFECTS — DISABLED

Zoom punch та color punch effects вимкнені — реалізація виявилась занадто жорстокою і псує відео.
Встановити `state.stages.effects = "skip"` і продовжити без змін у overlayed.mp4.

---

## CAPTIONS, RECONNECTING, RENDER LONG-FORM — ВИМКНЕНО (CapCut)

Ці кроки більше НЕ виконуються системою — фінальний монтаж (склейка епізоду,
reconnecting-перебивка, субтитри) робить користувач вручну в CapCut з
`processed/overlayed/*.mp4`. `gen-captions.js`, `build-concat.js`, `render-final.js`,
`render-concat-filter.js` лишились на диску (не викликаються) — довідка нижче застаріла,
не виконувати.

<details>
<summary>Стара довідка (не виконувати, лишена для контексту)</summary>

`renderReconnecting()` в apply-overlays.js будує 3-ступеневий filter_complex (B&W кліп +
colored RECONNECTING панель поверх + глітч noise/hue-rotate).

`build-concat.js` читав `editorial.json` (`clipSequence`/`reconnectAfterSet` з `lib/timeline.js`),
писав `edit/concat-list.txt`; `render-final.js` робив `ffmpeg -f concat -c copy` →
`exports/episode-NNN.mp4`; `render-concat-filter.js` — fallback з re-encode при несумісних
сегментах. Інтро/аутро — `assets/intro/intro_30fps.mp4` / `assets/outro/outro_30fps.mp4`.

</details>
