# Skill: ddos-score

Транскрибуй кліпи, оціни через Claude, побудуй план епізоду, згенеруй хуки.

---

## TRANSCRIBE — faster-whisper

```bash
node scripts/progress.js "projects/<runId>" 4 "Транскрипція (Whisper large-v3)"
```

Для кожного завантаженого кліпу запусти Python скрипт:

Шлях до відео брати з `clips/downloaded-clips.json` → `clip.localPath`.

```bash
python3 scripts/transcribe.py \
  "<clip.localPath>" \
  "projects/<runId>/processed/<clipId>/transcript.json" \
  "<clipId>"
```

Якщо transcript.json вже існує — пропустити.
Якщо Python/faster-whisper не встановлений — записати `transcribe: "skipped"` і продовжити без транскрипту.

---

## SCORE — Claude оцінка (batch, 8 кліпів за раз)

```bash
node scripts/progress.js "projects/<runId>" 5 "Оцінювання кліпів (Claude)"
```

**Батчинг обов'язковий** — ніколи не оцінювати по одному кліпу. Групувати по 8 і відправляти один запит.

Для кожної групи 8 кліпів:
1. Прочитати `processed/<clipId>/transcript.json` якщо існує. Підготувати три поля:
   - `excerptStart` — перші **1000 символів** тексту (більше контексту)
   - `excerptEnd` — **останні 200 символів** (payoff майже завжди в кінці)
   - `speechDensity` — `(words.length / clip.duration).toFixed(1)` слів/сек; 3+ = action/reaction, < 1 = спокійна розмова
2. Відправити один batch prompt:

**Scoring prompt (batch):**
```
You are scoring Twitch clips for "Daily Dose Of Stream" — a daily English-language compilation channel.
Target audience: general English-speaking viewers who may NOT know the streamer.
Tone: funny, comfortable, curated. Not toxic.

Be strict — most clips score 40-70. Only truly outstanding clips score 80+.

THE 5-SECOND TEST: Would someone who has never seen this streamer laugh or say "WTF" within the first 5 seconds? If no → contextClarity should be low (under 50).

WHAT WORKS FOR THIS AUDIENCE (score higher):
- Surprise/shock — something goes wrong, or streamer reacts to something completely unexpected
- Cringe/awkward — streamer ends up in an embarrassing live moment (secondhand embarrassment)
- Genuine emotional moment — unexpected donation, streamer cries, something wholesome
- Fail/disaster — something breaks, falls, or goes catastrophically wrong
- Divine timing — two unrelated things coincide perfectly in one second

PENALIZE HEAVILY:
- Clip requires 2+ minutes of context to understand → contextClarity < 30
- Lots of talking about something that happened earlier, no real-time reaction → retentionScore < 40
- Inside joke only regulars of that community would understand → contextClarity < 35, noveltyScore < 30
- No visible face or facial emotion → thumbnailPotential < 30

Clips:
[1] <clipId>
  Streamer: <broadcaster_name>, Category: <game_name>, Language: <language>, Duration: <duration>s
  Title: "<title>"
  Speech density: <speechDensity> words/sec
  Transcript start: "<excerptStart>"
  Transcript end: "<excerptEnd>"

[2] ...
(up to 8 clips)

Respond ONLY with a valid JSON array (no markdown):
[
  {
    "clipId": "...",
    "retentionScore": 0-100,
    "funnyScore": 0-100,
    "payoffStrength": 0-100,
    "contextClarity": 0-100,
    "noveltyScore": 0-100,
    "shortsPotential": 0-100,
    "longFormPotential": 0-100,
    "transitionPotential": 0-100,
    "cooldownPotential": 0-100,
    "toxicityRisk": 0-100,
    "singingScore": 0-100,
    "dancingScore": 0-100,
    "rageScore": 0-100,
    "thumbnailPotential": 0-100,
    "emotionalCategory": "surprise|cringe|emotional|fail|divine_timing|gameplay|other",
    "flags": [],
    "reasoning": "1 sentence — what happens and why it does or doesn't work for a general audience"
  },
  ...
]

Field definitions:
- contextClarity: does a viewer with NO knowledge of this streamer understand what's happening within 5 seconds?
- thumbnailPotential: high (70+) if streamer face shows strong emotion (shock, laughing, panic, rage). Low if gameplay without face or static/dark frame.
- emotionalCategory: pick the single best fit from the list above.
```

**DDOS Score формула:**
```
viralityScore = min(100, sqrt(viralityRatio) * 35)
  // viralityRatio = view_count / hours_alive / avg_viewers (з TwitchTracker)

ddosScore =
  viralityScore  * 0.30
  + retentionScore * 0.25
  + funnyScore   * 0.20
  + payoffStrength * 0.15
  + contextClarity * 0.10
  - (toxicityRisk > 40 ? (toxicityRisk - 40) * 0.5 : 0)
```

Зберегти у `processed/<clipId>/score.json`.
Зберегти всі scores у `clips/scored-clips.json`.

Показати таблицю топ-20 кліпів перед плануванням:
```
# | Стрімер          | Категорія    | DDOS | Funny | Shorts | Flags
1 | xQc              | Just Chatting| 87   | 92    | 85     |
2 | KaiCenat         | Just Chatting| 83   | 88    | 90     |
...
```

---

## PEAK MOMENT — Знайти найгучніший 1-секундний момент

Для кожного кліпу після scoring:

```bash
ffprobe -v quiet -select_streams a:0 -show_entries stream=codec_type \
  "processed/<clipId>/clean.mp4" 2>/dev/null
```

Якщо аудіо трек відсутній → `peakMoment = {"start": 0, "end": 1.0, "rmsDb": -50}`, пропустити.

Інакше — запустити Python скрипт:

```bash
PEAK=$(python3 scripts/find_peak.py "processed/<clipId>/clean.mp4")
# Додати peakMoment в score.json
```

Зберегти `score.json`:
```json
{
  "...all score fields...",
  "peakMoment": {"start": 12.5, "end": 13.5, "rmsDb": -8.3}
}
```

---

## GENERATE_EDITORIAL — Відбір кліпів + генерація edit.html

```bash
node scripts/progress.js "projects/<runId>" 7 "Генерую editorial UI"
```

**Крок 1 — Згенерувати edit.html:**

```bash
node scripts/gen-editorial.js <runId>
```

Скрипт кладе ВСІ scored кліпи в `selected` (відсортовано JC/IRL → Gaming → Music/Specialty, за ddosScore), оновлює `state.json` та `projects/index.html` автоматично.

**Показати користувачу:**

Відкрити браузер автоматично:
```bash
start "" "d:\Projects\ddos\projects\<runId>\edit\edit.html"
```

Потім вивести користувачу:

✅ Editorial UI відкрито у браузері (`projects/<runId>/edit/edit.html`)

Переглянь кліпи, внеси правки і натисни "Copy Prompt".
Потім встав JSON сюди для продовження.

Зупинитись і чекати на JSON від користувача.
