# Команда: /run special

Запустити спеціальний епізод з довільною темою або критерієм відбору.

## Використання
```
/run special найкращі кліпи за червень 2026
/run special best school of streaming moments
/run special xQc best clips this month
```

## Перед початком — уточнити у юзера

Перед тим як запускати pipeline, запитати:

1. **Критерій відбору** (якщо незрозуміло з тексту):
   - Часовий діапазон? (напр. June 1–30, 2026)
   - Тема/keyword? (напр. "school of streaming")
   - Стрімер? (напр. "best xQc clips")

2. **Категорії** — JC/IRL, Gaming, або обидві? (дефолт: обидві)

3. **Кількість кліпів** — скільки в епізоді (дефолт: як звичайний епізод, 720–900s)

4. **Назва для папки** — Claude пропонує, юзер підтверджує

## Іменування

Папка: `Special_N_YYYY_MM_DD` де N — порядковий номер серед Special епізодів, дата — дата запуску.

Приклад: `Special_1_2026_07_01`

Для визначення N — перевірити скільки вже є папок `Special_*` в `projects/Special/`.

## Pipeline

Той самий що `/ddos run`, але:

### Відмінності від звичайного запуску:

**Немає окремого скрипта для Special INGEST/SELECT** — на відміну від `/run` (`ingest.js`)
і `/run month` (`ingest-month.js`), тут немає готового `ingest-special.js`. Це ad-hoc
Claude-driven виклик: писати невеликий Node-скрипт під конкретний критерій (за зразком
`ingest.js`/`ingest-month.js`), обов'язково імпортуючи `lib/filter.js` (FILTER-правила),
`lib/twitch-api.js` (Twitch клієнт з retry/backoff) і `lib/select.js`'s `pickByPopularity`
— не копіювати ці правила вручну (звідси й був баг у `ingest-month.js`: ручна копія
блоклістів відстала від `lib/filter.js`).

**INGEST**: Twitch API з кастомними параметрами залежно від критерію:
- Часовий діапазон → `started_at` / `ended_at` в API запиті (як `ingest-month.js`,
  але без recency-вікон — просто весь діапазон одним запитом)
- Тема/keyword → пошук у title кліпів або фільтрація post-fetch
- Дефолт: ті самі категорії що в звичайному run

**SELECT**:
- **Без diversity floor, без recency-компенсації** — чистий `pickByPopularity()` з `lib/select.js`
- Якщо тема → додаткова фільтрація по релевантності title/category

**Решта стадій**: ідентичні звичайному run (`download-clips.js`, `gaming-screen.js`, ...)

### Зупинка після GENERATE_EDITORIAL

Те саме: відкрити edit.html, юзер робить editorial рішення.

**Важливо для шортсів**: edit.html тепер має Shorts Assembly блок — юзер може:
- Групувати кліпи в **Merge** шортс (drag кліп на кліп)  
- Групувати кліпи в **Ranking** шортс (checkbox "Ranking" на групі)
- Порядок в ranking групі: зверху = #1 (найкращий), знизу = останнє місце

### State.json стадії

Ідентичні звичайному run, тільки `runId` = `Special_N_YYYY_MM_DD`.

## Після editorial — Stage 2

Той самий resume skill. Якщо editorial.json містить `shorts` масив з ranking/merge групами — render-shorts.js обробить автоматично.

## Приклад запуску

```
/ddos special найкращі кліпи за червень 2026
```

Claude уточнює:
- Діапазон: June 1–30, 2026
- Категорії: JC/IRL + Gaming
- Папка: Special_1_2026_07_01

Потім запускає той самий ingest pipeline з `started_at=2026-06-01T00:00:00Z&ended_at=2026-06-30T23:59:59Z`.
