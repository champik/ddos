# Команда: /ddos resume

Продовжити pipeline Stage 2 після editorial рішень користувача.

## Використання

Користувач вставляє JSON блок (скопійований з edit.html → "Copy Prompt"):
```
Editorial decisions for /ddos resume — paste this to Claude:

{ "runId": "...", "clipOrder": [...], ... }
```

Або пише `/ddos resume` без JSON — тоді продовжити з `editorial.json`, який вже лежить
у `<projectDir>/edit/` (fallback нижче).

## Виконання

Прочитай `.claude/skills/resume/SKILL.md` → виконай повністю, крок за кроком
(включно з обов'язковою перевіркою стрімерів на причетність до Росії — Крок 1
skill'а). Не дублюй логіку тут: формат editorial.json (`reconnectSource`,
`reconnectPositions`, `editorial.shorts[]` тощо) і послідовність stage2.js
підтримуються в одному місці — skill'і — саме тому, що дві копії цієї логіки
вже одного разу розійшлися.

## Fallback: продовжити після помилки

Якщо editorial.json вже існує (попередній resume перервався) — пропустити кроки
збереження editorial.json/episode-plan.json і продовжити з першого незавершеного
stage в state.json.
