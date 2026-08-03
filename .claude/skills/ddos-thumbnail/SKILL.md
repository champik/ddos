# Skill: ddos-thumbnail

Генерація thumbnail кандидатів — по два кандидати (nano + seedream) на кожне вибране
зображення з `editorial.thumbnails`. Higgsfield робить тільки **очищення кадру** (прибирає
стрімерський chat/HUD/сабки/рекламу) і **upscale** (якість) — обличчя, поза, емоція, фон
лишаються як на оригінальному кадрі, без творчого домальовування. Наш власний дизайн
(жовто-чорні caution-tape смужки + заголовок) накладається окремо через
`render-thumbnail.js` (`assets/thumbnail-template/thumbnail.html`).

**Джерело хука:** `editorial.thumbnails[].hook` — користувач вписує текст прямо в edit.html
при позначенні кадру (без API/транскриптів). `exports/metadata.json` більше не потрібен.

---

```bash
node scripts/progress.js "<projectDir>" 14 "Thumbnail (Higgsfield)"
```

### Крок 1 — Підготовка кадрів

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
      "hook": "THEY LIED",
      "framePath": "<projectDir>/exports/thumb-frame-0.png",
      "nanoCandidatePath": "<projectDir>/exports/thumb-candidate-0-nano.png",
      "seedreamCandidatePath": "<projectDir>/exports/thumb-candidate-0-seedream.png"
    }
  ]
}
```

`hook` береться з `editorial.thumbnails[].hook`; якщо порожній (старий editorial.json без
цього поля) — fallback на `exports/metadata.json → thumbnailHooks` якщо він існує, інакше `''`.
Якщо `thumbnails` порожній — fallback на перший кліп з `clipOrder` як єдиний item.

### Крок 2 — Промпт для очищення кадру (однаковий для всіх items)

Жодного tailoring за емоцією — це не творча трансформація, а прибирання чужого UI:

```
Remove all Twitch/streaming UI elements from this image: chat overlay, subscriber goal bar,
follower/donation alerts, subtitle or caption boxes, promotional banners or ads, watermarks,
and any of the streamer's own on-screen layout graphics.
Keep the person, their exact facial expression, pose, and the background exactly as they
appear in the original — do not change the emotion, do not recompose the framing, do not add
or remove anything else that isn't stream UI.
Photorealistic, natural lighting, no artifacts.
```

### Крок 3 — Higgsfield: очищення + upscale (всі паралельно)

Для кожного item: `media_upload` + `media_confirm` кадру → зберегти media ID.

**Очищення** — запустити всі паралельно (items.length × 2 jobs):
- кожен item × `nano_banana_pro` (resolution: `2k`, aspect_ratio: `16:9`, medias role: `image`)
- кожен item × `seedream_v4_5` (quality: `high`, aspect_ratio: `16:9`, medias role: `image_references`)

**Роль медіа обов'язково перевірити per-model** (`models_explore(action:'get', model_id:...)` →
`medias[].roles`) — кожна модель приймає свою назву ролі. Якщо роль не збігається з тим, що
модель очікує, деякі моделі (напр. seedream_v4_5) мовчки ігнорують referenced-зображення і
генерують з нуля, не зберігаючи ні сцену, ні людину з оригінального кадру — результат виглядає
правдоподібно, але не має нічого спільного з вхідним фото. Завжди звіряти `input_images` у
відповіді job_status: якщо там порожньо/відсутнє — зображення не передалося, роль невірна.

Дочекатись усіх (job_status sync: true).

**Upscale** — для кожного щойно очищеного кандидата викликати `upscale_image` (`resolution: '4k'`,
`width`/`height` з очищеного зображення). Це окремий job на кожен candidate (items.length × 2).

Якщо генерація/upscale для певного item провалились 2 рази поспіль — пропустити і залогувати,
продовжити з рештою.

### Крок 4 — Наш дизайн: overlay на кожного кандидата

Для кожного результату (після upscale):
1. Завантажити image через curl → `exports/thumb-candidate-{i}-{model}-raw.png`
2. Накласти наш дизайн (caution-tape смужки + заголовок) через Puppeteer:
```bash
node scripts/render-thumbnail.js \
  "<projectDir>/exports/thumb-candidate-{i}-{model}-raw.png" \
  "<hook з item.hook>" \
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
- `exports/thumb-candidate-{i}-nano.png` — Higgsfield nano (очищено + upscaled) з нашим overlay
- `exports/thumb-candidate-{i}-seedream.png` — Higgsfield seedream (очищено + upscaled) з нашим overlay
- `exports/thumbnail.png` — default (main item nano)
- `exports/thumb-candidate-{i}-{model}-raw.png` — очищене+upscaled, без нашого overlay (для reference)
