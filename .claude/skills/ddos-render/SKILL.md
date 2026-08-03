# Skill: ddos-render

Приведи обрані кліпи до єдиного стандарту (повна довжина, CRF18/30fps/loudnorm) →
`processed/clean/*.mp4`, і зроби картинки імені стрімера → `processed/streamers_name/*.png`.
Обидва — готові для монтажу в CapCut. **Selection-only pipeline** — обрізка кліпів, цензура,
транскрипція, burned-in overlay, RENDER LONG (склейка епізоду) і RECONNECTING-рендер більше
НЕ виконуються тут (файли/секції нижче лишені як довідка, код не викликається) —
див. `docs/superpowers/specs/2026-08-02-capcut-handoff-design.md`.

Всі шляхи `processed/...` тепер групуються за типом, файл = `<basename>` з
`scripts/lib/clip-naming.js` (`buildBasenameMap`), формат `<NN>_<streamer>_<idSuffix>` —
НЕ `<clipId>` напряму.

---

## APPLY_EDITORIAL — Стандартизація кліпів, повна довжина

```bash
node scripts/progress.js "<projectDir>" 6 "Обробка кліпів (full length)"
```

```bash
node scripts/apply-editorial.js "<runId>"
```

Скрипт читає `edit/editorial.json` → для кожного кліпу з `clipOrder` генерує
`processed/clean/<basename>.mp4` на **повну оригінальну довжину** — `trim`/`keeps` з
editorial.json (якщо присутні) ігноруються, обрізку робить користувач сам у CapCut.
Завжди: scale 1920×1080, loudnorm (attenuate-only, `lib/audio-loudness.js`), libx264 CRF 18,
30fps, aac 192k, `-ac 2`. Кліп без аудіодоріжки → автоматично додається тиша (anullsrc).

Кешування: `clean.mp4` пропускається тільки якщо хеш audio-рішення (`edit-hash.txt`,
залежить лише від `skipLoudnorm`) не змінився.

Якщо в `editorial.vodClipIds` є кліпи — після цього кроку `vod-segment.js` підміняє їхній
`clean.mp4` на VOD-якість (той самий діапазон `[0, fullDur]`, без обрізки — сумісно з
full-length policy вище).

Оновити `state.stages.trim` (`done` / `done_with_errors` / `failed` — скрипт ставить сам).

---

## STREAMER_NAMES — Статична картинка імені стрімера

> VP9/VP8 WebM alpha is broken on Windows FFmpeg — FFV1/PNG-alpha шлях лишається; але тут
> результат уже не відео, а один PNG-кадр на стрімера (не на кліп).

```bash
node scripts/fetch-avatars.js "<projectDir>"
node scripts/render-streamer-names.js "<projectDir>"
```

Скрипт:
- Читає `edit/episode-plan.json` (`clipOrder`) і `clips/downloaded-clips.json`
- Для кожного **унікального** стрімера серед обраних кліпів (не для кожного кліпу окремо)
  рендерить один PNG → `processed/streamers_name/<slug(streamer)>.png`
- Картинка — це `#so` блок з `assets/streamer-overlay/streamer_name.html` (caution-tape
  смужка + аватар + нік), settled-кадр анімації (без руху), розмір під сам блок — НЕ
  1920×1080 повний кадр
- Аватар — `clips/streamer-avatars.json` (готує `fetch-avatars.js`), якщо є
- `render-overlay.js streamer-static "<name>" "<out.png>" [avatarUrl]` — Puppeteer рендерить
  HTML у 1920×1080 viewport (щоб CSS `bottom/left %` рахувався правильно), потім скріншотить
  тільки елемент `#so`, `omitBackground: true` → прозорий PNG

Користувач сам накладає картинку на потрібний кліп у CapCut (позиція/тривалість — вручну).

Оновити `state.stages.overlays = "done"` (та сама назва stage, що й раніше — просто інший
результат: PNG замість burned-in відео).

**render-overlay.js modes:**
```bash
node scripts/render-overlay.js streamer "<name>" "<out.mkv>"           # старий animated video overlay — НЕ викликається з render-streamer-names.js
node scripts/render-overlay.js streamer-static "<name>" "<out.png>" [avatarUrl]   # новий, статична картинка
node scripts/render-overlay.js reconnecting "<out.mkv>"                # не викликається
```

Streamer overlay HTML: `assets/streamer-overlay/streamer_name.html`

---

## TRANSCRIBE, CENSOR, EFFECTS, старий video-burn OVERLAYS — ВИМКНЕНО

Більше не виконуються — немає транскриптів (нема кому давати censor word-таймстемпи),
а ім'я стрімера тепер накладається вручну в CapCut як картинка (`STREAMER_NAMES` вище)
замість burned-in відео-оверлею. `transcribe-batch.js`, `apply-censor.js`,
`apply-overlays.js` лишились на диску (не викликаються зі `stage2.js`) — довідка нижче
застаріла, не виконувати.

<details>
<summary>Стара довідка (не виконувати, лишена для контексту)</summary>

**CENSOR** читала `processed/transcripts/<basename>.json` (word-level таймстемпи з WhisperX)
і `editorial.json → clips[id].manualMutes`, мьютила Tier 1/2 матюки/слюри
(`scripts/lib/profanity.js`) вікном `[word.start-40ms, word.end+40ms]`, підмішувала
`assets/sounds/glitch.wav`, писала `processed/censor/<basename>.censor-log.json` для
review.html Tags column.

**OVERLAYS (стара версія)** — `apply-overlays.js` рендерила animated banner (Puppeteer →
FFV1 MKV, кешовано в `cache/overlays/<slug>.mkv`) і накладала його на перші 3с кожного
`clean.mp4` через `ffmpeg overlay=0:0:enable='between(t,0,3)'` → `processed/overlayed/
<basename>.mp4`. Consecutивні кліпи від одного стрімера — банер не показувався.

</details>

---

## CAPTIONS, RECONNECTING, RENDER LONG-FORM — ВИМКНЕНО (CapCut)

Ці кроки більше НЕ виконуються системою — фінальний монтаж (склейка епізоду, обрізка
кліпів, reconnecting-перебивка, субтитри) робить користувач вручну в CapCut з
`processed/clean/*.mp4` + `processed/streamers_name/*.png`. `gen-captions.js`,
`build-concat.js`, `render-final.js`, `render-concat-filter.js` лишились на диску
(не викликаються) — довідка нижче застаріла, не виконувати.

<details>
<summary>Стара довідка (не виконувати, лишена для контексту)</summary>

`renderReconnecting()` в apply-overlays.js будує 3-ступеневий filter_complex (B&W кліп +
colored RECONNECTING панель поверх + глітч noise/hue-rotate).

`build-concat.js` читав `editorial.json` (`clipSequence`/`reconnectAfterSet` з `lib/timeline.js`),
писав `edit/concat-list.txt`; `render-final.js` робив `ffmpeg -f concat -c copy` →
`exports/episode-NNN.mp4`; `render-concat-filter.js` — fallback з re-encode при несумісних
сегментах. Інтро/аутро — `assets/intro/intro_30fps.mp4` / `assets/outro/outro_30fps.mp4`.

</details>
