# Skill: ddos-thumbnail

Рендер thumbnail PNG через Puppeteer.

**Залежність:** `exports/metadata.json` повинен існувати — генерується `ddos-youtube-creatives` (Stage 13).

---

```bash
node scripts/progress.js "projects/<runId>" 14 "Thumbnail (Puppeteer рендер)"
```

### Крок 1 — Визначити кліп і момент для thumbnail

Читати з `edit/editorial.json`:
```javascript
const editorial = JSON.parse(fs.readFileSync('edit/editorial.json'));
const thumbClipId = editorial.thumbnail?.clipId || editorial.clipOrder[0];
const thumbAt = editorial.thumbnail?.at ?? null;
```

Якщо `thumbAt` задано — використати цю секунду.
Якщо `thumbAt` не задано — взяти 60% тривалості кліпу.

```bash
CLIP_SRC="processed/<thumbClipId>/clean.mp4"

if [ -n "$THUMB_AT" ]; then
  TIMESTAMP=$THUMB_AT
else
  DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$CLIP_SRC")
  TIMESTAMP=$(echo "$DURATION * 0.6" | bc)
fi

ffmpeg -ss $TIMESTAMP -i "$CLIP_SRC" -frames:v 1 -q:v 2 -y "exports/best-frame.png"
```

### Крок 2 — Рендер через Puppeteer

```bash
# Usage: node scripts/render-thumbnail.js <framePath> <headlineText> <outPath>
THUMBNAIL_HOOK=$(node -p "require('./exports/metadata.json').thumbnailHook")

node scripts/render-thumbnail.js \
  "exports/best-frame.png" \
  "$THUMBNAIL_HOOK" \
  "exports/thumbnail.png"
```

Якщо Puppeteer недоступний — зберегти best-frame.png як thumbnail (без overlay).

Оновити `state.stages.thumbnail = "done"`.
