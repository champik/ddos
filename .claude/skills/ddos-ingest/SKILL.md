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
509658 = Just Chatting      [JC/IRL]
509672 = IRL                [JC/IRL]
26936  = Music              [Specialty]
116747788 = Pools, Hot Tubs, and Beaches  [Specialty]
32399  = Counter-Strike 2   [Gaming]
516575 = Valorant           [Gaming]
21779  = League of Legends  [Gaming]
29595  = Dota 2             [Gaming]
493057 = PUBG: BATTLEGROUNDS [Gaming]
```

**Dynamic (запитати щоразу):**

```bash
curl -s "https://api.twitch.tv/helix/games/top?first=20" \
  -H "Client-ID: $TWITCH_CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN"
```

З топ-20 взяти перші 5, виключивши:

- id вже є в core
- name (lowercase) містить: slots, casino, gambling, betting, poker, tarkov, overwatch, marvel rivals, sports betting

Результат: ~14 категорій загалом.

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

| Умова                                                                                       | Причина                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------ |
| `language == "ru"`                                                                          | excluded_language                    |
| title (lowercase) містить: русский/россия/russian/путін/рф                                  | ru_keyword                           |
| `broadcaster_name` (lowercase) в org-списку                                                 | tournament_official                  |
| title (lowercase) містить: " major"/" grand final"/"championship"/" tournament"/"qualifier" | tournament_event                     |
| game_name (lowercase) містить: slots/casino/gambling/betting/poker                          | gambling                             |
| `duration < 6` або `duration > 90`                                                          | duration                             |
| `language` in `["ja","ko","zh","th"]`                                                       | asian_language (see exception below) |

**Азійські мови — виняток:** Максимум **1 кліп на епізод** якщо виконані обидві умови:

- момент суто візуальний (без діалогу — реакція, фізичний гег, тощо)
- стрімер міжнародно відомий (xfactor, впізнаваний глядачам без контексту)

Якщо таких кліпів кілька — взяти лише найкращий за `preScore`. Решту відхиляти з причиною `asian_language`.

Зберегти у `filtered-clips.json` і `rejected-clips.json`.
Оновити `state.counts.filtered`.

---

## PRE-SCORE — Відбір кліпів для download

Для кожного filtered кліпу розрахувати `preScore` (0–100):

```javascript
const coreIds = ['509658','509672','26936','116747788','32399','516575','21779','29595','493057'];

// Pass 1: build broadcasterMaxViews for ratio signal
const broadcasterMaxViews = new Map();
for (const clip of filteredClips) {
  const cur = broadcasterMaxViews.get(clip.broadcaster_name) || 0;
  if (clip.view_count > cur) broadcasterMaxViews.set(clip.broadcaster_name, clip.view_count);
}

function calcPreScore(clip, seenStreamers, seenCategories) {
  // velocityScore: views/hour, log scale — 5k views/hr = 100
  // Replaces raw viewsScore + noveltyScore (age is already penalized via velocity)
  const hoursAlive = Math.max((Date.now() - new Date(clip.created_at)) / 3600000, 0.5);
  const velocity = clip.view_count / hoursAlive;
  const velocityScore = Math.min(100, (Math.log10(velocity + 1) / Math.log10(5000)) * 100);

  // broadcasterRatioScore: how dominant is this clip among all clips from this broadcaster in dataset
  // clip that is the top clip from its broadcaster = 100; 10% of top = 10
  const maxViews = broadcasterMaxViews.get(clip.broadcaster_name) || clip.view_count;
  const ratioScore = Math.min(100, (clip.view_count / Math.max(maxViews, 1)) * 100);

  // categoryScore: core = 88, dynamic = 60
  const categoryScore = coreIds.includes(clip.game_id) ? 88 : 60;

  // durationScore: 15–60s = 100, 6–15s = 60, 60–90s = 70
  const d = clip.duration;
  const durationScore = d >= 15 && d <= 60 ? 100 : d < 15 ? 60 : 70;

  // languageScore: viral bypass — якщо velocityScore > 85, мова не важлива
  const isViralLang = velocityScore > 85;
  const rawLangScore = clip.language === 'en' ? 100 : clip.language === 'uk' ? 80 : 20;
  const languageScore = isViralLang ? 100 : rawLangScore;

  // riskPenalty
  const title = (clip.title || '').toLowerCase();
  const riskPenalty = title.includes('music') || title.includes('song') ? 15 : 0;

  const baseScore = (
    velocityScore * 0.25 +
    ratioScore    * 0.15 +
    categoryScore * 0.25 +
    durationScore * 0.20 +
    languageScore * 0.15
  ) - riskPenalty;

  // Diversity: soft cap multipliers, applied per streamer AND per category independently
  const streamerCount  = seenStreamers.get(clip.broadcaster_name) || 0;
  const categoryCount  = seenCategories.get(clip.game_id) || 0;
  const streamerMult   = streamerCount === 0 ? 1.0 : streamerCount === 1 ? 0.85 : 0.70;
  const categoryMult   = categoryCount < 5  ? 1.0 : categoryCount < 10  ? 0.90 : 0.80;

  // Exceptional viral clips bypass diversity penalty
  const isViral = velocityScore > 80 || (ratioScore >= 100 && velocityScore > 60);
  const diversityMult  = isViral ? 1.0 : streamerMult * categoryMult;

  return Math.max(0, Math.min(100, baseScore * diversityMult));
}

// Pass 2: score — process sorted by velocity so top clip from each streamer wins full score
const seenStreamers  = new Map();
const seenCategories = new Map();
const scored = filteredClips
  .sort((a, b) => (b.view_count / Math.max((Date.now() - new Date(b.created_at)) / 3600000, 0.5))
                - (a.view_count / Math.max((Date.now() - new Date(a.created_at)) / 3600000, 0.5)))
  .map(clip => {
    const score = calcPreScore(clip, seenStreamers, seenCategories);
    seenStreamers.set(clip.broadcaster_name, (seenStreamers.get(clip.broadcaster_name) || 0) + 1);
    seenCategories.set(clip.game_id, (seenCategories.get(clip.game_id) || 0) + 1);
    return { ...clip, preScore: score };
  })
  .sort((a, b) => b.preScore - a.preScore);
```

**Download buckets (100 кліпів):**

Для кожного бакету: viral = sort by views/hour, popularity = sort by view_count.

```
JC/IRL     → до 50  (30 viral + 20 popularity)
Specialty  → до 10  (7 viral + 3 popularity, max 6 з однієї категорії)
Gaming     → до 40  (30 viral + 10 popularity, max 5 з однієї гри)
```

- JC/IRL: game_id in [509658, 509672]
- Specialty: game_id in [26936, 116747788]
- Gaming: все інше (core gaming + dynamic)

Зберегти у `clips/prescore-candidates.json`. Оновити `state.stages.prescore = "done"`.

---

## DOWNLOAD

```bash
node scripts/progress.js "projects/<runId>" 3 "Завантаження кліпів (yt-dlp)"
```

### Назва файлу

```javascript
function buildDownloadFilename(clip) {
  const cat = (clip.game_name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
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
- Limit: 100 кліпів

Зберегти `downloaded-clips.json` (кожен кліп має `localPath`).
Оновити `state.counts.downloaded`, `state.stages.download = "done"`.

> Downstream steps (trim, transcribe) мають брати шлях до файлу з `clip.localPath`, не конструювати його з clipId.
