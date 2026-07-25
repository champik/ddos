# Команда: /ddos run

Запускає DDOS pipeline Stage 1 — від ingest до editorial UI.

## Аргументи
- `/run N` — позиційне число одразу після `/run` = кількість годин для ingest-вікна (напр. `/run 120` = останні 120 годин). Без числа — 24 години (дефолт).
- `--dry-run` — тільки ingest + filter, без завантаження

Ліміту кандидатів немає CLI-флагом — `maxClipCandidates: 500` захардкожено в `ingest.js`/`ingest-month.js` (`MAX_CANDIDATES`).

**Розбір першого аргументу (перед усім іншим):**
1. Якщо перший аргумент — ключове слово `month` → це не `/ddos run`, а `/run month` (окремий skill `run-month`)
2. Якщо перший аргумент — ключове слово `special` → окремий skill `ddos-special`
3. Якщо перший аргумент парситься як ціле число → `HOURS = це число`
4. Інакше → `HOURS = 24` (дефолт)

## Виконання

### Крок 1 — Підготовка run

Створи унікальний runId у форматі `Episode_N_YYYY_MM_DD`.
Визнач episodeNumber: читай `projects/episode-counter.json`, збільш на 1, збережи.
Створи структуру папок для цього runId.
Запиши початковий `state.json`:
```json
{
  "runId": "<runId>",
  "episodeNumber": <N>,
  "startedAt": "<ISO>",
  "status": "running",
  "stages": {
    "ingest": "pending",
    "filter": "pending",
    "select": "pending",
    "download": "pending",
    "gaming_screen": "pending",
    "generate_editorial": "pending",
    "editorial": "pending",
    "trim": "pending",
    "transcribe": "pending",
    "overlays": "pending",
    "reconnecting": "pending",
    "renderLong": "pending",
    "captions": "pending",
    "renderShorts": "pending",
    "thumbnail": "pending",
    "metadata": "pending",
    "review": "pending",
    "publish": "pending"
  },
  "counts": { "raw": 0, "filtered": 0, "downloaded": 0 },
  "outputs": { "longformPath": null, "thumbnailPath": null, "shortsPaths": [] }
}
```

### Крок 2 — Stage 1 (авто)

Читай skill і виконуй повністю перед переходом до наступного.
Після кожного skill оновлюй state.json (stage → "done" або "failed").
Якщо stage "failed" — записати помилку і продовжувати далі якщо можливо.

**Порядок:**
1. Прочитай `.claude/skills/ddos-ingest/SKILL.md` → виконай INGEST + FILTER + SELECT + DOWNLOAD.
   Запусти `node scripts/ingest.js <runId> <token>` — і додай `--hours <HOURS>` тільки якщо
   `HOURS != 24` (дефолтний виклик без прапорця лишається без змін).
2. GAMING_SCREEN — циклічно, без зупинки для користувача:
   - `node scripts/gaming-screen.js <runId> --prepare`
   - переглянь `<projectDir>/clips/gaming-contact-sheet.png` (вебка/VTuber/турнірний HUD)
   - запиши рішення в `<projectDir>/clips/gaming-screen-results.json`
   - `node scripts/gaming-screen.js <runId> --apply`
   - якщо вивід просить ще раунд — повтори з `--prepare`; інакше переходь далі
3. Запусти `node scripts/gen-editorial.js <runId>` → GENERATE_EDITORIAL
   Після успіху: `state.stages.generate_editorial = "done"` ← **зупинка тут**

### Крок 3 — Звіт подій і зупинка

Пошукати помітні стрімінг-події/колаборації за останні 24 години і вивести звіт у
чат (деталі — `ddos-score` skill, розділ "Звіт подій за останні 24 години").

Відкрити браузер і зупинитись (команда залежить від ОС, шлях — від кореня репозиторію):
```bash
# Windows:  start "" "<projectDir>\edit\edit.html"
# macOS:    open "<projectDir>/edit/edit.html"
# Linux:    xdg-open "<projectDir>/edit/edit.html"
```
Якщо відкрити браузер неможливо (headless/remote середовище) — просто вивести повний шлях до файлу.

```
✅ Editorial UI готовий!

Відкрий у браузері:
  <projectDir>/edit/edit.html

Переглянь кліпи, налаштуй порядок, обріж, вибери shorts/thumb/reconnect.
Коли готово — натисни "Copy Prompt" і встав JSON сюди.
```

**Зупинитись і чекати на editorial JSON від користувача.**

## Якщо --dry-run

Виконати тільки INGEST + FILTER зі skill ddos-ingest.
Вивести список відфільтрованих кліпів і зупинитись.
