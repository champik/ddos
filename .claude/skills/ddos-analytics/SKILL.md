# Skill: ddos-analytics

Тягни статистику попередніх відео з YouTube і зберігай локально.

Запускається на ПОЧАТКУ кожного нового `/ddos run` (перед ingest).

---

## Перевірки

Якщо `auth/token.json` не існує → пропустити.
Якщо немає попередніх епізодів з `youtubeVideoId` → пропустити.

---

## Pull YouTube Stats

Для кожного епізоду в `projects/Episode_*/state.json` де є `outputs.youtubeVideoId`:

```javascript
const yt = google.youtube({ version: 'v3', auth });

// Основне відео
const { data } = await yt.videos.list({ part: ['statistics'], id: [videoId] });
const s = data.items[0].statistics;
// views, likes, comments

// Шортси — те саме для кожного shortId з state.outputs.youtubeShortsIds
```

Зберегти у `projects/<runId>/exports/analytics.json`:
```json
{
  "pulledAt": "2026-05-17",
  "episode": { "videoId": "...", "views": 0, "likes": 0, "comments": 0 },
  "shorts": [{ "shortId": "...", "views": 0, "likes": 0 }]
}
```

**Примітка:** Для avgViewPercentage і minutesWatched потрібна YouTube Analytics API (окремо вмикається в Google Cloud Console).

Оновити `state.stages.analytics = "done"`.
