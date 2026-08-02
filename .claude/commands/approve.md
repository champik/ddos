# Команда: /approve

Приймає JSON з вибраним заголовком і thumbnail, публікує відео на YouTube.

## Формат вхідних даних

```json
{
  "runId": "Episode_N_YYYY_MM_DD",
  "title": "Обраний заголовок відео",
  "thumbnail": "thumb-candidate-0-nano"
}
```

- `title` — обраний заголовок з review.html
- `thumbnail` — id кандидата з review.html (`thumb-candidate-<i>-<model>`, файл `exports/<id>.png`)

## Виконання

Проекти зберігаються в місячних підпапках: `projects/<YYYY_Month>/<runId>/`.
`<YYYY_Month>` визначається по даті в runId (напр. `Episode_44_2026_06_28` → `2026_June`).

```js
// Обчислити projectDir:
const { getProjectDir } = require('./scripts/lib/project-path');
const projectDir = getProjectDir(runId); // напр. "projects/2026_June/Episode_44_2026_06_28"
```

### Крок 1 — Підготовка

Прочитати `<projectDir>/state.json`.

Якщо `<projectDir>/exports/episode.mp4` відсутній — СТОП: користувач ще не поклав фінальний
експорт з CapCut. Не намагатись рендерити його самому — система більше не рендерить фінальне
відео (selection-only pipeline, `processed/overlayed/*.mp4` монтується вручну).

Якщо `state.outputs.youtubeVideoId` відсутній — **одразу завантажити відео** без зупинок:
```bash
node scripts/youtube-upload.js upload-video "<runId>" "<projectDir>/exports/metadata.json" "<projectDir>/exports/episode.mp4" "<projectDir>/exports/<thumbnail>.png"
```
Це нормальний стан для нового епізоду. Після завантаження продовжити далі.

### Крок 2 — Thumbnail

Якщо `thumbnail` вказаний, `youtubeVideoId` вже є, і `exports/<thumbnail>.png` існує:
```bash
node scripts/youtube-upload.js update-thumbnail "<videoId>" "<projectDir>/exports/<thumbnail>.png"
```
(upload-video в Кроці 1 вже встановлює thumbnail під час завантаження — цей крок потрібен тільки якщо відео вже було завантажено раніше і треба змінити обкладинку)

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
node scripts/youtube-upload.js publish-all "<runId>" "$PUBLISH_AT" "<title>" "" "<thumbnail>"
```

Повторний запуск безпечний: вже заплановані шортси пропускаються (idempotency по
`state.outputs.youtubeShortsIds`).

Shorts публікуються з інтервалом 2 години після основного відео (вже реалізовано в `publish-all`).

Скрипт:
- Встановлює обраний `title` для відео
- Публікує основне відео (public або за розкладом)
- Планує Shorts (+2год, +4год, +6год... — інтервал налаштовується залежно від кількості шортсів, дефолт 2 години)

### Крок 5 — Оновити state та index.html

Оновити `state.json`:
- `state.status = "published"`
- `state.approvedAt = <ISO>`

Оновити `projects/index.html`:
- Замінити `status-pending">⏳ pending` → `status-published">✓ published`
- **Не додавати** YouTube або Shorts кнопки — тільки статус

Регенерувати `review.html`:
```bash
node scripts/gen-review.js "<projectDir>"
```

### Крок 6 — Вивести результат

```
✅ Епізод #N опублікований: https://youtu.be/<videoId>
📱 Shorts: +2год, +4год...
🖼 Thumbnail: <thumbnail>
📝 Title: "<обраний заголовок>"
```
