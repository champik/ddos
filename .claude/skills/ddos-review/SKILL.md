# Skill: ddos-review

Згенеруй локальну HTML сторінку для перегляду і апруву епізоду. **Selection-only pipeline:**
запускається одразу після OVERLAYS/METADATA/THUMBNAIL, ДО монтажу в CapCut — фінального відео
і Shorts ще нема, сторінка мінімальна (без video embed).

---

## Генерація review.html

```bash
node scripts/progress.js "<projectDir>" 15 "Генерую review.html"
```

`<projectDir>` = `getProjectDir(runId)` = `projects/<YYYY_Month>/<runId>` (напр. `projects/2026_June/Episode_44_2026_06_28`).

Запустити готовий скрипт:

```bash
node scripts/gen-review.js "<projectDir>"
```

Скрипт читає episode-plan.json, metadata.json, scored-clips.json, state.json і генерує повну сторінку review/review.html.

**Секції сторінки:**
1. Header (лого + "EPISODE #N")
2. Subtitle: runId · дата · статус · кількість кліпів
3. Якщо опубліковано — рядок з кнопками YouTube ↗ та Short 1 ↗ Short 2 ↗ ... одразу під subtitle
4. Таблиця кліпів — деталі нижче (порядок = clipOrder, це і є порядок для CapCut)
5. Thumbnail — радіо-кнопки по кандидатах `thumb-candidate-{i}-{model}.png`; підпис `[streamerNickname] - [model]`
6. Title — чекбокси з `clipHooks`; live textarea що конкатенує вибрані через ` | `
7. Tags block: hidden tags (`meta.tags`), visible tags/hashtags (`meta.visibleTags`), chapters (`meta.chapters`) — для ручного копіювання в YouTube Studio при публікації
8. Approve box: команда `/ddos approve <runId>` якщо ще не опубліковано; порожньо якщо опубліковано

Long-form video і Shorts grid embed **прибрані** — система не рендерить фінальне відео/Shorts,
монтаж робить користувач у CapCut з `processed/overlayed/*.mp4`.

**Таблиця кліпів — колонки (7 шт, colspan=7 для reconnect row):**

| Колонка | Вміст |
|---|---|
| # | порядковий номер |
| Streamer | посилання на оригінальний кліп на Twitch (`s.url`) |
| Cat | скорочена категорія (JC, CS2, GTA V...) |
| Title | назва кліпу з Twitch (обрізана) |
| Dur | `trimmedDuration/originalDuration` у секундах; оригінал сірим |
| Views | view_count (1.4k, 2.1M) |
| Tags | `SHORT:DESKTOP/MOBILE/SPLIT` якщо short; `THUMB` якщо thumbnail; `✂N` якщо є cuts |

**Reconnect рядки:** між групами — `<tr class="reconnect-row"><td colspan="7">⟳ reconnect</td></tr>`

**Статус subtitle:**
- До публікації: `✓ Ready for review`
- Після публікації: `✓ Published`

**Стиль:** #0e0e10 фон, #f4f0e6 текст, #f5ff3d акцент, Anton/Space Grotesk/JetBrains Mono.

Після генерації — відкрити браузер автоматично (команда залежить від ОС, шлях — від кореня репозиторію):
```bash
# <projectDir> = projects/<YYYY_Month>/<runId>, напр. projects/2026_June/Episode_44_2026_06_28
# Windows:  start "" "<projectDir>\review\review.html"
# macOS:    open "<projectDir>/review/review.html"
# Linux:    xdg-open "<projectDir>/review/review.html"
```
Якщо відкрити браузер неможливо (headless/remote середовище) — вивести повний шлях до файлу.

Потім вивести в чат:

✅ Ревю відкрито у браузері (`<projectDir>/review/review.html`)

Перевір відео, thumbnail, title options і metadata.
Коли готово — виконай: /ddos approve <runId>
```

```bash
node scripts/progress.js "<projectDir>" summary
```

Оновити `state.stages.review = "done"`.

---

## Оновлення projects/index.html

Після генерації review.html — оновити `projects/index.html`:

1. Зчитай `projects/index.html`
2. Перевір чи картка цього епізоду вже існує (шукай `EP #N` де N = episodeNumber) — якщо так, пропусти
3. Якщо не існує — вставити новий `<div class="episode-card">` одразу після рядка `<div class="subtitle">...</div>`, перед усіма існуючими картками (щоб новий епізод був першим)

### Шаблон картки

`<YYYY_Month>/<runId>` у шаблоні нижче — відносний шлях від `projects/`, напр. `2026_June/Episode_44_2026_06_28`.

`exports/episode.mp4` на цьому етапі ще не існує (CapCut-монтаж попереду) — тривалість
оціни сумою `processed/overlayed/*.mp4` (ffprobe кожного, + ~2.5s на intro/outro):
```bash
DURATION_S=$(node -e "
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const dir = '<projectDir>/processed/overlayed';
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
  let total = 2.5; // intro + outro (1.25s each)
  for (const f of files) {
    total += parseFloat(execFileSync('ffprobe', ['-v','quiet','-show_entries','format=duration','-of','csv=p=0', path.join(dir, f)], { encoding: 'utf8' }));
  }
  console.log(Math.round(total));
")
# Форматувати як M:SS (наприклад 501s → "8:21"). Це ОЦІНКА (кліпи вже обрізані TRIM'ом,
# CapCut зазвичай лише додає динаміку/reconnect — не має різко змінити довжину).
```

Стрімери — унікальні broadcaster_name з `meta.chapters` (порядок зліва направо; окреме поле,
опису більше нема).

```html
<!-- EPISODE N -->
<div class="episode-card">
  <div class="thumb-wrap">
    <a href="<YYYY_Month>/<runId>/review/review.html">
      <img src="<YYYY_Month>/<runId>/exports/thumbnail.png" alt="Episode N thumbnail">
    </a>
  </div>
  <div class="info">
    <div>
      <div class="episode-meta">
        Episode #N <span class="sep">·</span> M:SS <span class="sep">·</span> YYYY-MM-DD <span class="sep">·</span> <span class="status-pending">⏳ pending</span>
      </div>
      <div class="title"><titleOptions[0]></div>
      <div class="streamers"><streamer1> · <streamer2> · ...</div>
    </div>
    <div class="links-row">
      <a class="btn btn-review" href="<YYYY_Month>/<runId>/review/review.html">Review</a>
    </div>
  </div>
</div>
```

- `status-pending` → замінюється на `status-published` при `/ddos approve`
- `M:SS` — оцінка з суми `processed/overlayed/*.mp4` (ffprobe), не з Twitch API. Точну тривалість
  `exports/episode.mp4` система не знає — фінальний монтаж робиться в CapCut поза системою
- Стрімери беруться з chapters у metadata.json description (унікальні, через ` · `)
- YouTube + shorts посилання додаються при `/ddos approve`
