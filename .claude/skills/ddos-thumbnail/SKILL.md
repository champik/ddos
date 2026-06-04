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
# Використовуємо оригінальний кліп — at задано відносно нього в editorial UI
CLIP_SRC=$(node -p "require('./clips/downloaded-clips.json').find(c=>c.id==='<mainThumb.clipId>')?.localPath")
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

### Крок 3 — V2 і V3: Higgsfield генерація з оцінкою

Запустити скрипт щоб отримати кадри і промпти:

```bash
node scripts/gen-thumbnails-higgsfield.js <runId>
```

Скрипт виводить JSON з полями:
- `mainFrame` — шлях до витягнутого кадру main thumbnail
- `secondaryFrames` — масив кадрів secondary thumbnails
- `v2.prompt` / `v2.outPath`
- `v3.prompt` / `v3.outPath` (null якщо менше 2 thumbnails)

---

**Flow для кожного варіанту (V2 і V3 окремо):**

**Раунд 1 — паралельно дві моделі:**
1. `media_upload` + `media_confirm` для потрібних кадрів
2. Запустити `generate_image` **4 рази паралельно** (V2 і V3 одночасно):
   - V2 × `nano_banana_pro`, resolution `2k`, aspect_ratio `16:9`
   - V2 × `seedream_v4_5`, quality `high`, aspect_ratio `16:9`
   - V3 × `nano_banana_pro`, resolution `2k`, aspect_ratio `16:9`
   - V3 × `seedream_v4_5`, quality `high`, aspect_ratio `16:9`
3. Дочекатись всіх 4, переглянути результати (Read image)
4. Оцінити кожну пару (V2 і V3 окремо) → вибрати переможця

**Якщо для версії є переможець** → зберегти і перейти далі.

**Якщо обидва для версії незадовільні** → Раунд 2: ще 2 генерації для тієї версії (nano + seedream). Максимум 3 раунди на версію.

**Якщо всі спроби незадовільні** → пропустити V2/V3, залогувати. V1 Puppeteer залишається основним.

---

**Критерії оцінки (пріоритет по порядку):**

1. **Обличчя** — найважливіше. Людина на зображенні має бути впізнавано схожою на reference frame. Якщо обличчя змінилось, виглядає як інша людина або змішане — FAIL.

2. **Відповідність промпту** — чи відображено головний момент/емоцію яка описана в промпті.

3. **Якість як YouTube обкладинка** — висока контрастність, чітке головне фото, вільне місце для тексту (thumbnailHook), читабельно на 200px мобільному розмірі.

---

Зберегти сирий результат як `exports/thumbnail-v2-raw.png` і `exports/thumbnail-v3-raw.png`.

**Після вибору переможця** — накласти дефолтну плашку (hook text + yellow stripes) через Puppeteer:

```bash
# thumbnailHook береться з exports/metadata.json
# V2: з текстом hook
node scripts/render-thumbnail.js "exports/thumbnail-v2-raw.png" "<thumbnailHook>" "exports/thumbnail-v2.png"
# V3: без тексту (--no-text), лише смуги
node scripts/render-thumbnail.js "exports/thumbnail-v3-raw.png" "exports/thumbnail-v3.png" --no-text
```

### Крок 4 — Завершення

Оновити `state.stages.thumbnail = "done"`.

Наявні файли після stage:
- `exports/thumbnail.png` — V1 (Puppeteer, йде в YouTube API)
- `exports/thumbnail-v2.png` — V2 (Higgsfield emotion, для A/B тесту вручну)
- `exports/thumbnail-v3.png` — V3 (Higgsfield composite, для A/B тесту вручну)
