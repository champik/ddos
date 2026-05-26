# Skill: ddos-render

Обріж кліпи, накладе оверлеї, зберери long-form епізод.

---

## APPLY_EDITORIAL — Обробка кліпів за editorial.json

```bash
node scripts/progress.js "projects/<runId>" 6 "Обробка кліпів (editorial cuts)"
```

```bash
node scripts/apply-editorial.js "projects/<runId>"
```

Скрипт читає `edit/editorial.json` → для кожного кліпу з `clipOrder` генерує `processed/<clipId>/clean.mp4` з:
- `-ss trim.in -to trim.out` (якщо задано)
- FFmpeg filter_complex з множинними сегментами (якщо є `cuts[]`)
- Завжди: scale 1920×1080, loudnorm, libx264, 30fps, aac 192k, -ac 2

Якщо `clean.mp4` вже існує — пропустити (кешування).

Оновити `state.stages.trim = "done"` (для сумісності з downstream).

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
- FFmpeg overlay (ВАЖЛИВО — НЕ використовувати `eof_action=pass`, не працює на Windows FFmpeg):
  ```
  [0:v][1:v]overlay=0:0:enable='between(t,0,3)':format=auto[out]
  ```
  `enable='between(t,0,3)'` — банер показується перші 3 секунди, потім зникає автоматично.

Якщо треба переробити overlay — видалити `cache/overlays/<slug>.mkv` вручну, потім запустити знову.

**Reconnecting clip — B&W + colored panel + glitch:**

`renderReconnecting()` в apply-overlays.js будує 3-ступеневий filter_complex:
```javascript
const bwFilter    = 'setpts=PTS-STARTPTS,eq=saturation=0:contrast=1.25:brightness=-0.05';
const glitchFilter = "noise=alls=25:allf=t+u,hue=H='if(mod(floor(t*13),2), 1.57, 0)'";

// filter_complex:
'[0:v]' + bwFilter + '[bw]',           // сам кліп → чорно-білий
'[bw][1:v]overlay=0:0:format=auto[composite]',  // colored RECONNECTING панель поверх
'[composite]' + glitchFilter + '[out]'  // глітч (noise + hue-rotate) на все разом
```
Результат: відео B&W, панель з написом кольорова, поверх всього — глітч ефект.

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

## CAPTIONS

Субтитри генеруються ТІЛЬКИ для шортсів — в рамках ddos-shorts skill, після вибору shortClipIds.
На цьому етапі (ddos-render) субтитри НЕ генеруються.

Встановити `state.stages.captions = "skip"` і продовжити.

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
TOTAL_DUR=$(node -e "
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const plan=JSON.parse(fs.readFileSync('edit/episode-plan.json','utf8'));
let t=0;
plan.clipOrder.forEach(id=>{
  const r=spawnSync('ffprobe',['-v','quiet','-show_entries','format=duration','-of','csv=p=0',
    path.join('processed',id,'clean.mp4')],{encoding:'utf8'});
  t+=parseFloat(r.stdout)||0;
});
console.log(Math.round(t));
")
```

Якщо `TOTAL_DUR < 600` (менше 10 хв) — попередження в консоль, але **не зупинятись**.
Якщо `TOTAL_DUR > 1200` (більше 20 хв) — попередження, але **не зупинятись**.

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

### Крок 4: Фінальний рендер (ЗАВЖДИ без субтитрів)

Longform відео рендериться БЕЗ субтитрів — episode.ass вже видалений на кроці CAPTIONS.

```bash
node scripts/render-final.js "projects/<runId>" <episodeNumber>
```

Скрипт:
- Бере `edit/raw-episode.mp4`
- `edit/episode.ass` має бути ВІДСУТНІЙ (видалений після gen-captions.js)
- Виконує `-c copy` → `exports/episode-NNN.mp4`

Оновити `state.outputs.longformPath` і `state.stages.renderLong = "done"`.
