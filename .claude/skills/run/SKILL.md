# Команда: /run

Запустити повний DDOS pipeline Stage 1 (до editorial UI).

## Використання
```
/run
/run 48
/run --dry-run
/run special <опис>
/run month
```

Розбір першого аргументу (в цьому порядку):
1. `special` — делегувати до `ddos-special` skill
2. `month` — делегувати до `run-month` skill
3. парситься як ціле число → `HOURS = це число` (напр. `/run 48` → 48 годин)
4. інакше → `HOURS = 24` (дефолт)

## Що робить

Запускає pipeline стадії в порядку:
1. INGEST (ddos-ingest skill)
2. FILTER (ddos-ingest skill)
3. SELECT (ddos-ingest skill)
4. DOWNLOAD (ddos-ingest skill)
5. GAMING_SCREEN (ddos-ingest skill)
6. GENERATE_EDITORIAL (ddos-score skill) ← зупинка тут

> TRANSCRIBE відбувається в Stage 2 (resume skill, крок 2) — після editorial рішень, на clean.mp4.

Після GENERATE_EDITORIAL:
1. Пошукати помітні стрімінг-події/колаборації за останні 24 години і вивести звіт у чат (деталі — `ddos-score` skill, розділ "Звіт подій за останні 24 години")
2. Відкрити браузер і зупинитись (команда залежить від ОС, шлях — від кореня репозиторію):
```bash
# Windows:  start "" "<projectDir>\edit\edit.html"
# macOS:    open "<projectDir>/edit/edit.html"
# Linux:    xdg-open "<projectDir>/edit/edit.html"
```
Якщо відкрити браузер неможливо (headless/remote середовище) — просто вивести повний шлях до файлу.

Потім вивести:

✅ Editorial UI відкрито у браузері (`<projectDir>/edit/edit.html`)

Переглянь кліпи, внеси правки і натисни "Copy Prompt".
Потім встав JSON сюди для продовження.

## Параметри
- `N` (позиційне, напр. `/run 48`) — кліпи за останні N годин (default: 24)
- `--dry-run` — тільки ingest+filter, без завантаження

## State
Зберігати прогрес у `<projectDir>/state.json`. При помилці — записати в state і продовжити якщо можливо.
