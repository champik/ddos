# Команда: /ddos run

Запускає повний DDOS pipeline від ingest до review.html.

## Аргументи
- `--hours N` — скільки годин назад шукати кліпи (default: 24)
- `--dry-run` — тільки ingest + filter, без завантаження
- `--limit N` — максимум кандидатів (default: 500)

## Виконання

### Крок 1 — Підготовка run

Створи унікальний runId (timestamp-based: YYYYMMDD-HHMMSS).
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
    "prescore": "pending",
    "download": "pending",
    "transcribe": "pending",
    "score": "pending",
    "plan": "pending",
    "hooks": "pending",
    "trim": "pending",
    "effects": "skip",
    "overlays": "pending",
    "captions": "pending",
    "reconnecting": "pending",
    "chillFinale": "pending",
    "renderLong": "pending",
    "renderShorts": "pending",
    "thumbnail": "pending",
    "metadata": "pending",
    "review": "pending",
    "publish": "pending"
  },
  "counts": { "raw": 0, "filtered": 0, "downloaded": 0, "scored": 0 },
  "outputs": { "longformPath": null, "thumbnailPath": null, "shortsPaths": [] }
}
```

### Крок 2 — Виклик skills по порядку

Читай skill і виконуй повністю перед переходом до наступного.
Після кожного skill оновлюй state.json (stage → "done" або "failed").
Якщо stage "failed" — записати помилку і **продовжувати** далі якщо можливо.

**Порядок:**
1. Прочитай `.claude/skills/ddos-ingest/SKILL.md` → виконай ingest + filter + prescore + download
2. Прочитай `.claude/skills/ddos-score/SKILL.md` → виконай transcribe + score (оцінка по контенту, clean.mp4 ще не потрібен)
3. Прочитай `.claude/skills/ddos-render/SKILL.md` → виконай TRIM --incremental (використовує ddosScore для пріоритизації, зупиняється коли сума clean.mp4 ≥ 720s або ddosScore < 45)
4. Прочитай `.claude/skills/ddos-score/SKILL.md` → виконай plan (з реальними clean.mp4 тривалостями) + hooks
5. Прочитай `.claude/skills/ddos-render/SKILL.md` → виконай overlays + reconnecting + chill finale + render long-form
6. Прочитай `.claude/skills/ddos-shorts/SKILL.md` → виконай captions (--shorts-only) + render shorts
7. Прочитай `.claude/skills/ddos-thumbnail/SKILL.md` → виконай thumbnail + metadata
8. Прочитай `.claude/skills/ddos-review/SKILL.md` → виконай review.html
9. Прочитай `.claude/skills/ddos-publish/SKILL.md` → виконай upload YouTube

### Крок 3 — Фінальний звіт

Після всіх skills вивести:
```
✓ DDOS Episode #NNN готовий

📺 Long-form:  projects/<runId>/exports/episode-NNN.mp4
🖼  Thumbnail:  projects/<runId>/exports/thumbnail.png
📱 Shorts:     projects/<runId>/exports/shorts/ (N файлів)
📋 Review:     projects/<runId>/review/review.html

Заголовки:
  [1] ...
  [2] ...
  [3] ...

Approve для upload: /ddos approve <runId>
```

## Якщо --dry-run

Виконати тільки ingest + filter зі skill ddos-ingest.
Вивести список відфільтрованих кліпів і зупинитись.
