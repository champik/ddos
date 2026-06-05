# Skill: ddos-ingest

Отримай кліпи з Twitch, відфільтруй, відбери кандидатів для завантаження.

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
- name (lowercase) містить: slots, casino, gambling, betting, poker, tarkov, overwatch, marvel rivals, sports betting, dark and darker, path of exile

Результат: ~14 категорій загалом.

### Запит кліпів

Для кожної категорії — послідовні сторінки без пропусків:

- **JC/IRL** (509658, 509672): **15 сторінок** → до 300 кліпів кожна
- **Решта категорій**: **5 сторінок** → до 100 кліпів кожна

```
GET https://api.twitch.tv/helix/clips
  ?game_id=<gameId>
  &started_at=<ISO: now - $HOURS годин>
  &first=20
  &after=<cursor>
```

Зберегти у `clips/raw-clips.json`. Оновити `state.counts.raw`.

---

## FILTER — Metadata фільтрація (до download)

```bash
node scripts/progress.js "projects/<runId>" 2 "Фільтрація та відбір кандидатів"
```

**Офіційні org-акаунти (відхиляти):**

```
esl_csgo, eslcs, eslcsb, blasttv, pgl, riotgames, valorant, esl_dota2,
weplay_esports, faceit, dreamhack, esltv, iem
```

**Перед фільтром — fetch VTuber tags (batch):**

```
GET /helix/channels?broadcaster_id=id1&broadcaster_id=id2...
```
До 100 broadcaster_id за запит. Якщо канал має тег `"vtuber"` — додати broadcaster_id до `vtuberBroadcasterIds`.

**Відхиляти кліп якщо будь-яка умова:**

| Умова | Причина |
| --- | --- |
| `language != "en"` | non_english |
| title містить: русский/россия/russian/путін/рф | ru_keyword |
| `broadcaster_name` в org-списку | official_broadcaster |
| `broadcaster_name` в blacklist: lyasyaa, qoqsik | streamer_blacklist |
| `broadcaster_id` в vtuberBroadcasterIds | vtuber |
| title містить: " major"/" grand final"/"championship"/" tournament"/"qualifier" | tournament_event |
| game_name містить: slots/casino/gambling/betting/poker/tarkov/overwatch/marvel rivals/sports betting/dark and darker/path of exile | banned_game |
| `duration < 6` або `duration > 90` | duration |

**ORG_BLACKLIST** (official broadcasters, не стрімери):
- Esports: esl_csgo, eslcs, eslcsb, blasttv, pgl, riotgames, valorant, esl_dota2, weplay_esports, faceit, dreamhack, esltv, iem
- Sports/Media: espn, espn2, nba, nfl, mlb, nhl, ufc, cnn, bbcnews, skynews, twitch, twitchgaming, twitchrivals
- Gaming media: gamespot, ign, kotaku
- Esports leagues: lolesports, lcs, lec, lck, lpl, dota2ti, pgl_dota2, overwatchleague, callofduty, fifa, pubg_battlegrounds

Зберегти у `filtered-clips.json` і `rejected-clips.json`.
Оновити `state.counts.filtered`.

---

## SELECT — Відбір кандидатів для download

Без formulas — простий bucket відбір по velocity і popularity.

**Bucket структура (100 кліпів):**

```
JC/IRL     → до 50  (30 по velocity + 20 по popularity, max 3/streamer)
Specialty  → до 10  (7 по velocity + 3 по popularity, max 6/cat, max 3/streamer)
Gaming     → до 40  (30 по velocity + 10 по popularity, max 5/game, max 3/streamer)
```

- `velocity` = `view_count / hoursAlive`
- `popularity` = raw `view_count`
- JC/IRL: game_id in [509658, 509672]
- Specialty: game_id in [26936, 116747788]
- Gaming: все інше (core gaming + dynamic)

JC/IRL мінімум 50: якщо після bucket selection JC/IRL < 50 — swap найменш вірусні non-JC/IRL кліпи на додаткові JC/IRL по velocity.

Зберегти у `clips/prescore-candidates.json`. Оновити `state.stages.select = "done"`.

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
