# Skill: ddos-render

Обріж кліпи, накладе оверлеї, зберери long-form епізод.

---

## APPLY_EDITORIAL — Обробка кліпів за editorial.json

```bash
node scripts/progress.js "projects/<runId>" 6 "Обробка кліпів (editorial cuts)"
```

```bash
node scripts/apply-editorial.js "projects/<runId>"
```

Скрипт читає `edit/editorial.json` → для кожного кліпу з `clipOrder` генерує `processed/<clipId>/clean.mp4` з:
- `-ss trim.in -to trim.out` (якщо задано)
- FFmpeg filter_complex з множинними сегментами (якщо є `cuts[]`)
- Завжди: scale 1920×1080, loudnorm, libx264, 30fps, aac 192k, -ac 2

Якщо `clean.mp4` вже існує — пропустити (кешування).

Оновити `state.stages.trim = "done"` (для сумісності з downstream).

---

## OVERLAYS — Puppeteer frame-by-frame → FFV1 MKV

> VP9/VP8 WebM alpha is broken on Windows FFmpeg — FFV1 in MKV correctly preserves alpha.
> Drawtext/drawbox cannot replicate the designed animation — use Puppeteer capture.

```bash
node scripts/apply-overlays.js "projects/<runId>"
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

Субтитри генеруються ТІЛЬКИ для шортсів — в рамках ddos-shorts skill, після вибору shortClipIds.
На цьому етапі (ddos-render) субтитри НЕ генеруються.

Встановити `state.stages.captions = "skip"` і продовжити.

---

## RENDER LONG-FORM

### Крок 1: Валідація episode-plan.json

```bash
TOTAL_DUR=$(node -e "
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const plan=JSON.parse(fs.readFileSync('edit/episode-plan.json','utf8'));
let t=0;
plan.clipOrder.forEach(id=>{
  const r=spawnSync('ffprobe',['-v','quiet','-show_entries','format=duration','-of','csv=p=0',
    path.join('processed',id,'clean.mp4')],{encoding:'utf8'});
  t+=parseFloat(r.stdout)||0;
});
console.log(Math.round(t));
")
```

Якщо `TOTAL_DUR < 600` (менше 10 хв) — попередження в консоль, але **не зупинятись**.
Якщо `TOTAL_DUR > 1200` (більше 20 хв) — попередження, але **не зупинятись**.

### Крок 2: Побудова concat-list.txt

Порядок (абсолютні шляхи, форвард-слеші):
```
file '/abs/path/assets/intro/intro_30fps.mp4'
[кліпи GROUP 1: overlayed.mp4, або clean.mp4 якщо overlay не існує]
file '/abs/path/edit/reconnecting.mp4'
[кліпи GROUP 2]
file '/abs/path/edit/reconnecting.mp4'
...
[кліпи GROUP N]
file '/abs/path/assets/outro/outro_30fps.mp4'
```

**ВАЖЛИВО:** Використовувати `intro_30fps.mp4` і `outro_30fps.mp4` (re-encoded 30fps версії), НЕ оригінальні. Оригінали (60fps, без SAR) викликають обрізання у склеєному відео.

Групи беремо з `episode-plan.json.groups[].clipIds`, в порядку груп.
Reconnecting.mp4 вставляємо після кожної групи КРІМ останньої (до outro).

Всі файли в concat-list МАЮТЬ бути у форматі: H.264, 30fps, 1920×1080, AAC 48kHz — гарантується TRIM стадією. Якщо файл відсутній → skip з попередженням.

### Крок 3: Concat (без re-encode — всі файли однакового формату)

```bash
ffmpeg -f concat -safe 0 \
  -i "edit/concat-list.txt" \
  -c copy \
  -y "edit/raw-episode.mp4"
```

### Крок 4: Фінальний рендер (ЗАВЖДИ без субтитрів)

Longform відео рендериться БЕЗ субтитрів — episode.ass вже видалений на кроці CAPTIONS.

```bash
node scripts/render-final.js "projects/<runId>" <episodeNumber>
```

Скрипт:
- Бере `edit/raw-episode.mp4`
- `edit/episode.ass` має бути ВІДСУТНІЙ (видалений після gen-captions.js)
- Виконує `-c copy` → `exports/episode-NNN.mp4`

Оновити `state.outputs.longformPath` і `state.stages.renderLong = "done"`.
