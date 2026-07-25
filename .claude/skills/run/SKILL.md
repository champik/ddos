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

## Виконання

Прочитай `.claude/commands/run.md` → виконай повністю, крок за кроком (bootstrap
runId/state.json, episode-counter, точні виклики скриптів, GAMING_SCREEN-цикл,
зупинка після GENERATE_EDITORIAL). Не дублюй логіку тут: одна копія цих кроків
вже розійшлася з іншою один раз (те саме сталося з `ingest-month.js` — ручна
копія FILTER-правил відстала від `lib/filter.js`).

## Параметри
- `N` (позиційне, напр. `/run 48`) — кліпи за останні N годин (default: 24)
- `--dry-run` — тільки ingest+filter, без завантаження

## State
Зберігати прогрес у `<projectDir>/state.json`. При помилці — записати в state і продовжити якщо можливо.
