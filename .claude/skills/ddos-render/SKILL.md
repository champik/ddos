# Skill: ddos-render

Обріж кліпи, накладе оверлеї, зберери long-form епізод.

---

## TRIM — FFmpeg обрізка dead air

Для кожного кліпу з episode-plan.json:

```bash
# Отримай тривалість
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "downloads/<clipId>.mp4")

# Розрахуй trim points:
# - якщо duration > 20s: пропустити перші 5% (max 2s)
# - обрізати останні 3% (max 1.5s)
START=<calculated>
END=<calculated>

ffmpeg -i "downloads/<clipId>.mp4" \
  -ss $START -to $END \
  -c copy \
  -avoid_negative_ts make_zero \
  -y "processed/<clipId>/clean.mp4"
```

Потім нормалізуй аудіо:
```bash
ffmpeg -i "processed/<clipId>/clean.mp4" \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
  -c:v copy \
  -y "processed/<clipId>/normalized.mp4"
```

Якщо normalized.mp4 вже існує — пропустити.

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

### Побудуй список файлів для concat

Порядок:
1. `assets/intro/intro.mp4`
2. Кліпи з episode-plan.json clipOrder:
   - Використовуй `overlayed.mp4` якщо існує, інакше `normalized.mp4`
   - Після останнього кліпу кожного segment (крім останнього) — вставити `edit/reconnecting.mp4`
3. `assets/outro/outro.mp4`

Записати concat list:
```
file '/absolute/path/to/assets/intro/intro.mp4'
file '/absolute/path/to/processed/clipId1/overlayed.mp4'
file '/absolute/path/to/processed/clipId2/overlayed.mp4'
file '/absolute/path/to/edit/reconnecting.mp4'
file '/absolute/path/to/processed/clipId3/overlayed.mp4'
...
file '/absolute/path/to/assets/outro/outro.mp4'
```

### Concat + render
```bash
ffmpeg \
  -f concat -safe 0 \
  -i "edit/concat-list.txt" \
  -c:v h264_nvenc -preset p4 -cq 22 \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  -y "exports/episode-<N>.mp4"
```

Якщо NVENC не доступний — `libx264 -preset medium -crf 22`.

Оновити `state.outputs.longformPath` і `state.stages.renderLong = "done"`.
