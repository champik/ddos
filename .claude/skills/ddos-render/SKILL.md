# Skill: ddos-render

Обріж кліпи, накладе оверлеї, зберери long-form епізод.

---

## TRIM — Silence Detection + Re-encode

```bash
node scripts/progress.js "projects/<runId>" 7 "Обрізка кліпів (FFmpeg trim + loudnorm)"
```

Для кожного кліпу з episode-plan.json clipOrder:

### 1. Знайти точки обрізання через silencedetect

Шлях до завантаженого файлу: читати з `clips/downloaded-clips.json` → `clip.localPath` (не конструювати з clipId).

```bash
LOCAL_PATH=$(node -e "const c=require('./clips/downloaded-clips.json').find(c=>c.id==='<clipId>'); console.log(c.localPath)")
SILENCE_OUT=$(ffmpeg -i "$LOCAL_PATH" \
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

## OVERLAYS — Puppeteer frame-by-frame → FFV1 MKV

> VP9/VP8 WebM alpha is broken on Windows FFmpeg — FFV1 in MKV correctly preserves alpha.
> Drawtext/drawbox cannot replicate the designed animation — use Puppeteer capture.

```bash
node scripts/apply-overlays.js "projects/<runId>"
```

Скрипт:
- Читає `edit/episode-plan.json` і `clips/scored-clips.json`
- Для кожного кліпу: `clean.mp4` → `overlayed.mp4` з animated streamer name banner (перші 3с)
- Банер рендериться через `scripts/render-overlay.js streamer <name> <out.mkv>` (Puppeteer → FFV1 MKV)
- Кешується в `cache/overlays/<slug>.mkv` (повторно використовується між епізодами)
- Consecutивні кліпи від одного стрімера: банер не показується (лише `-c copy`)
- Рендерить `edit/reconnecting.mp4` через render-overlay.js reconnecting → `cache/overlays/reconnecting-panel.mkv`
- FFmpeg overlay: `[0:v][1:v]overlay=0:0:eof_action=pass:format=auto`

Якщо треба переробити overlay — видалити `cache/overlays/<slug>.mkv` вручну, потім запустити знову.

Оновити `state.stages.overlays = "done"`, `state.stages.reconnecting = "done"`.

**render-overlay.js modes:**
```bash
node scripts/render-overlay.js streamer "<broadcaster_name>" "<out.mkv>"
node scripts/render-overlay.js reconnecting "<out.mkv>"
```

Streamer overlay HTML: `assets/streamer-overlay/streamer_name.html`
Reconnecting overlay HTML: `assets/overlays/reconnecting.html`

---

## EFFECTS — DISABLED

Zoom punch та color punch effects вимкнені — реалізація виявилась занадто жорстокою і псує відео.
Встановити `state.stages.effects = "skip"` і продовжити без змін у overlayed.mp4.

---

## CAPTIONS — ASS субтитри

Виконується після TRIM і перед RENDER LONG.

```bash
node scripts/gen-captions.js "projects/<runId>"
```

Скрипт:
- Генерує `processed/<clipId>/captions-longform.ass` (тільки емоційні фрази, Impact 72px жовтий)
- Генерує `processed/<clipId>/captions-vertical.ass` (всі фрази, word-by-word reveal, Impact 82px)
- Генерує `edit/episode.ass` (merged з time offsets для all clips)

Якщо жоден кліп не має transcript.json → episode.ass не буде, render без субтитрів.

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

**ВАЖЛИВО — уникнути дублювання chill-finale:**

Якщо `chillPlan.type != "skip"` і `edit/chill-finale.mp4` існує:
- Clips з `chillPlan.dancingClipIds` (та `chillPlan.singingClipId`) НЕ додавати до concat з груп — вони вже є в chill-finale.mp4
- Остання група в episode-plan.json може містити ці самі кліпи — пропустити її з concat, замінити на chill-finale.mp4

Порядок (абсолютні шляхи, форвард-слеші):
```
file '/abs/path/assets/intro/intro_30fps.mp4'
[кліпи GROUP 1: overlayed.mp4, або clean.mp4 якщо overlay не існує]
file '/abs/path/edit/reconnecting.mp4'
[кліпи GROUP 2]
file '/abs/path/edit/reconnecting.mp4'
...
[кліпи GROUP N-1]               ← всі групи крім тих що містять chill clips
file '/abs/path/edit/reconnecting.mp4'
[file '/abs/path/edit/chill-finale.mp4' — якщо існує, замість останньої групи]
[або кліпи GROUP N якщо chill-finale.mp4 не існує]
file '/abs/path/assets/outro/outro_30fps.mp4'
```

**ВАЖЛИВО:** Використовувати `intro_30fps.mp4` і `outro_30fps.mp4` (re-encoded 30fps версії), НЕ оригінальні. Оригінали (60fps, без SAR) викликають обрізання у склеєному відео.

Групи беремо з `episode-plan.json.groups[].clipIds`, в порядку груп.
Reconnecting.mp4 вставляємо після кожної групи КРІМ останньої (до chill/outro).

Всі файли в concat-list МАЮТЬ бути у форматі: H.264, 30fps, 1920×1080, AAC 48kHz — гарантується TRIM стадією. Якщо файл відсутній → skip з попередженням.

### Крок 3: Concat (без re-encode — всі файли однакового формату)

```bash
ffmpeg -f concat -safe 0 \
  -i "edit/concat-list.txt" \
  -c copy \
  -y "edit/raw-episode.mp4"
```

### Крок 4: Burn captions (якщо episode.ass існує)

Використовувати Node скрипт — він обробляє Windows path escaping для ASS filter:

```bash
node scripts/render-final.js "projects/<runId>" <episodeNumber>
```

Скрипт автоматично:
- Бере `edit/raw-episode.mp4`
- Якщо `edit/episode.ass` існує → `-vf ass=<escaped path>` + re-encode libx264 crf22
- Якщо немає → `-c copy`
- Виводить в `exports/episode-NNN.mp4`

Оновити `state.outputs.longformPath` і `state.stages.renderLong = "done"`.
