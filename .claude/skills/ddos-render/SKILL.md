# Skill: ddos-render

Обріж кліпи, накладе оверлеї, зберери long-form епізод.

---

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

---

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

---

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

---

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

---

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

---

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

---

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
