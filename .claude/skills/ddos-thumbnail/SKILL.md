# Skill: ddos-thumbnail

Генерація thumbnail кандидатів через Higgsfield — по два кандидати (nano + seedream) на кожне вибране зображення з `editorial.thumbnails`.

**Залежність:** `exports/metadata.json` повинен існувати — генерується `ddos-youtube-creatives` (Stage 13).

---

```bash
node scripts/progress.js "projects/<runId>" 14 "Thumbnail (Higgsfield)"
```

### Крок 1 — Підготовка кадрів і промптів

```bash
node scripts/gen-thumbnails-higgsfield.js <runId>
```

Скрипт витягує кадр для кожного запису з `editorial.thumbnails` і повертає JSON:
```json
{
  "items": [
    {
      "index": 0,
      "clipId": "...",
      "isMain": true,
      "broadcasterName": "YonnaJay",
      "framePath": "projects/<runId>/exports/thumb-frame-0.png",
      "prompt": "...",
      "nanoCandidatePath": "projects/<runId>/exports/thumb-candidate-0-nano.png",
      "seedreamCandidatePath": "projects/<runId>/exports/thumb-candidate-0-seedream.png"
    }
  ]
}
```

Якщо `thumbnails` порожній — fallback на перший кліп з `clipOrder` як єдиний item.

### Крок 2 — Higgsfield генерація (всі паралельно)

Для кожного item: `media_upload` + `media_confirm` кадру → зберегти media ID.

Запустити **всі генерації паралельно** (items.length × 2 jobs):
- кожен item × `nano_banana_pro` (resolution: `2k`, aspect_ratio: `16:9`)
- кожен item × `seedream_v4_5` (quality: `high`, aspect_ratio: `16:9`)

Дочекатись усіх (job_status sync: true).

Якщо генерація для певного item провалилась 2 рази поспіль — пропустити і залогувати, продовжити з рештою.

### Крок 3 — Overlay на кожного кандидата

Для кожного результату:
1. Завантажити raw image через curl → `exports/thumb-candidate-{i}-{model}-raw.png`
2. Прочитати hook для цього кліпу: `metadata.json → thumbnailHooks` → знайти запис де `clipId` співпадає
3. Накласти overlay через Puppeteer:
```bash
node scripts/render-thumbnail.js \
  "projects/<runId>/exports/thumb-candidate-{i}-{model}-raw.png" \
  "<hook>" \
  "projects/<runId>/exports/thumb-candidate-{i}-{model}.png"
```

### Крок 4 — Default thumbnail.png

Перший item де `isMain: true`, nano варіант → скопіювати як `exports/thumbnail.png`.
Якщо жоден не `isMain` — використати перший item nano.

### Крок 5 — Завершення

Оновити `state.stages.thumbnail = "done"`.

**Файли після stage:**
- `exports/thumb-candidate-{i}-nano.png` — Higgsfield nano з hook overlay
- `exports/thumb-candidate-{i}-seedream.png` — Higgsfield seedream з hook overlay
- `exports/thumbnail.png` — default (main item nano)
- `exports/thumb-candidate-{i}-{model}-raw.png` — raw без overlay (для reference)
