# Skill: ddos-render

Обріж кліпи, накладе оверлеї, зберери long-form епізод.

---

## APPLY_EDITORIAL — Обробка кліпів за editorial.json

```bash
node scripts/progress.js "<projectDir>" 6 "Обробка кліпів (editorial cuts)"
```

```bash
node scripts/apply-editorial.js "<runId>"
```

Скрипт читає `edit/editorial.json` → для кожного кліпу з `clipOrder` генерує `processed/<clipId>/clean.mp4` з:
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
- Для кожного кліпу читає `processed/<clipId>/transcript.json` (word-level таймстемпи)
  і `edit/editorial.json → clips[id].manualMutes` (ручні позначки 🔇 Mute з edit.html)
- Список слів для мьюту — `scripts/lib/profanity.js` (Tier 1 матюки + Tier 2 слюри,
  без м'яких слів типу damn/hell/crap)
- Кожне знайдене слово: мьютить оригінальне аудіо в межах `[word.start-40ms, word.end+40ms]`
  (clamp щоб не зайти в сусіднє слово) і підмішує `assets/sounds/glitch.wav`, обрізаний
  точно під це вікно — не вилазить у сусіднє слово
- Ручні позначки: вікно `[at, at + тривалість glitch.wav]`
- Перезаписує `clean.mp4` на місці (відео — `-c:v copy`, без перекодування;
  лише аудіо-фільтр) — тому `apply-overlays.js`, `build-concat.js`, `render-shorts.js`
  нічого не треба міняти, вони й так читають `clean.mp4`/`overlayed.mp4`
- Кешування: `processed/<clipId>/censor-hash.txt` — пропускає кліп, якщо набір
  mute-вікон не змінився з минулого запуску
- Пише `processed/<clipId>/censor-log.json` (слово/маска/час/джерело auto|manual)
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
- Для кожного кліпу: `clean.mp4` → `overlayed.mp4` з animated streamer name banner (перші 3с)
- Банер рендериться через `scripts/render-overlay.js streamer <name> <out.mkv>` (Puppeteer → FFV1 MKV)
- Кешується в `cache/overlays/<slug>.mkv` (повторно використовується між епізодами)
- Consecutивні кліпи від одного стрімера: банер не показується (лише `-c copy`)
- Рендерить `edit/reconnecting.mp4` через render-overlay.js reconnecting → `cache/overlays/reconnecting-panel.mkv`
- FFmpeg overlay (ВАЖЛИВО — НЕ використовувати `eof_action=pass`, не працює на Windows FFmpeg):
  ```
  [0:v][1:v]overlay=0:0:enable='between(t,0,3)':format=auto[out]
  ```
  `enable='between(t,0,3)'` — банер показується перші 3 секунди, потім зникає автоматично.

Якщо треба переробити overlay — видалити `cache/overlays/<slug>.mkv` вручну, потім запустити знову.

**Reconnecting clip — B&W + colored panel + glitch:**

`renderReconnecting()` в apply-overlays.js будує 3-ступеневий filter_complex:
```javascript
const bwFilter    = 'setpts=PTS-STARTPTS,eq=saturation=0:contrast=1.25:brightness=-0.05';
const glitchFilter = "noise=alls=25:allf=t+u,hue=H='if(mod(floor(t*13),2), 1.57, 0)'";

// filter_complex:
'[0:v]' + bwFilter + '[bw]',           // сам кліп → чорно-білий
'[bw][1:v]overlay=0:0:format=auto[composite]',  // colored RECONNECTING панель поверх
'[composite]' + glitchFilter + '[out]'  // глітч (noise + hue-rotate) на все разом
```
Результат: відео B&W, панель з написом кольорова, поверх всього — глітч ефект.

Оновити `state.stages.overlays = "done"`, `state.stages.reconnecting = "done"`.

**render-overlay.js modes:**
```bash
node scripts/render-overlay.js streamer "<broadcaster_name>" "<out.mkv>"
node scripts/render-overlay.js reconnecting "<out.mkv>"
```

Streamer overlay HTML: `assets/streamer-overlay/streamer_name.html`
Reconnecting overlay HTML: `assets/overlays/reconnecting.html`

---

## EFFECTS — DISABLED

Zoom punch та color punch effects вимкнені — реалізація виявилась занадто жорстокою і псує відео.
Встановити `state.stages.effects = "skip"` і продовжити без змін у overlayed.mp4.

---

## CAPTIONS

Субтитри генеруються в ddos-shorts skill (після RENDER LONG). Не пропускати — вони обов'язкові для шортсів.

---

## RENDER LONG-FORM

Longform відео рендериться БЕЗ субтитрів. Обидва скрипти запускаються автоматично
в `stage2.js` (chain: `fetch-avatars.js` → `apply-overlays.js` → `build-concat.js` →
`render-final.js`), окремо руками треба лише при resume/дебазі.

### Крок 1: Побудова concat-list.txt

```bash
node scripts/build-concat.js "<runId>"
```

Скрипт (не пише список руками — читає `edit/editorial.json`):
- Порядок кліпів — `clipSequence(editorial)` з `lib/timeline.js` (`clipOrder` без службових `__recon` маркерів)
- Позиції reconnect — `reconnectAfterSet(editorial)` з `lib/timeline.js`: об'єднує `reconnectPositions` і `__recon`-маркери в один Set, тому та сама позиція, записана обома способами, вставляє `reconnecting.mp4` рівно один раз
- Для кожного кліпу: `overlayed.mp4`, якщо є, інакше `clean.mp4`
- Інтро/аутро: **`intro_30fps.mp4`/`outro_30fps.mp4`** (re-encoded 30fps версії з `assets/intro/`, `assets/outro/`) — НЕ оригінальні 60fps-файли, ті обрізаються у склеєному відео
- **Аудіо-перевірки на кожному сегменті** (`lib/media-probe.js`): немає аудіо-доріжки → **стоп, exit 1** (concat `-c copy` в render-final.js мовчки зламав би звук усього епізоду); повністю німий або провал тиші ≥3с → попередження, рендер продовжується
- Перебивка (`reconnecting.mp4`) перевіряється окремо: відсутня/закоротка/без відео- чи аудіо-доріжки → пропускається з попередженням, епізод іде без неї

Пише `edit/concat-list.txt`.

### Крок 2: Фінальний рендер (concat → exports, без проміжного raw-episode.mp4)

```bash
node scripts/render-final.js "<projectDir>" <episodeNumber>
```

Скрипт:
- Перевіряє що всі сегменти з `edit/concat-list.txt` існують
- `ffmpeg -f concat -c copy -movflags +faststart` → одразу `exports/episode-NNN.mp4`
- Пост-перевірка готового епізоду (тривалість, наявність і чутність звуку) — проблема → `state.stages.renderLong = "done_with_errors"` + запис у `state.warnings`, а не мовчазний "успіх"
- Оновлює `state.outputs.longformPath` і `state.stages.renderLong` сам

Якщо concat падає через несумісні сегменти — fallback з re-encode:
```bash
node scripts/render-concat-filter.js "<projectDir>" "<projectDir>/exports/episode-NNN.mp4"
```
