# Skill: ddos-ingest

Отримай кліпи з Twitch, відфільтруй, відбери кандидатів для завантаження.

---

## INGEST — Twitch API

```bash
node scripts/progress.js "<projectDir>" 1 "Отримую кліпи з Twitch"
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
curl -s "https://api.twitch.tv/helix/games/top?first=50" \
  -H "Client-ID: $TWITCH_CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN"
```

Взяти перші 10 по популярності, виключивши:

- id вже є в core
- name (lowercase) містить: slots, casino, gambling, betting, poker, tarkov, overwatch, marvel rivals, sports betting, dark and darker, path of exile

Результат: ~19 категорій загалом.

### Запит кліпів

Реалізовано в `node scripts/ingest.js <runId> <token> [--hours N]` (дефолт N=24).

Для кожної категорії — послідовні сторінки без пропусків. Кількість сторінок
масштабується з N (щоб довші вікна не отримували неповний пул):

```
pages_JCIRL  = min(15, ceil(3 × N / 24))   → N=24: 3,  N=120: 15, N=240: 15 (кап)
pages_OTHER  = min(6,  ceil(N / 24))       → N=24: 1,  N=120: 5,  N=240: 6  (кап)
```

```
GET https://api.twitch.tv/helix/clips
  ?game_id=<gameId>
  &started_at=<ISO: now - N годин>
  &first=100
  &after=<cursor>
```

Зберегти у `clips/raw-clips.json`. Оновити `state.counts.raw`.

---

## FILTER — Metadata фільтрація (до download)

```bash
node scripts/progress.js "<projectDir>" 2 "Фільтрація та відбір кандидатів"
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
| `broadcaster_name` в blacklist: lyasyaa, qoqsik, vedal987, miladeva, winningbikini, panterochka_ | streamer_blacklist |
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

Без velocity — тільки popularity (raw `view_count`) і diversity floor.
Деталі та обґрунтування: `docs/superpowers/specs/2026-06-16-select-stage-rebalance-design.md`.

Якщо filtered > 500 — обрізати пул до топ-500 по view_count (maxClipCandidates).

**JC/IRL (100, фінал на цій стадії):**

```
80 по popularity, max 5/streamer
+ 20 diversity-floor:
    крок 1 — гарантований ≥1 слот кожному стрімеру з 0 слотів у перших 80 (по popularity desc)
    крок 2 — решта diversity-слотів заповнюється з того ж пулу по popularity (без ліміту/стрімер)
+ fallback: якщо diversity pool вичерпаний і total < 100 —
    добирає з основного JC/IRL пулу (не вибрані) по popularity до 100
```

**Gaming (50 — GAMING_SCREEN перевіряє за один раунд, ~50% очікуваний відсів):**

```
50 по popularity, max 5/game, max 5/streamer
```

- `popularity` = raw `view_count`
- JC/IRL: game_id in [509658, 509672]
- Gaming: все інше (core gaming + dynamic)
- Specialty (Music, Pools) — виключено

**Recency-компенсація (тільки якщо `--hours N` > 24):**

Три вікна, прив'язані до фіксованих позначок "годин тому" (не пропорційні до N):

| Вікно | Діапазон (hours-ago) | Активне коли | JC/IRL | Gaming |
|---|---|---|---|---|
| new | `[0, min(24,N))`  | N > 24 | +15 | +8 |
| mid | `[24, min(72,N))` | N > 24 | +10 | +5 |
| old | `[72, N)`          | N > 72 | +5  | +2 |

Слоти додаються **зверху** базового пулу (100 JC/IRL / 50 Gaming вище), з
кліпів що ще не обрані. Деталі: `docs/superpowers/specs/2026-07-07-custom-hours-recency-ingest-design.md`.

Зберегти у `clips/prescore-candidates.json` (150 кандидатів за замовчуванням
N=24: 100 JC/IRL + 50 Gaming; більше при N>24 через recency-компенсацію).
Оновити `state.stages.select = "done"`.

---

## DOWNLOAD

```bash
node scripts/progress.js "<projectDir>" 3 "Завантаження кліпів (yt-dlp)"
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
  // суфікс з clip.id — захист від колізій (однакові views за день)
  const idSuffix = clip.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8);
  return `${cat}_${streamer}_${views}_${date}_${idSuffix}.mp4`;
}
```

```bash
FILENAME=$(buildDownloadFilename clip)
yt-dlp \
  --no-playlist \
  --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" \
  --merge-output-format mp4 \
  --output "<projectDir>/downloads/$FILENAME" \
  --quiet \
  "<clip_url>"
```

Після успішного завантаження додати `localPath` до clip об'єкта:

```javascript
clip.localPath = `<projectDir>/downloads/${filename}`;
```

- Якщо файл вже існує → пропустити
- Якщо помилка → записати в rejected, продовжити
- Паралельно: max 5 одночасно
- Limit: 150 кліпів (100 JC/IRL + 50 Gaming)

Зберегти `downloaded-clips.json` (кожен кліп має `localPath`).
Оновити `state.counts.downloaded`, `state.stages.download = "done"`.

> Downstream steps (trim, transcribe) мають брати шлях до файлу з `clip.localPath`, не конструювати його з clipId.

---

## GAMING_SCREEN — перевірка вебка/VTuber/турнірний HUD

Gaming-кліпи неможливо оцінити на якість з метаданих Twitch API — тільки з кадру.
`scripts/gaming-screen.js` витягує 1 кадр на кліп і будує contact sheet; рішення приймає
Claude в розмові (без API-викликів зі скрипта), так само як editorial-оцінки.

```bash
node scripts/gaming-screen.js <runId> --prepare
```

Переглянь `clips/gaming-contact-sheet.png`. **Правило pass: ВСІ три умови мають бути true:**
- є реальна вебка з обличчям людини (не анімація)
- НЕ VTuber (анімований аватар)
- НЕМА турнірного HUD (скорборд 5-на-5 команд, турнірна таблиця)

→ якщо є вебка але є турнірний HUD — `pass: false, reason: "tournament_hud"`

Запиши рішення в `clips/gaming-screen-results.json`:

```json
{ "<clipId>": { "pass": true, "reason": null } }
```

Потім:

```bash
node scripts/gaming-screen.js <runId> --apply
```

Якщо пройшло < 20 — скрипт сам довантажує 2×(потрібно) нових кандидатів і просить ще
один `--prepare`. Safety cap: 2 раунди максимум. Жодної зупинки для користувача.
