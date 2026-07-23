# Skill: ddos-thumbnail

Генерація thumbnail кандидатів через Higgsfield — по два кандидати (nano + seedream) на кожне вибране зображення з `editorial.thumbnails`.

**Залежність:** `exports/metadata.json` повинен існувати — генерується `ddos-youtube-creatives` (Stage 13).

---

```bash
node scripts/progress.js "<projectDir>" 14 "Thumbnail (Higgsfield)"
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
      "framePath": "<projectDir>/exports/thumb-frame-0.png",
      "prompt": "...",
      "nanoCandidatePath": "<projectDir>/exports/thumb-candidate-0-nano.png",
      "seedreamCandidatePath": "<projectDir>/exports/thumb-candidate-0-seedream.png"
    }
  ]
}
```

Якщо `thumbnails` порожній — fallback на перший кліп з `clipOrder` як єдиний item.

### Крок 2 — Написати промпт для кожного item

Для кожного item написати **tailored** Higgsfield промпт на основі `hook` + `transcriptSnippet` + `gameName`.

**Правила промпту:**
- Визнач емоцію моменту з hook/transcript: радість, шок, біль, збентеження, сміх, страх, захват — і посиль САМЕ ЇЇ.
- **Обличчя має займати щонайменше ⅓ кадру** — якщо на витягнутому кадрі воно менше, додай у промпт recompose/zoom на обличчя. Емоція має читатись на превʼю 200px.
- Ніколи не додавай відкритий рот якщо його немає на кадрі.
- Ніколи не додавай нових людей яких немає на кадрі.
- Завжди прибирай stream UI, chat overlay, watermarks.
- Результат: photorealistic, YouTube thumbnail aesthetic, vivid colors, cinematic lighting.
- Hook на обкладинці і заголовок відео мають ДОПОВНЮВАТИ одне одного (обкладинка = емоція, заголовок = контекст), не повторювати слова.

**Маппінг емоцій → інструкції:**
| Момент | Емоція | Як посилити |
|---|---|---|
| Смішна теорія, розповідь | Амбіційна усмішка / conspiratorial smirk | "widen the knowing grin, raise one eyebrow, lean forward energy" |
| Несподіваний звук/стрибок | Шок/переляк | "frozen mid-flinch, eyes wide, mouth caught open" |
| Біль/дискомфорт | Гримаса | "intensify the grimace, eyes squeezed shut or teary, teeth clenched" |
| Число/знак/містика | Захват/надія | "brighten the smile, wide excited eyes, hands-up energy if present" |
| Фізичне зусилля | Натуга/концентрація | "straining expression, clenched jaw, intense focus, veins visible" |
| Роздратування/роast | Зневага/сміх | "exaggerated eye-roll or deadpan look, or barely-containing laughter" |
| Забув що стрімить | Збентеження | "frozen caught-red-handed expression, eyes wide, hand to mouth" |
| Щось виходить з носа | Огида/шок | "full cringe/disgust face, eyes squeezed, shoulders up" |
| Статуї повертаються | Жах/недовіра | "wide paranoid eyes, head turning, haunted expression" |

Структура промпту (одне речення на кожен пункт):
```
Transform the person in this image into a YouTube thumbnail.
[EMOTION-SPECIFIC instruction based on the table above — 1-2 sentences]
Recompose so the face fills at least one third of the frame, eyes clearly visible.
Never add people or objects not present in the original.
Never add an open mouth if the mouth is closed in the original.
Remove all stream overlays, chat, UI, watermarks.
YouTube thumbnail aesthetic: extreme contrast, vivid saturated colors, sharp face detail, cinematic lighting boost.
Photorealistic, no artifacts.
```

### Крок 3 — Higgsfield генерація (всі паралельно)

Для кожного item: `media_upload` + `media_confirm` кадру → зберегти media ID.

Запустити **всі генерації паралельно** (items.length × 2 jobs):
- кожен item × `nano_banana_pro` (resolution: `2k`, aspect_ratio: `16:9`, medias role: `image`)
- кожен item × `seedream_v4_5` (quality: `high`, aspect_ratio: `16:9`, medias role: `image_references`)

**Роль медіа обов'язково перевірити per-model** (`models_explore(action:'get', model_id:...)` →
`medias[].roles`) — кожна модель приймає свою назву ролі. Якщо роль не збігається з тим, що
модель очікує, деякі моделі (напр. seedream_v4_5) мовчки ігнорують referenced-зображення і
генерують з нуля, не зберігаючи ні сцену, ні людину з оригінального кадру — результат виглядає
правдоподібно, але не має нічого спільного з вхідним фото. Завжди звіряти `input_images` у
відповіді job_status: якщо там порожньо/відсутнє — зображення не передалося, роль невірна.

Дочекатись усіх (job_status sync: true).

Якщо генерація для певного item провалилась 2 рази поспіль — пропустити і залогувати, продовжити з рештою.

### Крок 4 — Overlay на кожного кандидата

Для кожного результату:
1. Завантажити raw image через curl → `exports/thumb-candidate-{i}-{model}-raw.png`
2. Прочитати hook для цього кліпу: `metadata.json → thumbnailHooks` → знайти запис де `clipId` співпадає
3. Накласти overlay через Puppeteer:
```bash
node scripts/render-thumbnail.js \
  "<projectDir>/exports/thumb-candidate-{i}-{model}-raw.png" \
  "<hook>" \
  "<projectDir>/exports/thumb-candidate-{i}-{model}.png"
```

### Крок 5 — Default thumbnail.png

Перший item де `isMain: true`, nano варіант → скопіювати як `exports/thumbnail.png`.
Якщо жоден не `isMain` — використати перший item nano.

### Крок 6 — Завершення

Оновити `state.stages.thumbnail = "done"`.

**Не видаляти невибраних кандидатів** — після публікації постав топ-3 у
YouTube Studio → відео → Thumbnail → "Test & compare" (A/B тест, YouTube сам
вибере переможця по watch time). Через API ця фіча недоступна — 30 секунд руками.

**Файли після stage:**
- `exports/thumb-candidate-{i}-nano.png` — Higgsfield nano з hook overlay
- `exports/thumb-candidate-{i}-seedream.png` — Higgsfield seedream з hook overlay
- `exports/thumbnail.png` — default (main item nano)
- `exports/thumb-candidate-{i}-{model}-raw.png` — raw без overlay (для reference)
