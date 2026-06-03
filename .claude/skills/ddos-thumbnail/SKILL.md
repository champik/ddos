# Skill: ddos-thumbnail

Рендер thumbnail PNG через Puppeteer (V1) + Higgsfield генерація V2 і V3.

**Залежність:** `exports/metadata.json` повинен існувати — генерується `ddos-youtube-creatives` (Stage 13).

---

```bash
node scripts/progress.js "projects/<runId>" 14 "Thumbnail (Puppeteer + Higgsfield)"
```

### Крок 1 — Читати thumbnails з editorial.json

```javascript
const editorial = JSON.parse(fs.readFileSync('edit/editorial.json'));
const thumbnails = editorial.thumbnails || [];
const mainThumb = thumbnails.find(t => t.main) || thumbnails[0];
// mainThumb = { clipId, at, crop, main: true }
// crop = { x, y, w, h } — відсотки від кадру
// null або w >= 99 → повний кадр без зуму
```

Якщо `thumbnails` порожній — fallback на перший кліп з `clipOrder`.

### Крок 2 — V1: Puppeteer рендер (головний thumbnail)

```bash
CLIP_SRC="processed/<mainThumb.clipId>/clean.mp4"
THUMB_AT=<mainThumb.at>  # або 60% тривалості якщо не задано

ffmpeg -ss $THUMB_AT -i "$CLIP_SRC" -frames:v 1 -q:v 2 -y "exports/best-frame.png"
```

```bash
THUMBNAIL_HOOK=$(node -p "require('./exports/metadata.json').thumbnailHook")

CROP_JSON=$(node -p "
  const e = require('./edit/editorial.json');
  const thumbs = e.thumbnails || [];
  const main = thumbs.find(t => t.main) || thumbs[0];
  const c = main?.crop;
  (c && c.w < 99) ? JSON.stringify(c) : ''
")

if [ -n "$CROP_JSON" ]; then
  node scripts/render-thumbnail.js "exports/best-frame.png" "$THUMBNAIL_HOOK" "exports/thumbnail.png" --crop "$CROP_JSON"
else
  node scripts/render-thumbnail.js "exports/best-frame.png" "$THUMBNAIL_HOOK" "exports/thumbnail.png"
fi
```

`exports/thumbnail.png` — йде в YouTube API при публікації.

### Крок 3 — V2 і V3: Higgsfield генерація

Запустити скрипт щоб отримати кадри і промпти:

```bash
node scripts/gen-thumbnails-higgsfield.js <runId>
```

Скрипт виводить JSON з полями:
- `mainFrame` — шлях до витягнутого кадру main thumbnail
- `secondaryFrames` — масив кадрів secondary thumbnails
- `v2.prompt` — промпт для Higgsfield (emotion enhancement)
- `v2.outPath` — куди зберегти результат
- `v3.prompt` — промпт для композитної сцени (null якщо менше 2 thumbnails)
- `v3.outPath` — куди зберегти результат

**V2 — emotion enhancement:**
1. `media_upload` + `media_confirm` для `mainFrame`
2. `generate_image` з `v2.prompt`, reference = uploaded media, модель `nano_banana_pro`, resolution `2k`, aspect_ratio `16:9`
3. Зберегти результат як `exports/thumbnail-v2.png`

**V3 — composite scene** (тільки якщо `v3 !== null`):
1. `media_upload` + `media_confirm` для кожного кадру (`mainFrame` + `secondaryFrames`)
2. `generate_image` з `v3.prompt`, всі кадри як references, модель `nano_banana_pro`, resolution `2k`, aspect_ratio `16:9`
3. Зберегти результат як `exports/thumbnail-v3.png`

Якщо Higgsfield недоступний або помилка — пропустити V2/V3, залогувати і продовжити.

### Крок 4 — Завершення

Оновити `state.stages.thumbnail = "done"`.

Наявні файли після stage:
- `exports/thumbnail.png` — V1 (Puppeteer, йде в YouTube API)
- `exports/thumbnail-v2.png` — V2 (Higgsfield emotion, для A/B тесту вручну)
- `exports/thumbnail-v3.png` — V3 (Higgsfield composite, для A/B тесту вручну)
