# Skill: ddos-ingest

Отримай кліпи з Twitch, відфільтруй, завантаж через yt-dlp.

---

## INGEST — Twitch API

### Отримати токен
```bash
curl -s -X POST "https://id.twitch.tv/oauth2/token" \
  -d "client_id=$TWITCH_CLIENT_ID" \
  -d "client_secret=$TWITCH_CLIENT_SECRET" \
  -d "grant_type=client_credentials"
```
Зберегти access_token.

### Запит кліпів по категорії
```
GET https://api.twitch.tv/helix/clips
  ?game_id=<gameId>
  &started_at=<ISO час - N годин>
  &first=20
  &after=<cursor>

Headers:
  Client-ID: $TWITCH_CLIENT_ID
  Authorization: Bearer <token>
```

### Гібридний sampling для кожної категорії

**Top range** (перша сторінка, 20 кліпів):
- Запит без cursor

**Mid range** (позиції 21–80):
- Пропустити 1 сторінку (зберегти cursor), запросити ще 3 сторінки

**Hidden gems** (позиції 81–160, для 3 випадкових категорій):
- Пропустити 4 сторінки, запросити 2 сторінки

Зберегти всі кліпи у `projects/<runId>/clips/raw-clips.json`.
Оновити `state.counts.raw`.

---

## FILTER

Відхилити кліп якщо будь-яка умова:

| Умова | Причина |
|-------|---------|
| language == "ru" | excluded_language |
| title містить: русский/россия/russian/путін/рф | ru_keyword |
| game назва містить: Slots/Casino/Gambling/Betting | gambling |
| duration < 6 | too_short |
| duration > 90 | too_long |
| broadcaster_name вже зустрівся >= 3 рази | streamer_limit |

Зберегти прийняті у `filtered-clips.json`, відхилені у `rejected-clips.json`.
Оновити `state.counts.filtered`.

---

## DOWNLOAD

Завантажити максимум 50 кліпів (найвищий view_count з filtered).

Для кожного кліпу:
```bash
yt-dlp \
  --no-playlist \
  --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" \
  --merge-output-format mp4 \
  --output "projects/<runId>/downloads/<clipId>.mp4" \
  --quiet \
  "<clip_url>"
```

- Якщо файл вже існує — пропустити (кешування)
- Якщо помилка — записати в rejected і продовжити
- Паралельно: максимум 3 одночасно

Зберегти `downloaded-clips.json` зі списком успішних.
Оновити `state.counts.downloaded`.
Оновити `state.stages.download = "done"`.
