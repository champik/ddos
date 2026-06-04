# Skill: ddos-review

Згенеруй локальну HTML сторінку для перегляду і апруву епізоду.

---

## Генерація review.html

```bash
node scripts/progress.js "projects/<runId>" 15 "Генерую review.html"
```

Запустити готовий скрипт:

```bash
node scripts/gen-review.js "projects/<runId>"
```

Скрипт читає episode-plan.json, metadata.json, scored-clips.json, state.json і генерує повну сторінку review/review.html.

**Секції сторінки:**
1. Header (лого + "EPISODE #N")
2. Subtitle: runId · дата · статус · кількість кліпів
3. Якщо опубліковано — рядок з кнопками YouTube ↗ та Short 1 ↗ Short 2 ↗ ... одразу під subtitle
4. Long-form video (episode-NNN.mp4)
5. Thumbnail
6. Title options (клікабельні картки)
7. Таблиця кліпів — деталі нижче
8. Shorts grid (9:16 vertical відео + title + caption)
9. Metadata block (description + tags)
10. Approve box: команда `/ddos approve <runId>` якщо ще не опубліковано; порожньо якщо опубліковано

**Таблиця кліпів — колонки (8 шт, colspan=8 для reconnect row):**

| Колонка | Вміст |
|---|---|
| # | порядковий номер |
| Streamer | посилання на оригінальний кліп на Twitch (`s.url`) |
| Cat | скорочена категорія (JC, CS2, GTA V...) |
| Title | назва кліпу з Twitch (обрізана) |
| Dur | `trimmedDuration/originalDuration` у секундах; оригінал сірим |
| Views | view_count (1.4k, 2.1M) |
| Vel/hr | views/hour — velocity кліпу (наскільки вірусний відносно часу створення) |
| Tags | `SHORT:DESKTOP/MOBILE/SPLIT` якщо short; `THUMB` якщо thumbnail; `✂N` якщо є cuts |

**Reconnect рядки:** між групами — `<tr class="reconnect-row"><td colspan="8">⟳ reconnect</td></tr>`

**Статус subtitle:**
- До публікації: `✓ Ready for review`
- Після публікації: `✓ Published`

**Стиль:** #0e0e10 фон, #f4f0e6 текст, #f5ff3d акцент, Anton/Space Grotesk/JetBrains Mono.

Після генерації — відкрити браузер автоматично:
```bash
start "" "d:\Projects\ddos\projects\<runId>\review\review.html"
```

Потім вивести в чат:

✅ Ревю відкрито у браузері (`projects/<runId>/review/review.html`)

Перевір відео, thumbnail, title options і metadata.
Коли готово — виконай: /ddos approve <runId>
```

```bash
node scripts/progress.js "projects/<runId>" summary
```

Оновити `state.stages.review = "done"`.

---

## Оновлення projects/index.html

Після генерації review.html — оновити `projects/index.html`:

1. Зчитай `projects/index.html`
2. Перевір чи картка цього епізоду вже існує (шукай `EP #N` де N = episodeNumber) — якщо так, пропусти
3. Якщо не існує — вставити новий `<div class="episode-card">` одразу після рядка `<div class="subtitle">...</div>`, перед усіма існуючими картками (щоб новий епізод був першим)

### Шаблон картки

Перед вставкою — виміряй тривалість фінального відео:
```bash
DURATION_S=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "projects/<runId>/exports/episode-<NNN>.mp4")
# Форматувати як M:SS (наприклад 501s → "8:21")
```

Стрімери — унікальні broadcaster_name з chapters опису metadata.json (порядок зліва направо).

```html
<!-- EPISODE N -->
<div class="episode-card">
  <div class="thumb-wrap">
    <a href="<projectFolder>/review/review.html">
      <img src="<projectFolder>/exports/thumbnail.png" alt="Episode N thumbnail">
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
      <a class="btn btn-review" href="<projectFolder>/review/review.html">Review</a>
    </div>
  </div>
</div>
```

- `status-pending` → замінюється на `status-published` при `/ddos approve`
- `M:SS` — реальна тривалість episode-NNN.mp4 (ffprobe), не з Twitch API
- Стрімери беруться з chapters у metadata.json description (унікальні, через ` · `)
- YouTube + shorts посилання додаються при `/ddos approve`
