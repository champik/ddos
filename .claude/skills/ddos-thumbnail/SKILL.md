# Skill: ddos-thumbnail

Рендер thumbnail PNG через Puppeteer.

**Залежність:** `exports/metadata.json` повинен існувати — генерується `ddos-youtube-creatives` (Stage 13).

---

```bash
node scripts/progress.js "projects/<runId>" 14 "Thumbnail (Puppeteer рендер)"
```

### Крок 1 — Витягни найкращий кадр

З openerClipId (з episode-plan.json) витягни кадр на позиції 60% тривалості:

```bash
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "processed/<openerClipId>/clean.mp4")
TIMESTAMP=$(echo "$DURATION * 0.6" | bc)

ffmpeg \
  -ss $TIMESTAMP \
  -i "processed/<openerClipId>/clean.mp4" \
  -frames:v 1 -q:v 2 \
  -y "exports/best-frame.png"
```

### Крок 2 — Рендер через Puppeteer

```javascript
// scripts/render-thumbnail.js <framePath> <episodeNumber> <headlineText> <outPath>
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function render(framePath, episodeNumber, headline, outPath) {
  let html = fs.readFileSync('assets/thumbnail-template/thumbnail.html', 'utf8');

  const frameB64 = fs.readFileSync(framePath).toString('base64');
  const frameDataUrl = 'data:image/png;base64,' + frameB64;

  const logoB64 = fs.readFileSync('assets/thumbnail-template/logo.svg').toString('base64');
  const logoDataUrl = 'data:image/svg+xml;base64,' + logoB64;

  html = html.replace(
    /var THUMB_CONFIG = \{[^}]+\}/,
    `var THUMB_CONFIG = { ep: ${episodeNumber}, headline: '${headline}', img: '${frameDataUrl}', variant: 'A' }`
  );
  html = html.replace('./logo.svg', logoDataUrl);

  const tmpHtml = outPath.replace('.png', '_tmp.html');
  fs.writeFileSync(tmpHtml, html);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-web-security'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('file://' + path.resolve(tmpHtml), { waitUntil: 'networkidle0', timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: outPath, type: 'png' });
  await browser.close();

  fs.unlinkSync(tmpHtml);
  console.log('Thumbnail:', outPath);
}

const [,, framePath, ep, headline, outPath] = process.argv;
render(framePath, parseInt(ep), headline, outPath);
```

Читай `thumbnailHook` з `exports/metadata.json` і передай як headlineText:

```bash
THUMBNAIL_HOOK=$(node -p "require('./exports/metadata.json').thumbnailHook")

node scripts/render-thumbnail.js \
  "exports/best-frame.png" \
  <episodeNumber> \
  "$THUMBNAIL_HOOK" \
  "exports/thumbnail.png"
```

Якщо Puppeteer недоступний — зберегти best-frame.png як thumbnail (без overlay).

Оновити `state.stages.thumbnail = "done"`.
