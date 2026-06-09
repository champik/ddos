# Команда: /ddos run

Запускає DDOS pipeline Stage 1 — від ingest до editorial UI.

## Аргументи
- `--hours N` — скільки годин назад шукати кліпи (default: 24)
- `--dry-run` — тільки ingest + filter, без завантаження
- `--limit N` — максимум кандидатів (default: 500)

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
1. Прочитай `.claude/skills/ddos-ingest/SKILL.md` → виконай INGEST + FILTER + SELECT + DOWNLOAD
2. Запусти `node scripts/gen-editorial.js <runId>` → GENERATE_EDITORIAL
   Після успіху: `state.stages.generate_editorial = "done"` ← **зупинка тут**

### Крок 3 — Показати користувачу і зупинитись

```
✅ Editorial UI готовий!

Відкрий у браузері:
  projects/<runId>/edit/edit.html

Переглянь кліпи, налаштуй порядок, обріж, вибери shorts/thumb/reconnect.
Коли готово — натисни "Copy Prompt" і встав JSON сюди.
```

**Зупинитись і чекати на editorial JSON від користувача.**

## Якщо --dry-run

Виконати тільки INGEST + FILTER зі skill ddos-ingest.
Вивести список відфільтрованих кліпів і зупинитись.
