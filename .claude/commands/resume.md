# Команда: /ddos resume

Продовжити pipeline Stage 2 після editorial рішень користувача.

## Використання

Користувач вставляє JSON блок (скопійований з edit.html → "Copy Prompt"):
```
Editorial decisions for /ddos resume — paste this to Claude:

{ "runId": "...", "clipOrder": [...], ... }
```

## Виконання

### Крок 1 — Зберегти editorial.json

Знайти JSON блок у повідомленні (перший `{...}` після рядка "Editorial decisions").
Записати як `projects/<runId>/edit/editorial.json`.

### Крок 2 — Згенерувати episode-plan.json

З editorial.json побудувати `edit/episode-plan.json` для сумісності з downstream skills:
```javascript
{
  clipOrder: editorial.clipOrder,
  groups: // розбити clipOrder на групи по 4 (VIBE_GROUP)
  openerClipId: editorial.thumbnail?.clipId || editorial.clipOrder[0],
  reconnectingClipId: editorial.reconnect?.clipId || null,
  shortClipIds: Object.entries(editorial.clips || {})
    .filter(([id, c]) => c.short)
    .map(([id]) => id),
  reasoning: "User editorial decisions"
}
```

Зберегти також як `edit/shorts-selection.json` з полем `shortClipIds`.
Оновити `state.stages.editorial = "done"`.

### Крок 3 — Stage 2 (assembly)

Читай skill і виконуй повністю перед переходом до наступного.

**Порядок:**
1. `scripts/apply-editorial.js <runId>` — clean.mp4 для кожного кліпу (trim + cuts)
2. `scripts/transcribe-batch.js <runId>` — транскрипція тільки вибраних кліпів (з clipOrder)
3. Прочитай `.claude/skills/ddos-render/SKILL.md` → виконай OVERLAYS + RECONNECT + CHILL FINALE + RENDER LONG
4. Прочитай `.claude/skills/ddos-shorts/SKILL.md` → виконай CAPTIONS + RENDER SHORTS
5. Прочитай `.claude/skills/ddos-thumbnail/SKILL.md` → виконай THUMBNAIL + METADATA
6. Прочитай `.claude/skills/ddos-review/SKILL.md` → виконай REVIEW

### Крок 4 — Фінальний звіт

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

## Fallback: продовжити після помилки

Якщо editorial.json вже існує (попередній resume перервався) — пропустити Крок 1-2 і продовжити з першого незавершеного stage в state.json.
