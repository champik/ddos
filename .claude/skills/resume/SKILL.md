# Команда: /ddos resume

Продовжити pipeline Stage 2 після editorial рішень.

## Використання
```
/ddos resume
```
Або: користувач вставляє JSON блок з editorial рішеннями напряму в чат.

## Що отримує Claude

Повідомлення містить JSON блок виду:
```json
{
  "runId": "Episode_N_YYYY_MM_DD",
  "clipOrder": ["id1", "id2", "..."],
  "reconnect": { "clipId": "id1", "from": 3.0, "to": 5.0, "afterIndex": 1 },
  "thumbnail": { "clipId": "id4", "at": 25.5 },
  "clips": {
    "id1": { "short": { "mode": "split", "webcam": [0.72, 0.07, 0.23, 0.36], "camPos": "top" } },
    "id2": { "cuts": [[3.0, 5.0], [13.0, 25.0]], "trim": { "in": 0, "out": 41.0 } }
  }
}
```

## Крок 1 — Зберегти editorial.json

Витягти JSON блок з повідомлення (перший `{...}` після рядка "Editorial decisions").
Записати як `projects/<runId>/edit/editorial.json`.

## Крок 2 — Згенерувати episode-plan.json

З editorial.json побудувати `edit/episode-plan.json` для сумісності з downstream skills:
```javascript
{
  clipOrder: editorial.clipOrder,
  groups: buildGroups(editorial.clipOrder),  // розбити на групи по 4 кліпи
  openerClipId: editorial.thumbnail?.clipId || editorial.clipOrder[0],
  reconnectingClipId: editorial.reconnect?.clipId || null,
  chillPlan: { type: "skip" },
  shortClipIds: Object.entries(editorial.clips || {})
    .filter(([id, c]) => c.short)
    .map(([id]) => id),
  reasoning: "User editorial decisions"
}
```

`buildGroups` — поділити clipOrder на групи по 4 кліпи (VIBE_GROUP).

Зберегти також як `edit/shorts-selection.json` з полем `shortClipIds`.

## Крок 3 — Продовжити pipeline Stage 2

Запустити в порядку:
1. APPLY_EDITORIAL → `scripts/apply-editorial.js <runId>` (clean.mp4 для кожного кліпу)
2. HOOKS — згенерувати хуки в розмові для кліпів з clipOrder (hook.txt)
3. OVERLAYS (ddos-render skill)
4. RECONNECT (ddos-render skill)
5. CHILL FINALE (ddos-render skill, якщо є chill кліпи)
6. RENDER LONG (ddos-render skill)
7. CAPTIONS (ddos-shorts skill)
8. RENDER SHORTS (ddos-shorts skill)
9. THUMBNAIL (ddos-thumbnail skill)
10. METADATA (ddos-youtube-creatives skill)
11. REVIEW (ddos-review skill)

Оновити `state.stages.editorial = "done"` перед початком Stage 2.
