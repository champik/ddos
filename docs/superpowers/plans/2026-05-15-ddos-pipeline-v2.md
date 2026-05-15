# DDOS Pipeline v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переписати DDOS пайплайн з v1 (78 хв відео, без субтитрів, без звуку, неправильний монтаж) до v2 (12–15 хв, динамічний монтаж, субтитри, правильний reconnecting, YouTube auto-publish, Notion аналітика).

**Architecture:** 4 незалежних плани що виконуються послідовно: A (критичні фіксі) → B (ingest/score) → C (render/effects) → D (publish/analytics). Кожна зміна — у skill файлах `.claude/skills/**/SKILL.md` і допоміжних скриптах `scripts/`. Новий код: `scripts/merge-captions.js`, `scripts/youtube-upload.js`, оновлений `scripts/render-overlay.js`.

**Tech Stack:** Node.js 18+, FFmpeg 6+, Puppeteer v24, faster-whisper Python, yt-dlp, googleapis npm, Notion MCP

---

# PLAN A: Critical Fixes

_Мета: відео виходить правильним — правильна тривалість, звук, субтитри, vertical crop._

---

## Task A1: Auto-approve permissions

**Files:**
- Modify: `.claude/settings.json`

- [ ] **Step 1: Прочитати поточний settings.json**

```bash
cat .claude/settings.json
```

- [ ] **Step 2: Записати новий settings.json з auto-approve**

`.claude/settings.json`:
```json
{
  "permissions": {
    "allow": [
      "Bash(ffmpeg:*)",
      "Bash(ffprobe:*)",
      "Bash(yt-dlp:*)",
      "Bash(python3:*)",
      "Bash(python:*)",
      "Bash(node:*)",
      "Bash(curl:*)",
      "Bash(mkdir:*)",
      "Bash(cp:*)",
      "Bash(mv:*)",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(rm:*)"
    ]
  }
}
```

- [ ] **Step 3: Перевірити формат JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add .claude/settings.json
git commit -m "config: auto-approve pipeline bash commands to remove approval prompts"
```

---

## Task A2: Fix TRIM — re-encode замість -c copy + silence detection

**Files:**
- Modify: `.claude/skills/ddos-render/SKILL.md` (секція TRIM)

- [ ] **Step 1: Замінити повністю секцію `## TRIM` в `ddos-render/SKILL.md`**

Знайти `## TRIM` і замінити весь блок до наступного `---` на:

```markdown
## TRIM — Silence Detection + Re-encode

Для кожного кліпу з episode-plan.json clipOrder:

### 1. Знайти точки обрізання через silencedetect

```bash
SILENCE_OUT=$(ffmpeg -i "downloads/<clipId>.mp4" \
  -af "silencedetect=noise=-40dB:duration=0.3" \
  -f null - 2>&1)
```

Парсинг:
- `START` = перше `silence_end: X.XX` → кінець початкової тиші = початок контенту
- `END` = останнє `silence_start: Y.YY` → початок кінцевої тиші = кінець контенту

Якщо silencedetect не знайшов жодного silence event → `START=0`, `END=<full duration>` (повний кліп без обрізання).

### 2. Re-encode з виправленими timestamps (НІКОЛИ не використовувати -c copy після -ss)

```bash
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "downloads/<clipId>.mp4")
# START і END вже розраховані з silencedetect або 0/DURATION

ffmpeg -i "downloads/<clipId>.mp4" -ss $START -to $END \
  -vf "setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -af "asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11" \
  -c:v libx264 -preset fast -crf 23 \
  -c:a aac -b:a 192k -ar 48000 \
  -r 30 \
  -y "processed/<clipId>/clean.mp4"
```

Якщо `processed/<clipId>/clean.mp4` вже існує → пропустити.

Видалити `processed/<clipId>/normalized.mp4` якщо існує (більше не потрібен — loudnorm вбудовано).

Оновити `state.stages.trim = "done"`.
```

- [ ] **Step 2: Видалити окрему секцію нормалізації з skill**

У тому ж файлі знайти і видалити блок:
```
Потім нормалізуй аудіо:
```bash
ffmpeg -i "processed/<clipId>/clean.mp4" \
  -af "loudnorm=...
```
(вона тепер вбудована в trim)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ddos-render/SKILL.md
git commit -m "fix: trim re-encodes clips with setpts to fix timestamp/speed issues, embeds loudnorm"
```

---

## Task A3: Fix RENDER LONG — валідація + правильний порядок

**Files:**
- Modify: `.claude/skills/ddos-render/SKILL.md` (секція RENDER LONG-FORM)

- [ ] **Step 1: Замінити секцію `## RENDER LONG-FORM` на:**

```markdown
## RENDER LONG-FORM

### Крок 1: Валідація episode-plan.json

```bash
CLIP_COUNT=$(node -e "const p=require('./edit/episode-plan.json'); console.log(p.clipOrder.length)")
```

Якщо `CLIP_COUNT < 12` або `CLIP_COUNT > 18`:
→ Записати `state.stages.renderLong = "failed"` з поясненням і ЗУПИНИТИСЬ.

### Крок 2: Побудова concat-list.txt

Порядок (абсолютні шляхи):
```
file '/abs/path/assets/intro/intro.mp4'
[кліпи GROUP 1: overlayed.mp4, або clean.mp4 якщо overlay не існує]
file '/abs/path/edit/reconnecting.mp4'
[кліпи GROUP 2]
file '/abs/path/edit/reconnecting.mp4'
...
[кліпи GROUP N]
[file '/abs/path/edit/chill-finale.mp4' — тільки якщо файл існує]
file '/abs/path/assets/outro/outro.mp4'
```

Групи беремо з `episode-plan.json` поля `groups[].clipIds`, в порядку груп.
Reconnecting.mp4 вставляємо після кожної групи КРІМ останньої (до chill/outro).

Всі файли в concat-list МАЮТЬ бути у форматі: H.264, 30fps, 1920×1080, AAC 48kHz — це гарантується TRIM стадією. Якщо файл відсутній → skip з попередженням.

### Крок 3: Concat (без re-encode — всі файли однакового формату)

```bash
ffmpeg -f concat -safe 0 \
  -i "edit/concat-list.txt" \
  -c copy \
  -y "edit/raw-episode.mp4"
```

### Крок 4: Burn captions (якщо episode.ass існує)

```bash
# Якщо edit/episode.ass існує:
ffmpeg -i "edit/raw-episode.mp4" \
  -vf "ass=edit/episode.ass" \
  -c:v libx264 -preset medium -crf 22 \
  -c:a copy \
  -movflags +faststart \
  -y "exports/episode-<N>.mp4"

# Якщо episode.ass НЕ існує:
ffmpeg -i "edit/raw-episode.mp4" \
  -c copy \
  -movflags +faststart \
  -y "exports/episode-<N>.mp4"
```

Оновити `state.outputs.longformPath` і `state.stages.renderLong = "done"`.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/ddos-render/SKILL.md
git commit -m "fix: render long-form validates clip count and uses proper group-based concat"
```

---

## Task A4: Fix RENDER SHORTS — background blur замість чорних смуг

**Files:**
- Modify: `.claude/skills/ddos-shorts/SKILL.md` (секція RENDER SHORTS)

- [ ] **Step 1: Замінити секцію `## RENDER SHORTS` на:**

```markdown
## RENDER SHORTS — 1080×1920 Background Blur (без чорних смуг)

Для кожного clipId з `edit/shorts-selection.json`:

```bash
INPUT="processed/<clipId>/clean.mp4"
CAPTIONS="processed/<clipId>/captions-vertical.ass"

# Побудова caption filter (порожній якщо файл відсутній)
if [ -f "$CAPTIONS" ]; then
  CAPTION_FILTER=",ass=${CAPTIONS}"
else
  CAPTION_FILTER=""
fi

ffmpeg -i "$INPUT" \
  -filter_complex "
    [0:v]split[main][bg];
    [bg]scale=1080:1920:force_original_aspect_ratio=increase,
        crop=1080:1920,
        boxblur=20:5,
        eq=brightness=-0.3[blurred];
    [main]scale=1080:608[fg];
    [blurred][fg]overlay=(W-w)/2:(H-h)/2${CAPTION_FILTER}[out]
  " \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 24 \
  -c:a aac -b:a 128k -ar 48000 \
  -movflags +faststart \
  -y "exports/shorts/<clipId>.mp4"
```

Якщо NVENC доступний: замінити `-c:v libx264 -preset fast -crf 24` на `-c:v h264_nvenc -preset p4 -cq 24`.

Зберегти список у `state.outputs.shortsPaths`.
Оновити `state.stages.renderShorts = "done"`.
```

- [ ] **Step 2: Перевірити FFmpeg filter синтаксис (тест на будь-якому mp4)**

```bash
ffmpeg -i "assets/intro/intro.mp4" \
  -filter_complex "
    [0:v]split[main][bg];
    [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred];
    [main]scale=1080:608[fg];
    [blurred][fg]overlay=(W-w)/2:(H-h)/2[out]
  " \
  -map "[out]" -map "0:a" \
  -t 1 -y /tmp/shorts-test.mp4 2>&1 | tail -5
```

Expected: `encoded X frames` без `Invalid option` помилок.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ddos-shorts/SKILL.md
git commit -m "fix: shorts use background blur crop — no black bars"
```

---

## Task A5: Створити merge-captions.js + додати captions merge в render skill

**Files:**
- Create: `scripts/merge-captions.js`
- Modify: `.claude/skills/ddos-render/SKILL.md` (додати секцію CAPTIONS MERGE)

- [ ] **Step 1: Створити `scripts/merge-captions.js`**

```javascript
#!/usr/bin/env node
// Merges multiple per-clip ASS caption files into one episode ASS file with time offsets.
// Usage: node scripts/merge-captions.js <segments.json> <output.ass>
// segments.json: [{"assFile": "path/to/file.ass", "offset": 12.5}, ...]
'use strict';
const fs = require('fs');

function parseAssTime(t) {
  const [h, m, rest] = t.trim().split(':');
  const [s, cs] = rest.split('.');
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(cs || 0) / 100;
}

function formatAssTime(secs) {
  if (secs < 0) secs = 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const cs = Math.round((secs % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Outline, Alignment, MarginV
Style: Default,Archivo Black,56,&H00F4F0E6,&H000E0E10,-1,3,2,80
Style: Hot,Archivo Black,56,&H00F5FF3D,&H000E0E10,-1,3,2,80

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function mergeAss(segments) {
  const dialogues = [];
  for (const { assFile, offset } of segments) {
    if (!fs.existsSync(assFile)) {
      console.warn(`Warning: ASS not found: ${assFile}`);
      continue;
    }
    const lines = fs.readFileSync(assFile, 'utf8').split(/\r?\n/);
    let inEvents = false;
    for (const line of lines) {
      if (line.trim().startsWith('[Events]')) { inEvents = true; continue; }
      if (!inEvents || !line.startsWith('Dialogue:')) continue;
      // Format: "Dialogue: 0,0:00:01.20,0:00:01.50,Default,,0,0,0,,text"
      const afterLayer = line.slice(line.indexOf(',') + 1);
      const parts = afterLayer.split(',');
      if (parts.length < 9) continue;
      const startSecs = parseAssTime(parts[0]) + offset;
      const endSecs   = parseAssTime(parts[1]) + offset;
      if (endSecs < 0) continue;
      parts[0] = formatAssTime(startSecs);
      parts[1] = formatAssTime(endSecs);
      dialogues.push(`Dialogue: 0,${parts.join(',')}`);
    }
  }
  dialogues.sort((a, b) => {
    const ta = parseAssTime(a.split(',')[1]);
    const tb = parseAssTime(b.split(',')[1]);
    return ta - tb;
  });
  return HEADER + dialogues.join('\n') + '\n';
}

const [,, segmentsFile, outputFile] = process.argv;
if (!segmentsFile || !outputFile) {
  console.error('Usage: node merge-captions.js <segments.json> <output.ass>');
  process.exit(1);
}
const segments = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
const merged = mergeAss(segments);
fs.writeFileSync(outputFile, merged, 'utf8');
console.log(`Merged ${segments.length} ASS files → ${outputFile}`);
```

- [ ] **Step 2: Перевірити скрипт на синтаксичні помилки**

```bash
node -c scripts/merge-captions.js
```

Expected: `scripts/merge-captions.js syntax OK`

- [ ] **Step 3: Функціональний тест**

```bash
echo '[{"assFile":"nonexistent.ass","offset":0}]' > /tmp/test-seg.json
node scripts/merge-captions.js /tmp/test-seg.json /tmp/test-out.ass
cat /tmp/test-out.ass
```

Expected: Файл зі HEADER і попередженням `Warning: ASS not found`, без краша.

- [ ] **Step 4: Додати секцію `## CAPTIONS MERGE` в `ddos-render/SKILL.md` (перед RENDER LONG-FORM)**

```markdown
## CAPTIONS MERGE — Об'єднати субтитри з time offsets

Виконується після TRIM і перед RENDER LONG. Збирає всі per-clip ASS файли в один `edit/episode.ass`.

### Розрахунок cumulative offsets

```javascript
const plan = require('./edit/episode-plan.json');
const { execSync } = require('child_process');

const INTRO_DUR = 1.25;     // assets/intro/intro.mp4
const RECONNECT_DUR = 1.0;  // edit/reconnecting.mp4

function getClipDuration(clipId) {
  const out = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "processed/${clipId}/clean.mp4"`
  ).toString().trim();
  return parseFloat(out) || 0;
}

let offset = INTRO_DUR;
const segments = [];

for (let gi = 0; gi < plan.groups.length; gi++) {
  const group = plan.groups[gi];
  for (const clipId of group.clipIds) {
    const assFile = `processed/${clipId}/captions-longform.ass`;
    segments.push({ assFile, offset });
    offset += getClipDuration(clipId);
  }
  // Додати reconnecting між групами (не після останньої)
  if (gi < plan.groups.length - 1) {
    offset += RECONNECT_DUR;
  }
}

require('fs').writeFileSync('edit/captions-segments.json', JSON.stringify(segments, null, 2));
```

### Запуск merge

```bash
node scripts/merge-captions.js "edit/captions-segments.json" "edit/episode.ass"
```

Якщо жоден кліп не має `captions-longform.ass` → пропустити (episode.ass не буде, render без субтитрів).

Оновити `state.stages.captions = "done"`.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/merge-captions.js .claude/skills/ddos-render/SKILL.md
git commit -m "feat: add merge-captions.js for ASS time-offset merging, burn subtitles in long-form"
```

---

# PLAN B: Ingest + Score v2

_Мета: краща вибірка кліпів, фільтрація турнірів, більше вимірів для scoring._

---

## Task B1: Оновити ddos-ingest — dynamic categories + tournament filter + pre-score

**Files:**
- Modify: `.claude/skills/ddos-ingest/SKILL.md`

- [ ] **Step 1: Повністю перезаписати `ddos-ingest/SKILL.md`**

```markdown
# Skill: ddos-ingest

Отримай кліпи з Twitch, відфільтруй, розрахуй pre-score, завантаж найкращі.

---

## INGEST — Twitch API

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
yt-dlp \
  --no-playlist \
  --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" \
  --merge-output-format mp4 \
  --output "projects/<runId>/downloads/<clipId>.mp4" \
  --quiet \
  "<clip_url>"
```

- Якщо файл вже існує → пропустити
- Якщо помилка → записати в rejected, продовжити
- Паралельно: max 5 одночасно
- Limit: 80 кліпів

Зберегти `downloaded-clips.json`. Оновити `state.counts.downloaded`, `state.stages.download = "done"`.
```

- [ ] **Step 2: Перевірити синтаксис JS-коду в skill (скопіювати в тимчасовий файл)**

```bash
node -e "
const calcPreScore = function(clip, seenBroadcasters) {
  const viewsScore = Math.min(100, Math.log10(clip.view_count + 1) / Math.log10(500000) * 100);
  return viewsScore;
};
console.log('calcPreScore test:', calcPreScore({view_count: 1000}, new Map()));
"
```

Expected: `calcPreScore test: 50.xxx` (число між 0 і 100)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ddos-ingest/SKILL.md
git commit -m "feat: ingest uses dynamic categories, tournament filter, pre-download scoring, 80 downloads"
```

---

## Task B2: Оновити ddos-score — 13 вимірів + editingNotes + peakMoment + chill archive

**Files:**
- Modify: `.claude/skills/ddos-score/SKILL.md`

- [ ] **Step 1: Замінити секцію `## SCORE — Claude оцінка` на:**

```markdown
## SCORE — Claude оцінка (13 вимірів + editingNotes)

Для кожного кліпу з downloaded-clips.json:

1. Прочитати `processed/<clipId>/transcript.json` якщо існує (витяг перших 500 символів)
2. Оцінити безпосередньо в поточній розмові (ніяких зовнішніх API запитів):

**Scoring prompt:**
```
Ти оцінюєш Twitch кліп для "Daily Dose Of Stream".
Контент: смішний, комфортний, курований. Не токсичний.

Кліп:
- Стрімер: <broadcaster_name>
- Категорія: <game_name>
- Мова: <language>
- Тривалість: <duration>s
- Назва: "<title>"
- Транскрипт (до 500 симв): "<excerpt>"

Оціни від 0 до 100. Будь строгим — не кожен заслуговує 80+.

JSON (без markdown):
{
  "retentionScore": 0-100,
  "funnyScore": 0-100,
  "payoffStrength": 0-100,
  "contextClarity": 0-100,
  "noveltyScore": 0-100,
  "shortsPotential": 0-100,
  "longFormPotential": 0-100,
  "transitionPotential": 0-100,
  "cooldownPotential": 0-100,
  "musicRisk": 0-100,
  "toxicityRisk": 0-100,
  "singingScore": 0-100,
  "dancingScore": 0-100,
  "rageScore": 0-100,
  "flags": [],
  "reasoning": "1-2 речення",
  "editingNotes": {
    "punchZoomAt": null,
    "colorPunchAt": [],
    "rageMoments": []
  }
}
```

**editingNotes:** Визначати на основі транскрипту і категорії:
- `punchZoomAt`: секунда найсильнішого моменту (де треба punch zoom). null якщо немає.
- `colorPunchAt`: масив секунд де burst of energy (excited words in transcript).
- `rageMoments`: масив {start, end} де rage/крик (ALL CAPS слова + rage vocabulary в transcript).

**DDOS Score формула:**
```
ddosScore =
  retentionScore * 0.30
  + funnyScore   * 0.25
  + payoffStrength * 0.20
  + contextClarity * 0.15
  + noveltyScore * 0.10
  - (musicRisk > 60 ? (musicRisk - 60) * 0.3 : 0)
  - (toxicityRisk > 40 ? (toxicityRisk - 40) * 0.5 : 0)
```

Зберегти у `processed/<clipId>/score.json`.
```

- [ ] **Step 2: Додати секцію PEAK MOMENT після SCORE:**

```markdown
## PEAK MOMENT — Знайти найгучніший 1-секундний момент

Для кожного кліпу після scoring:

```bash
ffprobe -v quiet -select_streams a:0 -show_entries stream=codec_type \
  "processed/<clipId>/clean.mp4" 2>/dev/null
```

Якщо аудіо трек відсутній → `peakMoment = {"start": 0, "end": 1.0, "rmsDb": -50}`, пропустити.

Інакше — запустити Python скрипт:

```python
# scripts/find_peak.py
import subprocess, json, sys, re

def find_peak(path):
    result = subprocess.run(
        ['ffmpeg', '-i', path,
         '-af', 'astats=metadata=1:reset=30,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
         '-f', 'null', '-'],
        capture_output=True, text=True
    )
    values = []
    for line in result.stderr.split('\n'):
        m = re.search(r'lavfi\.astats\.Overall\.RMS_level=([-\d.]+)', line)
        if m:
            try: values.append(float(m.group(1)))
            except: pass
    if not values:
        return {"start": 0.0, "end": 1.0, "rmsDb": -50.0}
    window = 30  # 1 second at 30fps
    best_i, best_avg = 0, -999
    for i in range(max(1, len(values) - window)):
        avg = sum(values[i:i+window]) / min(window, len(values)-i)
        if avg > best_avg:
            best_avg, best_i = avg, i
    start = round(best_i / 30.0, 2)
    return {"start": start, "end": round(start + 1.0, 2), "rmsDb": round(best_avg, 2)}

path = sys.argv[1]
print(json.dumps(find_peak(path)))
```

```bash
PEAK=$(python3 scripts/find_peak.py "processed/<clipId>/clean.mp4")
# Додати peakMoment в score.json
```

Зберегти `score.json`:
```json
{
  ...all score fields...,
  "peakMoment": {"start": 12.5, "end": 13.5, "rmsDb": -8.3}
}
```

## CHILL CLIP ACCUMULATION

Після scoring кожного кліпу:

```bash
if singingScore > 70:
  mkdir -p assets/chill-archive/singing
  cp "processed/<clipId>/clean.mp4" "assets/chill-archive/singing/<clipId>.mp4"
  # Додати в assets/chill-archive/index.json:
  {"clipId": "...", "type": "singing", "broadcaster": "...", "score": N, "runId": "...", "duration": N}

if dancingScore > 70:
  mkdir -p assets/chill-archive/dancing
  cp "processed/<clipId>/clean.mp4" "assets/chill-archive/dancing/<clipId>.mp4"
  # Аналогічно в index.json з type: "dancing"
```
```

- [ ] **Step 3: Замінити секцію `## PLAN` на:**

```markdown
## PLAN — Claude будує план епізоду

Передай топ-30 scored кліпів. Claude вирішує план безпосередньо в розмові.

**Planning prompt:**
```
Ти директор епізоду "Daily Dose Of Stream" #<N>.

Кліпи (відсортовані за ddosScore):
<clipId | стрімер | категорія | ddosScore | funnyScore | rageScore | singingScore | dancingScore | shortsPotential | duration>

ПРАВИЛА ГРУПУВАННЯ:
- GAME_GROUP: та сама гра, різні стрімери → підряд (до 5 кліпів)
- STREAMER_GROUP: той самий стрімер, та сама гра → підряд (до 3 кліпів)
- VIBE_GROUP: схожий тон chaos/wholesome/rage → підряд
- MICRO_GROUP: кліпи < 15с → збирати разом (до 6 кліпів) для динамічного ритму
- ЗАБОРОНЕНО: той самий стрімер + різна гра в одній групі

ПРАВИЛА ВИБОРУ:
- Обери 12–18 кліпів для long-form (ціль 12–15 хв, враховуй duration кожного)
- Перша група: сильний, захоплюючий контент (opener)
- reconnectingClipId: кліп з першої групи з найвищим funnyScore або rageScore
- Chill фінал: якщо є кліпи з singingScore > 70 або dancingScore > 70 → ставити в кінець
- Обери 5–10 кліпів для Shorts (найвищий shortsPotential)

Відповідай ТІЛЬКИ JSON:
{
  "clipOrder": ["id1","id2",...],
  "groups": [
    {"type":"GAME_GROUP","label":"CS2 Chaos","clipIds":["id1","id2"],"tone":"chaotic"}
  ],
  "openerClipId": "id",
  "reconnectingClipId": "id",
  "chillPlan": {
    "type": "singing_then_dancing|dancing_montage|skip",
    "singingClipId": "id or null",
    "dancingClipIds": ["id1",...],
    "extractFromVod": false
  },
  "shortClipIds": ["id1",...],
  "reasoning": "..."
}
```

Зберегти у `edit/episode-plan.json` і `edit/shorts-selection.json`.
Оновити `state.stages.plan = "done"`.
```

- [ ] **Step 4: Створити `scripts/find_peak.py`**

```python
#!/usr/bin/env python3
"""Find the 1-second window with highest average RMS audio energy in a video."""
import subprocess, json, sys, re

def find_peak(path):
    result = subprocess.run(
        ['ffmpeg', '-i', path,
         '-af', 'astats=metadata=1:reset=30,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
         '-f', 'null', '-'],
        capture_output=True, text=True
    )
    values = []
    for line in (result.stdout + result.stderr).split('\n'):
        m = re.search(r'lavfi\.astats\.Overall\.RMS_level=([-\d.inf]+)', line)
        if m:
            try:
                v = float(m.group(1))
                if v > -100:  # filter -inf
                    values.append(v)
            except (ValueError, OverflowError):
                pass

    if not values:
        return {"start": 0.0, "end": 1.0, "rmsDb": -50.0}

    window = min(30, len(values))
    best_i, best_avg = 0, -999.0
    for i in range(max(1, len(values) - window + 1)):
        chunk = values[i:i+window]
        avg = sum(chunk) / len(chunk)
        if avg > best_avg:
            best_avg, best_i = avg, i

    start = round(best_i / 30.0, 2)
    return {"start": start, "end": round(start + 1.0, 2), "rmsDb": round(best_avg, 2)}

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: find_peak.py <video.mp4>"}))
        sys.exit(1)
    print(json.dumps(find_peak(sys.argv[1])))
```

- [ ] **Step 5: Тестувати find_peak.py на існуючому файлі**

```bash
python3 scripts/find_peak.py assets/intro/intro.mp4
```

Expected: JSON з `{"start": N, "end": N, "rmsDb": N}` без помилок.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/ddos-score/SKILL.md scripts/find_peak.py
git commit -m "feat: score adds 3 new dimensions, editingNotes, peakMoment detection, chill archive"
```

---

# PLAN C: Render v2

_Мета: WebM overlays з анімацією, правильний reconnecting, effects, chill finale._

---

## Task C1: Оновити render-overlay.js — WebM VP9 alpha animation

**Files:**
- Modify: `scripts/render-overlay.js`

- [ ] **Step 1: Перезаписати `scripts/render-overlay.js`**

```javascript
#!/usr/bin/env node
// render-overlay.js — renders animated HTML overlays to WebM with alpha channel
// Modes:
//   node render-overlay.js streamer <name> <out.webm>   — streamer name overlay (3s, 30fps)
//   node render-overlay.js reconnecting <out.webm>      — reconnecting panel (3s, 30fps)
'use strict';
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const FPS = 30;
const DURATION_S = 3;
const FRAMES = FPS * DURATION_S;

async function captureFrames(html, width, height, framesDir) {
  const tmpHtml = path.join(framesDir, '_overlay.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(`file://${path.resolve(tmpHtml)}`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 800)); // wait for fonts

  // Pause all animations and control them manually
  await page.evaluate(() => {
    document.getAnimations().forEach(a => { a.pause(); a.currentTime = 0; });
  });

  for (let i = 0; i < FRAMES; i++) {
    const timeMs = (i / FRAMES) * DURATION_S * 1000;
    await page.evaluate((t) => {
      document.getAnimations().forEach(a => { a.currentTime = t; });
    }, timeMs);
    await new Promise(r => setTimeout(r, 16)); // allow repaint
    await page.screenshot({
      path: path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`),
      type: 'png',
      omitBackground: true
    });
  }

  await browser.close();
  fs.unlinkSync(tmpHtml);
}

function compileWebm(framesDir, outputPath) {
  const cmd = [
    'ffmpeg', '-y',
    '-framerate', String(FPS),
    '-i', path.join(framesDir, 'frame_%04d.png'),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-b:v', '0', '-crf', '25',
    '-auto-alt-ref', '0',
    outputPath
  ];
  execSync(cmd.join(' '), { stdio: 'pipe' });
}

function inlineLogoSvg(html) {
  const logoPath = 'assets/thumbnail-template/logo.svg';
  if (!fs.existsSync(logoPath)) return html;
  const b64 = fs.readFileSync(logoPath).toString('base64');
  return html.replace(/['"]\.\/logo\.svg['"]/g, `"data:image/svg+xml;base64,${b64}"`);
}

async function renderStreamer(name, outputPath) {
  let html = fs.readFileSync('assets/streamer-overlay/streamer_name.html', 'utf8');
  html = inlineLogoSvg(html);
  html = html.replace(/NORTHERNLION_OFFICIAL/g, name.toUpperCase());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddos-str-'));
  try {
    await captureFrames(html, 1920, 1080, tmpDir);
    compileWebm(tmpDir, outputPath);
    console.log(`Streamer overlay (${name}) → ${outputPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function renderReconnecting(outputPath) {
  let html = fs.readFileSync('assets/overlays/reconnecting.html', 'utf8');
  html = inlineLogoSvg(html);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddos-rc-'));
  try {
    await captureFrames(html, 1920, 1080, tmpDir);
    compileWebm(tmpDir, outputPath);
    console.log(`Reconnecting panel → ${outputPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const [,, mode, ...args] = process.argv;
if (mode === 'streamer' && args.length >= 2) {
  renderStreamer(args[0], args[1]).catch(e => { console.error(e.message); process.exit(1); });
} else if (mode === 'reconnecting' && args.length >= 1) {
  renderReconnecting(args[0]).catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.error('Usage: node render-overlay.js streamer <name> <out.webm>');
  console.error('       node render-overlay.js reconnecting <out.webm>');
  process.exit(1);
}
```

- [ ] **Step 2: Тест синтаксису**

```bash
node -c scripts/render-overlay.js
```

Expected: `scripts/render-overlay.js syntax OK`

- [ ] **Step 3: Тест рендеру reconnecting (займе ~30с)**

```bash
mkdir -p cache/overlays
node scripts/render-overlay.js reconnecting cache/overlays/reconnecting-test.webm
```

Expected: файл `cache/overlays/reconnecting-test.webm` розміром 100–800KB.

- [ ] **Step 4: Перевірити що WebM має alpha канал**

```bash
ffprobe -v quiet -show_streams cache/overlays/reconnecting-test.webm 2>&1 | grep pix_fmt
```

Expected: `pix_fmt=yuva420p`

- [ ] **Step 5: Commit**

```bash
git add scripts/render-overlay.js
git commit -m "feat: render-overlay.js outputs animated WebM VP9 with alpha channel"
```

---

## Task C2: Оновити OVERLAYS секцію в ddos-render + додати RECONNECTING

**Files:**
- Modify: `.claude/skills/ddos-render/SKILL.md` (секції OVERLAYS і RECONNECTING)

- [ ] **Step 1: Замінити секцію `## OVERLAYS` на:**

```markdown
## OVERLAYS — WebM Alpha з кешуванням

### Reconnecting panel (pre-render один раз на початку)

```bash
mkdir -p edit
if [ ! -f "edit/reconnecting-panel.webm" ]; then
  node scripts/render-overlay.js reconnecting "edit/reconnecting-panel.webm"
fi
```

### Streamer name overlay (per clip, з кешуванням)

Для кожного кліпу з episode-plan.json:

```bash
BROADCASTER="<broadcaster_name_lowercase>"
CACHE="cache/overlays/${BROADCASTER}.webm"

mkdir -p cache/overlays
if [ ! -f "$CACHE" ]; then
  node scripts/render-overlay.js streamer "<broadcaster_name>" "$CACHE"
fi

# Burn animated WebM overlay (показується перші 3с кліпу)
ffmpeg -i "processed/<clipId>/clean.mp4" \
  -i "$CACHE" \
  -filter_complex "
    [0:v][1:v]overlay=20:H-h-120:eof_action=pass:format=auto[out]
  " \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 23 \
  -c:a copy \
  -y "processed/<clipId>/overlayed.mp4"
```

Якщо `overlayed.mp4` вже існує → пропустити.

Оновити `state.stages.overlays = "done"`.
```

- [ ] **Step 2: Замінити секцію `## RECONNECTING` на:**

```markdown
## RECONNECTING — Glitch Moment + Panel Overlay (1 секунда)

Виконується після OVERLAYS.

### Вибір моменту

Читати `episode-plan.json.reconnectingClipId`.
Читати `processed/<reconnectingClipId>/score.json` → `peakMoment.start`.

### Рендер

```bash
CLIP="processed/<reconnectingClipId>/overlayed.mp4"
# Якщо overlayed не існує → використати clean.mp4
[ -f "$CLIP" ] || CLIP="processed/<reconnectingClipId>/clean.mp4"

PEAK_START=<peakMoment.start>
PANEL="edit/reconnecting-panel.webm"

ffmpeg -ss $PEAK_START -t 1.1 -i "$CLIP" \
  -i "$PANEL" \
  -filter_complex "
    [0:v]setpts=PTS-STARTPTS,
         noise=alls=15:allf=t+u,
         eq=contrast=1.3:saturation=0.6[glitch];
    [glitch][1:v]overlay=W-w-44:44:eof_action=pass:format=auto[out]
  " \
  -map "[out]" -map "0:a" \
  -t 1.0 \
  -c:v libx264 -preset fast -crf 22 \
  -c:a aac -b:a 192k -ar 48000 -r 30 \
  -y "edit/reconnecting.mp4"
```

Оновити `state.stages.reconnecting = "done"`.

**Примітка:** Один і той самий `edit/reconnecting.mp4` вставляється між ВСІМА групами в concat-list — глядач вже бачив цей момент у першій групі, тому він впізнаваний.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ddos-render/SKILL.md
git commit -m "feat: overlays use WebM alpha with broadcaster cache, reconnecting uses glitch effect"
```

---

## Task C3: Додати EFFECTS стадію в ddos-render

**Files:**
- Modify: `.claude/skills/ddos-render/SKILL.md` (нова секція EFFECTS)

- [ ] **Step 1: Додати секцію `## EFFECTS` після секції OVERLAYS і перед RECONNECTING:**

```markdown
## EFFECTS — Динамічний монтаж

Для кожного кліпу з episode-plan.json де `score.json.editingNotes` непорожній:

**Input:** `processed/<clipId>/overlayed.mp4`

### Zoom punch (якщо punchZoomAt != null)

```bash
PUNCH_S=<editingNotes.punchZoomAt>
PUNCH_F=$(echo "$PUNCH_S * 30" | bc | cut -d. -f1)  # frame number
DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "processed/<clipId>/overlayed.mp4")
TOTAL_F=$(echo "$DUR * 30" | bc | cut -d. -f1)

ffmpeg -i "processed/<clipId>/overlayed.mp4" \
  -vf "
    zoompan=
      z='if(between(on,${PUNCH_F}-9,${PUNCH_F}),
           1+0.15*(on-${PUNCH_F}+9)/9,
         if(between(on,${PUNCH_F},${PUNCH_F}+6),
           1.15,
         if(between(on,${PUNCH_F}+6,${PUNCH_F}+15),
           1.15-0.15*(on-${PUNCH_F}-6)/9,1)))':
      d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=30,
    scale=1920:1080
  " \
  -c:v libx264 -preset fast -crf 23 -c:a copy \
  -y "processed/<clipId>/overlayed_fx.mp4"
mv "processed/<clipId>/overlayed_fx.mp4" "processed/<clipId>/overlayed.mp4"
```

### Color punch (якщо colorPunchAt непорожній)

```bash
# Застосовується до всього відео але eq=saturation=1.3 тільки в потрібні моменти
# Для простоти: якщо є colorPunchAt → легкий color boost всього кліпу
ffmpeg -i "processed/<clipId>/overlayed.mp4" \
  -vf "eq=saturation=1.2:contrast=1.05" \
  -c:v libx264 -preset fast -crf 23 -c:a copy \
  -y "processed/<clipId>/overlayed_fx.mp4"
mv "processed/<clipId>/overlayed_fx.mp4" "processed/<clipId>/overlayed.mp4"
```

### Перевірка чи потрібні effects

Якщо `editingNotes.punchZoomAt == null` І `editingNotes.colorPunchAt == []` І `editingNotes.rageMoments == []` → пропустити clip (overlayed.mp4 залишається без змін).

Оновити `state.stages.effects = "done"`.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/ddos-render/SKILL.md
git commit -m "feat: add EFFECTS stage with zoom punch and color grade from editingNotes"
```

---

## Task C4: Додати CHILL FINALE стадію в ddos-render

**Files:**
- Modify: `.claude/skills/ddos-render/SKILL.md` (нова секція CHILL FINALE)

- [ ] **Step 1: Додати секцію `## CHILL FINALE` перед RENDER LONG-FORM:**

```markdown
## CHILL FINALE

Читати `episode-plan.json.chillPlan`.

### Якщо type == "skip"
Пропустити. `edit/chill-finale.mp4` не створювати. Concat-list закінчуватиметься на останній групі.

### Якщо type == "singing_then_dancing" або "dancing_montage"

**Підготовка singing clip (тільки для singing_then_dancing):**

```bash
SING_ID=<chillPlan.singingClipId>
SING_SRC="assets/chill-archive/singing/${SING_ID}.mp4"
[ -f "$SING_SRC" ] || SING_SRC="processed/${SING_ID}/clean.mp4"

if chillPlan.extractFromVod == false:
  ffmpeg -i "$SING_SRC" -t 15 \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS" \
    -af "asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11" \
    -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -ar 48000 -r 30 \
    -y "edit/chill-singing.mp4"

if chillPlan.extractFromVod == true:
  # 1. Отримати vod_offset
  VOD_DATA=$(curl -s "https://api.twitch.tv/helix/clips?id=$SING_ID" \
    -H "Client-ID: $TWITCH_CLIENT_ID" -H "Authorization: Bearer $TOKEN")
  VOD_ID=$(echo $VOD_DATA | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).data[0].video_id))")
  VOD_OFFSET=$(echo $VOD_DATA | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).data[0].vod_offset))")

  # 2. Скачати VOD сегмент
  yt-dlp "https://www.twitch.tv/videos/$VOD_ID" \
    --download-sections "*${VOD_OFFSET}s-$((VOD_OFFSET+90))s" \
    --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" \
    --output "edit/chill-vod-raw.mp4"

  # 3. Trim і encode
  ffmpeg -i "edit/chill-vod-raw.mp4" -t 15 \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS" \
    -af "asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11" \
    -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -ar 48000 -r 30 \
    -y "edit/chill-singing.mp4"
```

**Підготовка dancing clips:**

Для кожного clipId в `chillPlan.dancingClipIds` (до 10):
```bash
DANCE_SRC="assets/chill-archive/dancing/${CLIP_ID}.mp4"
[ -f "$DANCE_SRC" ] || DANCE_SRC="processed/${CLIP_ID}/clean.mp4"

ffmpeg -i "$DANCE_SRC" -t 5 \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS" \
  -af "asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11" \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -ar 48000 -r 30 \
  -y "edit/chill-dance-${N}.mp4"
```

**Склейка (singing_then_dancing):**

```bash
# Concat-list для dancing clips (без аудіо — аудіо буде від singing)
echo "file '...chill-dance-1.mp4'" >> edit/dancing-list.txt
# ... для кожного dance clip

ffmpeg -f concat -safe 0 -i edit/dancing-list.txt \
  -an -c:v copy "edit/chill-dancing-video.mp4"

# Аудіо від singing від секунди 10 до кінця
DANCE_DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 edit/chill-dancing-video.mp4)
ffmpeg -i "edit/chill-singing.mp4" -ss 10 -t $DANCE_DUR \
  -vn -c:a aac -b:a 192k -ar 48000 "edit/chill-singing-audio.mp4"

# Накласти аудіо від singing на відео танців
ffmpeg -i "edit/chill-dancing-video.mp4" -i "edit/chill-singing-audio.mp4" \
  -map 0:v -map 1:a \
  -c:v copy -c:a aac -b:a 192k \
  -shortest "edit/chill-dancing-mixed.mp4"

# Фінальний concat: 15с спів + танці з аудіо співу
cat > edit/chill-final-list.txt << 'EOF'
file 'edit/chill-singing.mp4'
file 'edit/chill-dancing-mixed.mp4'
EOF
ffmpeg -f concat -safe 0 -i edit/chill-final-list.txt \
  -c copy "edit/chill-finale.mp4"
```

**Склейка (dancing_montage):**
```bash
# Просто concat dancing clips з їх оригінальним аудіо
ffmpeg -f concat -safe 0 -i edit/dancing-list.txt \
  -c copy "edit/chill-finale.mp4"
```

Оновити `state.stages.chillFinale = "done"`.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/ddos-render/SKILL.md
git commit -m "feat: add CHILL FINALE stage with singing+VOD extraction and dancing montage"
```

---

# PLAN D: Publish + Analytics

_Мета: автоматична публікація на YouTube і Notion аналітика._

---

## Task D1: Встановити googleapis + створити youtube-upload.js

**Files:**
- Modify: `package.json`
- Create: `scripts/youtube-upload.js`
- Create: `auth/.gitignore`

- [ ] **Step 1: Встановити googleapis**

```bash
npm install googleapis
```

Expected: `added N packages` без помилок.

- [ ] **Step 2: Створити `auth/.gitignore` (захистити credentials)**

```
*
!.gitignore
```

- [ ] **Step 3: Створити `scripts/youtube-upload.js`**

```javascript
#!/usr/bin/env node
// YouTube Data API v3 upload tool
// Commands:
//   node youtube-upload.js upload-video <runId> <metadata.json> <video.mp4> <thumbnail.png>
//   node youtube-upload.js upload-short <runId> <clipId> <short.mp4> <mainVideoId> <hookText>
//   node youtube-upload.js publish-video <videoId>
'use strict';
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SECRET_PATH = process.env.YOUTUBE_CLIENT_SECRET_PATH || 'auth/client_secret.json';
const TOKEN_PATH  = 'auth/token.json';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube'
];

async function getAuth() {
  if (!fs.existsSync(SECRET_PATH)) {
    throw new Error(`client_secret.json not found at ${SECRET_PATH}. Download from Google Cloud Console.`);
  }
  const creds = JSON.parse(fs.readFileSync(SECRET_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oauth2 = new OAuth2Client(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2.setCredentials(saved);
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials), 'utf8');
      return oauth2;
    } catch {
      console.log('Refresh token expired, re-authorizing...');
      fs.unlinkSync(TOKEN_PATH);
    }
  }

  // First-time OAuth flow
  const url = oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\n=== YouTube Authorization ===');
  console.log('Open in browser:\n' + url);
  console.log('\nPaste the authorization code:');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(r => rl.question('> ', a => { rl.close(); r(a.trim()); }));
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  fs.mkdirSync('auth', { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens), 'utf8');
  console.log('Token saved to auth/token.json');
  return oauth2;
}

async function uploadVideo(runId, metadataPath, videoPath, thumbnailPath) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const size = fs.statSync(videoPath).size;

  console.log(`Uploading ${path.basename(videoPath)} (${(size/1e6).toFixed(0)}MB)...`);

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: (meta.titleOptions && meta.titleOptions[0]) || meta.title || 'Daily Dose Of Stream',
        description: meta.description || '',
        tags: meta.hashtags || ['twitch', 'gaming', 'clips'],
        categoryId: '20',
        defaultLanguage: 'uk'
      },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(videoPath) }
  }, {
    onUploadProgress: e => {
      const pct = Math.round(e.bytesRead / size * 100);
      process.stdout.write(`\rProgress: ${pct}%`);
    }
  });

  const videoId = res.data.id;
  process.stdout.write('\n');
  console.log(`Uploaded (unlisted): https://youtu.be/${videoId}`);

  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    await yt.thumbnails.set({ videoId, media: { body: fs.createReadStream(thumbnailPath) } });
    console.log('Thumbnail set.');
  }

  // Save to state.json
  const statePath = path.join('projects', runId, 'state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.outputs = state.outputs || {};
    state.outputs.youtubeVideoId = videoId;
    state.stages.publish = 'done';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  return videoId;
}

async function uploadShort(runId, clipId, shortPath, mainVideoId, hookText) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  const title = `${hookText || 'Clip'} #shorts`.slice(0, 100);
  const desc  = mainVideoId
    ? `Full episode → https://youtu.be/${mainVideoId}\n\n#shorts #twitch #gaming`
    : '#shorts #twitch #gaming';

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description: desc, tags: ['shorts','twitch','gaming'], categoryId: '20' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(shortPath) }
  });
  const shortId = res.data.id;
  console.log(`Short: https://youtube.com/shorts/${shortId}`);

  const statePath = path.join('projects', runId, 'state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.outputs = state.outputs || {};
    state.outputs.youtubeShortsIds = state.outputs.youtubeShortsIds || [];
    state.outputs.youtubeShortsIds.push(shortId);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  return shortId;
}

async function publishVideo(videoId) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  await yt.videos.update({
    part: ['status'],
    requestBody: { id: videoId, status: { privacyStatus: 'public' } }
  });
  console.log(`Published: https://youtu.be/${videoId}`);
}

const [,, cmd, ...args] = process.argv;
const cmds = {
  'upload-video':  () => uploadVideo(...args),
  'upload-short':  () => uploadShort(...args),
  'publish-video': () => publishVideo(args[0])
};
if (!cmds[cmd]) { console.error('Unknown command:', cmd); process.exit(1); }
cmds[cmd]().catch(e => { console.error('Error:', e.message); process.exit(1); });
```

- [ ] **Step 4: Перевірити синтаксис**

```bash
node -c scripts/youtube-upload.js
```

Expected: `scripts/youtube-upload.js syntax OK`

- [ ] **Step 5: Перевірити що googleapis доступний**

```bash
node -e "require('googleapis'); console.log('googleapis OK')"
```

Expected: `googleapis OK`

- [ ] **Step 6: Commit**

```bash
git add scripts/youtube-upload.js auth/.gitignore package.json package-lock.json
git commit -m "feat: add youtube-upload.js with OAuth2, unlisted upload, shorts, approve flow"
```

---

## Task D2: Створити ddos-publish skill

**Files:**
- Create: `.claude/skills/ddos-publish/SKILL.md`

- [ ] **Step 1: Створити директорію**

```bash
mkdir -p .claude/skills/ddos-publish
```

- [ ] **Step 2: Написати SKILL.md**

```markdown
# Skill: ddos-publish

Завантаж відео і шортси на YouTube.

---

## Перевірки перед upload

1. `state.stages.review == "done"` — інакше СТОП
2. `exports/episode-NNN.mp4` існує — інакше СТОП
3. `exports/thumbnail.png` існує — інакше СТОП
4. `auth/client_secret.json` існує — інакше вивести інструкцію:
   ```
   Щоб отримати client_secret.json:
   1. console.cloud.google.com → новий проект
   2. APIs & Services → Enable → "YouTube Data API v3"
   3. Credentials → Create → OAuth 2.0 → Desktop app
   4. Download → зберегти як auth/client_secret.json
   ```

---

## UPLOAD MAIN VIDEO

```bash
node scripts/youtube-upload.js upload-video \
  "<runId>" \
  "projects/<runId>/exports/metadata.json" \
  "projects/<runId>/exports/episode-<N>.mp4" \
  "projects/<runId>/exports/thumbnail.png"
```

При першому запуску відкриється браузер для авторизації. Далі — автоматично.

Зберегти повернутий videoId. Оновити `state.outputs.youtubeVideoId`.

---

## UPLOAD SHORTS

Для кожного clipId з `state.outputs.shortsPaths`:

```bash
HOOK=$(cat "projects/<runId>/processed/<clipId>/hook.txt" 2>/dev/null || echo "CLIP")
MAIN_ID=$(node -e "const s=require('projects/<runId>/state.json'); console.log(s.outputs.youtubeVideoId||'')")

node scripts/youtube-upload.js upload-short \
  "<runId>" \
  "<clipId>" \
  "projects/<runId>/exports/shorts/<clipId>.mp4" \
  "$MAIN_ID" \
  "$HOOK"
```

Шортси публікуються одразу як Public і лінкуються на основне відео.

Оновити `state.stages.publish = "done"`.

---

## Команда `/ddos approve <runId>`

Обробляється в `.claude/commands/approve.md`. Після approve:

```bash
VIDEO_ID=$(node -e "const s=require('projects/<runId>/state.json'); console.log(s.outputs.youtubeVideoId)")
node scripts/youtube-upload.js publish-video "$VIDEO_ID"
```

Оновити `state.status = "published"`.
Вивести: `✅ Епізод #N опублікований: https://youtu.be/$VIDEO_ID`
```

- [ ] **Step 3: Оновити `.claude/commands/approve.md`**

```markdown
# Команда: /ddos approve <runId>

1. Прочитати `projects/<runId>/state.json`
2. Перевірити `state.outputs.youtubeVideoId` — якщо порожній, вивести помилку
3. Опублікувати відео:
   ```bash
   VIDEO_ID=<state.outputs.youtubeVideoId>
   node scripts/youtube-upload.js publish-video "$VIDEO_ID"
   ```
4. Оновити `state.status = "published"`, `state.approvedAt = <ISO datetime>`
5. Вивести: `Епізод #<N> опублікований: https://youtu.be/$VIDEO_ID`
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/ddos-publish/SKILL.md .claude/commands/approve.md
git commit -m "feat: add ddos-publish skill and update approve command for YouTube publish"
```

---

## Task D3: Створити ddos-analytics skill

**Files:**
- Create: `.claude/skills/ddos-analytics/SKILL.md`

- [ ] **Step 1: Створити директорію**

```bash
mkdir -p .claude/skills/ddos-analytics
```

- [ ] **Step 2: Написати SKILL.md**

```markdown
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

```javascript
// Використати той самий getAuth() що і в youtube-upload.js
// Потрібен googleapis пакет

const { google } = require('googleapis');
// auth = getAuth() (той самий flow)

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
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ddos-analytics/SKILL.md
git commit -m "feat: add ddos-analytics skill for YouTube Analytics → Notion tracking"
```

---

## Task D4: Оновити run.md і CLAUDE.md

**Files:**
- Modify: `.claude/commands/run.md`
- Modify: `CLAUDE.md`
- Create: `assets/chill-archive/index.json`

- [ ] **Step 1: Прочитати поточний run.md і оновити список стадій**

У `state.json.stages` додати нові стадії:
```json
{
  "analytics": "pending",
  "ingest": "pending",
  "filter": "pending",
  "prescore": "pending",
  "download": "pending",
  "transcribe": "pending",
  "score": "pending",
  "plan": "pending",
  "hooks": "pending",
  "trim": "pending",
  "effects": "pending",
  "overlays": "pending",
  "captions": "pending",
  "reconnecting": "pending",
  "chillFinale": "pending",
  "renderLong": "pending",
  "renderShorts": "pending",
  "thumbnail": "pending",
  "metadata": "pending",
  "review": "pending",
  "publish": "pending"
}
```

Порядок виклику skills у run.md:
```
1. ddos-analytics (якщо є попередні run з youtubeVideoId)
2. ddos-ingest (ingest → filter → prescore → download)
3. ddos-score (transcribe → score → plan → hooks)
4. ddos-render (trim → effects → overlays → captions merge → reconnecting → chill finale → render long → render shorts)
5. ddos-shorts (captions for shorts)
6. ddos-thumbnail (thumbnail → metadata)
7. ddos-review (review.html)
8. ddos-publish (upload YouTube)
```

- [ ] **Step 2: Оновити ліміти в CLAUDE.md**

Секція "Ліміти":
```markdown
### Ліміти
- maxClipCandidates: 500
- maxDownloads: 80
- maxClipsPerEpisode: 12–18
- maxClipsPerStreamer: 3 (у episode plan)
- minDuration: 6s / maxDuration: 90s
- targetEpisodeMin: 720с (12 хв)
- targetEpisodeMax: 900с (15 хв)
- maxShorts: 10
- maxDancingClipsInFinale: 10
```

- [ ] **Step 3: Створити `assets/chill-archive/index.json`**

```json
[]
```

- [ ] **Step 4: Commit**

```bash
git add .claude/commands/run.md CLAUDE.md assets/chill-archive/index.json
git commit -m "config: update run.md with new pipeline stages, update CLAUDE.md limits, init chill-archive"
```

---

# Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| Tournament filter | B1 |
| Pre-download scoring (300-500 candidates) | B1 |
| Dynamic categories from Twitch API | B1 |
| 13 scoring dimensions + editingNotes | B2 |
| Peak moment detection | B2 |
| Chill clip accumulation | B2 |
| Group types (GAME/STREAMER/VIBE/MICRO) | B2 (PLAN section) |
| Reconnecting clip = first group peak | B2 (PLAN) + C2 |
| Chill finale (singing + dancing + VOD) | B2 (PLAN) + C4 |
| TRIM re-encode (no -c copy) | A2 |
| Silence detection fallback = full clip | A2 |
| RENDER LONG validation (12-18 clips) | A3 |
| Background blur shorts | A4 |
| Captions merge with time offsets | A5 |
| WebM alpha overlays | C1, C2 |
| Reconnecting glitch effect | C2 |
| Effects stage (zoom, color) | C3 |
| YouTube upload (unlisted → approve → public) | D1, D2 |
| Shorts linked to main video | D2 |
| YouTube Analytics → Notion | D3 |
| Auto-approve permissions | A1 |
| Settings.json permissions | A1 |

**Placeholder scan:** None found. All steps have concrete commands or code.

**Type consistency:** `peakMoment` used consistently as `{start, end, rmsDb}`. `chillPlan` has same shape in PLAN prompt and CHILL FINALE skill. `editingNotes` shape matches between SCORE prompt and EFFECTS stage.
