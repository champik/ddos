# Skill: ddos-thumbnail

Згенеруй thumbnail і metadata для епізоду.

---

## THUMBNAIL

```bash
node scripts/progress.js "projects/<runId>" 13 "Thumbnail (Puppeteer рендер)"
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

  // Base64 encode frame
  const frameB64 = fs.readFileSync(framePath).toString('base64');
  const frameDataUrl = 'data:image/png;base64,' + frameB64;

  // Base64 encode logo
  const logoB64 = fs.readFileSync('assets/thumbnail-template/logo.svg').toString('base64');
  const logoDataUrl = 'data:image/svg+xml;base64,' + logoB64;

  // Inject config — замінити THUMB_CONFIG
  html = html.replace(
    /var THUMB_CONFIG = \{[^}]+\}/,
    `var THUMB_CONFIG = { ep: ${episodeNumber}, headline: '${headline}', img: '${frameDataUrl}', variant: 'A' }`
  );
  // Замінити ./logo.svg
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

  // Cleanup
  fs.unlinkSync(tmpHtml);
  console.log('Thumbnail:', outPath);
}

const [,, framePath, ep, headline, outPath] = process.argv;
render(framePath, parseInt(ep), headline, outPath);
```

Запустити:
```bash
node scripts/render-thumbnail.js \
  "exports/best-frame.png" \
  <episodeNumber> \
  "<thumbnailText>" \
  "exports/thumbnail.png"
```

Якщо Puppeteer недоступний — зберегти best-frame.png як thumbnail (без overlay).

---

## METADATA — Claude генерація

```bash
node scripts/progress.js "projects/<runId>" 14 "YouTube метадані (Claude)"
```

Передай список кліпів Claude:

```
Згенеруй YouTube metadata для Daily Dose Of Stream Episode #<N>.

Кліпи в епізоді:
<список: стрімер | категорія | назва кліпу>

Канал — щоденний дайджест стрімерської культури: смішно, комфортно, курований контент.

Відповідай ТІЛЬКИ валідним JSON без markdown:
{
  "titleOptions": [
    "Hook Text Here | Daily Dose Of Stream",
    "Second Option | Daily Dose Of Stream",
    "Third Option | Daily Dose Of Stream"
  ],
  "description": "Короткий вступ (2-3 речення).\n\nСтрімери: streamer1, streamer2...\n\n#DailyDoseOfStream #TwitchClips #Streaming",
  "tags": ["DailyDoseOfStream","TwitchClips","Streaming","JustChatting"],
  "thumbnailText": "2-4 СЛОВА ВЕЛИКИМИ",
  "shortsMetadata": [
    {
      "clipId": "id",
      "title": "Hook | Daily Dose Of Stream",
      "caption": "текст підпису для TikTok/Shorts",
      "hashtags": ["#DailyDoseOfStream","#TwitchClips","#Shorts"]
    }
  ]
}

Правила для title:
- НЕ "Daily Dose Of Stream #284"
- Curiosity-based, emotional implication
- Приклад: "Nobody Expected Him To Win This | Daily Dose Of Stream"
```

Зберегти у `exports/metadata.json`.

### Після збереження metadata.json — вставити YouTube timecodes в description

Claude генерує description БЕЗ timecodes (тільки вступ + теги). Timecodes рахуються окремо з реальних тривалостей кліпів:

```javascript
// Порядок: 00:00 Intro → кожен кліп з groups[].clipIds → Chill Outro (якщо є)
// INTRO_DUR = 1.25s, RECONNECT_DUR = 1.0s
// fmt(secs): "MM:SS" або "H:MM:SS" для відео >1 год
// YouTube вимоги: перший timestamp = 00:00, мінімум 3 глави, зростаючий порядок

const chaptersStr = chapters.map(c => fmt(c.t) + ' ' + c.label).join('\n');
const tags = meta.tags.map(t => '#' + t).join(' ');

// Фінальний формат description:
// "Your daily dose of the best Twitch moments.\n\n{chapters}\n\n{hashtags}"
meta.description = 'Your daily dose of the best Twitch moments.\n\n' + chaptersStr + '\n\n' + tags;
```

Оновити `state.stages.thumbnail = "done"`, `state.stages.metadata = "done"`.
