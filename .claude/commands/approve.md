# Команда: /approve

Приймає JSON з вибраним заголовком і thumbnail, публікує відео на YouTube.

## Формат вхідних даних

```json
{
  "runId": "Episode_N_YYYY_MM_DD",
  "title": "Обраний заголовок відео",
  "thumbnail": "v1"
}
```

- `title` — обраний заголовок з review.html
- `thumbnail` — `v1` (Puppeteer), `v2` або `v3` (Higgsfield)

## Виконання

### Крок 1 — Підготовка

Прочитати `projects/<runId>/state.json`.
Перевірити `state.outputs.youtubeVideoId` — якщо порожній, вивести помилку і зупинитись.

### Крок 2 — Thumbnail

Якщо `thumbnail` = `v2` або `v3`:
```bash
cp "projects/<runId>/exports/thumbnail-<v>.png" "projects/<runId>/exports/thumbnail.png"
```
Це замінить V1 на обраний варіант перед публікацією.

### Крок 3 — Розрахувати час публікації

15:15 за Києвом (UTC+3). Якщо цей час сьогодні вже пройшов — публікувати негайно.

```bash
PUBLISH_AT=$(node -e "
  const now = new Date();
  const kyiv1515 = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    12, 15
  ));
  console.log(kyiv1515 > now ? kyiv1515.toISOString() : '');
")
```

### Крок 4 — Публікація

```bash
node scripts/youtube-upload.js publish-all "<runId>" "$PUBLISH_AT" "<title>"
```

Shorts публікуються з інтервалом 1 година після основного відео (вже реалізовано в `publish-all`).

Скрипт:
- Встановлює обраний `title` для відео
- Публікує основне відео (public або за розкладом)
- Планує Shorts (+1год, +2год, +3год...)

### Крок 5 — Оновити state та index.html

Оновити `state.json`:
- `state.status = "published"`
- `state.approvedAt = <ISO>`

Оновити `projects/index.html`:
- Замінити `status-pending">⏳ pending` → `status-published">✓ published`
- Додати кнопку YouTube в `.links-row`
- Додати кнопки Shorts якщо є `youtubeShortsIds`

Регенерувати `review.html`:
```bash
node scripts/gen-review.js "projects/<runId>"
```

### Крок 6 — Вивести результат

```
✅ Епізод #N опублікований: https://youtu.be/<videoId>
📱 Shorts: +1год, +2год...
🖼 Thumbnail: <v1/v2/v3>
📝 Title: "<обраний заголовок>"
```
