# Skill: ddos-analytics

Тягни статистику попередніх відео з YouTube Analytics і записуй у Notion.

Запускається на ПОЧАТКУ кожного нового `/ddos run` (перед ingest).

---

## Перевірки

Якщо `auth/token.json` не існує → пропустити (YouTube ще не авторизований).
Якщо немає попередніх епізодів з `youtubeVideoId` → пропустити.

---

## Знайти попередні епізоди

```javascript
// Знайти всі state.json в projects/ де status != "pending" і youtubeVideoId існує
const projects = fs.readdirSync('projects').sort().reverse(); // newest first
const toUpdate = [];
for (const runId of projects.slice(0, 10)) { // перевірити останні 10
  const statePath = `projects/${runId}/state.json`;
  if (!fs.existsSync(statePath)) continue;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.outputs?.youtubeVideoId) {
    toUpdate.push({ runId, state });
  }
}
```

---

## Pull YouTube Analytics

Для кожного попереднього епізоду:

Виконати через тимчасовий Node.js скрипт, що реюзає `getAuth()` з `youtube-upload.js`:

```bash
node -e "
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');

// Реюзаємо збережений token (без інтерактивного OAuth)
const creds = JSON.parse(fs.readFileSync('auth/client_secret.json','utf8'));
const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
const oauth2 = new OAuth2Client(client_id, client_secret, redirect_uris[0]);
const saved = JSON.parse(fs.readFileSync('auth/token.json','utf8'));
oauth2.setCredentials(saved);

// ...решта коду нижче
"
```

```javascript
const { google } = require('googleapis');
const auth = oauth2; // з блоку вище

const analytics = google.youtubeAnalytics({ version: 'v2', auth });
const today = new Date().toISOString().split('T')[0];
const publishedDate = state.publishedAt ? state.publishedAt.split('T')[0] : '2026-01-01';

const { data } = await analytics.reports.query({
  ids: 'channel==MINE',
  startDate: publishedDate,
  endDate: today,
  metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments',
  dimensions: 'video',
  filters: `video==${state.outputs.youtubeVideoId}`
});

const row = data.rows?.[0];
if (!row) return; // відео ще не має статистики

const stats = {
  episodeNumber: state.episodeNumber,
  runId,
  youtubeVideoId: state.outputs.youtubeVideoId,
  pulledAt: today,
  daysSincePublish: Math.floor((Date.now() - new Date(state.publishedAt)) / 86400000),
  views: row[1],
  minutesWatched: row[2],
  avgViewDuration: row[3],
  avgViewPercentage: row[4],
  likes: row[5],
  comments: row[6]
};

// Зберегти локально
fs.writeFileSync(`projects/${runId}/exports/analytics.json`, JSON.stringify(stats, null, 2));
```

---

## Оновити Notion

Використати Notion MCP для оновлення або створення рядка:

1. Знайти або створити базу даних "DDOS Analytics" в Notion (пошук через `notion-search`)
2. Перевірити чи є рядок з `Run ID == runId` через `notion-fetch` або `notion-search`
3. Якщо є → `notion-update-page` з новими views/likes/etc.
4. Якщо немає → `notion-create-pages` з усіма полями:

```json
{
  "Episode": episodeNumber,
  "Title": metadata.titleOptions[0],
  "Published": publishedAt,
  "YouTube ID": youtubeVideoId,
  "Views": stats.views,
  "Avg Watch %": stats.avgViewPercentage,
  "Likes": stats.likes,
  "Comments": stats.comments,
  "Days Since Publish": stats.daysSincePublish,
  "Run ID": runId
}
```

Оновити `state.stages.analytics = "done"`.
