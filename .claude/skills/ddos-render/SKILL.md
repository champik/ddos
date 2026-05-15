# Skill: ddos-render

Обріж кліпи, накладе оверлеї, зберери long-form епізод.

---

## TRIM — Silence Detection + Re-encode

Для кожного кліпу з episode-plan.json clipOrder:

### 1. Знайти точки обрізання через silencedetect

```bash
SILENCE_OUT=$(ffmpeg -i "downloads/<clipId>.mp4" \
  -af "silencedetect=noise=-40dB:duration=0.3" \
  -f null - 2>&1)
```

Парсинг:
- `START` = перше `silence_end: X.XX` → кінець початкової тиші = початок контенту
- `END` = останнє `silence_start: Y.YY` → початок кінцевої тиші = кінець контенту

Якщо silencedetect не знайшов жодного silence event → `START=0`, `END=<full duration>` (повний кліп без обрізання).

### 2. Re-encode з виправленими timestamps (НІКОЛИ не використовувати -c copy після -ss)

```bash
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "downloads/<clipId>.mp4")
# START і END вже розраховані з silencedetect або 0/DURATION

ffmpeg -i "downloads/<clipId>.mp4" -ss $START -to $END \
  -vf "setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -af "asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11" \
  -c:v libx264 -preset fast -crf 23 \
  -c:a aac -b:a 192k -ar 48000 \
  -r 30 \
  -y "processed/<clipId>/clean.mp4"
```

Якщо `processed/<clipId>/clean.mp4` вже існує → пропустити.

Видалити `processed/<clipId>/normalized.mp4` якщо існує (більше не потрібен — loudnorm вбудовано).

Оновити `state.stages.trim = "done"`.

---

## OVERLAYS — Puppeteer → PNG → FFmpeg

### Streamer name overlay

Для кожного кліпу згенеруй PNG через Node.js + Puppeteer:

```javascript
// scripts/render-overlay.js
const puppeteer = require('puppeteer');
const fs = require('fs');

async function renderStreamerOverlay(streamerName, outPath) {
  let html = fs.readFileSync('assets/streamer-overlay/streamer_name.html', 'utf8');
  // Підстав ім'я стрімера
  html = html.replace('@NORTHERNLION_OFFICIAL', '@' + streamerName.toUpperCase());
  // Підстав logo якщо треба
  const logoB64 = fs.readFileSync('assets/thumbnail-template/logo.svg').toString('base64');
  html = html.replace('./logo.svg', 'data:image/svg+xml;base64,' + logoB64);

  const tmpHtml = outPath.replace('.png', '_tmp.html');
  fs.writeFileSync(tmpHtml, html);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('file://' + require('path').resolve(tmpHtml));
  await page.waitForTimeout(300);
  await page.screenshot({ path: outPath, type: 'png', omitBackground: true });
  await browser.close();
}
```

Запустити для кожного кліпу:
```bash
node scripts/render-overlay.js "<broadcaster_name>" "processed/<clipId>/streamer-overlay.png"
```

Потім burn overlay у відео (перші 3 секунди):
```bash
ffmpeg -i "processed/<clipId>/normalized.mp4" \
  -i "processed/<clipId>/streamer-overlay.png" \
  -filter_complex "[0:v][1:v]overlay=0:0:enable='between(t,0,3)'[out]" \
  -map "[out]" -map "0:a" \
  -c:v h264_nvenc -preset p4 -cq 23 \
  -c:a copy \
  -y "processed/<clipId>/overlayed.mp4"
```

Якщо NVENC не доступний — замінити на `-c:v libx264 -preset fast -crf 23`.

### RECONNECTING transition

Згенеруй PNG оверлею:
```javascript
// scripts/render-reconnecting.js
async function renderReconnecting(outPath) {
  let html = fs.readFileSync('assets/overlays/reconnecting.html', 'utf8');
  const logoB64 = fs.readFileSync('assets/thumbnail-template/logo.svg').toString('base64');
  html = html.replace('./logo.svg', 'data:image/svg+xml;base64,' + logoB64);

  // ... puppeteer screenshot з omitBackground: true
}
```

Застосуй до transitionClipId (перші 0.7s, B&W + затемнення):
```bash
ffmpeg \
  -i "processed/<transitionClipId>/normalized.mp4" \
  -i "edit/reconnecting-overlay.png" \
  -filter_complex "
    [0:v]trim=duration=0.7,setpts=PTS-STARTPTS,hue=s=0,eq=brightness=-0.25[bw];
    [bw][1:v]overlay=0:0[out]
  " \
  -map "[out]" -map "0:a" \
  -t 0.7 \
  -c:v h264_nvenc -preset p4 -cq 24 \
  -c:a aac -b:a 128k \
  -y "edit/reconnecting.mp4"
```

---

## RENDER LONG-FORM

### Крок 1: Валідація episode-plan.json

```bash
CLIP_COUNT=$(node -e "const p=require('./edit/episode-plan.json'); console.log(p.clipOrder.length)")
```

Якщо `CLIP_COUNT < 12` або `CLIP_COUNT > 18`:
→ Записати `state.stages.renderLong = "failed"` з поясненням і ЗУПИНИТИСЬ.

### Крок 2: Побудова concat-list.txt

Порядок (абсолютні шляхи):
```
file '/abs/path/assets/intro/intro.mp4'
[кліпи GROUP 1: overlayed.mp4, або clean.mp4 якщо overlay не існує]
file '/abs/path/edit/reconnecting.mp4'
[кліпи GROUP 2]
file '/abs/path/edit/reconnecting.mp4'
...
[кліпи GROUP N]
[file '/abs/path/edit/chill-finale.mp4' — тільки якщо файл існує]
file '/abs/path/assets/outro/outro.mp4'
```

Групи беремо з `episode-plan.json` поля `groups[].clipIds`, в порядку груп.
Reconnecting.mp4 вставляємо після кожної групи КРІМ останньої (до chill/outro).

Всі файли в concat-list МАЮТЬ бути у форматі: H.264, 30fps, 1920×1080, AAC 48kHz — це гарантується TRIM стадією. Якщо файл відсутній → skip з попередженням.

### Крок 3: Concat (без re-encode — всі файли однакового формату)

```bash
ffmpeg -f concat -safe 0 \
  -i "edit/concat-list.txt" \
  -c copy \
  -y "edit/raw-episode.mp4"
```

### Крок 4: Burn captions (якщо episode.ass існує)

```bash
# Якщо edit/episode.ass існує:
ffmpeg -i "edit/raw-episode.mp4" \
  -vf "ass=edit/episode.ass" \
  -c:v libx264 -preset medium -crf 22 \
  -c:a copy \
  -movflags +faststart \
  -y "exports/episode-<N>.mp4"

# Якщо episode.ass НЕ існує:
ffmpeg -i "edit/raw-episode.mp4" \
  -c copy \
  -movflags +faststart \
  -y "exports/episode-<N>.mp4"
```

Оновити `state.outputs.longformPath` і `state.stages.renderLong = "done"`.
