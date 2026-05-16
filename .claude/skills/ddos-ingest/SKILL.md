# Skill: ddos-ingest

Отримай кліпи з Twitch, відфільтруй, розрахуй pre-score, завантаж найкращі.

---

## INGEST — Twitch API

```bash
node scripts/progress.js "projects/<runId>" 1 "Отримую кліпи з Twitch"
```

### Отримати токен

```bash
curl -s -X POST "https://id.twitch.tv/oauth2/token" \
  -d "client_id=$TWITCH_CLIENT_ID" \
  -d "client_secret=$TWITCH_CLIENT_SECRET" \
  -d "grant_type=client_credentials"
```

Зберегти `access_token`.

### Категорії

**Core (завжди включати):**
```
509658 = Just Chatting
509672 = IRL
32399  = Counter-Strike 2
516575 = Valorant
```

**Dynamic (запитати щоразу):**
```bash
curl -s "https://api.twitch.tv/helix/games/top?first=20" \
  -H "Client-ID: $TWITCH_CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN"
```

З топ-20 взяти перші 12, виключивши:
- id вже є в core
- name (lowercase) містить: slots, casino, gambling, betting, poker

Результат: ~14–16 категорій.

### Запит кліпів

Для кожної категорії:
```
GET https://api.twitch.tv/helix/clips
  ?game_id=<gameId>
  &started_at=<ISO: now - $HOURS годин>
  &first=20
  &after=<cursor>
```

**Hybrid sampling:**
- Top range: 1 сторінка (20 кліпів)
- Mid range: пропустити 1 сторінку cursor, взяти 2 сторінки (40 кліпів)
- Hidden gems (для 4 random категорій): пропустити 3 сторінки, взяти 1 сторінку (20 кліпів)

Мета: **300–500 metadata кандидатів** загалом.

Зберегти у `clips/raw-clips.json`. Оновити `state.counts.raw`.

---

## FILTER — Metadata фільтрація (до download)

```bash
node scripts/progress.js "projects/<runId>" 2 "Фільтрація та pre-score"
```

**Офіційні org-акаунти (відхиляти):**
```
esl_csgo, eslcs, blasttv, pgl, riotgames, valorant, esl_dota2,
weplay_esports, faceit, dreamhack, esltv, iem
```

**Відхиляти кліп якщо будь-яка умова:**

| Умова | Причина |
|-------|---------|
| `language == "ru"` | excluded_language |
| title (lowercase) містить: русский/россия/russian/путін/рф | ru_keyword |
| `broadcaster_name` (lowercase) в org-списку | tournament_official |
| title (lowercase) містить: " major"/" grand final"/"championship"/" tournament"/"qualifier" | tournament_event |
| game_name (lowercase) містить: slots/casino/gambling/betting/poker | gambling |
| `duration < 6` або `duration > 90` | duration |

Зберегти у `filtered-clips.json` і `rejected-clips.json`.
Оновити `state.counts.filtered`.

---

## PRE-SCORE — Відбір кліпів для download

Для кожного filtered кліпу розрахувати `preScore` (0–100):

```javascript
function calcPreScore(clip, seenBroadcasters) {
  // viewsScore: log10 scale, 500k views = 100
  const viewsScore = Math.min(100, Math.log10(clip.view_count + 1) / Math.log10(500000) * 100);

  // categoryScore: core = 85–90, dynamic = 60
  const coreIds = ['509658','509672','32399','516575'];
  const categoryScore = coreIds.includes(clip.game_id) ? 88 : 60;

  // durationScore: 15–60s = 100, 6–15s = 60, 60–90s = 70
  const d = clip.duration;
  const durationScore = d >= 15 && d <= 60 ? 100 : d < 15 ? 60 : 70;

  // diversityScore: штраф за повторення стрімера
  const seen = seenBroadcasters.get(clip.broadcaster_name) || 0;
  const diversityScore = seen === 0 ? 100 : seen === 1 ? 75 : seen === 2 ? 45 : 0;

  // noveltyScore: штраф за старі кліпи
  const ageH = (Date.now() - new Date(clip.created_at)) / 3600000;
  const noveltyScore = ageH <= 24 ? 100 : ageH <= 48 ? 65 : 35;

  // languageScore
  const languageScore = clip.language === 'en' ? 100 : clip.language === 'uk' ? 90 : 50;

  // riskPenalty
  const title = (clip.title || '').toLowerCase();
  const riskPenalty = (title.includes('music') || title.includes('song')) ? 15 : 0;

  return (
    viewsScore    * 0.30 +
    categoryScore * 0.20 +
    durationScore * 0.15 +
    diversityScore* 0.20 +
    noveltyScore  * 0.10 +
    languageScore * 0.05 -
    riskPenalty
  );
}

// Порахувати preScore для всіх, трекати кількість по broadcaster
const broadcasterCount = new Map();
const scored = filteredClips.map(clip => {
  const score = calcPreScore(clip, broadcasterCount);
  broadcasterCount.set(clip.broadcaster_name, (broadcasterCount.get(clip.broadcaster_name) || 0) + 1);
  return { ...clip, preScore: score };
}).sort((a, b) => b.preScore - a.preScore);
```

**Hybrid sampling для download (80 кліпів):**
```
N = 80
top35  = scored.slice(0, Math.floor(N * 0.35))              // топ 28
mid35  = scored.slice(Math.floor(scored.length * 0.30),
                      Math.floor(scored.length * 0.70))
         .sort(() => Math.random()-0.5).slice(0, Math.floor(N * 0.35))  // mid 28
gems15 = scored.slice(Math.floor(scored.length * 0.70),
                      Math.floor(scored.length * 0.90))
         .sort(() => Math.random()-0.5).slice(0, Math.floor(N * 0.15))  // gems 12
small10 = scored.filter(c => c.view_count < 10000)
          .sort(() => Math.random()-0.5).slice(0, Math.floor(N * 0.10)) // small 8
trending5 = scored.filter(c => !coreIds.includes(c.game_id))
            .slice(0, Math.floor(N * 0.05))                              // trending 4

toDownload = dedup([...top35, ...mid35, ...gems15, ...small10, ...trending5]).slice(0, 80)
```

Зберегти у `clips/prescore-candidates.json`. Оновити `state.stages.prescore = "done"`.

---

## DOWNLOAD

```bash
node scripts/progress.js "projects/<runId>" 3 "Завантаження кліпів (yt-dlp)"
```

### Назва файлу

```javascript
function buildDownloadFilename(clip) {
  const cat = (clip.game_name || 'unknown').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const streamer = clip.broadcaster_name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const views = clip.view_count;
  const date = clip.created_at.slice(0, 10).replace(/-/g, '_');
  return `${cat}_${streamer}_${views}_${date}.mp4`;
}
```

```bash
FILENAME=$(buildDownloadFilename clip)
yt-dlp \
  --no-playlist \
  --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" \
  --merge-output-format mp4 \
  --output "projects/<runId>/downloads/$FILENAME" \
  --quiet \
  "<clip_url>"
```

Після успішного завантаження додати `localPath` до clip об'єкта:
```javascript
clip.localPath = `projects/${runId}/downloads/${filename}`;
```

- Якщо файл вже існує → пропустити
- Якщо помилка → записати в rejected, продовжити
- Паралельно: max 5 одночасно
- Limit: 80 кліпів

Зберегти `downloaded-clips.json` (кожен кліп має `localPath`).
Оновити `state.counts.downloaded`, `state.stages.download = "done"`.

> Downstream steps (trim, transcribe) мають брати шлях до файлу з `clip.localPath`, не конструювати його з clipId.
