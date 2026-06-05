# Команда: /ddos run

Запустити повний DDOS pipeline Stage 1 (до editorial UI).

## Використання
```
/ddos run
/ddos run --hours 48
/ddos run --dry-run
```

## Що робить

Запускає pipeline стадії в порядку:
1. INGEST (ddos-ingest skill)
2. FILTER (ddos-ingest skill)
3. DOWNLOAD (ddos-ingest skill)
4. GENERATE_EDITORIAL (ddos-score skill) ← зупинка тут

> TRANSCRIBE відбувається в Stage 2 (resume skill, крок 2) — після editorial рішень, на clean.mp4.

Після GENERATE_EDITORIAL — відкрити браузер і зупинитись:
```bash
start "" "d:\Projects\ddos\projects\<runId>\edit\edit.html"
```

Потім вивести:

✅ Editorial UI відкрито у браузері (`projects/<runId>/edit/edit.html`)

Переглянь кліпи, внеси правки і натисни "Copy Prompt".
Потім встав JSON сюди для продовження.

## Параметри
- `--hours N` — кліпи за останні N годин (default: 24)
- `--dry-run` — тільки ingest+filter, без завантаження

## State
Зберігати прогрес у `projects/<runId>/state.json`. При помилці — записати в state і продовжити якщо можливо.
