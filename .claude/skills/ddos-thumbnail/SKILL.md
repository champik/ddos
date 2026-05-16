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
  "description": "Your daily dose of the best Twitch moments.",
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

### Після збереження metadata.json — розрахувати timecodes і зібрати фінальний опис

Claude генерує тільки вступний рядок description. Timecodes і теги додаються окремо:

**Правила timecodes (глав):**
- Кожна нова плашка стрімера = нова глава (перший кліп кожної групи + перший кліп від нового стрімера в групі)
- Consecutивні кліпи від ТОГО САМОГО стрімера — НЕ новий таймкод
- Перша глава ЗАВЖДИ `00:00` — вона поглинає інтро (00:00 = перший стрімер, не "Intro")
- Нікнейм стрімера з `scored-clips.json` (broadcaster_name), БЕЗ символу `@`
- RECONNECT_DUR = 1.0s між групами, INTRO_DUR = 1.25s (але 00:00 поглинає intro)

```javascript
// INTRO_DUR = 1.25s, RECONNECT_DUR = 1.0s
// fmt(secs): "MM:SS" або "H:MM:SS" для відео >1 год
// YouTube вимоги: перший timestamp = 00:00, мінімум 3 глави, зростаючий порядок

// Рахуємо: t починається з 0 (intro поглинається першою главою)
// Для кожної групи: якщо стрімер змінився — додати chapter
// Між групами +RECONNECT_DUR

const chaptersStr = chapters.map(c => fmt(c.t) + ' ' + c.broadcasterName).join('\n');
```

**Теги — завжди включати нікнейми стрімерів:**
```javascript
// Базові теги + всі стрімери з episode-plan.json groups[].clipIds
const streamerTags = [...new Set(
  plan.groups.flatMap(g => g.clipIds.map(id => scored.find(c => c.id === id)?.broadcaster_name))
)].filter(Boolean);

meta.tags = [
  'DailyDoseOfStream','TwitchClips','Streaming','JustChatting','IRL',
  'Twitch','TwitchHighlights','StreamerMoments',
  ...streamerTags
];
```

**Видимі хештеги в description** — тільки базові + топ-5 стрімерів за ddosScore:
```javascript
const topStreamers = streamerTags.slice(0, 5).map(s => '#' + s.replace(/\s/g, '')).join(' ');
const baseHashtags = '#DailyDoseOfStream #TwitchClips #Streaming #JustChatting #IRL #Twitch #TwitchHighlights #StreamerMoments';
```

**Фінальний формат description:**
```
Your daily dose of the best Twitch moments.

00:00 HAchubby
00:21 theavamariee
01:13 Gorgc
...

#DailyDoseOfStream #TwitchClips #Streaming #JustChatting #IRL #Twitch #TwitchHighlights #StreamerMoments #xQc #HAchubby #Gorgc
```

```javascript
meta.description = 'Your daily dose of the best Twitch moments.\n\n' + chaptersStr + '\n\n' + baseHashtags + ' ' + topStreamers;
```

Оновити `state.stages.thumbnail = "done"`, `state.stages.metadata = "done"`.
