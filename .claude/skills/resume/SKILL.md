# Команда: /ddos resume

Продовжити pipeline Stage 2 після editorial рішень.

## Використання
```
/ddos resume
```
Або: користувач вставляє JSON блок з editorial рішеннями напряму в чат.

## Що отримує Claude

Повідомлення містить JSON блок виду (формат editorial.json):
```json
{
  "runId": "Episode_N_YYYY_MM_DD",
  "clipOrder": ["id1", "id2", "id3", "..."],
  "reconnectSource": { "clipId": "id1", "from": 3.0, "to": 5.0 },
  "reconnectPositions": ["id1"],
  "thumbnail": { "clipId": "id4", "at": 25.5, "crop": { "x": 10, "y": 0, "w": 80, "h": 80 } },
  "clips": {
    "id1": { "keeps": [[3.0, 25.0]], "short": { "mode": "desktop", "desktop": { "x": 0, "y": 0, "w": 100, "h": 100 } } }
  }
}
```

## Крок 1 — Перевірка стрімерів на причетність до Росії

**ОБОВ'ЯЗКОВО перед будь-якою обробкою.**

З отриманого JSON витягти всіх стрімерів з `clipOrder` (через `downloaded-clips.json` або `editorial.clips`).
Перевірити кожного: чи є він громадянином РФ, чи публічно підтримував агресію проти України.

Якщо знайдено підозрілого — **ЗУПИНИТИСЬ** і показати:
```
⚠️ СТОП — перевірка стрімерів

streamer: <ім'я>
проблема: <що відомо — громадянство, публічні заяви, дати>
впевненість: висока / середня / немає інформації

Додати в blacklist і прибрати з епізоду?
```

Чекати підтвердження користувача. Якщо підтверджено:
1. Додати стрімера в blacklist у `CLAUDE.md` (поле `blacklist: Lyasyaa, Qoqsik, ...`)
2. Оновити `memory/feedback-streamer-blacklist.md`
3. Прибрати кліп з `clipOrder` і продовжити

Якщо стрімер невідомий → написати "немає інформації, рекомендую перевірити вручну" і продовжити без блокування.

## Крок 2 — Зберегти editorial.json

Витягти JSON блок з повідомлення (перший `{...}` після рядка "Editorial decisions").
Записати як `<projectDir>/edit/editorial.json`.

## Крок 2 — Згенерувати episode-plan.json

З editorial.json побудувати `edit/episode-plan.json`:
```javascript
{
  clipOrder: editorial.clipOrder,
  // Groups = splits at reconnectPositions; reconnect separator inserted after each group except last
  groups: buildGroups(editorial.clipOrder, editorial.reconnectPositions || []),
  openerClipId: editorial.thumbnail?.clipId || editorial.clipOrder[0],
  reconnectingClipId: editorial.reconnectSource?.clipId || null,
  chillPlan: { type: "skip" },
  // shorts: new format — copy directly from editorial.shorts if present
  // shortClipIds: flat list of ALL clip IDs across all shorts (for captions/review/upload)
  shorts: editorial.shorts || null,
  shortClipIds: editorial.shorts
    ? [...new Set(editorial.shorts.flatMap(s => s.type === 'solo' ? [s.clipId] : (s.clips || [])))]
    : (editorial.clipOrder || []).filter(id => editorial.clips?.[id]?.short),
  reasoning: "User editorial decisions"
}
```

`buildGroups(clipOrder, reconnectPositions)`:
- Ділить clipOrder на групи за позиціями reconnect (clip після якого стоїть сепаратор)
- Якщо reconnectPositions порожній → одна група з усіх кліпів
- Приклад: clipOrder=[A,B,C,D], reconnectPositions=[B] → [[A,B],[C,D]]

Зберегти також як `edit/shorts-selection.json` з полем `shortClipIds`.

## Крок 3 — Продовжити pipeline Stage 2

Оновити `state.stages.editorial = "done"` перед початком Stage 2.

Вивести в чат:
```
[6–11/16] APPLY_EDITORIAL + TRANSCRIBE + CENSOR + OVERLAYS + EXTRACT_FRAMES...
```

Запустити **у фоні** (`run_in_background: true`):
```bash
node scripts/stage2.js <runId> <episodeNumber>
```

**ОДРАЗУ після запуску** — зберегти шлях до output файлу з результату команди і викликати `ScheduleWakeup`:

```
ScheduleWakeup(
  delaySeconds: 60,
  reason: "моніторинг stage2.js для <runId>",
  prompt: """
Покажи статус stage2.js для <runId>.
Лог: <OUTPUT_FILE_PATH>

Прочитай кінець логу (offset ~150, limit 100) і виведи таблицю:
✅/🔄/⏳ СТАДІЯ   прогрес/деталі

Стадії:
- APPLY_EDITORIAL (X/26 clips — шукай "OK:" рядки)
- VOD_REPLACE (шукай "replaced, N skipped")
- TRANSCRIBE (шукай "[N/26]")
- CENSOR (шукай "Done: N censored" в apply-censor секції; done_with_errors/warnings — не зупиняє pipeline, дивись "state.warnings")
- EXTRACT_FRAMES (шукай "Done. N ok")
- OVERLAYS (шукай "[OK]" в apply-overlays секції)
- BUILD_CONCAT (шукай "build-concat" або "concat-list")
- RENDER_FINAL (шукай "render-final" або "episode-")
- stage2 загалом (шукай "=== stage2.js done")

Якщо "=== stage2.js done" знайдено → НЕ плануй наступний wakeup, продовж pipeline:

Перед METADATA — прочитай `<projectDir>/edit/vod-segment-results.json` (якщо існує) і виведи VOD звіт:

```
📼 VOD заміни: X/N успішно
```

Якщо є `status: "failed"` або `status: "skipped"` — вивести таблицю:
| Стрімер | Статус | Причина |
|---------|--------|---------|
| StreamerName | ❌ failed | VOD download failed: ... |
| StreamerName | ⚠️ skipped | no VOD metadata |

Якщо всі ok — написати одним рядком "📼 VOD заміни: N/N успішно" і продовжити.

Далі → METADATA → SHORTS+THUMBNAIL паралельно → REVIEW.
Якщо ще йде → заплануй ще один ScheduleWakeup(60s) з цим самим prompt.
"""
)
```

Виконує послідовно потім паралельно:
1. `apply-editorial.js` — trim + cuts → `clean.mp4` per clip (+ VOD replace)
2. `transcribe-batch.js` → `apply-censor.js` (серіально — CENSOR мьютить матюки/слюри
   в `clean.mp4`, тому все нижче має чекати його завершення)
3. Паралельно:
   - A: `gen-captions.js`
   - B: `apply-overlays.js` → `build-concat.js` → `render-final.js`
   - C: `extract-frames.js` (не залежить від CENSOR — тільки відео-кадри)

### Кроки 7–10 (Claude + скрипти)

Після завершення `stage2.js`:

7. Вивести `[12/16] METADATA — генерую YouTube метадані...` → METADATA (ddos-youtube-creatives skill)

8+9. **RENDER SHORTS + THUMBNAIL — паралельно** (обидва залежать тільки від metadata.json):

   **Крок A — captions (sync, ~5s):**
   ```bash
   node scripts/gen-captions.js "<projectDir>" --shorts-only
   ```

   **Крок B — render-shorts у фоні** (`run_in_background: true`):
   ```bash
   node scripts/render-shorts.js "<projectDir>"
   ```

   **Крок C — thumbnail pipeline одразу після запуску B** (ddos-thumbnail skill):
   Не чекати завершення render-shorts — виконати весь thumbnail pipeline паралельно.

   **Крок D — дочекатись render-shorts:**
   Фоновий процес надішле нотифікацію. Оновити `state.stages.renderShorts = "done"`.

10. Вивести `[15/16] REVIEW — генерую сторінку ревю...` → REVIEW (ddos-review skill)
