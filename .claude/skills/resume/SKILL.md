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
  "thumbnails": [{ "clipId": "id4", "at": 25.5, "main": true, "hook": "THEY LIED", "crop": { "x": 10, "y": 0, "w": 80, "h": 80 } }],
  "clips": {
    "id1": { "keeps": [[3.0, 25.0]], "short": { "mode": "desktop", "desktop": { "x": 0, "y": 0, "w": 100, "h": 100 } } }
  }
}
```

`clips[id].keeps`/`trim`, якщо присутні в JSON, **ігноруються** — `apply-editorial.js`
завжди бере повну довжину кліпу (обрізку робить користувач сам у CapCut).

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
  openerClipId: (editorial.thumbnails || []).find(t => t.main)?.clipId || editorial.thumbnails?.[0]?.clipId || editorial.clipOrder[0],
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
[6–9/16] VOD_REPLACE + APPLY_EDITORIAL (full length) + STREAMER_NAMES...
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

Стадії (у цьому порядку — VOD_REPLACE тепер йде ПЕРЕД APPLY_EDITORIAL, замінює сирий
downloads/-файл до кодування, а не clean.mp4 після):
- VOD_REPLACE (шукай "replaced, N skipped")
- APPLY_EDITORIAL (X/26 clips — шукай "OK:" рядки; кліпи повної довжини, без обрізки,
  кодуються рівно один раз — з уже підміненого VOD-джерела де застосовно)
- STREAMER_NAMES (шукай "[OK]"/"[STREAMER_NAMES] Done" в render-streamer-names секції)
- stage2 загалом (шукай "=== stage2.js done")

Якщо "=== stage2.js done" знайдено → НЕ плануй наступний wakeup, продовж pipeline:

Прочитай `<projectDir>/edit/vod-segment-results.json` (якщо існує) і виведи VOD звіт:

```
📼 VOD заміни: X/N успішно
```

Якщо є `status: "failed"` або `status: "skipped"` — вивести таблицю:
| Стрімер | Статус | Причина |
|---------|--------|---------|
| StreamerName | ❌ failed | VOD download failed: ... |
| StreamerName | ⚠️ skipped | no VOD metadata |

Якщо всі ok — написати одним рядком "📼 VOD заміни: N/N успішно" і продовжити.

**ОДРАЗУ після цього — вивести список готових кліпів для CapCut**:
```
🎬 Готові кліпи для CapCut (processed/clean/, повна довжина):
01_<streamer>.mp4
02_<streamer>.mp4
...

🏷️ Картинки імені стрімера (processed/streamers_name/):
<streamer1>.png
<streamer2>.png
...
```
(`ls processed/clean/*.mp4` і `ls processed/streamers_name/` в projectDir, у порядку
файлів — вони вже NN-префіксовані).

Якщо `editorial.thumbnails` не порожній — запусти THUMBNAIL (ddos-thumbnail skill) у фоні
одразу після цього, не чекаючи нічого іншого (хук тепер береться прямо з
`editorial.thumbnails[].hook`, не з metadata.json). METADATA/REVIEW лишаються вимкненими
(METADATA залежала від транскриптів, яких більше нема; REVIEW — від metadata.json).

Якщо ще йде stage2.js → заплануй ще один ScheduleWakeup(60s) з цим самим prompt.
"""
)
```

`stage2.js` виконує один серійний ланцюг (детальніше — `docs/superpowers/specs/2026-08-02-capcut-handoff-design.md`):
1. `vod-segment.js` — якщо є `editorial.vodClipIds`, підміняє СИРИЙ `downloads/<file>.mp4`
   на той самий діапазон з VOD (ДО кодування — не чіпає `processed/clean/`)
2. `apply-editorial.js` — повна довжина кліпу, без trim/cuts → `processed/clean/<basename>.mp4`,
   рівно один encode на кліп (читає вже підмінене джерело, якщо крок 1 його підмінив)
3. `fetch-avatars.js` → `render-streamer-names.js` — по одній статичній PNG-картинці
   імені на унікального стрімера → `processed/streamers_name/<slug>.png` — ГОТОВО ДЛЯ CAPCUT

TRANSCRIBE, CENSOR і старий video-burn OVERLAYS (`apply-overlays.js`) більше не
виконуються (файли лишились, виклики прибрані зі `stage2.js`) — немає транскриптів,
немає що цензурити, а ім'я стрімера тепер накладається вручну в CapCut як картинка.
CAPTIONS, EXTRACT_FRAMES, BUILD_CONCAT, RENDER_FINAL так само не виконуються.

### Крок 7 — THUMBNAIL (якщо є editorial.thumbnails)

Вивести `[14/16] THUMBNAIL — генерую обкладинку...` → THUMBNAIL (ddos-thumbnail skill),
у фоні. Хук на обкладинці — `editorial.thumbnails[].hook`, вписаний користувачем в edit.html
(жодної залежності від METADATA/транскриптів).

### Кроки 8+ — ВИМКНЕНО

METADATA (ddos-youtube-creatives) і REVIEW (ddos-review) більше не запускаються
автоматично після `stage2.js`/THUMBNAIL — METADATA залежала від транскриптів
(`processed/transcripts/`), яких тепер нема, а REVIEW залежить від `exports/metadata.json`,
який METADATA більше не генерує. Pipeline зупиняється одразу після THUMBNAIL (або одразу
після виводу списку готових файлів, якщо `editorial.thumbnails` порожній).
