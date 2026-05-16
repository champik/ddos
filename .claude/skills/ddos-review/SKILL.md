# Skill: ddos-review

Згенеруй локальну HTML сторінку для перегляду і апруву епізоду.

---

## Генерація review.html

```bash
node scripts/progress.js "projects/<runId>" 15 "Генерую review.html"
```

Зчитай:
- `state.json` — runId, episodeNumber, outputs
- `edit/episode-plan.json` — clipOrder, segments
- `exports/metadata.json` — titleOptions, description, tags
- `clips/scored-clips.json` — scores по clipId
- `clips/raw-clips.json` — broadcaster_name, title, game_id

Згенеруй HTML файл `review/review.html` з такими секціями:

### 1. Header
- Заголовок: DDOS · EPISODE #N
- RunId, дата
- Статус: ✓ Ready for review

### 2. Long-form відео
```html
<video src="../exports/episode-N.mp4" controls width="960"></video>
```
Відносний шлях від папки review/.

### 3. Thumbnail preview
```html
<img src="../exports/thumbnail.png" style="max-width:640px">
```

### 4. Title options (клікабельні для вибору)
Кожен варіант як окрема картка.

### 5. Таблиця кліпів
Колонки: # | Стрімер | Категорія | Назва | DDOS | Funny | Shorts | Music⚠ | Flags

### 6. Shorts preview grid
```html
<video src="../exports/shorts/clipId.mp4" controls width="200" style="border-radius:8px"></video>
```

### 7. Metadata preview
Description і hashtags.

### 8. Approve section
```html
<div style="background:#1a1a1e; padding:20px; border-radius:8px; margin-top:24px">
  <p>Перевір все вище. Коли готово — виконай команду:</p>
  <code style="color:#f5ff3d">/ddos approve <runId></code>
</div>
```

### Стиль
- Фон: #0e0e10
- Текст: #f4f0e6
- Акцент: #f5ff3d
- Шрифт заголовків: Anton (Google Fonts)
- Шрифт тексту: Space Grotesk (Google Fonts)
- Mono: JetBrains Mono (Google Fonts)

Після генерації вивести в чат:
```
✓ Review page готова
Відкрий: projects/<runId>/review/review.html
```

```bash
node scripts/progress.js "projects/<runId>" summary
```

Оновити `state.stages.review = "done"`.
