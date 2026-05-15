# DDOS Pipeline v2 — Architecture Design Spec

**Date:** 2026-05-15
**Author:** Vitalii Luchko + Claude Code
**Status:** Approved for implementation

---

## Executive Summary

Pipeline v1 вийшов: відео зробило, але з критичними проблемами — 78 хв замість 12–15 хв, немає субтитрів, немає звуку, неправильний reconnecting, чорні смуги в шортс. v2 — повна переробка архітектури з новими можливостями: dynamic категорії, pre-download scoring, динамічний монтаж, правильний reconnecting, YouTube publish, Notion аналітика.

---

## Pipeline — новий порядок стадій

```
1.  INGEST      Динамічні категорії (core + Twitch top games) → 300–500 metadata
2.  PRE-SCORE   Pre-download scoring (формула, без AI) → відбір 50–80 кліпів
3.  DOWNLOAD    yt-dlp паралельно, hybrid sampling
4.  TRANSCRIBE  faster-whisper → word timestamps
5.  SCORE       Claude: 13 вимірів + editingNotes + peak moment + chill detection
6.  PLAN        Групування + вибір reconnecting-момент + chill finale plan
7.  TRIM        silencedetect → точне обрізання → re-encode (не -c copy)
8.  EFFECTS     FFmpeg ефекти за editingNotes (zoom, color grade)
9.  OVERLAYS    WebM alpha: streamer overlay (з аватаром) + reconnecting panel
10. HOOKS       Claude: 2–5 word anticipation hooks
11. CAPTIONS    Merged ASS з time offsets → burn у long-form
12. RECONNECTING Глич-момент + reconnecting panel overlay → 1s кліп
13. CHILL       Пошук/витяг signing/dancing → VOD якщо потрібно → render finale
14. RENDER LONG Concat (12–18 кліпів, 12–15 хв), burn captions, chill + outro
15. RENDER SHORTS Background blur crop + full captions
16. THUMBNAIL   Puppeteer → best frame + байтерський текст
17. METADATA    Таймкоди + description шаблон
18. REVIEW      review.html
19. PUBLISH     YouTube: main (Unlisted) + Shorts → /ddos approve → Public
20. ANALYTICS   (на початку наступного запуску) YouTube Analytics → Notion
```

---

## Stage 1: INGEST — Dynamic Categories

### Категорії

**Core (завжди, фіксовані):**

```json
["Just Chatting", "IRL", "Counter-Strike 2", "Valorant", "Grand Theft Auto V"]
```

**Dynamic (запитуємо у Twitch щоразу):**

- `GET /helix/games/top?first=20` → топ-20 ігор за глядачами прямо зараз
- Виключити: gambling (Slots, Casino, Sports Betting, Poker), вже є в core
- Взяти перші 10 з решти → додати до sampling як "trending"

**Результат:** ~14 категорій, але завжди відображають актуальний Twitch.

### Фільтрація на стадії metadata (ДО download)

Відхиляти одразу:

| Умова                                                                                                                              | Причина             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `language == "ru"`                                                                                                                 | excluded_language   |
| title містить: русский/россия/russian/путін/рф                                                                                     | ru_keyword          |
| `broadcaster_name` в офіційному org-списку ESL/BLAST/PGL/RiotGames/Valve/EpicGames                                                 | tournament_official |
| title містить: "Major", "Grand Final", "Championship", "Tournament", "qualifier" (case-insensitive) + game категорія є competitive | tournament_event    |
| game назва містить: Slots/Casino/Gambling/Betting                                                                                  | gambling            |
| `duration < 6` або `duration > 90`                                                                                                 | duration            |

**Офіційні org-акаунти (broadcaster_name):**

```
ESL_CSGO, ESLCS, BLASTtv, PGL, RiotGames, valorant,
esl_dota2, WePlay_Esports, faceit, dreamhack
```

### Обсяг sampling

- Цільова кількість metadata: **300–500 кліпів**
- Для кожної категорії: top 20 + mid 40 + hidden gems 20 = ~80 per category
- Після фільтрації: ~200–350 валідних

---

## Stage 2: PRE-SCORE — Pre-download Scoring

Формула (без AI, чиста математика):

```
preScore =
  viewsScore    * 0.30   // normalized view_count (log scale, топ категорії)
  + categoryScore * 0.20  // вага категорії з config
  + durationScore * 0.15  // optimal range: 15–60s = 100, решта пропорційно
  + diversityScore* 0.20  // штраф якщо broadcaster_name вже зустрівся
  + noveltyScore  * 0.10  // штраф якщо clip.created_at > 48 годин тому
  + languageScore * 0.05  // en/uk = 100, інші = 40
  - riskPenalty           // title містить "music"/"song" = -20, gambling keywords = -999
```

**Результат:** сортуємо 200–350 кліпів, беремо **50–80 для download** по hybrid sampling:

- 35% top preScore
- 35% mid preScore (позиції 30–70%)
- 15% hidden gems (позиції 70–90%)
- 10% small/mid streamers (< 5000 глядачів онлайн)
- 5% trending/niche categories (нові ігри що тільки вийшли)

---

## Stage 3: DOWNLOAD

Без змін в логіці, але:

- `maxDownloads`: 80 (було 50)
- Паралельно: max 5 (було 3)
- yt-dlp формат: незмінний

---

## Stage 4: TRANSCRIBE

Без змін. faster-whisper tiny model. Word-level timestamps.

---

## Stage 5: SCORE — 13 вимірів + editingNotes

### Нові виміри (додаємо до існуючих 11):

| Поле           | Що оцінює                                            |
| -------------- | ---------------------------------------------------- |
| `singingScore` | 0–100: є момент де стрімер/хтось добре співає, довго |
| `dancingScore` | 0–100: є момент де стрімер або хтось танцює          |
| `rageScore`    | 0–100: intense reaction, rage quit, крик від гри     |

### Нове поле editingNotes:

```json
{
  "editingNotes": {
    "punchZoomAt": 12.5, // секунда де робити zoom punch (null якщо не треба)
    "colorPunchAt": [8.0, 15.3], // секунди для насиченості кольору
    "rageMoments": [
      // для shake/glitch ефекту
      { "start": 10.2, "end": 11.8 }
    ],
    "faceZoneSeconds": [3, 4, 5, 6] // секунди де треба ближче на face cam
  }
}
```

### Peak moment detection (для reconnecting)

Для кожного кліпу знайти 1-секундний відрізок з найвищою RMS аудіо енергією:

```bash
ffmpeg -i clip.mp4 \
  -af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level" \
  -f null - 2>&1
```

Зберегти в score.json:

```json
{
  "peakMoment": {
    "start": 23.4,
    "end": 24.4,
    "rmsDb": -12.3
  }
}
```

Якщо в transcript є emotional keyword (oh, no, wtf, wait, insane, no way) в межах ±2с від пікового аудіо → пріоритет цьому моменту.

### Chill clip accumulation

Якщо `singingScore > 70` або `dancingScore > 70`:

- Зберегти копію у `assets/chill-archive/singing/<clipId>.mp4` або `dancing/`
- Додати запис у `assets/chill-archive/index.json`:
  ```json
  {
    "clipId": "...",
    "type": "singing|dancing",
    "broadcaster": "...",
    "score": 85,
    "runId": "...",
    "duration": 47.2
  }
  ```

---

## Stage 6: PLAN — Групування і структура

### Алгоритм групування

```
groups = []
for each clip in scored top-25:
  key = broadcaster_name + ":" + game_id
  if key exists in current group → append to that group
  else → start new group

Виняток: якщо broadcaster однаковий але game різна → завжди окрема група
```

**Типи груп:**

| Тип | Умова | Приклад |
|-----|-------|---------|
| `GAME_GROUP` | Та сама гра, різні стрімери | CS2 моменти від 3–4 стрімерів підряд |
| `STREAMER_GROUP` | Той самий стрімер, та сама гра | 2–3 кліпи одного стрімера в одній грі |
| `VIBE_GROUP` | Схожий емоційний тон (chaos/wholesome/rage) | 3–4 rage-кліпи з різних ігор |
| `MICRO_GROUP` | Кліпи < 15с → збираємо 4–6 разом | Швидка нарізка смішних моментів по 3–10с |

**Правила:**
- Той самий стрімер + різна гра → завжди окремі групи
- Та сама гра + різні стрімери → об'єднувати в GAME_GROUP
- Кліпи < 15с → збирати в MICRO_GROUP для динамічного ритму
- Claude вирішує тип і склад кожної групи під час PLAN

Максимум кліпів у групі: **5** (MICRO_GROUP: до 6)
Кількість груп: **5–7** (= ~12–18 кліпів загалом)

### Reconnecting clip selection

1. Серед усіх кліпів у groups → знайти той з найвищим `peakMoment.rmsDb`
2. Перемістити групу цього кліпу **на перше місце** в clipOrder
3. Reconnecting transition = `peakMoment` цього кліпу (вже показаний глядачу)

### Chill finale planning

```
chillAssets = читати assets/chill-archive/index.json
if singingClips.length >= 1:
  chillPlan = {
    type: "singing_then_dancing",
    singingClipId: best singingScore,
    dancingClipIds: up to 10 best dancingScore clips (більше різних стрімерів = краще),
    extractFromVod: false   // true якщо потрібно витягнути більше з VOD
  }
elif dancingClips.length >= 3:
  chillPlan = { type: "dancing_montage", clipIds: [...] }
else:
  chillPlan = { type: "skip" }
```

Якщо `singingScore > 70` знайдено в поточному run і тривалість кліпу < 60с → встановити `extractFromVod: true`.

### Цільова тривалість

- **Target:** 12–15 хвилин (740–900 секунд)
- Якщо сума тривалостей вибраних кліпів > 900с → прибрати кліпи з найнижчим ddosScore поки не < 900с
- Якщо < 720с → додати наступні за рейтингом (мінімум 12 хвилин)

---

## Stage 7: TRIM — Silence Detection + Re-encode

### Пошук тиші

```bash
ffmpeg -i clip.mp4 \
  -af "silencedetect=noise=-40dB:duration=0.3" \
  -f null - 2>&1
```

Парсимо: `silence_end: X.XX`, `silence_start: Y.YY` → обрізаємо від першого не-тихого до останнього не-тихого.
Fallback якщо silencedetect нічого не знайшов: **використовуємо повний кліп без обрізання** (можливо там одразу починається щось цікаве).

### Re-encode (НЕ -c copy)

```bash
ffmpeg -i clip.mp4 -ss $START -to $END \
  -vf "setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -af "asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11" \
  -c:v libx264 -preset fast -crf 23 \
  -c:a aac -b:a 192k -ar 48000 \
  -r 30 \
  -y "processed/<clipId>/clean.mp4"
```

Всі кліпи виходять в єдиному форматі: H.264, 30fps, 1920×1080, AAC 192k, 48kHz.
Це гарантує що concat без проблем і audio sync правильний.

---

## Stage 8: EFFECTS — Dynamic Editing

На основі `editingNotes` з score.json, застосувати FFmpeg ефекти:

### Zoom punch

```bash
# У момент punchZoomAt: плавний zoom 1.0→1.15 за 0.3с, hold, 1.15→1.0 за 0.3с
ffmpeg -i clean.mp4 -vf "
  zoompan=z='if(between(t,$PUNCH_AT-0.3,$PUNCH_AT),1+(0.15*(t-($PUNCH_AT-0.3))/0.3),
           if(between(t,$PUNCH_AT,$PUNCH_AT+0.3),1.15,1))':
         d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=30
" -c:v libx264 -preset fast -crf 23 -c:a copy -y edited.mp4
```

### Color punch

```bash
# eq saturation+20%, brightness+5% в colorPunchAt секунди (±0.5s window)
-vf "eq=saturation=1.2:brightness=0.05"
```

### Rage shake

```bash
# Легкий shake: random pixel offset ±8px
-vf "crop=iw-16:ih-16:8+8*sin(2*PI*t*12):8+8*cos(2*PI*t*7),scale=1920:1080"
```

Якщо `editingNotes` порожній → пропустити stage, використовувати clean.mp4.

---

## Stage 9: OVERLAYS — WebM Alpha

### Streamer overlay

**Процес рендеру (один раз per broadcaster_name):**

1. Puppeteer → 90 скріншотів за 3с (кожні 33ms, via `page.evaluate(() => animation.currentTime)`)
3. PNG sequence з прозорим фоном → WebM VP9 alpha:

```bash
ffmpeg -framerate 30 -i frame_%04d.png \
  -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 \
  -y "processed/<clipId>/streamer-overlay.webm"
```

4. Кешувати у `cache/overlays/<broadcaster_name>.webm`

**Зміни в streamer_name.html:**

- Шрифт нік: 24px (вже збільшено)
- Показувати лише нік (без категорії, без аватара)
- Compact варіант: тільки caution tape + панель з ніком

**Burn у відео:**

```bash
ffmpeg -i edited.mp4 -i streamer-overlay.webm \
  -filter_complex "[0:v][1:v]overlay=20:H-h-120:eof_action=pass[out]" \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 23 -c:a copy \
  -y "processed/<clipId>/overlayed.mp4"
```

### Reconnecting panel

Pre-render один раз при старті pipeline:

- Puppeteer → 30 кадрів за 1с → WebM alpha `edit/reconnecting-panel.webm`
- Розмір панелі: 460×120px в кутку top-right

---

## Stage 10: HOOKS

Без змін. Claude генерує 2–5 word anticipation hooks.

---

## Stage 11: CAPTIONS — Merged ASS з time offsets

### Розрахунок time offsets

При побудові concat-list рахуємо cumulative start time кожного кліпу:

```
intro.mp4 duration → offset[clip1] = intro_duration
clip1 duration → offset[clip2] = intro_duration + clip1_duration
reconnecting.mp4 → offset[clip3] = ... + reconnecting_duration
...
```

### Long-form ASS merge

Для кожного кліпу читаємо `captions-longform.ass`, зсуваємо timestamps на `offset[clipN]`, об'єднуємо в `edit/episode.ass`.

ASS timestamp format: `0:MM:SS.CC` → парсимо, додаємо offset у секундах, конвертуємо назад.

### Burn при render

```bash
ffmpeg -i concat_output.mp4 \
  -vf "ass=edit/episode.ass" \
  -c:v libx264 -preset medium -crf 22 \
  -c:a copy \
  -y "exports/episode-NNN.mp4"
```

### Long-form subtitle style

- Тільки emotional keywords (bro, no way, insane, wtf, oh, wait, etc.) + ALL CAPS слова
- Білий текст (#F4F0E6), жовтий highlight (#F5FF3D) для keyword
- Archivo Black 56px, outline 3px
- Word-by-word timing (не групами)
- Позиція: `\an2` (знизу по центру), marginV=80

---

## Stage 12: RECONNECTING — Glitch Moment

### Алгоритм

```
reconnectingClip = кліп з peakMoment (перша група в clipOrder)
start = peakMoment.start
end   = peakMoment.start + 1.0   // рівно 1 секунда

ffmpeg -i "processed/<clipId>/overlayed.mp4" \
  -ss $start -to $end \
  -i "edit/reconnecting-panel.webm" \
  -filter_complex "
    [0:v]
      trim=duration=1,setpts=PTS-STARTPTS,
      rgbashift=rh=6:gh=0:bh=-6,
      noise=alls=18:allf=t+u,
      eq=contrast=1.3
    [glitch];
    [glitch][1:v]overlay=W-w-44:44:eof_action=pass
    [out]
  " \
  -map "[out]" -map "0:a" \
  -t 1.0 \
  -c:v libx264 -preset fast -crf 22 \
  -c:a aac -b:a 192k -ar 48000 \
  -y "edit/reconnecting.mp4"
```

Один reconnecting.mp4 → вставляється між **кожною** парою груп в concat-list.

---

## Stage 13: CHILL FINALE

### Якщо `chillPlan.type == "singing_then_dancing"`:

**Singing clip:**

- Якщо `extractFromVod == false`: використовуємо `normalized.mp4` кліпу
- Якщо `extractFromVod == true`:
  1. `GET /helix/clips?id=<clipId>` → отримуємо `vod_offset` (секунди від початку VOD)
  2. `GET /helix/videos?user_id=<broadcaster_id>&type=archive&first=1` → VOD id
  3. Витягуємо сегмент VOD:
     ```bash
     yt-dlp "https://www.twitch.tv/videos/<vodId>" \
       --download-sections "*$(vod_offset-10)s-$(vod_offset+90)s" \
       --output "edit/chill-singing.mp4"
     ```
  4. Trim, re-encode, normalize як звичайний кліп

**Render chill finale:**

```
10с showing_singer.mp4 → audio continues, video cuts to dancing clips (5с each)
```

```bash
# Singing відео (перші 10с)
ffmpeg -i singing.mp4 -t 10 singing_10s.mp4

# Dancing montage (зі збереженим аудіо від singing)
ffmpeg -i singing.mp4 -ss 10 -t 30 singing_audio.mp4   # аудіо хвіст
ffmpeg -f concat -i dancing_list.txt -i singing_audio.mp4 \
  -c:v libx264 -c:a aac dancing_montage.mp4

# Склейка
ffmpeg -f concat -i chill_list.txt chill_finale.mp4
```

### Якщо `chillPlan.type == "skip"`:

Pряуємо просто outro після останнього кліпу, без chill.

---

## Stage 14: RENDER LONG-FORM

### Валідація перед render

```
clips = episode-plan.json.clipOrder
assert len(clips) >= 12 and len(clips) <= 18
total_duration = sum(clip.duration for clip in clips)
assert 600 <= total_duration <= 960  // 10–16 хвилин
```

Якщо валідація не пройшла → error у state.json, не рендеримо.

### Concat-list порядок

```
intro.mp4 (1.25s)
└── GROUP 1 clips (overlayed.mp4 × N)
reconnecting.mp4 (1s)
└── GROUP 2 clips
reconnecting.mp4 (1s)
└── GROUP N clips
chill_finale.mp4 (якщо є, ~40–50s)
outro.mp4 (1.25s)
```

**Всі файли в concat-list мають однаковий формат** (H.264, 30fps, 1920×1080, AAC 48kHz) — тому concat без re-encode працює стабільно.

```bash
ffmpeg -f concat -safe 0 -i "edit/concat-list.txt" \
  -c copy \
  -y "edit/raw-episode.mp4"

# Потім burn captions
ffmpeg -i "edit/raw-episode.mp4" \
  -vf "ass=edit/episode.ass" \
  -c:v libx264 -preset medium -crf 22 \
  -c:a copy \
  -movflags +faststart \
  -y "exports/episode-NNN.mp4"
```

---

## Stage 15: RENDER SHORTS — Background Blur Crop

### Вертикальний crop без чорних смуг

```bash
ffmpeg -i normalized.mp4 \
  -filter_complex "
    [0:v]split[main][bg];
    [bg]scale=1080:1920:force_original_aspect_ratio=increase,
        crop=1080:1920,
        boxblur=20:5,
        eq=brightness=-0.3[blurred];
    [main]scale=1080:608[fg];
    [blurred][fg]overlay=(W-w)/2:(H-h)/2[composed];
    [composed]ass=processed/<clipId>/captions-vertical.ass[out]
  " \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 24 \
  -c:a aac -b:a 128k -ar 48000 \
  -movflags +faststart \
  -y "exports/shorts/<clipId>.mp4"
```

Результат: оригінальне відео letterboxed по центру, розмитий фон без чорних смуг.

### Shorts subtitles style

- Всі слова (word-by-word), Archivo Black 72px
- Білі (#FFFFFF) + жовті keywords (#F5FF3D)
- Позиція: нижня третина (marginV=300)
- Outline 4px темний

---

## Stage 16–18: THUMBNAIL, METADATA, REVIEW

Без суттєвих змін. METADATA додає:

- Timecodes для кожного кліпу: `0:00 @StreamerName — clip title`
- Description шаблон: однаковий для всіх епізодів з блоком таймкодів

---

## Stage 19: PUBLISH — YouTube

### OAuth 2.0 setup (one-time)

```
auth/client_secret.json  ← скачати з Google Cloud Console
auth/token.json          ← зберігається автоматично після першої авторизації
```

Перший запуск → відкривається браузер для авторизації → зберігається refresh token.
Наступні запуски → автоматично через refresh token.

### Upload main video

```javascript
// scripts/youtube-upload.js
const { google } = require('googleapis');
const youtube = google.youtube('v3');

await youtube.videos.insert({
  part: ['snippet', 'status'],
  requestBody: {
    snippet: {
      title: metadata.titleOptions[0],
      description: metadata.description, // includes timecodes
      tags: metadata.hashtags,
      categoryId: '20', // Gaming
    },
    status: {
      privacyStatus: 'unlisted', // → approve робить 'public'
    },
  },
  media: { body: fs.createReadStream('exports/episode-NNN.mp4') },
});

// Потім thumbnail
await youtube.thumbnails.set({
  videoId: uploadedVideoId,
  media: { body: fs.createReadStream('exports/thumbnail.png') },
});
```

### Upload Shorts

Кожен short → окремий upload:

- Title: `<hook> 🔴 #shorts #twitch`
- Description: `Full episode → <main video link>\n\n#shorts #twitch #gaming`
- Status: `public` (shorts публікуються відразу)

### Після `/ddos approve`

```javascript
await youtube.videos.update({
  part: ['status'],
  requestBody: { id: videoId, status: { privacyStatus: 'public' } },
});
```

Зберегти `videoId` у `state.outputs.youtubeVideoId`.

---

## Stage 20: ANALYTICS — YouTube → Notion

**Запускається на ПОЧАТКУ кожного нового `/ddos run`** (тобто pull статистики попереднього перед новим).

### YouTube Analytics API

```javascript
const analyticsData = await youtubeAnalytics.reports.query({
  ids: 'channel==MINE',
  startDate: publishedAt,
  endDate: today,
  metrics:
    'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,subscribersGained',
  dimensions: 'video',
  filters: `video==${videoId}`,
});
```

### Notion запис (via MCP)

Один рядок на епізод у базі "DDOS Analytics":

| Field      | Notion Type |
| ---------- | ----------- |
| Episode    | Number      |
| Title      | Text        |
| Published  | Date        |
| YouTube ID | Text        |
| Views 24h  | Number      |
| Views 7d   | Number      |
| Views 28d  | Number      |
| CTR %      | Number      |
| Watch %    | Number      |
| Likes      | Number      |
| Comments   | Number      |
| Run ID     | Text        |

При кожному запуску оновлюємо попередній рядок (якщо є) з новими Views 7d / Views 28d.

---

## Нова файлова структура

```
projects/<runId>/
├── state.json                    # + нові стадії: effects, reconnecting, chill, publish, analytics
├── clips/
│   ├── raw-clips.json
│   ├── prescore-candidates.json  # NEW: 300-500 з preScore
│   ├── filtered-clips.json
│   ├── downloaded-clips.json
│   └── scored-clips.json
├── processed/<clipId>/
│   ├── transcript.json
│   ├── score.json               # + singingScore, dancingScore, rageScore, editingNotes, peakMoment
│   ├── hook.txt
│   ├── clean.mp4                # re-encoded (не -c copy)
│   ├── edited.mp4               # NEW: після effects stage
│   ├── streamer-overlay.webm    # NEW: WebM alpha (або посилання на кеш)
│   ├── overlayed.mp4
│   ├── captions-longform.ass
│   └── captions-vertical.ass
├── edit/
│   ├── episode-plan.json        # + chillPlan, reconnectingClipId, groupOrder
│   ├── shorts-selection.json
│   ├── reconnecting-panel.webm  # NEW: pre-rendered panel animation
│   ├── reconnecting.mp4         # NEW: 1s glitch moment + panel
│   ├── chill-finale.mp4         # NEW: singing + dancing segment (якщо є)
│   ├── episode.ass              # NEW: merged ASS з time offsets
│   ├── raw-episode.mp4          # NEW: concat без captions
│   └── concat-list.txt
├── exports/
│   ├── episode-NNN.mp4          # final з captions
│   ├── thumbnail.png
│   ├── metadata.json            # + youtubeVideoId після publish
│   └── shorts/<clipId>.mp4
└── review/review.html

assets/
├── chill-archive/               # NEW: накопичення singing/dancing кліпів
│   ├── index.json
│   ├── singing/<clipId>.mp4
│   └── dancing/<clipId>.mp4
└── cache/
    └── overlays/<broadcaster>.webm  # NEW: кеш streamer overlays

auth/                            # NEW: YouTube OAuth
├── client_secret.json
└── token.json
```

---

## Permissions (auto-approve)

Додати у `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(ffmpeg:*)",
      "Bash(ffprobe:*)",
      "Bash(yt-dlp:*)",
      "Bash(python3:*)",
      "Bash(node:*)",
      "Bash(curl:*)"
    ]
  }
}
```

---

## Зміни у Skills

| Skill            | Статус           | Ключові зміни                                                                                                           |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ddos-ingest`    | Суттєво змінений | Dynamic categories, tournament filter, pre-score, 80 downloads                                                          |
| `ddos-score`     | Розширений       | +3 виміри, editingNotes, peakMoment, chill detection + accumulation                                                     |
| `ddos-render`    | Повна переробка  | re-encode trim, effects stage, WebM overlays, proper reconnecting, captions merge+burn, chill finale, concat validation |
| `ddos-shorts`    | Змінений         | Background blur crop, subtitles burn                                                                                    |
| `ddos-thumbnail` | Мінімальні       | Без змін                                                                                                                |
| `ddos-review`    | Мінімальні       | Без змін                                                                                                                |
| `ddos-publish`   | Новий skill      | YouTube OAuth upload + Shorts + approve flow                                                                            |
| `ddos-analytics` | Новий skill      | YouTube Analytics → Notion update                                                                                       |

---

## Відкриті питання / v3

- TikTok + Instagram publish (окрема задача, вимагає app approval)
- Автоматичне A/B тестування thumbnail (YouTube дозволяє тестувати)
- Face detection для точнішого zoom (потребує ML бібліотеки)
- Multilingual subtitles (overlay в оригінальній мові + EN переклад)
